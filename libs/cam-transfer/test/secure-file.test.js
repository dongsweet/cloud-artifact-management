import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeBufferAtomic, writeFilesAtomic, writeStreamAtomic } from '../src/secure-file.js';

test('secure file helpers atomically write bounded content and preserve its digest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-secure-file-'));
  const destination = join(root, 'nested', 'artifact.bin');
  const bytes = Buffer.from('secure artifact');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const result = await writeBufferAtomic({ data: bytes, destination, expectedSize: bytes.length, expectedSha256: expected });
  assert.deepEqual(result, { size: bytes.length, sha256: expected, path: destination });
  assert.deepEqual(await readFile(destination), bytes);
  assert.ok((await stat(destination)).isFile());
});

test('secure stream and file-sequence helpers reject digest mismatch without leaving a target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cam-secure-file-'));
  const streamTarget = join(root, 'stream.bin');
  const stream = (async function * () { yield Buffer.from('part one'); yield Buffer.from('part two'); }());
  await assert.rejects(() => writeStreamAtomic({ stream, destination: streamTarget, expectedSha256: '0'.repeat(64) }), /SHA-256/u);
  await assert.rejects(() => stat(streamTarget), { code: 'ENOENT' });

  const first = join(root, 'first');
  const second = join(root, 'second');
  const output = join(root, 'assembled.bin');
  await writeBufferAtomic({ data: Buffer.from('part one'), destination: first });
  await writeBufferAtomic({ data: Buffer.from('part two'), destination: second });
  await writeFilesAtomic({ sources: [first, second], destination: output, expectedSize: 16 });
  assert.equal((await readFile(output)).toString(), 'part onepart two');
});
