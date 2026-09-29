import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildEdgeApp } from '../src/app.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('cam-edge accepts resumable candidate parts and finalizes the candidate', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-api-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const payload = Buffer.from('abcdefghij');
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/candidates',
    payload: { sourceUrl: 'http://127.0.0.1:39001/release.bin', fileName: 'release.bin', version: '8.0.6.2', architecture: 'amd64', targets: ['政务外网'], size: payload.length, chunkSize: 4 }
  });
  assert.equal(created.statusCode, 201);
  const candidate = created.json();
  const listed = await app.inject({ method: 'GET', url: '/api/v1/candidates' });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().items[0].candidateId, candidate.candidateId);
  const putPart = async (index, bytes) => app.inject({ method: 'PUT', url: `/api/v1/candidates/${candidate.candidateId}/parts/${index}`, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex') }, payload: bytes });
  assert.equal((await putPart(2, payload.subarray(8))).statusCode, 200);
  assert.equal((await putPart(0, payload.subarray(0, 4))).statusCode, 200);
  assert.equal((await putPart(1, payload.subarray(4, 8))).statusCode, 200);
  const progress = await app.inject({ method: 'GET', url: `/api/v1/candidates/${candidate.candidateId}/parts` });
  assert.deepEqual(progress.json().missingParts, []);
  const completed = await app.inject({ method: 'POST', url: `/api/v1/candidates/${candidate.candidateId}/complete` });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().status, 'COMPLETED');
  assert.equal(await readFile(join(dataDir, 'candidates', candidate.candidateId, 'source', 'release.bin'), 'utf8'), 'abcdefghij');
  await app.close();

  const reopened = await buildEdgeApp({ dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const loaded = await reopened.inject({ method: 'GET', url: `/api/v1/candidates/${candidate.candidateId}` });
  assert.equal(loaded.json().status, 'COMPLETED');
  await reopened.close();
});

test('cam-edge validates candidate metadata, preserves parts on conflict and stores final digest', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-validation-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 3, allowlist: ['127.0.0.1'] });
  const invalid = await app.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: 'http://127.0.0.1/release.bin', fileName: '../release.bin', version: '1.0.0', size: 6 } });
  assert.equal(invalid.statusCode, 400);

  const payload = Buffer.from('abcdef');
  const created = await app.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: 'http://127.0.0.1/release.bin', fileName: 'release.bin', version: '1.0.0', size: payload.length, chunkSize: 3 } });
  const candidate = created.json();
  const put = (index, bytes, digest = sha256(bytes)) => app.inject({ method: 'PUT', url: '/api/v1/candidates/' + candidate.candidateId + '/parts/' + index, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': digest }, payload: bytes });
  assert.equal((await put(0, payload.subarray(0, 3))).statusCode, 200);
  assert.equal((await put(0, payload.subarray(0, 3))).json().idempotent, true);
  const conflict = await put(0, Buffer.from('xyz'), sha256(Buffer.from('xyz')));
  assert.equal(conflict.statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/candidates/' + candidate.candidateId + '/complete' })).statusCode, 409);
  assert.equal((await put(1, Buffer.from('de'))).statusCode, 400);
  assert.equal((await put(1, payload.subarray(3))).statusCode, 200);
  const completed = await app.inject({ method: 'POST', url: '/api/v1/candidates/' + candidate.candidateId + '/complete' });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().finalSha256, sha256(payload));
  await app.close();
});

test('cam-edge receives a candidate from an HTTP Range source and records its source tag', async () => {
  const payload = Buffer.from('range-source-payload');
  const source = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) return response.writeHead(416).end();
    const start = Number(match[1]);
    const end = Number(match[2]);
    response.writeHead(206, { 'content-range': 'bytes ' + start + '-' + end + '/' + payload.length, etag: '"release-1"' });
    response.end(payload.subarray(start, end + 1));
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = source.address().port;
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-receive-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 5, allowlist: ['127.0.0.1'] });
  const created = await app.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: 'http://127.0.0.1:' + port + '/release.bin', fileName: 'release.bin', version: '2.0.0', size: payload.length, chunkSize: 5 } });
  const candidate = created.json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/candidates/' + candidate.candidateId + '/receive' })).statusCode, 202);
  await app.candidateReceiver.running.get(candidate.candidateId);
  const completed = await app.inject({ method: 'POST', url: '/api/v1/candidates/' + candidate.candidateId + '/complete' });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().finalSha256, sha256(payload));
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/candidates/' + candidate.candidateId })).json().status, 'COMPLETED');
  await app.close();
  await new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
});
