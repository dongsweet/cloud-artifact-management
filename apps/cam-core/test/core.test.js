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
  let cloudStatus = 'UNKNOWN';
  const cloud = {
    async createApproval(value) { calls.push(['create', value]); return { approvalId: 'APR-1', status: 'PENDING', mappingSnapshot: { priority: { id: '394' } }, requestBody: { priority: '394' } }; },
    async getApproval(id) { calls.push(['get', id]); return { approvalId: id, status: cloudStatus, workflowStep: cloudStatus === 'UNKNOWN' ? '已结束' : '工单确认', transferTaskId: cloudStatus === 'APPROVED' ? 'TR-1' : undefined, manifestSha256: cloudStatus === 'APPROVED' ? manifestSha256 : undefined, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async closeApproval(id) { calls.push(['close', id]); return { status: 'CLOSED' }; }
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false });
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  try {
    const received = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: envelope });
    assert.equal(received.statusCode, 202, received.body);
    assert.equal(received.json().item.status, 'CLOUD_PENDING');
    assert.equal(received.json().cloudSubmission, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const created = app.coreStore.get('FREEZE-1');
    assert.equal(created.status, 'CLOUD_SUBMITTED');
    assert.equal(created.cloudApprovalId, 'APR-1');
    assert.deepEqual(calls[0][0], 'create');
    assert.deepEqual(created.cloudMappingSnapshot, { priority: { id: '394' } });
    assert.deepEqual(created.cloudRequestSnapshot, { priority: '394' });

    const beforeSync = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(beforeSync.statusCode, 409);

    const synced = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/sync', payload: {} });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().item.status, 'CLOUD_STATUS_UNCONFIRMED');
    assert.equal(synced.json().item.cloudWorkflowStep, '已结束');
    const unconfirmedTransfer = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(unconfirmedTransfer.statusCode, 409);

    cloudStatus = 'APPROVED';
    const approved = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/sync', payload: {} });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().item.status, 'APPROVED');
    const authorized = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().item.transferTaskId, 'TR-1');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } })).json().item.idempotent, true);
    const earlyClose = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/close', payload: {} });
    assert.equal(earlyClose.statusCode, 409);
    assert.equal(calls.filter(([kind]) => kind === 'close').length, 0);
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
    const syncAfterClose = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/sync', payload: {} });
    assert.equal(syncAfterClose.json().item.status, 'CLOSED');
    assert.equal(calls.filter(([kind]) => kind === 'get').length, 2);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('gate approval messages require the configured exchange identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-auth-'));
  const app = await buildCoreApp({ dataDir, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) }, gateSecret: 'secret', enableAuth: false });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', payload: envelope });
    assert.equal(response.statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core acknowledges an approval before a slow cloud work-order create finishes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-async-create-'));
  let finishCreate;
  const cloud = { createApproval: () => new Promise((resolve) => { finishCreate = resolve; }) };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false });
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: { ...envelope, requestId: 'FREEZE-SLOW', freezeId: 'FREEZE-SLOW' } });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().item.status, 'CLOUD_PENDING');
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishCreate({ approvalId: 'APR-SLOW', status: 'PENDING' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.coreStore.get('FREEZE-SLOW').cloudApprovalId, 'APR-SLOW');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core retries a failed cloud work-order submission when Edge synchronizes the queued request', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-dispatch-retry-'));
  let createAttempts = 0;
  const cloud = {
    async createApproval() {
      createAttempts += 1;
      if (createAttempts === 1) throw new Error('temporary cloud outage');
      return { approvalId: 'APR-RETRY', status: 'PENDING' };
    },
    async getApproval(approvalId) { return { approvalId, status: 'PENDING', workflowStep: '审批中' }; }
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false });
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  const payload = { schemaVersion: 1, type: 'VERIFICATION_APPROVAL_REQUEST', requestId: 'FREEZE-RETRY', freezeId: 'FREEZE-RETRY', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), reportFileName: 'report.pdf', conclusion: 'PASS' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().item.status, 'CLOUD_PENDING');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.coreStore.get('FREEZE-RETRY').lastError, 'temporary cloud outage');
    const synced = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests/FREEZE-RETRY/sync', headers, payload: {} });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().item.status, 'CLOUD_PENDING');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.coreStore.get('FREEZE-RETRY').cloudApprovalId, 'APR-RETRY');
    assert.equal(createAttempts, 2);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
