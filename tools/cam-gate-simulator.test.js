import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { transferBundle } from './cam-gate-simulator.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function bundle(root, { direction = 'outside-to-inside', transferId = 'TR-1', filename = 'package.zip', bytes = Buffer.from('one simulated artifact') } = {}) {
  const [source] = direction === 'outside-to-inside' ? ['outside'] : ['inside'];
  const directory = join(root, source, 'outbox', transferId);
  const contentDir = join(directory, 'content', 'packages');
  await mkdir(contentDir, { recursive: true });
  await writeFile(join(contentDir, filename), bytes);
  const chunks = [];
  const chunkBytes = 5;
  for (let offset = 0, index = 0; offset < bytes.length; offset += chunkBytes, index++) {
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    chunks.push({ index, sizeBytes: chunk.length, sha256: hash(chunk) });
  }
  if (!chunks.length) chunks.push({ index: 0, sizeBytes: 0, sha256: hash(Buffer.alloc(0)) });
  const manifest = { schemaVersion: 1, transferId, direction, chunkSizeBytes: chunkBytes, files: [{ path: `packages/${filename}`, sizeBytes: bytes.length, sha256: hash(bytes), chunks }] };
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return directory;
}

test('copies one-way into the opposite zone with integrity receipt and idempotent retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-gate-sim-'));
  try {
    const content = Buffer.from('large-enough-for-multiple-test-chunks');
    await bundle(root, { bytes: content });
    const first = await transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-1' });
    assert.equal(first.idempotent, false);
    const dest = join(root, 'inside', 'inbox', 'TR-1');
    assert.deepEqual(await readFile(join(dest, 'content', 'packages', 'package.zip')), content);
    const receipt = JSON.parse(await readFile(join(dest, 'receipt.json'), 'utf8'));
    assert.equal(receipt.verification, 'SHA256_VERIFIED');
    assert.equal(receipt.manifestSha256, first.manifestSha256);
    assert.equal((await transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-1' })).idempotent, true);
    const mismatchDir = await bundle(root, { transferId: 'TR-2' });
    const mismatchManifestPath = join(mismatchDir, 'manifest.json');
    const mismatchManifest = JSON.parse(await readFile(mismatchManifestPath, 'utf8'));
    mismatchManifest.direction = 'inside-to-outside';
    await writeFile(mismatchManifestPath, JSON.stringify(mismatchManifest));
    await assert.rejects(transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-2' }), /direction does not match/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('resumes a partially copied bundle by rechecking destination chunks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-gate-sim-'));
  try {
    const content = Buffer.from('0123456789abcdefghij');
    await bundle(root, { bytes: content });
    await assert.rejects(transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-1', interruptAfterChunks: 2 }), { code: 'simulated_interruption' });
    const result = await transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-1' });
    assert.equal(result.bytes, content.length);
    assert.deepEqual(await readFile(join(root, 'inside', 'inbox', 'TR-1', 'content', 'packages', 'package.zip')), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('rejects path traversal and a source file whose content does not match its manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-gate-sim-'));
  try {
    const directory = await bundle(root);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files[0].path = '../secret';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-1' }), /unsafe relative path/u);
    manifest.files[0].path = 'packages/package.zip';
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(directory, 'content', 'packages', 'package.zip'), 'tampered');
    await assert.rejects(transferBundle({ root, direction: 'outside-to-inside', transferId: 'TR-1' }), /size does not match manifest/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
