import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get } from 'node:http';
import { open } from 'node:fs/promises';
import test from 'node:test';
import { DownloadGrantStore } from '../src/download-grant-store.js';
import { buildEdgeApp } from '../src/app.js';

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE candidates (
    candidate_id TEXT PRIMARY KEY, file_name TEXT NOT NULL, expected_size INTEGER NOT NULL,
    final_md5 TEXT, final_sha256 TEXT, status TEXT NOT NULL
  )`);
  const candidates = new Map([
    ['CAND-1', { candidate_id: 'CAND-1', file_name: 'package.tar.gz', expected_size: 4096, final_md5: 'a'.repeat(32), final_sha256: 'b'.repeat(64), source_path: '/data/package.tar.gz', status: 'COMPLETED' }],
    ['CAND-2', { candidate_id: 'CAND-2', file_name: 'partial.rpm', expected_size: 200, final_sha256: null, source_path: '/data/partial.rpm', status: 'PARTIAL' }]
  ]);
  for (const candidate of candidates.values()) db.prepare(`INSERT INTO candidates
    (candidate_id, file_name, expected_size, final_md5, final_sha256, status) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(candidate.candidate_id, candidate.file_name, candidate.expected_size, candidate.final_md5 ?? null, candidate.final_sha256 ?? null, candidate.status);
  const store = new DownloadGrantStore({ db, candidateStore: { get: (candidateId) => candidates.get(candidateId) ?? null } });
  return { db, store };
}

test('download grants bind a completed-file allowlist to a principal and persist only token digests', () => {
  const { db, store } = setup();
  const grant = store.createGrant({ candidateIds: ['CAND-1'], principalId: 'user-42', principalType: 'LOCAL_PENDING', expiresAt: new Date(Date.now() + 60_000).toISOString(), maxTotalSessions: 3, maxSessionsPerFile: 2 });
  assert.equal(grant.items[0].sha256, 'b'.repeat(64));
  assert.equal(store.getGrantByToken(grant.token).principalId, 'user-42');
  assert.equal(db.prepare('SELECT token_sha256 FROM download_grants WHERE grant_id = ?').get(grant.grantId).token_sha256.includes(grant.token), false);
  assert.throws(() => store.createGrant({ candidateIds: ['CAND-2'], principalId: 'user-42', principalType: 'LOCAL_PENDING', expiresAt: new Date(Date.now() + 60_000).toISOString(), maxTotalSessions: 1, maxSessionsPerFile: 1 }), /not a verified completed file/);
  db.close();
});

test('download session resumes do not consume another slot and scope/revocation are enforced', () => {
  const { store } = setup();
  const grant = store.createGrant({ candidateIds: ['CAND-1'], principalId: 'user-42', principalType: 'LOCAL_PENDING', expiresAt: new Date(Date.now() + 60_000).toISOString(), maxTotalSessions: 1, maxSessionsPerFile: 1 });
  const first = store.beginSession({ token: grant.token, candidateId: 'CAND-1', downloadedBy: 'user-42', sourceAddress: '10.0.0.8' });
  assert.equal(first.resumed, false);
  assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 0);
  store.recordSessionProgress(first.sessionId, { bytesSent: 100, status: 'INTERRUPTED' });
  const resumed = store.beginSession({ token: grant.token, candidateId: 'CAND-1', sessionId: first.sessionId, downloadedBy: 'user-42' });
  assert.equal(resumed.resumed, true);
  assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 1);
  assert.throws(() => store.beginSession({ token: grant.token, candidateId: 'CAND-2', downloadedBy: 'user-42' }), /outside the download grant/);
  assert.throws(() => store.beginSession({ token: grant.token, candidateId: 'CAND-1', downloadedBy: 'user-42' }), /limit reached/);
  store.revokeGrant(grant.grantId, 'user-42');
  assert.throws(() => store.beginSession({ token: grant.token, candidateId: 'CAND-1', sessionId: first.sessionId, downloadedBy: 'user-42' }), /invalid, expired or revoked/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM download_events WHERE grant_id = ?').get(grant.grantId).count, 5);
});

test('cam-edge serves completed packages through principal-bound, resumable grants', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-downloads-'));
  const app = await buildEdgeApp({ dataDir, principalProvider: (request) => request.headers['x-test-user'] ? { id: request.headers['x-test-user'], type: 'TEST_IDP', roles: ['VALIDATOR'] } : null });
  try {
    const payload = Buffer.from('verified-package-content');
    const candidate = await app.candidateStore.create({ sourceUrl: 'https://dev.invalid/package.tar.gz', fileName: 'package.tar.gz', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
    await writeFile(candidate.source_path, payload);
    app.candidateStore.db.prepare("UPDATE candidates SET status = 'COMPLETED', final_sha256 = ?, completed_at = ? WHERE candidate_id = ?")
      .run(createHash('sha256').update(payload).digest('hex'), new Date().toISOString(), candidate.candidate_id);

    const body = { candidateIds: [candidate.candidate_id], expiresAt: new Date(Date.now() + 60_000).toISOString(), maxTotalSessions: 1, maxSessionsPerFile: 1 };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/download-grants', payload: body })).statusCode, 401);
    const created = await app.inject({ method: 'POST', url: '/api/v1/download-grants', headers: { 'x-test-user': 'validator-1' }, payload: body });
    assert.equal(created.statusCode, 201);
    const grant = created.json();
    const first = await app.inject({ method: 'GET', url: grant.items[0].downloadUrl, headers: { range: 'bytes=0-6' } });
    assert.equal(first.statusCode, 206);
    assert.deepEqual(first.rawPayload, payload.subarray(0, 7));
    const sessionId = first.headers['x-cam-download-session'];
    const second = await app.inject({ method: 'GET', url: grant.items[0].downloadUrl, headers: { range: `bytes=7-${payload.length - 1}`, 'x-cam-download-session': sessionId } });
    assert.equal(second.statusCode, 206);
    assert.deepEqual(second.rawPayload, payload.subarray(7));
    const grantState = await app.inject({ method: 'GET', url: `/api/v1/download-grants/${grant.grantId}`, headers: { 'x-test-user': 'validator-1' } });
    assert.equal(grantState.json().usedTotalSessions, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/download-grants/${grant.grantId}`, headers: { 'x-test-user': 'validator-1' } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: grant.items[0].downloadUrl })).statusCode, 403);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('HEAD, browser handoff, sequential retries and parallel requests do not exhaust download slots', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-download-handoff-'));
  const app = await buildEdgeApp({ dataDir });
  try {
    const bytes = Buffer.from('a verified package for download handoff');
    const candidate = await app.candidateStore.create({ sourceUrl: 'https://dev.invalid/pkg.bin', fileName: 'pkg.bin', size: bytes.length });
    await writeFile(candidate.source_path, bytes);
    app.candidateStore.db.prepare("UPDATE candidates SET status = 'COMPLETED', final_sha256 = ? WHERE candidate_id = ?").run(createHash('sha256').update(bytes).digest('hex'), candidate.candidate_id);
    const store = app.downloadGrantStore;
    const grant = store.createGrant({ candidateIds: [candidate.candidate_id], principalId: 'validator', principalType: 'TEST', expiresAt: new Date(Date.now() + 60000).toISOString(), maxTotalSessions: 1, maxSessionsPerFile: 1 });
    const url = `/api/v1/downloads/${candidate.candidate_id}/content?token=${grant.token}`;
    assert.equal((await app.inject({ method: 'HEAD', url })).statusCode, 200);
    assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 0);
    // Browser hands an unconsumed response to a manager with a different identity/User-Agent.
    const probe = store.beginSession({ token: grant.token, candidateId: candidate.candidate_id, downloadedBy: 'browser', sourceAddress: '127.0.0.1' });
    store.recordSessionProgress(probe.sessionId, { bytesSent: 0, status: 'INTERRUPTED' });
    const first = await app.inject({ url, headers: { range: 'bytes=0-3', 'user-agent': 'IDM' } });
    assert.equal(first.statusCode, 206);
    assert.equal(first.headers['x-cam-download-session'], probe.sessionId);
    assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 1);
    const unlock = store.acquireTransfer(grant.grantId, candidate.candidate_id);
    const denied = await app.inject({ url, headers: { range: 'bytes=4-', 'x-cam-download-session': probe.sessionId } });
    assert.equal(denied.statusCode, 409);
    assert.equal(denied.json().error.code, 'download_in_progress');
    assert.equal((await app.inject({ method: 'POST', url: `/api/v1/downloads/${candidate.candidate_id}/session`, headers: { authorization: `Bearer ${grant.token}` } })).statusCode, 409);
    unlock();
    assert.equal((await app.inject({ url, headers: { range: 'bytes=20-' } })).statusCode, 409);
    assert.equal((await app.inject({ url, headers: { range: 'bytes=0-1,5-6' } })).statusCode, 416);
    assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 1);
    const resumed = await app.inject({ url, headers: { range: 'bytes=4-', 'user-agent': 'another downloader' } });
    assert.equal(resumed.statusCode, 206);
    assert.equal(resumed.headers['x-cam-download-session'], probe.sessionId);
    assert.deepEqual(resumed.rawPayload, bytes.subarray(4));
    assert.equal((await app.inject({ url })).statusCode, 403);
    assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 1);
    assert.equal(store.db.prepare('SELECT bytes_sent FROM download_sessions').get().bytes_sent, bytes.length);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('real interrupted HTTP transfer persists partial flushed bytes and resumes without a custom header', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-download-socket-'));
  const app = await buildEdgeApp({ dataDir });
  try {
    const size = 32 * 1024 * 1024;
    const candidate = await app.candidateStore.create({ sourceUrl: 'https://dev.invalid/large.bin', fileName: 'large.bin', size });
    const file = await open(candidate.source_path, 'w'); await file.truncate(size); await file.close();
    app.candidateStore.db.prepare("UPDATE candidates SET status = 'COMPLETED', final_sha256 = ? WHERE candidate_id = ?").run('a'.repeat(64), candidate.candidate_id);
    const store = app.downloadGrantStore;
    const grant = store.createGrant({ candidateIds: [candidate.candidate_id], principalId: 'validator', principalType: 'TEST', expiresAt: new Date(Date.now() + 60000).toISOString(), maxTotalSessions: 1, maxSessionsPerFile: 1 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const url = `http://127.0.0.1:${app.server.address().port}/api/v1/downloads/${candidate.candidate_id}/content?token=${grant.token}`;
    let received = 0;
    await new Promise((resolve, reject) => {
      const req = get(url, (res) => {
        res.once('data', (data) => { received = data.length; res.pause();
          setTimeout(() => { req.destroy(); resolve(); }, 1200);
        });
      });
      req.on('error', reject);
    });
    for (let i = 0; i < 50; i++) {
      if (store.db.prepare('SELECT status FROM download_sessions').get()?.status === 'INTERRUPTED') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const partial = store.db.prepare('SELECT * FROM download_sessions').get();
    assert.equal(partial.status, 'INTERRUPTED');
    assert.ok(partial.bytes_sent >= received && partial.bytes_sent < size, JSON.stringify(partial));
    assert.equal(partial.covered_bytes, partial.bytes_sent);
    const resumed = await new Promise((resolve, reject) => {
      get(url, { headers: { range: `bytes=${received}-`, 'user-agent': 'IDM' } }, (res) => {
        let count = 0; res.on('data', (data) => { count += data.length; });
        res.on('end', () => resolve({ status: res.statusCode, count, sessionId: res.headers['x-cam-download-session'] }));
        res.on('error', reject);
      }).on('error', reject);
    });
    assert.equal(resumed.status, 206);
    assert.equal(resumed.count, size - received);
    assert.equal(resumed.sessionId, partial.session_id);
    const completed = store.db.prepare('SELECT * FROM download_sessions').get();
    assert.equal(completed.covered_bytes, size);
    assert.ok(completed.bytes_sent > size); // Retransmission is traffic, not additional file progress.
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(store.getGrant(grant.grantId).usedTotalSessions, 1);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
