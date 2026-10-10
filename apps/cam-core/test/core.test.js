import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';

const manifestSha256 = 'a'.repeat(64);
const reportSha256 = 'b'.repeat(64);
const envelope = {
  schemaVersion: 1,
  type: 'VERIFICATION_APPROVAL_REQUEST',
  requestId: 'FREEZE-1',
  freezeId: 'FREEZE-1',
  roundId: 'ROUND-1',
  releaseId: 'REL-1',
  manifestSha256,
  reportSha256,
  conclusion: 'PASS'
};

test('cam-core only authorizes transfer after cloud approval is queried and matched', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-'));
  const calls = [];
  const cloud = {
    async createApproval(value) { calls.push(['create', value]); return { approvalId: 'APR-1', status: 'PENDING' }; },
    async getApproval(id) { calls.push(['get', id]); return { approvalId: id, status: 'APPROVED', transferTaskId: 'TR-1', manifestSha256, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async closeApproval(id) { calls.push(['close', id]); return { status: 'CLOSED' }; }
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test' });
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  try {
    const received = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: envelope });
    assert.equal(received.statusCode, 202, received.body);
    assert.equal(received.json().item.status, 'CLOUD_SUBMITTED');
    assert.deepEqual(calls[0][0], 'create');

    const beforeSync = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(beforeSync.statusCode, 409);

    const synced = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/sync', payload: {} });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().item.status, 'APPROVED');
    const authorized = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().item.transferTaskId, 'TR-1');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } })).json().item.idempotent, true);
    const receipt = await app.inject({ method: 'POST', url: '/api/v1/gate/receipts', headers, payload: { requestId: 'FREEZE-1', transferTaskId: 'TR-1', manifestSha256 } });
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().item.status, 'RECEIVED');

    const replay = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: envelope });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().idempotent, true);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 1);

    const closed = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/close', payload: { reason: 'imported' } });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().item.status, 'CLOSED');
    assert.deepEqual(calls.at(-1), ['close', 'APR-1']);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('gate approval messages require the configured exchange identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-auth-'));
  const app = await buildCoreApp({ dataDir, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) }, gateSecret: 'secret' });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', payload: envelope });
    assert.equal(response.statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
