import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';

const DEFAULT_MODE = 0o600;

function normalizeDigest(value) {
  if (value === undefined || value === null || value === '') return null;
  const digest = String(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new TypeError('expected SHA-256 digest must be 64 hexadecimal characters');
  return digest;
}

function assertSize(size, expectedSize, maxSize) {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('written file size is invalid');
  if (expectedSize !== undefined && expectedSize !== null && size !== expectedSize) throw new Error(`written file size ${size} does not match expected ${expectedSize}`);
  if (maxSize !== undefined && maxSize !== null && (!Number.isSafeInteger(maxSize) || maxSize < 0 || size > maxSize)) throw new Error(`written file exceeds maximum size ${maxSize}`);
}

async function prepareDestination(destination) {
  await mkdir(dirname(destination), { recursive: true });
  return `${destination}.${process.pid}.${randomUUID()}.tmp`;
}

async function finalizeTemporary(temporary, destination, mode) {
  await chmod(temporary, mode);
  await rename(temporary, destination);
  await chmod(destination, mode);
}

/**
 * Atomically persist a bounded buffer with an optional SHA-256 assertion.
 * All callers use a random, exclusive temporary file and a private mode.
 */
export async function writeBufferAtomic({ data, destination, expectedSize, maxSize, expectedSha256, mode = DEFAULT_MODE } = {}) {
  if (typeof destination !== 'string' || !destination) throw new TypeError('destination is required');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data ?? '');
  assertSize(bytes.length, expectedSize, maxSize);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const expectedDigest = normalizeDigest(expectedSha256);
  if (expectedDigest && expectedDigest !== hash) throw new Error(`written file SHA-256 ${hash} does not match expected ${expectedDigest}`);
  const temporary = await prepareDestination(destination);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode });
    await finalizeTemporary(temporary, destination, mode);
    return { size: bytes.length, sha256: hash, path: destination };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Consume a readable stream into an atomically replaced file while enforcing
 * size and digest constraints. Progress is reported after each accepted chunk.
 */
export async function writeStreamAtomic({ stream, destination, expectedSize, maxSize, expectedSha256, onProgress = () => {}, mode = DEFAULT_MODE } = {}) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') throw new TypeError('stream is required');
  if (typeof destination !== 'string' || !destination) throw new TypeError('destination is required');
  const expectedDigest = normalizeDigest(expectedSha256);
  const temporary = await prepareDestination(destination);
  const output = createWriteStream(temporary, { flags: 'wx', mode });
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (expectedSize !== undefined && expectedSize !== null && size > expectedSize) throw new Error(`written file exceeds expected size ${expectedSize}`);
      if (maxSize !== undefined && maxSize !== null && size > maxSize) throw new Error(`written file exceeds maximum size ${maxSize}`);
      hash.update(bytes);
      if (!output.write(bytes)) await once(output, 'drain');
      onProgress(size);
    }
    output.end();
    await once(output, 'close');
    assertSize(size, expectedSize, maxSize);
    const digest = hash.digest('hex');
    if (expectedDigest && expectedDigest !== digest) throw new Error(`written file SHA-256 ${digest} does not match expected ${expectedDigest}`);
    await finalizeTemporary(temporary, destination, mode);
    return { size, sha256: digest, path: destination };
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Assemble existing private files through the same atomic destination path. */
export async function writeFilesAtomic({ sources, destination, expectedSize, expectedSha256, mode = DEFAULT_MODE } = {}) {
  if (!Array.isArray(sources) || sources.length === 0) throw new TypeError('sources are required');
  const stream = (async function * readSources() {
    for (const source of sources) {
      for await (const chunk of createReadStream(source)) yield chunk;
    }
  }());
  return writeStreamAtomic({ stream, destination, expectedSize, expectedSha256, mode });
}
