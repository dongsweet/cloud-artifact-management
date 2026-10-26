import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';
import { signedTestHeaders, trustTestPeer } from '../../../libs/cam-gate/test-helper.js';

const manifestSha256 = 'a'.repeat(64);
const reportSha256 = 'b'.repeat(64);
const envelope = {
  schemaVersion: 1,
  type: 'VERIFICATION_APPROVAL_REQUEST',
  requestId: 'FREEZE-1',
  freezeId: 'FREEZE-1',
  roundId: 'ROUND-1',
  releaseId: 'REL-1',
  productName: '曙光云 Stack',
  version: '8.0.6.2',
  roundNo: 2,
  reportTitle: '曙光云 Stack 8.0.6.2 验证报告',
  manifestSha256,
  reportSha256,
  conclusion: 'PASS'
};

test('Core rejects cross-zone business messages before identity pairing', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-unpaired-'));
  const app = await buildCoreApp({ dataDir, enableAuth: false, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-UNEXPECTED' }) } });
  try {
    assert.equal((await app.gateKeyring.status()).keyConfigured, false);
    assert.equal((await app.gateKeyring.status()).peerTrusted, false);
    const result = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', payload: envelope });
    assert.equal(result.statusCode, 503, result.body);
    assert.equal(result.json().error.code, 'gate_pairing_required');
    assert.deepEqual(app.coreStore.list(), []);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core pairing probe authenticates the paired Edge without requiring a browser session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-pairing-probe-'));
  const app = await buildCoreApp({ dataDir });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/gate/pairing-probe' });
    assert.equal(unauthorized.statusCode, 401);
    const accepted = await app.inject({ method: 'GET', url: '/api/v1/gate/pairing-probe', headers: await signedTestHeaders(app.gateKeyring, 'GET', '/api/v1/gate/pairing-probe') });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.deepEqual(accepted.json(), { role: 'core', peerTrusted: true, keyConfigured: true, businessReady: true, activeKeyId: (await app.gateKeyring.identity()).signingFingerprint, peerFingerprint: (await app.gateKeyring.status()).peerFingerprint });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('cam-core only authorizes transfer after cloud approval is queried and matched', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-'));
  const calls = [];
  let cloudStatus = 'UNKNOWN';
  const cloud = {
    async createApproval(value) { calls.push(['create', value]); return { approvalId: 'APR-1', status: 'PENDING', mappingSnapshot: { priority: { id: '394' } }, requestBody: { priority: '394', workOrderDetail: `审批暗号：${value.approvalCode}`, nested: [{ reply: value.approvalCode.toUpperCase() }] } }; },
    async getApproval(id) { calls.push(['get', id]); return { approvalId: id, status: cloudStatus, workflowStep: cloudStatus === 'UNKNOWN' ? '已结束' : '工单确认', transferTaskId: cloudStatus === 'APPROVED' ? 'TR-1' : undefined, manifestSha256: cloudStatus === 'APPROVED' ? manifestSha256 : undefined, expiresAt: new Date(Date.now() + 60_000).toISOString() }; },
    async closeApproval(id) { calls.push(['close', id]); return { status: 'CLOSED' }; }
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, enableAuth: false });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const headers = (path, payload) => signedTestHeaders(app.gateKeyring, 'POST', path, payload);
  try {
    const received = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers('/api/v1/gate/approval-requests', envelope), payload: envelope });
    assert.equal(received.statusCode, 202, received.body);
    assert.deepEqual(received.json(), { accepted: true, requestId: 'FREEZE-1', idempotent: false });

    const legacyEnvelope = { ...envelope, requestId: 'FREEZE-LEGACY', freezeId: 'FREEZE-LEGACY' };
    delete legacyEnvelope.productName;
    delete legacyEnvelope.version;
    delete legacyEnvelope.roundNo;
    delete legacyEnvelope.reportTitle;
    const legacyReceived = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers('/api/v1/gate/approval-requests', legacyEnvelope), payload: legacyEnvelope });
    assert.equal(legacyReceived.statusCode, 202, legacyReceived.body);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests/FREEZE-LEGACY/sync', payload: {} })).statusCode, 401);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const created = app.coreStore.get('FREEZE-1');
    assert.equal(created.status, 'CLOUD_SUBMITTED');
    assert.equal(created.cloudApprovalId, 'APR-1');
    assert.equal(created.approvalCode, undefined, 'approval code must not be exposed by the Core response object');
    assert.equal(created.approvalCodeConfigured, true);
    const publicRequest = await app.inject({ method: 'GET', url: '/api/v1/approval-requests/FREEZE-1' });
    assert.equal(publicRequest.statusCode, 200);
    assert.equal(publicRequest.json().item.approvalCode, undefined, 'approval code must not be returned to the browser');
    assert.equal(publicRequest.json().item.approvalCodeConfigured, true);
    assert.equal(publicRequest.body.toLowerCase().includes(app.coreStore.approvalCode('FREEZE-1')), false, 'nested request snapshots must not expose the approval code');
    assert.deepEqual(calls[0][0], 'create');
    assert.deepEqual(created.cloudMappingSnapshot, { priority: { id: '394' } });
    assert.deepEqual(created.cloudRequestSnapshot, { priority: '394', workOrderDetail: '审批暗号：[已隐藏]', nested: [{ reply: '[已隐藏]' }] });

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
    const emptyArtifacts = await app.inject({ method: 'GET', url: '/api/v1/artifacts' });
    assert.equal(emptyArtifacts.statusCode, 200);
    assert.deepEqual(emptyArtifacts.json().items, [], 'approval alone does not add a formal artifact record');
    const authorized = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(authorized.statusCode, 200, authorized.body);
    assert.equal(authorized.json().item.transferTaskId, 'TR-1');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/transfer-authorize', payload: { manifestSha256 } })).json().item.idempotent, true);
    const earlyClose = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/close', payload: {} });
    assert.equal(earlyClose.statusCode, 409);
    assert.equal(calls.filter(([kind]) => kind === 'close').length, 0);
    const receiptPayload = { requestId: 'FREEZE-1', transferTaskId: 'TR-1', manifestSha256 };
    const receipt = await app.inject({ method: 'POST', url: '/api/v1/gate/receipts', headers: await headers('/api/v1/gate/receipts', receiptPayload), payload: receiptPayload });
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().item.status, 'RECEIVED');
    const artifacts = await app.inject({ method: 'GET', url: '/api/v1/artifacts' });
    assert.equal(artifacts.statusCode, 200);
    assert.equal(artifacts.json().items.length, 1);
    assert.equal(artifacts.json().items[0].requestId, 'FREEZE-1');
    assert.equal(artifacts.json().items[0].releaseId, 'REL-1');
    assert.equal(artifacts.json().items[0].productName, '曙光云 Stack');
    assert.equal(artifacts.json().items[0].version, '8.0.6.2');
    assert.equal(artifacts.json().items[0].revision, 0);
    assert.equal(artifacts.json().items[0].displayVersion, '8.0.6.2');
    assert.equal('roundNo' in artifacts.json().items[0], false, 'formal artifact records do not expose Edge collection rounds');
    assert.equal(artifacts.json().items[0].transferTaskId, 'TR-1');
    assert.equal(artifacts.json().items[0].manifestSha256, manifestSha256);
    assert.ok(artifacts.json().items[0].receivedAt);
    const artifactDetail = await app.inject({ method: 'GET', url: '/api/v1/artifacts/BASELINE-FREEZE-1' });
    assert.equal(artifactDetail.statusCode, 200, artifactDetail.body);
    assert.equal(artifactDetail.json().item.artifactId, 'BASELINE-FREEZE-1');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/artifacts/BASELINE-NOT-FOUND' })).statusCode, 404);

    const replay = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers('/api/v1/gate/approval-requests', envelope), payload: envelope });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().idempotent, true);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 2, 'each accepted request gets its own cloud work order; replaying the first is idempotent');

    const closed = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/close', payload: { reason: 'imported' } });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().item.status, 'CLOSED');
    assert.deepEqual(calls.at(-1), ['close', 'APR-1']);
    const idempotentClose = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/close', payload: {} });
    assert.equal(idempotentClose.statusCode, 200, idempotentClose.body);
    assert.equal(idempotentClose.json().item.status, 'CLOSED');
    assert.deepEqual(calls.at(-1), ['close', 'APR-1'], 'a closed request does not call the cloud again');
    const manifestAfterClose = await app.inject({ method: 'GET', url: '/api/v1/gate/transfers/TR-1/manifest', headers: await signedTestHeaders(app.gateKeyring, 'GET', '/api/v1/gate/transfers/TR-1/manifest') });
    assert.equal(manifestAfterClose.statusCode, 200, manifestAfterClose.body);
    const receiptAfterClose = await app.inject({ method: 'POST', url: '/api/v1/gate/receipts', headers: await headers('/api/v1/gate/receipts', receiptPayload), payload: receiptPayload });
    assert.equal(receiptAfterClose.statusCode, 200, receiptAfterClose.body);
    assert.equal(receiptAfterClose.json().item.status, 'RECEIVED');
    const syncAfterClose = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/sync', payload: {} });
    assert.equal(syncAfterClose.json().item.status, 'CLOSED');
    assert.equal(calls.filter(([kind]) => kind === 'get').length, 2, 'the cloud approval is queried only when explicitly synchronized');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Core can withdraw an unapproved request locally without calling Cloud', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-withdraw-'));
  const calls = [];
  const app = await buildCoreApp({
    dataDir,
    enableAuth: false,
    cloudAdapter: {
      async createApproval() { calls.push('create'); return { approvalId: 'APR-WITHDRAW', status: 'PENDING' }; },
      async getApproval() { calls.push('get'); return { approvalId: 'APR-WITHDRAW', status: 'PENDING' }; }
    }
  });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  try {
    app.coreStore.receiveApproval({ ...envelope, requestId: 'FREEZE-WITHDRAW', freezeId: 'FREEZE-WITHDRAW' });
    const withdrawn = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-WITHDRAW/withdraw', payload: {} });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    assert.equal(withdrawn.json().item.status, 'WITHDRAWN');
    assert.equal(withdrawn.json().item.withdrawnAt !== null, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-WITHDRAW/withdraw', payload: {} })).json().item.status, 'WITHDRAWN');
    const retry = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-WITHDRAW/retry', payload: {} });
    assert.equal(retry.statusCode, 409);
    app.coreStore.applyCloudStatus('FREEZE-WITHDRAW', { status: 'PENDING' });
    assert.equal(app.coreStore.get('FREEZE-WITHDRAW').status, 'WITHDRAWN');
    app.coreStore.receiveApproval({ ...envelope, requestId: 'FREEZE-WITHDRAW-SUBMITTED', freezeId: 'FREEZE-WITHDRAW-SUBMITTED' });
    app.coreStore.markCloudSubmitted('FREEZE-WITHDRAW-SUBMITTED', { approvalId: 'APR-ALREADY-SUBMITTED', status: 'PENDING' });
    const submittedWithdrawn = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-WITHDRAW-SUBMITTED/withdraw', payload: {} });
    assert.equal(submittedWithdrawn.statusCode, 200, submittedWithdrawn.body);
    assert.equal(submittedWithdrawn.json().item.status, 'WITHDRAWN');
    assert.equal(submittedWithdrawn.json().item.cloudApprovalId, 'APR-ALREADY-SUBMITTED');
    const sync = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-WITHDRAW-SUBMITTED/sync', payload: {} });
    assert.equal(sync.statusCode, 200);
    assert.equal(sync.json().item.status, 'WITHDRAWN');
    assert.deepEqual(calls, []);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core automatically closes a rejected Cloud work order', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-rejected-close-'));
  const calls = [];
  const app = await buildCoreApp({
    dataDir,
    enableAuth: false,
    cloudAdapter: {
      async getApproval(approvalId) { calls.push({ approvalId, action: 'get' }); return { approvalId, status: 'REJECTED', workflowStep: '工单确认', cloudResponseSummary: '挺好的' }; },
      async closeApproval(approvalId, body) { calls.push({ approvalId, body }); return { status: 'CLOSED' }; }
    }
  });
  try {
    app.coreStore.receiveApproval({ ...envelope, requestId: 'FREEZE-REJECTED', freezeId: 'FREEZE-REJECTED' });
    app.coreStore.markCloudSubmitted('FREEZE-REJECTED', { approvalId: 'APR-REJECTED', status: 'PENDING' });
    app.coreStore.applyCloudStatus('FREEZE-REJECTED', { approvalId: 'APR-REJECTED', status: 'REJECTED', workflowStep: '工单确认', cloudResponseSummary: '旧摘要' });
    const synced = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-REJECTED/sync', payload: {} });
    assert.equal(synced.statusCode, 200, synced.body);
    assert.equal(synced.json().item.status, 'REJECTED');
    assert.equal(synced.json().item.cloudResponseSummary, '挺好的');
    assert.equal(synced.json().item.closeStatus, 'CLOSED');
    assert.deepEqual(calls, [
      { approvalId: 'APR-REJECTED', action: 'get' },
      { approvalId: 'APR-REJECTED', body: { reason: '审批未通过，Core 已自动关闭云管工单。' } }
    ]);
    const repeated = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-REJECTED/sync', payload: {} });
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(calls.filter((call) => call.body?.reason === '审批未通过，Core 已自动关闭云管工单。').length, 1, 'a rejected work order is closed only once');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core notifies Edge when an approval request is withdrawn', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-withdraw-callback-'));
  const callbacks = [];
  const app = await buildCoreApp({
    dataDir,
    enableAuth: false,
    cloudAdapter: { async createApproval() { return { approvalId: 'APR-WITHDRAW-CALLBACK', status: 'PENDING' }; } },
    fetchImpl: async (url, options) => {
      callbacks.push({ url, payload: JSON.parse(options.body) });
      return Response.json({ accepted: true, requestId: 'FREEZE-WITHDRAW-CALLBACK', eventId: callbacks.at(-1).payload.eventId });
    },
    approvalResultRetryBaseMs: 5,
    workerIntervalMs: 10
  });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  app.gateConfigStore.save({ edgeControlUrl: 'http://edge-map:3101', edgeTransferUrl: 'http://edge-map:3101' }, 'test');
  try {
    app.coreStore.receiveApproval({ ...envelope, requestId: 'FREEZE-WITHDRAW-CALLBACK', freezeId: 'FREEZE-WITHDRAW-CALLBACK' });
    const withdrawn = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-WITHDRAW-CALLBACK/withdraw', payload: {} });
    assert.equal(withdrawn.statusCode, 200, withdrawn.body);
    for (let i = 0; i < 100 && callbacks.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0].url, 'http://edge-map:3101/api/v1/gate/approval-results');
    assert.deepEqual({ requestId: callbacks[0].payload.requestId, freezeId: callbacks[0].payload.freezeId, status: callbacks[0].payload.status }, { requestId: 'FREEZE-WITHDRAW-CALLBACK', freezeId: 'FREEZE-WITHDRAW-CALLBACK', status: 'WITHDRAWN' });
    assert.equal(app.coreStore.listPendingApprovalResults().length, 0);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('gate approval messages require the configured exchange identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-auth-'));
  const app = await buildCoreApp({ dataDir, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) }, enableAuth: false });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', payload: envelope });
    assert.equal(response.statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core accepts Edge transfer failure reports without a browser session', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-transfer-failure-auth-'));
  const app = await buildCoreApp({ dataDir, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) } });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const payload = {
    requestId: 'FREEZE-MISSING', freezeId: 'FREEZE-MISSING', transferTaskId: 'TR-MISSING',
    manifestSha256: manifestSha256, attempt: 1, code: 'ENOSPC', message: '磁盘空间不足', terminal: true
  };
  try {
    const path = '/api/v1/gate/transfer-failures';
    const response = await app.inject({ method: 'POST', url: path, headers: await signedTestHeaders(app.gateKeyring, 'POST', path, payload), payload });
    assert.equal(response.statusCode, 404, response.body);
    assert.equal(response.json().error.code, 'request_not_found');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core sends a signed Edge transfer recovery instruction and supports terminal fallback recovery', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-transfer-retry-'));
  const calls = [];
  const app = await buildCoreApp({
    dataDir,
    enableAuth: false,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, payload: JSON.parse(options.body) });
      return Response.json({ accepted: true, requestId: 'FREEZE-TRANSFER-RETRY', transferTaskId: 'TR-TRANSFER-RETRY', status: 'QUEUED', idempotent: false }, { status: 202 });
    }
  });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  app.gateConfigStore.save({ edgeControlUrl: 'http://edge-map:3101', edgeTransferUrl: 'http://edge-map:3101' }, 'test');
  try {
    const requestId = 'FREEZE-TRANSFER-RETRY';
    app.coreStore.receiveApproval({ ...envelope, requestId, freezeId: requestId });
    app.coreStore.applyCloudStatus(requestId, { approvalId: 'APR-TRANSFER-RETRY', status: 'APPROVED', transferTaskId: 'TR-TRANSFER-RETRY', manifestSha256 });
    app.coreStore.authorizeTransfer(requestId, { manifestSha256, transferTaskId: 'TR-TRANSFER-RETRY' });
    app.coreStore.recordEdgeTransferFailure({ requestId, freezeId: requestId, transferTaskId: 'TR-TRANSFER-RETRY', manifestSha256, attempt: 5, code: 'ENOSPC', message: '磁盘空间不足', terminal: true });
    app.coreStore.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'FAILED', edge_failure_terminal = 1, edge_recovery_attempts = 5 WHERE transfer_task_id = ?").run('TR-TRANSFER-RETRY');
    const response = await app.inject({ method: 'POST', url: `/api/v1/approval-requests/${requestId}/transfer/recover`, payload: { fallback: true } });
    assert.equal(response.statusCode, 202, response.body);
    assert.equal(response.json().edgeStatus, 'QUEUED');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://edge-map:3101/api/v1/gate/transfer-retry');
    assert.equal(typeof calls[0].options.headers['x-cam-gate-signature'], 'string');
    assert.deepEqual(calls[0].payload, { requestId, freezeId: requestId, transferTaskId: 'TR-TRANSFER-RETRY', manifestSha256 });
    assert.equal(app.coreStore.get(requestId).transferEdgeStatus, 'ACCEPTED', 'an accepted manual retry waits for Edge to report that transfer started');
    assert.equal(app.coreStore.get(requestId).transferEdgeAttempts, 5, 'fallback recovery preserves the Edge attempt history');
    assert.equal(app.coreStore.get(requestId).transferEdgeLastError, '磁盘空间不足', 'fallback recovery preserves the historical Edge error');
    app.coreStore.recordEdgeTransferFailure({ requestId, freezeId: requestId, transferTaskId: 'TR-TRANSFER-RETRY', manifestSha256, attempt: 6, code: 'ETIMEDOUT', message: '新的传输超时', retryAt: new Date(Date.now() + 60_000).toISOString(), terminal: false });
    assert.equal(app.coreStore.get(requestId).transferEdgeStatus, 'RETRY_WAIT', 'the first failure of a fallback recovery window is accepted');
    assert.equal(app.coreStore.get(requestId).transferEdgeAttempts, 6);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core polls cloud approval status and reliably pushes only the decision to Edge', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-decision-callback-'));
  const callbacks = [];
  let failFirstCallback = true;
  let cloudStatus = 'PENDING';
  const cloud = {
    async createApproval() { return { approvalId: 'APR-CALLBACK', status: 'PENDING' }; },
    async getApproval(approvalId) { return { approvalId, status: cloudStatus, workflowStep: cloudStatus, transferTaskId: cloudStatus === 'APPROVED' ? 'TR-CALLBACK' : undefined, manifestSha256: cloudStatus === 'APPROVED' ? manifestSha256 : undefined }; }
  };
  const fetchImpl = async (url, options) => {
    callbacks.push({ url, options, payload: JSON.parse(options.body) });
    if (failFirstCallback) { failFirstCallback = false; return new Response('{}', { status: 503 }); }
    return Response.json({ accepted: true, requestId: 'FREEZE-CALLBACK', eventId: callbacks.at(-1).payload.eventId, idempotent: false });
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, enableAuth: false, fetchImpl, approvalResultRetryBaseMs: 5, workerIntervalMs: 10 });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  app.gateConfigStore.save({ edgeControlUrl: 'http://edge-map:3101', edgeTransferUrl: 'http://edge-map:3101' }, 'test');
  const headers = (payload) => signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-requests', payload);
  try {
    const acceptedPayload = { ...envelope, requestId: 'FREEZE-CALLBACK', freezeId: 'FREEZE-CALLBACK' };
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers(acceptedPayload), payload: acceptedPayload });
    assert.equal(accepted.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cloudStatus = 'APPROVED';
    const synced = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-CALLBACK/sync', payload: {} });
    assert.equal(synced.statusCode, 200, synced.body);
    for (let i = 0; i < 100 && callbacks.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(callbacks.length, 2, 'Core retains and retries the decision callback after a temporary Edge failure');
    assert.equal(callbacks[0].url, 'http://edge-map:3101/api/v1/gate/approval-results');
    assert.equal(typeof callbacks[0].options.headers['x-cam-gate-signature'], 'string');
    assert.deepEqual({ requestId: callbacks[0].payload.requestId, freezeId: callbacks[0].payload.freezeId, status: callbacks[0].payload.status }, { requestId: 'FREEZE-CALLBACK', freezeId: 'FREEZE-CALLBACK', status: 'APPROVED' });
    assert.equal('cloudApprovalId' in callbacks[0].payload, false);
    assert.equal(callbacks[1].payload.eventId, callbacks[0].payload.eventId, 'retries reuse the same idempotency key');
    assert.equal(app.coreStore.listPendingApprovalResults().length, 0);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core acknowledges an approval before a slow cloud work-order create finishes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-async-create-'));
  let finishCreate;
  const cloud = { createApproval: () => new Promise((resolve) => { finishCreate = resolve; }) };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, enableAuth: false });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const headers = (payload) => signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-requests', payload);
  try {
    const payload = { ...envelope, requestId: 'FREEZE-SLOW', freezeId: 'FREEZE-SLOW' };
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers(payload), payload });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().accepted, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishCreate({ approvalId: 'APR-SLOW', status: 'PENDING' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(app.coreStore.get('FREEZE-SLOW').cloudApprovalId, 'APR-SLOW');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core retries a failed cloud work-order submission from its own background worker', async () => {
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
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, enableAuth: false, cloudRetryDelayMs: 300, workerIntervalMs: 10 });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const headers = (payload) => signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-requests', payload);
  const payload = { schemaVersion: 1, type: 'VERIFICATION_APPROVAL_REQUEST', requestId: 'FREEZE-RETRY', freezeId: 'FREEZE-RETRY', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), reportFileName: 'report.pdf', conclusion: 'PASS' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers(payload), payload });
    assert.equal(accepted.statusCode, 202);
    assert.equal(accepted.json().accepted, true);
    for (let i = 0; i < 100 && app.coreStore.get('FREEZE-RETRY').cloudSubmissionState !== 'RETRY_WAIT'; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const waitingRetry = app.coreStore.get('FREEZE-RETRY');
    assert.equal(waitingRetry.lastError, 'temporary cloud outage');
    assert.equal(waitingRetry.cloudSubmissionAttempts, 1);
    assert.equal(waitingRetry.cloudSubmissionState, 'RETRY_WAIT');
    assert.ok(Date.parse(waitingRetry.cloudRetryAt) > Date.now());
    assert.deepEqual(app.coreStore.listCloudPending(), [], 'automatic retry waits until the persisted retry time');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(app.coreStore.get('FREEZE-RETRY').cloudApprovalId, 'APR-RETRY');
    assert.equal(app.coreStore.get('FREEZE-RETRY').cloudSubmissionAttempts, 2);
    assert.equal(app.coreStore.get('FREEZE-RETRY').cloudSubmissionState, 'SUBMITTED');
    assert.equal(app.coreStore.get('FREEZE-RETRY').cloudRetryAt, null);
    assert.equal(createAttempts, 2);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core receives and verifies the PDF before uploading it and creating the cloud work order', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-report-'));
  const pdf = Buffer.from('%PDF-1.7\nverification report');
  const pdfSha = (await import('node:crypto')).createHash('sha256').update(pdf).digest('hex');
  let uploaded; let created;
  const cloud = {
    async uploadApprovalReport(input) { uploaded = input; return '2026/10/report.pdf'; },
    async createApproval(value) { created = value; return { approvalId: 'APR-WITH-REPORT', status: 'PENDING' }; }
  };
  const fetchImpl = async (_url, options) => {
    assert.equal(typeof options.headers['x-cam-gate-signature'], 'string');
    return new Response(pdf, { status: 206, headers: { 'content-type': 'application/pdf', 'content-range': `bytes 0-${pdf.length - 1}/${pdf.length}`, 'x-report-sha256': pdfSha } });
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, enableAuth: false, fetchImpl });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  app.gateConfigStore.save({ edgeControlUrl: 'http://edge-control', edgeTransferUrl: 'http://edge-transfer' }, 'test');
  const headers = (payload) => signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-requests', payload);
  try {
    const payload = { ...envelope, requestId: 'FREEZE-REPORT', freezeId: 'FREEZE-REPORT', reportSha256: pdfSha, reportFileName: 'verification.pdf', reportSize: pdf.length };
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers(payload), payload });
    assert.equal(accepted.statusCode, 202, accepted.body);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const item = app.coreStore.get('FREEZE-REPORT');
    assert.equal(item.reportReceived, true);
    assert.equal(item.reportReceivedSha256, pdfSha);
    assert.equal(item.cloudAttachmentId, '2026/10/report.pdf');
    assert.equal(uploaded.fileName, 'verification.pdf');
    assert.equal(uploaded.sha256, pdfSha);
    assert.equal(created.cloudAttachmentId, '2026/10/report.pdf');
    assert.equal(item.cloudApprovalId, 'APR-WITH-REPORT');

    const textReport = Buffer.from('validation report in markdown');
    const textSha = (await import('node:crypto')).createHash('sha256').update(textReport).digest('hex');
    app.coreStore.receiveApproval({ ...envelope, requestId: 'FREEZE-REPORT-MD', freezeId: 'FREEZE-REPORT-MD', reportSha256: textSha, reportFileName: 'verification.md', reportSize: textReport.length });
    const textItem = await app.coreStore.saveReport('FREEZE-REPORT-MD', textReport);
    assert.equal(textItem.reportReceived, true);
    assert.equal(textItem.reportReceivedSha256, textSha);
    assert.match(app.coreStore.reportPath('FREEZE-REPORT-MD'), /FREEZE-REPORT-MD\.md$/u);
    const downloadedText = await app.inject({ url: '/api/v1/approval-requests/FREEZE-REPORT-MD/report-file' });
    assert.equal(downloadedText.statusCode, 200);
    assert.match(downloadedText.headers['content-type'], /^text\/markdown/u);
    assert.equal(downloadedText.body, textReport.toString());
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core stores approved files by SHA-256 and lets multiple package entries share one object', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-artifacts-'));
  const bytes = Buffer.from('shared operating system image');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { schemaVersion: 1, items: [
    { packageKey: 'os-iso', candidateId: 'CAND-1', fileName: 'linux.iso', sizeBytes: bytes.length, actualSha256: sha256, source: 'OWNED' },
    { packageKey: 'base-image', candidateId: 'CAND-2', fileName: 'base.iso', sizeBytes: bytes.length, actualSha256: sha256, source: 'INHERITED' }
  ] };
  const manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const cloud = {
    async createApproval() { return { approvalId: 'APR-FILES', status: 'PENDING' }; },
    async getApproval(approvalId) { return { approvalId, status: 'APPROVED', transferTaskId: 'TR-FILES', manifestSha256 }; }
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, enableAuth: false });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const headers = (method, path, payload, extra) => signedTestHeaders(app.gateKeyring, method, path, payload, extra);
  const request = { ...envelope, requestId: 'FREEZE-FILES', freezeId: 'FREEZE-FILES', manifestSha256 };
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await headers('POST', '/api/v1/gate/approval-requests', request), payload: request })).statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-FILES/sync', payload: {} });
    const authorize = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-FILES/transfer-authorize', payload: { manifestSha256 } });
    assert.equal(authorize.statusCode, 200, authorize.body);
    const transferTaskId = authorize.json().item.transferTaskId;
    const manifestPayload = { manifest };
    const manifestPath = `/api/v1/gate/transfers/${transferTaskId}/manifest`;
    const registeredManifest = await app.inject({ method: 'POST', url: manifestPath, headers: await headers('POST', manifestPath, manifestPayload), payload: manifestPayload });
    assert.equal(registeredManifest.statusCode, 200, registeredManifest.body);
    assert.equal(registeredManifest.json().item.fileCount, 2);
    assert.equal(app.coreStore.get('FREEZE-FILES').artifacts.length, 2, 'legacy request gets release artifact references when Edge synchronizes its manifest');
    const failurePayload = { requestId: 'FREEZE-FILES', freezeId: 'FREEZE-FILES', transferTaskId, manifestSha256, attempt: 1, code: 'ENOSPC', message: 'ENOSPC: no space left on device, write', retryAt: new Date(Date.now() + 60_000).toISOString(), terminal: false };
    const failurePath = '/api/v1/gate/transfer-failures';
    const failureReport = await app.inject({ method: 'POST', url: failurePath, headers: await headers('POST', failurePath, failurePayload), payload: failurePayload });
    assert.equal(failureReport.statusCode, 200, failureReport.body);
    const failedProgress = await app.inject({ method: 'GET', url: '/api/v1/approval-requests/FREEZE-FILES/transfer-progress' });
    assert.equal(failedProgress.json().item.status, 'RETRY_WAIT');
    assert.equal(failedProgress.json().item.edgeFailure.code, 'ENOSPC');
    assert.match(failedProgress.json().item.edgeFailure.message, /no space left/u);
    const waitingProgress = await app.inject({ method: 'GET', url: '/api/v1/approval-requests/FREEZE-FILES/transfer-progress' });
    assert.equal(waitingProgress.statusCode, 200, waitingProgress.body);
    assert.equal(waitingProgress.json().item.status, 'RETRY_WAIT');
    assert.equal(waitingProgress.json().item.summary.completedFiles, 0);
    const fetchedManifest = await app.inject({ method: 'GET', url: manifestPath, headers: await headers('GET', manifestPath) });
    assert.equal(fetchedManifest.statusCode, 200, fetchedManifest.body);
    assert.deepEqual(fetchedManifest.json().items.map((item) => item.receivedParts), [[], []]);
    const uploadPath = `/api/v1/gate/transfers/${transferTaskId}/artifacts/${sha256}`;
    const upload = await app.inject({ method: 'PUT', url: uploadPath, headers: await headers('PUT', uploadPath, bytes, { 'content-type': 'application/octet-stream' }), payload: bytes });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.deepEqual(upload.json().packages, ['os-iso', 'base-image']);
    const receivedProgress = await app.inject({ method: 'GET', url: '/api/v1/approval-requests/FREEZE-FILES/transfer-progress' });
    assert.equal(receivedProgress.json().item.status, 'VERIFYING');
    assert.equal(receivedProgress.json().item.summary.completedFiles, 2, 'duplicate SHA-256 references both show complete');
    assert.equal(receivedProgress.json().item.files.filter((file) => file.reused).length, 1, 'the second package reference identifies the shared object as reusable');
    const receiptPayload = { requestId: 'FREEZE-FILES', transferTaskId, manifestSha256 };
    const prematureReceipt = await app.inject({ method: 'POST', url: '/api/v1/gate/receipts', headers: await headers('POST', '/api/v1/gate/receipts', receiptPayload), payload: receiptPayload });
    assert.equal(prematureReceipt.statusCode, 200, prematureReceipt.body);
    const artifacts = (await app.inject({ method: 'GET', url: '/api/v1/artifacts' })).json().items;
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].files.length, 2);
    assert.ok(artifacts[0].files.every((file) => file.stored && file.sha256 === sha256));
    assert.ok(artifacts[0].files.every((file) => file.downloadUrl === `/api/v1/artifacts/${sha256}/content`));
    assert.equal('roundNo' in artifacts[0], false);
    assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/artifacts/${artifacts[0].artifactId}` })).json().item, artifacts[0]);
    const download = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${sha256}/content` });
    assert.equal(download.statusCode, 200);
    assert.deepEqual(download.rawPayload, bytes);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core distinguishes complete chunks waiting for assembly from an active receive', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-transfer-progress-'));
  const bytes = Buffer.from('chunked artifact');
  const first = bytes.subarray(0, 8);
  const second = bytes.subarray(8);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { schemaVersion: 1, items: [{ packageKey: 'chunked', candidateId: 'CAND-CHUNKED', fileName: 'chunked.bin', sizeBytes: bytes.length, actualSha256: sha256, source: 'OWNED' }] };
  const manifestSha256 = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const app = await buildCoreApp({ dataDir, enableAuth: false });
  const requestId = 'FREEZE-CHUNKED';
  try {
    app.coreStore.receiveApproval({ ...envelope, requestId, freezeId: requestId, manifestSha256, manifest });
    app.coreStore.applyCloudStatus(requestId, { approvalId: 'APR-CHUNKED', status: 'APPROVED', transferTaskId: 'TR-CHUNKED', manifestSha256 });
    app.coreStore.authorizeTransfer(requestId, { manifestSha256, transferTaskId: 'TR-CHUNKED' });
    await writeFile(join(dataDir, 'chunk-0'), first);
    await writeFile(join(dataDir, 'chunk-1'), second);
    await app.coreStore.saveTransferPart('TR-CHUNKED', sha256, { index: 0, chunkSize: 8, chunkCount: 2, offset: 0, size: first.length, sha256: createHash('sha256').update(first).digest('hex'), temporaryPath: join(dataDir, 'chunk-0') });
    await app.coreStore.saveTransferPart('TR-CHUNKED', sha256, { index: 1, chunkSize: 8, chunkCount: 2, offset: 8, size: second.length, sha256: createHash('sha256').update(second).digest('hex'), temporaryPath: join(dataDir, 'chunk-1') });
    const progress = app.coreStore.getTransferProgress(requestId);
    assert.equal(progress.files[0].status, 'ASSEMBLY_PENDING');
    assert.equal(progress.files[0].receivedParts, 2);
    assert.equal(progress.files[0].chunkCount, 2);
    assert.equal(progress.summary.assemblingFiles, 1);
    assert.equal(progress.summary.receivingFiles, 0);
    assert.equal(progress.summary.percent, 0, 'complete chunks are not shown as stored before assembly');
    assert.equal(progress.summary.storedBytes, 0);
    const reconciled = await app.coreStore.reconcileTransferParts('TR-CHUNKED');
    assert.deepEqual(reconciled.errors, []);
    assert.deepEqual(reconciled.assembled, [sha256]);
    assert.equal(app.coreStore.getTransferProgress(requestId).files[0].status, 'COMPLETED');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core watches Edge start and idle deadlines, coordinates recovery, and stops at its retry limit', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-edge-watchdog-'));
  const app = await buildCoreApp({ dataDir, enableAuth: false });
  const requestId = 'FREEZE-EDGE-WATCHDOG';
  const transferTaskId = 'TR-EDGE-WATCHDOG';
  const status = (state, attempt, extra = {}) => app.coreStore.recordEdgeTransferStatus({
    requestId, freezeId: requestId, transferTaskId, manifestSha256, state, attempt, ...extra
  }, { transferStartTimeoutMs: 60_000, transferIdleTimeoutMs: 60_000 });
  const expireAt = () => app.coreStore.db.prepare("UPDATE core_transfer_tasks SET edge_start_deadline_at = ?, edge_idle_deadline_at = ? WHERE transfer_task_id = ?")
    .run('1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z', transferTaskId);
  const makeRecoveryDue = () => app.coreStore.db.prepare("UPDATE core_transfer_tasks SET edge_retry_at = ? WHERE transfer_task_id = ?")
    .run('1970-01-01T00:00:00.000Z', transferTaskId);
  try {
    app.coreStore.receiveApproval({ ...envelope, requestId, freezeId: requestId });
    app.coreStore.applyCloudStatus(requestId, { approvalId: 'APR-EDGE-WATCHDOG', status: 'APPROVED', transferTaskId, manifestSha256 });
    app.coreStore.authorizeTransfer(requestId, { manifestSha256, transferTaskId });
    const delivery = app.coreStore.enqueueTransferReady(requestId);

    status('ACCEPTED', 0);
    assert.ok(app.coreStore.get(requestId).transferEdgeStartDeadlineAt, 'acceptance starts the Edge-start watchdog');
    status('STARTED', 0);
    const started = app.coreStore.get(requestId);
    assert.equal(started.transferEdgeStatus, 'STARTED');
    assert.equal(started.transferEdgeStartDeadlineAt, null);
    assert.ok(started.transferEdgeIdleDeadlineAt, 'started transfer changes to the idle watchdog');

    app.coreStore.db.prepare("UPDATE core_transfer_tasks SET edge_idle_deadline_at = '1970-01-01T00:00:00.000Z' WHERE transfer_task_id = ?").run(transferTaskId);
    status('HEARTBEAT', 0);
    const heartbeat = app.coreStore.get(requestId);
    assert.equal(heartbeat.transferEdgeStatus, 'STARTED', 'a heartbeat does not pretend that a chunk completed');
    assert.ok(Date.parse(heartbeat.transferEdgeIdleDeadlineAt) > Date.now(), 'a heartbeat extends the idle watchdog');

    // The delayed HTTP acknowledgement must not regress an already-started
    // transfer back into the start watchdog state.
    app.coreStore.markTransferDelivered(delivery.event_id, { transferStartTimeoutMs: 60_000 });
    assert.equal(app.coreStore.get(requestId).transferEdgeStatus, 'STARTED');

    expireAt();
    assert.equal(app.coreStore.expireEdgeTransferTimeouts({ retryLimit: 2 }), 1);
    let current = app.coreStore.get(requestId);
    assert.equal(current.transferEdgeStatus, 'RETRY_WAIT');
    assert.equal(current.transferEdgeErrorCode, 'edge_idle_timeout');
    assert.equal(current.transferEdgeRecoveryAttempts, 1);

    makeRecoveryDue();
    let recovery = app.coreStore.claimDueEdgeRecoveries();
    assert.equal(recovery.length, 1);
    app.coreStore.markEdgeRecoveryDispatchResult(transferTaskId, { ok: true, edgeState: 'QUEUED', transferStartTimeoutMs: 60_000, transferIdleTimeoutMs: 60_000, retryLimit: 2 });
    current = app.coreStore.get(requestId);
    assert.equal(current.transferEdgeStatus, 'ACCEPTED');
    assert.equal(current.transferEdgeRecoveryAttempts, 1, 'control acknowledgement alone does not reset the recovery counter');

    status('PROGRESS', 1);
    current = app.coreStore.get(requestId);
    assert.equal(current.transferEdgeStatus, 'RECEIVING');
    assert.equal(current.transferEdgeRecoveryAttempts, 0, 'only data-plane progress resets recovery accounting');

    expireAt();
    assert.equal(app.coreStore.expireEdgeTransferTimeouts({ retryLimit: 2 }), 1);
    makeRecoveryDue();
    recovery = app.coreStore.claimDueEdgeRecoveries();
    assert.equal(recovery.length, 1);
    app.coreStore.markEdgeRecoveryDispatchResult(transferTaskId, { ok: true, edgeState: 'QUEUED', transferStartTimeoutMs: 60_000, transferIdleTimeoutMs: 60_000, retryLimit: 2 });

    expireAt();
    assert.equal(app.coreStore.expireEdgeTransferTimeouts({ retryLimit: 2 }), 1);
    current = app.coreStore.get(requestId);
    assert.equal(current.transferEdgeStatus, 'FAILED');
    assert.equal(current.transferEdgeFailureTerminal, true);
    assert.equal(current.transferEdgeRecoveryAttempts, 2);
    assert.equal(current.transferEdgeErrorCode, 'edge_start_timeout');
    status('PROGRESS', 2);
    assert.equal(app.coreStore.get(requestId).transferEdgeStatus, 'FAILED', 'a late Edge progress report cannot revive a terminal failure');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
