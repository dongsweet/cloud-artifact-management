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

test('candidate metadata can be corrected after a failed digest and candidate can be deleted', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-edit-delete-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const created = await app.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: 'http://127.0.0.1:39001/package.bin', fileName: 'package.bin', size: 4, md5: '0'.repeat(32) } });
  const candidate = created.json();
  const fixedMd5 = createHash('md5').update('data').digest('hex');
  const updated = await app.inject({ method: 'PATCH', url: `/api/v1/candidates/${candidate.candidateId}`, payload: { md5: fixedMd5, sha256: null, architecture: 'x86_64' } });
  assert.equal(updated.statusCode, 200);
  assert.equal(updated.json().expectedMd5, fixedMd5);
  assert.equal(updated.json().expectedSha256, null);
  assert.equal(updated.json().architecture, 'x86_64');
  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/candidates/${candidate.candidateId}` });
  assert.equal(removed.statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/candidates/${candidate.candidateId}` })).statusCode, 404);
  await app.close();
});

test('candidate digest mismatch reports both expected and actual MD5 values', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-digest-details-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 16, allowlist: ['127.0.0.1'] });
  const payload = Buffer.from('actual-package');
  const expectedMd5 = '0'.repeat(32);
  const actualMd5 = createHash('md5').update(payload).digest('hex');
  const created = await app.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: 'http://127.0.0.1/package.bin', fileName: 'package.bin', size: payload.length, md5: expectedMd5, chunkSize: 16 } });
  const candidate = created.json();
  await app.inject({ method: 'PUT', url: `/api/v1/candidates/${candidate.candidateId}/parts/0`, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(payload) }, payload });
  const completed = await app.inject({ method: 'POST', url: `/api/v1/candidates/${candidate.candidateId}/complete` });
  assert.equal(completed.statusCode, 422);
  assert.match(completed.json().error.message, new RegExp(`expected: ${expectedMd5}`));
  assert.match(completed.json().error.message, new RegExp(`actual: ${actualMd5}`));
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
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/candidates/' + candidate.candidateId })).json().status, 'COMPLETED');
  const completed = await app.inject({ method: 'POST', url: '/api/v1/candidates/' + candidate.candidateId + '/complete' });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().finalSha256, sha256(payload));
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/candidates/' + candidate.candidateId })).json().status, 'COMPLETED');
  await app.close();
  await new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
});

test('cam-edge resumes partial candidate downloads after restart and finalizes automatically', async () => {
  const payload = Buffer.from('recoverable-download');
  const source = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) return response.writeHead(416).end();
    const start = Number(match[1]);
    const end = Number(match[2]);
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, etag: '"stable-source"' });
    response.end(payload.subarray(start, end + 1));
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = source.address().port;
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-resume-restart-'));
  const first = await buildEdgeApp({ dataDir, defaultChunkSize: 5, allowlist: ['127.0.0.1'] });
  const created = await first.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: `http://127.0.0.1:${port}/release.bin`, fileName: 'release.bin', version: '2.0.0', size: payload.length, chunkSize: 5 } });
  const candidate = created.json();
  const firstPart = payload.subarray(0, 5);
  await first.inject({ method: 'PUT', url: `/api/v1/candidates/${candidate.candidateId}/parts/0`, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(firstPart) }, payload: firstPart });
  await first.close();

  const reopened = await buildEdgeApp({ dataDir, defaultChunkSize: 5, allowlist: ['127.0.0.1'] });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (reopened.candidateStore.get(candidate.candidateId).status === 'COMPLETED') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const recovered = reopened.candidateStore.get(candidate.candidateId);
  assert.equal(recovered.status, 'COMPLETED');
  assert.equal(recovered.completed_parts, 4);
  assert.equal(recovered.final_sha256, sha256(payload));
  await reopened.close();
  await new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
});

test('release rounds inherit unchanged candidate packages and replace only updated package mappings', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-rounds-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '曙光云 Stack' } });
  assert.equal(product.statusCode, 201);
  const productId = product.json().productId;
  const release = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/releases`, payload: { version: '8.0.6.2' } });
  assert.equal(release.statusCode, 201);
  const releaseId = release.json().releaseId;
  const firstRound = await app.inject({ method: 'POST', url: `/api/v1/releases/${releaseId}/rounds`, payload: {} });
  const round1 = firstRound.json();
  const createPackage = (roundId, packageKey, fileName) => app.inject({ method: 'POST', url: `/api/v1/rounds/${roundId}/candidates`, payload: { packageKey, sourceUrl: `http://127.0.0.1/${fileName}`, fileName, size: 4 } });
  const packageA = (await createPackage(round1.roundId, 'base', 'base.tar')).json();
  const packageB = (await createPackage(round1.roundId, 'agent', 'agent.tar')).json();
  const secondRound = await app.inject({ method: 'POST', url: `/api/v1/releases/${releaseId}/rounds`, payload: { baseRoundId: round1.roundId } });
  const round2 = secondRound.json();
  const inherited = await app.inject({ method: 'GET', url: `/api/v1/rounds/${round2.roundId}/candidates` });
  assert.deepEqual(inherited.json().items.map((item) => [item.packageKey, item.candidateId, item.mappingSource]), [['agent', packageB.candidateId, 'INHERITED'], ['base', packageA.candidateId, 'INHERITED']]);
  const replacement = (await createPackage(round2.roundId, 'agent', 'agent-v2.tar')).json();
  const updated = await app.inject({ method: 'GET', url: `/api/v1/rounds/${round2.roundId}/candidates` });
  const items = updated.json().items;
  assert.equal(items.find((item) => item.packageKey === 'base').candidateId, packageA.candidateId);
  assert.equal(items.find((item) => item.packageKey === 'agent').candidateId, replacement.candidateId);
  assert.equal(items.find((item) => item.packageKey === 'agent').mappingSource, 'OWNED');
  await app.close();
});

test('deletes empty open releases and protects releases with candidate packages', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-release-delete-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '删除测试产品' } });
  const productId = product.json().productId;

  const emptyRelease = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/releases`, payload: { version: 'draft' } });
  const emptyReleaseId = emptyRelease.json().releaseId;
  const emptyRound = await app.inject({ method: 'POST', url: `/api/v1/releases/${emptyReleaseId}/rounds`, payload: {} });
  assert.equal(emptyRound.statusCode, 201);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/releases/${emptyReleaseId}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/releases/${emptyReleaseId}` })).statusCode, 404);

  const usedRelease = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/releases`, payload: { version: '8.0.6.2' } });
  const usedReleaseId = usedRelease.json().releaseId;
  const round = await app.inject({ method: 'POST', url: `/api/v1/releases/${usedReleaseId}/rounds`, payload: {} });
  const candidate = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.json().roundId}/candidates`, payload: { sourceUrl: 'http://127.0.0.1/package.tar', size: 1 } });
  assert.equal(candidate.statusCode, 201);
  const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/releases/${usedReleaseId}` });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'release_not_empty');
  await app.close();
});

test('deletes products without releases and protects products with releases', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-product-delete-'));
  const app = await buildEdgeApp({ dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const empty = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '空产品' } });
  const emptyProductId = empty.json().productId;
  assert.equal(empty.json().releaseCount, 0);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/products/${emptyProductId}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/products' })).json().items.some((item) => item.productId === emptyProductId), false);

  const used = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '有版本产品' } });
  const usedProductId = used.json().productId;
  await app.inject({ method: 'POST', url: `/api/v1/products/${usedProductId}/releases`, payload: { version: '8.0.6.2' } });
  const listed = (await app.inject({ method: 'GET', url: '/api/v1/products' })).json().items.find((item) => item.productId === usedProductId);
  assert.equal(listed.releaseCount, 1);
  const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/products/${usedProductId}` });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'product_not_empty');
  await app.close();
});
