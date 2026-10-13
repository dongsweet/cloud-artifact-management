#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIRECTIONS = Object.freeze({
  'outside-to-inside': ['outside', 'inside'],
  'inside-to-outside': ['inside', 'outside']
});
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u;

function assertId(value, field) {
  if (typeof value !== 'string' || !idPattern.test(value) || value === '.' || value === '..') {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[a-zA-Z]:/u.test(value)) {
    throw new Error('manifest contains an invalid relative path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error('manifest contains an unsafe relative path');
  return parts.join(sep);
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('bundle files must be regular files, not symlinks');
  return info;
}

async function assertNoSymlinkPath(root, relativePath, { allowMissingLeaf = false } = {}) {
  let current = root;
  const parts = relativePath.split(sep);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) { if (allowMissingLeaf && index === parts.length - 1 && error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) throw new Error('bundle paths must not contain symlinks');
  }
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function validateBundle(bundleDir, direction) {
  const manifestPath = join(bundleDir, 'manifest.json');
  await assertRegularFile(manifestPath);
  const manifestBytes = await readFile(manifestPath);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); }
  catch { throw new Error('manifest.json is not valid JSON'); }
  const transferId = assertId(manifest.transferId, 'transferId');
  if (manifest.schemaVersion !== 1) throw new Error('unsupported manifest schemaVersion');
  if (manifest.direction !== direction) throw new Error('manifest direction does not match the selected exchange direction');
  if (!Number.isSafeInteger(manifest.chunkSizeBytes) || manifest.chunkSizeBytes < 1 || manifest.chunkSizeBytes > 1024 * 1024 * 1024) throw new Error('manifest chunkSizeBytes is invalid');
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('manifest must contain at least one file');

  const seen = new Set();
  for (const entry of manifest.files) {
    const relativePath = safeRelativePath(entry.path);
    if (relativePath === 'manifest.json' || relativePath === 'receipt.json' || seen.has(relativePath)) throw new Error('manifest contains a reserved or duplicate path');
    seen.add(relativePath);
    if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0 || !/^[a-f0-9]{64}$/u.test(entry.sha256 ?? '')) throw new Error(`manifest metadata is invalid for ${entry.path}`);
    if (!Array.isArray(entry.chunks) || !entry.chunks.length) throw new Error(`manifest chunks are missing for ${entry.path}`);
    let total = 0;
    const expectedChunks = Math.max(1, Math.ceil(entry.sizeBytes / manifest.chunkSizeBytes));
    if (entry.chunks.length !== expectedChunks) throw new Error(`manifest chunk count does not match ${entry.path}`);
    for (let index = 0; index < entry.chunks.length; index++) {
      const chunk = entry.chunks[index];
      if (chunk.index !== index || !Number.isSafeInteger(chunk.sizeBytes) || chunk.sizeBytes < 0 || !/^[a-f0-9]{64}$/u.test(chunk.sha256 ?? '')) throw new Error(`manifest chunk metadata is invalid for ${entry.path}`);
      const expectedSize = Math.min(manifest.chunkSizeBytes, Math.max(0, entry.sizeBytes - index * manifest.chunkSizeBytes));
      if (chunk.sizeBytes !== expectedSize) throw new Error(`manifest chunk size does not match ${entry.path}`);
      total += chunk.sizeBytes;
    }
    if (total !== entry.sizeBytes || (entry.sizeBytes > 0 && entry.chunks.some((chunk) => chunk.sizeBytes === 0)) || (entry.sizeBytes === 0 && (entry.chunks.length !== 1 || entry.chunks[0].sizeBytes !== 0))) {
      throw new Error(`manifest chunk sizes do not match ${entry.path}`);
    }
    const sourceFile = join(bundleDir, 'content', relativePath);
    await assertNoSymlinkPath(bundleDir, join('content', relativePath));
    const info = await assertRegularFile(sourceFile);
    if (info.size !== entry.sizeBytes) throw new Error(`source file size does not match manifest for ${entry.path}`);
  }
  return { manifest, manifestBytes, manifestSha256: sha256(manifestBytes), transferId };
}

async function copyFileResumable(sourcePath, destinationPath, entry, chunkSizeBytes, onChunk) {
  await mkdir(dirname(destinationPath), { recursive: true });
  let source;
  let destination;
  try {
    source = await open(sourcePath, 'r');
    let existingBytes = 0;
    try {
      const info = await assertRegularFile(destinationPath);
      existingBytes = info.size;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    destination = await open(destinationPath, existingBytes ? 'r+' : 'w+', 0o600);
    for (const chunk of entry.chunks) {
      const offset = chunk.index * chunkSizeBytes;
      const bytes = Buffer.alloc(chunk.sizeBytes);
      if (chunk.sizeBytes) {
        const { bytesRead } = await source.read(bytes, 0, chunk.sizeBytes, offset);
        if (bytesRead !== chunk.sizeBytes || sha256(bytes) !== chunk.sha256) throw new Error(`source chunk ${chunk.index} failed SHA-256 verification for ${entry.path}`);
      } else if (sha256(bytes) !== chunk.sha256) throw new Error(`empty source chunk failed SHA-256 verification for ${entry.path}`);

      let alreadyValid = false;
      if (existingBytes >= offset + chunk.sizeBytes) {
        const prior = Buffer.alloc(chunk.sizeBytes);
        if (chunk.sizeBytes) await destination.read(prior, 0, chunk.sizeBytes, offset);
        alreadyValid = sha256(prior) === chunk.sha256;
      }
      if (!alreadyValid) {
        if (chunk.sizeBytes) await destination.write(bytes, 0, chunk.sizeBytes, offset);
        await destination.sync();
      }
      existingBytes = Math.max(existingBytes, offset + chunk.sizeBytes);
      await onChunk?.({ path: entry.path, index: chunk.index, resumed: alreadyValid });
    }
    await destination.truncate(entry.sizeBytes);
    await destination.sync();
    await destination.close(); destination = null;
    const finalInfo = await stat(destinationPath);
    if (finalInfo.size !== entry.sizeBytes || await hashFile(destinationPath) !== entry.sha256) throw new Error(`assembled file failed SHA-256 verification for ${entry.path}`);
    return finalInfo.size;
  } finally {
    await source?.close();
    await destination?.close();
  }
}

/**
 * Test-only directory exchange. The root deliberately exposes two isolated
 * zone directories; each invocation moves one immutable bundle in one way.
 */
export async function transferBundle({ root, direction, transferId, interruptAfterChunks = Infinity, onChunk } = {}) {
  if (!Object.hasOwn(DIRECTIONS, direction)) throw new Error('direction must be outside-to-inside or inside-to-outside');
  const absoluteRoot = resolve(root ?? '');
  if (!root || absoluteRoot === resolve(absoluteRoot, '..')) throw new Error('an explicit simulator root directory is required');
  const [sourceZone, targetZone] = DIRECTIONS[direction];
  const safeTransferId = assertId(transferId, 'transferId');
  const sourceDir = join(absoluteRoot, sourceZone, 'outbox', safeTransferId);
  await assertNoSymlinkPath(absoluteRoot, join(sourceZone, 'outbox', safeTransferId, 'manifest.json'));
  const targetInbox = join(absoluteRoot, targetZone, 'inbox');
  const { manifest, manifestBytes, manifestSha256, transferId: manifestId } = await validateBundle(sourceDir, direction);
  if (manifestId !== safeTransferId) throw new Error('transferId does not match manifest');

  await mkdir(targetInbox, { recursive: true });
  const finalDir = join(targetInbox, safeTransferId);
  const finalExists = await stat(finalDir).then(() => true, (error) => { if (error.code === 'ENOENT') return false; throw error; });
  if (finalExists) {
    const existingReceipt = JSON.parse(await readFile(join(finalDir, 'receipt.json'), 'utf8'));
    if (existingReceipt.manifestSha256 !== manifestSha256 || existingReceipt.direction !== direction) throw new Error('transferId already exists with different content');
    return { transferId: safeTransferId, direction, manifestSha256, files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0), idempotent: true };
  }

  const stagingDir = join(targetInbox, `.${safeTransferId}.partial`);
  const lockPath = join(targetInbox, `.${safeTransferId}.lock`);
  const lock = await open(lockPath, 'wx', 0o600).catch((error) => {
    if (error.code === 'EEXIST') throw new Error('another transfer attempt is already running for this transferId');
    throw error;
  });
  let processedChunks = 0;
  try {
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    const statePath = join(stagingDir, '.transfer-state.json');
    let existingState;
    try { existingState = JSON.parse(await readFile(statePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error('partial transfer state is corrupt');
      if ((await readdir(stagingDir)).length) throw new Error('partial transfer has no resume state; remove it before restarting');
      const state = { schemaVersion: 1, transferId: safeTransferId, direction, manifestSha256 };
      await writeFile(statePath, `${JSON.stringify(state)}\n`, { flag: 'wx', mode: 0o600 });
    }
    if (existingState && (existingState.schemaVersion !== 1 || existingState.transferId !== safeTransferId || existingState.direction !== direction || existingState.manifestSha256 !== manifestSha256)) {
      throw new Error('partial transfer is pinned to a different manifest or direction');
    }
    await writeFile(join(stagingDir, 'manifest.json'), manifestBytes, { mode: 0o600 });
    for (const entry of manifest.files) {
      const relativePath = safeRelativePath(entry.path);
      await mkdir(join(stagingDir, 'content', dirname(relativePath)), { recursive: true, mode: 0o700 });
      await assertNoSymlinkPath(stagingDir, join('content', relativePath), { allowMissingLeaf: true });
      await copyFileResumable(
        join(sourceDir, 'content', relativePath),
        join(stagingDir, 'content', relativePath),
        entry,
        manifest.chunkSizeBytes,
        async (chunk) => {
          processedChunks++;
          await onChunk?.(chunk);
          if (processedChunks >= interruptAfterChunks) throw Object.assign(new Error('simulated interruption'), { code: 'simulated_interruption' });
        }
      );
    }
    const receipt = {
      schemaVersion: 1,
      transferId,
      direction,
      sourceZone,
      targetZone,
      manifestSha256,
      fileCount: manifest.files.length,
      totalBytes: manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0),
      receivedAt: new Date().toISOString(),
      verification: 'SHA256_VERIFIED'
    };
    await rm(statePath, { force: true });
    await writeFile(join(stagingDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(stagingDir, finalDir);
    return { transferId: safeTransferId, direction, manifestSha256, files: receipt.fileCount, bytes: receipt.totalBytes, idempotent: false };
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--root', '--direction', '--transfer-id'].includes(key)) throw new Error(`unknown argument: ${key}`);
    const value = argv[++index];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === '--root') args.root = value;
    else if (key === '--direction') args.direction = value;
    else args.transferId = value;
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await transferBundle(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.code === 'simulated_interruption' ? 'TRANSFER_INTERRUPTED_RESUMABLE' : 'TRANSFER_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
