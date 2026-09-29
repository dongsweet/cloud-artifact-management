import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const DEFAULT_CHUNK_SIZE = 256 * 1024 * 1024;

export function calculateChunkCount(size, chunkSize = DEFAULT_CHUNK_SIZE) {
  if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('size must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new RangeError('chunkSize must be a positive safe integer');
  return size === 0 ? 0 : Math.ceil(size / chunkSize);
}

export function getChunkRange(index, size, chunkSize = DEFAULT_CHUNK_SIZE) {
  const count = calculateChunkCount(size, chunkSize);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new RangeError('chunk index out of range');
  const offset = index * chunkSize;
  return { index, offset, size: Math.min(chunkSize, size - offset) };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  const handle = await open(path, 'r');
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await handle.read(buffer, offset, buffer.length - offset, position + offset);
    if (result.bytesRead === 0) throw new Error('unexpected end of file while reading chunk');
    offset += result.bytesRead;
  }
}

export async function createManifest({ artifactId, releaseId, filePath, fileName, version, targets = [], chunkSize = DEFAULT_CHUNK_SIZE, approvalId, transferTaskId }) {
  const file = await stat(filePath);
  const sha256 = await sha256File(filePath);
  const chunks = [];
  const handle = await open(filePath, 'r');
  try {
    const count = calculateChunkCount(file.size, chunkSize);
    for (let index = 0; index < count; index += 1) {
      const range = getChunkRange(index, file.size, chunkSize);
      const buffer = Buffer.allocUnsafe(range.size);
      await readExactly(handle, buffer, range.offset);
      chunks.push({ ...range, sha256: sha256Bytes(buffer) });
    }
  } finally {
    await handle.close();
  }
  return {
    schemaVersion: 1,
    artifactId,
    releaseId,
    fileName,
    size: file.size,
    sha256,
    version,
    targets,
    approvalId,
    transferTaskId,
    transfer: { mode: 'chunked', chunkSize, chunkCount: chunks.length, chunks }
  };
}

export async function writeChunk({ sourcePath, taskDir, manifest, index }) {
  const expected = manifest.transfer.chunks[index];
  if (!expected) throw new RangeError('chunk index out of range');
  await mkdir(join(taskDir, 'parts'), { recursive: true });
  const source = await open(sourcePath, 'r');
  const buffer = Buffer.allocUnsafe(expected.size);
  try {
    await readExactly(source, buffer, expected.offset);
  } finally {
    await source.close();
  }
  const actual = sha256Bytes(buffer);
  if (actual !== expected.sha256) throw new Error(`chunk ${index} checksum mismatch`);
  const path = join(taskDir, 'parts', `part-${String(index).padStart(6, '0')}`);
  const temp = `${path}.tmp`;
  const destination = await open(temp, 'w');
  try {
    await destination.writeFile(buffer);
  } finally {
    await destination.close();
  }
  await rename(temp, path);
  return { index, path, sha256: actual, size: expected.size };
}

export async function assembleChunks({ taskDir, manifest, outputPath }) {
  await mkdir(join(taskDir, 'parts'), { recursive: true });
  await mkdir(dirname(outputPath), { recursive: true });
  const outputTemp = `${outputPath}.tmp`;
  const destination = await open(outputTemp, 'w');
  try {
    for (const part of manifest.transfer.chunks) {
      const path = join(taskDir, 'parts', `part-${String(part.index).padStart(6, '0')}`);
      const bytes = await readFile(path);
      if (bytes.length !== part.size || sha256Bytes(bytes) !== part.sha256) throw new Error(`chunk ${part.index} checksum mismatch`);
      await destination.write(bytes);
    }
  } finally {
    await destination.close();
  }
  const actual = await sha256File(outputTemp);
  if (manifest.sha256 && actual !== manifest.sha256) throw new Error('assembled file checksum mismatch');
  await rename(outputTemp, outputPath);
  return { path: outputPath, size: manifest.size, sha256: actual };
}
