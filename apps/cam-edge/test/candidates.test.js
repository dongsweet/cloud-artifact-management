import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildEdgeApp } from '../src/app.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('cam-edge accepts resumable candidate parts and finalizes the candidate', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-api-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
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
  await assert.rejects(access(join(dataDir, 'candidates', candidate.candidateId, 'parts')));
  assert.equal(app.candidateStore.listParts(candidate.candidateId).length, 3, 'keep verified chunk metadata for audit and progress');
  const stalePartsDir = join(dataDir, 'candidates', candidate.candidateId, 'parts');
  await mkdir(stalePartsDir, { recursive: true });
  await writeFile(join(stalePartsDir, 'part-000000'), 'stale');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/candidates/${candidate.candidateId}/complete` })).statusCode, 200);
  await assert.rejects(access(stalePartsDir), 'idempotent completion should clean up legacy parts');
  await app.close();

  const reopened = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const loaded = await reopened.inject({ method: 'GET', url: `/api/v1/candidates/${candidate.candidateId}` });
  assert.equal(loaded.json().status, 'COMPLETED');
  await reopened.close();
});

test('cam-edge validates candidate metadata, preserves parts on conflict and stores final digest', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-validation-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 3, allowlist: ['127.0.0.1'] });
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
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
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
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 16, allowlist: ['127.0.0.1'] });
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
  await access(join(dataDir, 'candidates', candidate.candidateId, 'parts', 'part-000000'));
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
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 5, allowlist: ['127.0.0.1'] });
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
  const first = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 5, allowlist: ['127.0.0.1'] });
  const created = await first.inject({ method: 'POST', url: '/api/v1/candidates', payload: { sourceUrl: `http://127.0.0.1:${port}/release.bin`, fileName: 'release.bin', version: '2.0.0', size: payload.length, chunkSize: 5 } });
  const candidate = created.json();
  const firstPart = payload.subarray(0, 5);
  await first.inject({ method: 'PUT', url: `/api/v1/candidates/${candidate.candidateId}/parts/0`, headers: { 'content-type': 'application/octet-stream', 'x-chunk-sha256': sha256(firstPart) }, payload: firstPart });
  await first.close();

  const reopened = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 5, allowlist: ['127.0.0.1'] });
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

test('round batch receive is persisted and limits concurrent downloads', async () => {
  const payload = Buffer.from('scheduled-package');
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let rangeRequests = 0;
  const source = createServer(async (request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) return response.writeHead(416).end();
    activeRequests += 1;
    rangeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const start = Number(match[1]);
    const end = Number(match[2]);
    response.writeHead(206, { 'content-range': `bytes ${start}-${end}/${payload.length}`, etag: '"batch-source"' });
    response.end(payload.subarray(start, end + 1), () => { activeRequests -= 1; });
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const port = source.address().port;
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-batch-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: payload.length, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Batch test' } });
  const release = await app.inject({ method: 'POST', url: `/api/v1/products/${product.json().productId}/releases`, payload: { version: '1.0.0' } });
  const round = release.json().initialRound;
  const candidateIds = [];
  for (let index = 0; index < 3; index += 1) {
    const created = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { packageKey: `package-${index}`, sourceUrl: `http://127.0.0.1:${port}/package-${index}.bin`, size: payload.length } });
    candidateIds.push(created.json().candidateId);
  }
  const batch = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/receive-batch`, payload: {} });
  assert.equal(batch.statusCode, 202);
  assert.equal(batch.json().enqueued, 3);
  assert.equal(batch.json().concurrency, 2);
  assert.equal(batch.json().items.filter((item) => item.status === 'QUEUED').length, 1);
  const repeatedBatch = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/receive-batch`, payload: {} });
  assert.equal(repeatedBatch.statusCode, 202);
  assert.equal(repeatedBatch.json().enqueued, 0);
  assert.equal(repeatedBatch.json().alreadyActive, 3);
  const queuedId = batch.json().items.find((item) => item.status === 'QUEUED').candidate_id;
  await app.inject({ method: 'POST', url: `/api/v1/candidates/${queuedId}/cancel-receive` });
  assert.equal(app.receiveScheduler.list().find((item) => item.candidate_id === queuedId).status, 'PAUSED');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.receiveScheduler.list().filter((item) => item.status === 'COMPLETED').length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(maxActiveRequests <= 2, true);
  assert.equal(app.receiveScheduler.list().find((item) => item.candidate_id === queuedId).status, 'PAUSED');
  await app.inject({ method: 'POST', url: `/api/v1/candidates/${queuedId}/receive` });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (app.receiveScheduler.list().every((item) => item.status === 'COMPLETED')) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(app.receiveScheduler.list().filter((item) => item.status === 'COMPLETED').length, 3);
  assert.equal(rangeRequests, 3);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/receive-queue' })).json().items.length, 3);
  await app.close();
  await new Promise((resolve, reject) => source.close((error) => error ? reject(error) : resolve()));
});

test('round candidate removal detaches only the current round mapping', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-round-remove-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Round remove test' } });
  const release = await app.inject({ method: 'POST', url: `/api/v1/products/${product.json().productId}/releases`, payload: { version: '1.0.0' } });
  const round = release.json().initialRound;
  const created = await app.inject({ method: 'POST', url: `/api/v1/rounds/${round.roundId}/candidates`, payload: { packageKey: 'base', sourceUrl: 'http://127.0.0.1/base.bin', size: 1 } });
  const candidateId = created.json().candidateId;
  const removed = await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${round.roundId}/candidates/${candidateId}` });
  assert.equal(removed.statusCode, 204);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/rounds/${round.roundId}/candidates` })).json().items, []);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/candidates/${candidateId}` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${round.roundId}/candidates/${candidateId}` })).statusCode, 404);
  await app.close();
});

test('release rounds inherit unchanged candidate packages and replace only updated package mappings', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-rounds-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '曙光云 Stack' } });
  assert.equal(product.statusCode, 201);
  const productId = product.json().productId;
  const release = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/releases`, payload: { version: '8.0.6.2' } });
  assert.equal(release.statusCode, 201);
  const releaseId = release.json().releaseId;
  const firstRound = await app.inject({ method: 'POST', url: `/api/v1/releases/${releaseId}/rounds`, payload: { changeNote: '测试轮次' } });
  assert.equal(firstRound.statusCode, 409, 'a release always starts with its first round already created');
  const firstRoundFromRelease = (await app.inject({ method: 'GET', url: `/api/v1/releases/${releaseId}/rounds` })).json().items[0];
  const round1 = firstRoundFromRelease;
  const createPackage = (roundId, packageKey, fileName) => app.inject({ method: 'POST', url: `/api/v1/rounds/${roundId}/candidates`, payload: { packageKey, sourceUrl: `http://127.0.0.1/${fileName}`, fileName, size: 4 } });
  const packageA = (await createPackage(round1.roundId, 'base', 'base.tar')).json();
  const packageB = (await createPackage(round1.roundId, 'agent', 'agent.tar')).json();
  const secondRound = await app.inject({ method: 'POST', url: `/api/v1/releases/${releaseId}/rounds`, payload: { baseRoundId: round1.roundId, changeNote: '更新轮次' } });
  assert.equal(secondRound.statusCode, 201, secondRound.body);
  const round2 = secondRound.json();
  assert.equal(round2.hasChanges, false, 'inheriting the prior package list unchanged is an empty round');
  assert.equal(round2.canDeleteEmpty, true);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/releases/${releaseId}/rounds`, payload: { changeNote: '不能从空轮次继续创建' } })).statusCode, 409);
  const inherited = await app.inject({ method: 'GET', url: `/api/v1/rounds/${round2.roundId}/candidates` });
  assert.deepEqual(inherited.json().items.map((item) => [item.packageKey, item.candidateId, item.mappingSource, item.inheritedFromRoundNo]), [['agent', packageB.candidateId, 'INHERITED', 1], ['base', packageA.candidateId, 'INHERITED', 1]]);
  const replacement = (await createPackage(round2.roundId, 'agent', 'agent-v2.tar')).json();
  const updated = await app.inject({ method: 'GET', url: `/api/v1/rounds/${round2.roundId}/candidates` });
  const items = updated.json().items;
  assert.equal(items.find((item) => item.packageKey === 'base').candidateId, packageA.candidateId);
  assert.equal(items.find((item) => item.packageKey === 'agent').candidateId, replacement.candidateId);
  assert.equal(items.find((item) => item.packageKey === 'agent').mappingSource, 'OWNED');
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/rounds/${round1.roundId}` })).json().readOnly, true);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/rounds/${round1.roundId}/candidates`, payload: { packageKey: 'old-round', sourceUrl: 'http://127.0.0.1/old.bin', size: 4 } })).statusCode, 409);
  await app.close();
});

test('batch round and candidate filters avoid per-release list queries', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-batch-filters-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir });
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '批量查询产品' } })).json();
  const first = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '1.0' } })).json();
  const second = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '2.0' } })).json();
  await app.inject({ method: 'POST', url: `/api/v1/rounds/${first.initialRound.roundId}/candidates`, payload: { packageKey: 'one', sourceUrl: 'http://127.0.0.1/one.tar', size: 0 } });
  await app.inject({ method: 'POST', url: `/api/v1/rounds/${second.initialRound.roundId}/candidates`, payload: { packageKey: 'two', sourceUrl: 'http://127.0.0.1/two.tar', size: 0 } });

  const rounds = await app.inject({ method: 'GET', url: `/api/v1/rounds?productId=${product.productId}` });
  assert.equal(rounds.statusCode, 200);
  assert.deepEqual(rounds.json().items.map((item) => item.releaseId).sort(), [first.releaseId, second.releaseId].sort());
  const candidates = await app.inject({ method: 'GET', url: `/api/v1/candidates?productId=${product.productId}&limit=200` });
  assert.equal(candidates.statusCode, 200);
  assert.deepEqual(candidates.json().items.map((item) => item.packageKey).sort(), ['one', 'two']);
  assert.deepEqual(candidates.json().items.find((item) => item.packageKey === 'one').rounds.map((round) => ({ releaseId: round.releaseId, roundNo: round.roundNo, packageKey: round.packageKey })), [{ releaseId: first.releaseId, roundNo: 1, packageKey: 'one' }]);
  assert.deepEqual(candidates.json().items.find((item) => item.packageKey === 'two').rounds.map((round) => ({ releaseId: round.releaseId, roundNo: round.roundNo, packageKey: round.packageKey })), [{ releaseId: second.releaseId, roundNo: 1, packageKey: 'two' }]);
  const onlySecond = await app.inject({ method: 'GET', url: `/api/v1/rounds?releaseId=${second.releaseId}` });
  assert.deepEqual(onlySecond.json().items.map((item) => item.releaseId), [second.releaseId]);
  await app.close();
});

test('release creation atomically creates the first round and server calculates the next round', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-release-round-atomic-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'release-operator', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir });
  const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Atomic Stack' } })).json();
  const created = await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '8.0.6.4' } });
  assert.equal(created.statusCode, 201, created.body);
  const release = created.json();
  assert.equal(release.initialRound.roundNo, 1);
  assert.equal(release.initialRound.releaseId, release.releaseId);
  const preview = await app.inject({ method: 'GET', url: `/api/v1/releases/${release.releaseId}/rounds` });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().nextRound.roundNo, 2);
  assert.equal(preview.json().nextRound.baseRoundId, release.initialRound.roundId);
  assert.equal(preview.json().nextRound.canCreate, false);
  const emptyAttempt = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '空轮次不能继续创建' } });
  assert.equal(emptyAttempt.statusCode, 409);
  const addPackage = await app.inject({ method: 'POST', url: `/api/v1/rounds/${release.initialRound.roundId}/candidates`, payload: { packageKey: 'core', sourceUrl: 'http://127.0.0.1/core.tar', size: 4 } });
  assert.equal(addPackage.statusCode, 201, addPackage.body);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/releases/${release.releaseId}/rounds` })).json().nextRound.canCreate, true);
  const second = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '第二轮变更' } });
  assert.equal(second.statusCode, 201, second.body);
  assert.equal(second.json().roundNo, 2);
  assert.equal(second.json().baseRoundId, release.initialRound.roundId);
  await app.close();
});

test('an inherited unchanged round can be deleted and restores the prior round as editable', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-empty-round-delete-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'release-operator', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir });
  try {
    const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Empty round test' } })).json();
    const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '1.0' } })).json();
    const initial = release.initialRound;
    const candidate = await app.inject({ method: 'POST', url: `/api/v1/rounds/${initial.roundId}/candidates`, payload: { packageKey: 'base', sourceUrl: 'http://127.0.0.1/base.tar', size: 4 } });
    assert.equal(candidate.statusCode, 201);
    const child = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '继承第一轮清单' } });
    assert.equal(child.statusCode, 201, child.body);
    assert.equal(child.json().candidateCount, 1);
    assert.equal(child.json().hasChanges, false);
    assert.equal(child.json().canDeleteEmpty, true);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '不允许空轮次继续' } })).statusCode, 409);

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${child.json().roundId}` });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(removed.json().deleted, true);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/rounds/${initial.roundId}` })).json().readOnly, false);
    const edit = await app.inject({ method: 'POST', url: `/api/v1/rounds/${initial.roundId}/candidates`, payload: { packageKey: 'agent', sourceUrl: 'http://127.0.0.1/agent.tar', size: 4 } });
    assert.equal(edit.statusCode, 201, edit.body);
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '重新创建下一轮' } })).statusCode, 201);
    assert.equal(app.candidateStore.db.prepare('SELECT event_type, actor_id FROM round_lifecycle_events WHERE round_id = ?').get(child.json().roundId).event_type, 'EMPTY_ROUND_DELETED');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a stale empty round from legacy edits can be deleted with a distinct audit event', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-stale-empty-round-'));
  const app = await buildEdgeApp({ dataDir, principalProvider: () => ({ id: 'recovery-operator', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }) });
  try {
    const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Stale round test' } })).json();
    const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '8.0.6.1' } })).json();
    const initial = release.initialRound;

    // Reproduce a legacy state: an empty child was created, then a package
    // mapping was added to its base round after the child already existed.
    const child = app.candidateStore.createRound(release.releaseId, { baseRoundId: initial.roundId, changeNote: '旧版创建的轮次', createdBy: 'test', requireBaseChanges: false });
    const candidate = await app.candidateStore.create({ releaseId: release.releaseId, packageKey: 'storage', sourceUrl: 'http://127.0.0.1/storage.tar', fileName: 'storage.tar', size: 4 });
    const mappingTime = new Date(Date.parse(child.createdAt) + 1000).toISOString();
    app.candidateStore.db.prepare(`INSERT INTO round_candidates (round_id, package_key, candidate_id, source, inherited_from_round_id, created_at)
      VALUES (?, ?, ?, 'OWNED', NULL, ?)`).run(initial.roundId, 'storage', candidate.candidate_id, mappingTime);

    const stale = (await app.inject({ method: 'GET', url: `/api/v1/rounds/${child.roundId}` })).json();
    assert.equal(stale.hasChanges, true, 'the late base package appears as a removal in the empty child');
    assert.equal(stale.staleEmptyBaseline, true);
    assert.equal(stale.canDeleteEmpty, true);
    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${child.roundId}` });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(deleted.json().recoveryDelete, true);
    assert.equal((await app.inject({ method: 'GET', url: `/api/v1/rounds/${initial.roundId}` })).json().readOnly, false);
    assert.equal(app.candidateStore.db.prepare('SELECT event_type, actor_id FROM round_lifecycle_events WHERE round_id = ?').get(child.roundId).event_type, 'STALE_EMPTY_ROUND_DELETED');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an intentional removal from an older base mapping is not treated as a stale empty round', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-intentional-empty-round-'));
  const app = await buildEdgeApp({ dataDir, principalProvider: () => ({ id: 'release-operator', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }) });
  try {
    const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Intentional removal test' } })).json();
    const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '1.0' } })).json();
    const initial = release.initialRound;
    await app.inject({ method: 'POST', url: `/api/v1/rounds/${initial.roundId}/candidates`, payload: { packageKey: 'base', sourceUrl: 'http://127.0.0.1/base.tar', size: 4 } });
    const child = app.candidateStore.createRound(release.releaseId, { baseRoundId: initial.roundId, changeNote: '显式移除包', createdBy: 'test', requireBaseChanges: false });
    app.candidateStore.db.prepare('DELETE FROM round_candidates WHERE round_id = ?').run(child.roundId);

    const current = (await app.inject({ method: 'GET', url: `/api/v1/rounds/${child.roundId}` })).json();
    assert.equal(current.hasChanges, true);
    assert.equal(current.staleEmptyBaseline, false);
    assert.equal(current.canDeleteEmpty, false);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/rounds/${child.roundId}` })).statusCode, 409);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('release creation migrates legacy release-round schema before inserting the first round', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-legacy-round-schema-'));
  const db = await openDatabase(join(dataDir, 'edge.sqlite'));
  db.exec(`
    CREATE TABLE products (product_id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE releases (release_id TEXT PRIMARY KEY, product_id TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(product_id, version));
    CREATE TABLE release_rounds (round_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, round_no INTEGER NOT NULL, base_round_id TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(release_id, round_no));
  `);
  await db.close();

  const app = await buildEdgeApp({ dataDir, principalProvider: () => ({ id: 'legacy-schema-operator', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }) });
  try {
    const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Legacy Schema Stack' } })).json();
    const created = await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '8.0.6.1' } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().initialRound.roundNo, 1);
    assert.equal(created.json().initialRound.changeNote, '发布版本创建，开始第一轮候选包收集');
    assert.equal(created.json().initialRound.createdBy, 'legacy-schema-operator');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('round creation requires an audit note and accepts downloadable evidence attachments', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-round-audit-'));
  const app = await buildEdgeApp({ dataDir, principalProvider: () => ({ id: 'release-operator', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }) });
  try {
    const product = (await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: 'Audit Stack' } })).json();
    const release = (await app.inject({ method: 'POST', url: `/api/v1/products/${product.productId}/releases`, payload: { version: '8.0' } })).json();
    await app.inject({ method: 'POST', url: `/api/v1/rounds/${release.initialRound.roundId}/candidates`, payload: { packageKey: 'base', sourceUrl: 'http://127.0.0.1/base.tar', size: 4 } });
    const missingNote = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: {} });
    assert.equal(missingNote.statusCode, 400);
    assert.match(missingNote.json().error.message, /说明/);
    const created = await app.inject({ method: 'POST', url: `/api/v1/releases/${release.releaseId}/rounds`, payload: { changeNote: '第二轮只更新计算节点补丁，其余从第一轮继承' } });
    assert.equal(created.statusCode, 201, created.body);
    assert.equal(created.json().createdBy, 'release-operator');
    const attachmentBytes = Buffer.from('%PDF-1.7\nround evidence');
    const upload = await app.inject({ method: 'POST', url: `/api/v1/rounds/${created.json().roundId}/attachments`, headers: { 'content-type': 'application/pdf', 'x-attachment-filename': 'release-note.pdf' }, payload: attachmentBytes });
    assert.equal(upload.statusCode, 201, upload.body);
    const docxBytes = Buffer.from('docx attachment bytes');
    const docxUpload = await app.inject({ method: 'POST', url: `/api/v1/rounds/${created.json().roundId}/attachments`, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x-attachment-filename': encodeURIComponent('发布说明.docx') }, payload: docxBytes });
    assert.equal(docxUpload.statusCode, 201, docxUpload.body);
    const docxDownload = await app.inject({ url: `/api/v1/round-attachments/${docxUpload.json().item.attachmentId}/file` });
    assert.equal(docxDownload.body, docxBytes.toString());
    for (const [fileName, contentType] of [['交付说明.wps', 'application/vnd.ms-works'], ['记录.txt', 'text/plain'], ['说明.md', 'text/markdown']]) {
      const bytes = Buffer.from(`round attachment ${fileName}`);
      const response = await app.inject({ method: 'POST', url: `/api/v1/rounds/${created.json().roundId}/attachments`, headers: { 'content-type': contentType, 'x-attachment-filename': encodeURIComponent(fileName) }, payload: bytes });
      assert.equal(response.statusCode, 201, response.body);
      const download = await app.inject({ url: `/api/v1/round-attachments/${response.json().item.attachmentId}/file` });
      assert.equal(download.body, bytes.toString());
    }
    const detail = await app.inject({ url: `/api/v1/rounds/${created.json().roundId}` });
    assert.equal(detail.json().changeNote, '第二轮只更新计算节点补丁，其余从第一轮继承');
    assert.equal(detail.json().attachments[0].sha256.length, 64);
    assert.equal('filePath' in detail.json().attachments[0], false);
    assert.equal(detail.json().attachments.some((item) => item.fileName === '发布说明.docx'), true);
    const download = await app.inject({ url: `/api/v1/round-attachments/${upload.json().item.attachmentId}/file` });
    assert.equal(download.body, attachmentBytes.toString());
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('deletes empty open releases and protects releases with candidate packages', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-release-delete-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '删除测试产品' } });
  const productId = product.json().productId;

  const emptyRelease = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/releases`, payload: { version: 'draft' } });
  const emptyReleaseId = emptyRelease.json().releaseId;
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/releases/${emptyReleaseId}` })).statusCode, 204);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/releases/${emptyReleaseId}` })).statusCode, 404);

  const usedRelease = await app.inject({ method: 'POST', url: `/api/v1/products/${productId}/releases`, payload: { version: '8.0.6.2' } });
  const usedReleaseId = usedRelease.json().releaseId;
  const candidate = await app.inject({ method: 'POST', url: `/api/v1/rounds/${usedRelease.json().initialRound.roundId}/candidates`, payload: { sourceUrl: 'http://127.0.0.1/package.tar', size: 1 } });
  assert.equal(candidate.statusCode, 201);
  const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/releases/${usedReleaseId}` });
  assert.equal(blocked.statusCode, 409);
  assert.equal(blocked.json().error.code, 'release_not_empty');
  await app.close();
});

test('deletes products without releases and protects products with releases', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-product-delete-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
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

test('candidate import creates only selected row metadata and refuses package key replacement', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-import-'));
  const app = await buildEdgeApp({ principalProvider: () => ({ id: 'test-receiver', type: 'TEST_IDP', roles: ['EDGE_OPERATOR'] }), dataDir, defaultChunkSize: 4, allowlist: ['127.0.0.1'] });
  const product = await app.inject({ method: 'POST', url: '/api/v1/products', payload: { name: '导入测试产品' } });
  const release = await app.inject({ method: 'POST', url: `/api/v1/products/${product.json().productId}/releases`, payload: { version: '8.0.6.2' } });
  const roundId = release.json().initialRound.roundId;
  const payload = { items: [{ packageKey: '系统包 / x86_64', sourceUrl: 'http://127.0.0.1/system.tar.gz', fileName: 'system.tar.gz', architecture: 'x86_64', size: 0, sourceMetadata: { type: '操作系统ISO', applicableProducts: ['Stack', 'SVM'], displaySize: '5.96 GB', sourceSheet: '完整部署包', sourceRow: 3 } }] };
  const imported = await app.inject({ method: 'POST', url: `/api/v1/rounds/${roundId}/import`, payload });
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.json().imported, 1);
  assert.equal(imported.json().items[0].metadata.displaySize, '5.96 GB');
  assert.equal(imported.json().items[0].type, '操作系统ISO');
  assert.equal(imported.json().items[0].status, 'CREATED');
  const duplicate = await app.inject({ method: 'POST', url: `/api/v1/rounds/${roundId}/import`, payload });
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.json().error.message, /包标识已存在/);
  const roundCandidates = (await app.inject({ method: 'GET', url: `/api/v1/rounds/${roundId}/candidates` })).json().items;
  assert.equal(roundCandidates.length, 1);
  assert.equal(roundCandidates[0].type, '操作系统ISO');
  await app.close();
});
