import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createManifest, assembleChunks, writeChunk } from '../src/transfer.js';
import { ProgressStore } from '../src/progress-store.js';
import { openDatabase } from '../../cam-sqlite/src/database.js';

test('manifest, chunk progress and assembly survive a partial transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-transfer-'));
  const source = join(root, 'source.bin');
  await writeFile(source, Buffer.from('abcdefghijklmnopqrstuvwxyz0123456789'));
  const manifest = await createManifest({ artifactId: 'ART-1', releaseId: 'REL-1', filePath: source, fileName: 'source.bin', version: '1.0.0', chunkSize: 7, approvalId: 'APR-1', transferTaskId: 'TR-1' });
  const db = await openDatabase(join(root, 'state', 'agent.sqlite'));
  const progress = new ProgressStore(db);
  progress.createTask({ transferTaskId: 'TR-1', artifactId: 'ART-1', totalParts: manifest.transfer.chunkCount });
  const taskDir = join(root, 'task');
  await mkdir(taskDir, { recursive: true });
  const first = await writeChunk({ sourcePath: source, taskDir, manifest, index: 0 });
  progress.markPart({ transferTaskId: 'TR-1', partIndex: first.index, size: first.size, sha256: first.sha256 });
  assert.equal(progress.getTask('TR-1').parts.length, 1);
  for (let i = 1; i < manifest.transfer.chunkCount; i += 1) {
    const part = await writeChunk({ sourcePath: source, taskDir, manifest, index: i });
    progress.markPart({ transferTaskId: 'TR-1', partIndex: part.index, size: part.size, sha256: part.sha256 });
  }
  const output = join(root, 'out', 'source.bin');
  await mkdir(join(root, 'out'), { recursive: true });
  const result = await assembleChunks({ taskDir, manifest, outputPath: output });
  progress.completeTask('TR-1');
  assert.equal(await readFile(output, 'utf8'), 'abcdefghijklmnopqrstuvwxyz0123456789');
  assert.equal(progress.getTask('TR-1').status, 'COMPLETED');
  assert.equal(result.sha256, manifest.sha256);
});

test('progress is recoverable after reopening SQLite and rejects a corrupt chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-transfer-recovery-'));
  const source = join(root, 'source.bin');
  await writeFile(source, Buffer.from('0123456789abcdef'));
  const manifest = await createManifest({ artifactId: 'ART-2', releaseId: 'REL-2', filePath: source, fileName: 'source.bin', version: '1.0.0', chunkSize: 4, approvalId: 'APR-2', transferTaskId: 'TR-2' });
  const dbPath = join(root, 'state', 'agent.sqlite');
  const db = await openDatabase(dbPath);
  const progress = new ProgressStore(db);
  progress.createTask({ transferTaskId: 'TR-2', artifactId: 'ART-2', totalParts: manifest.transfer.chunkCount });
  const taskDir = join(root, 'task');
  await mkdir(taskDir, { recursive: true });
  const first = await writeChunk({ sourcePath: source, taskDir, manifest, index: 0 });
  progress.markPart({ transferTaskId: 'TR-2', partIndex: first.index, size: first.size, sha256: first.sha256 });
  db.close();
  const reopened = await openDatabase(dbPath);
  const recovered = new ProgressStore(reopened);
  assert.deepEqual(recovered.missingParts('TR-2'), [1, 2, 3]);
  await writeFile(join(taskDir, 'parts', 'part-000001'), Buffer.from('bad!'));
  await assert.rejects(
    () => assembleChunks({ taskDir, manifest, outputPath: join(root, 'out.bin') }),
    /chunk 1 checksum mismatch/
  );
  reopened.close();
});
