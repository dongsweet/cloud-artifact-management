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
  productName: '曙光云 Stack',
  version: '8.0.6.2',
  roundNo: 2,
  reportTitle: '曙光云 Stack 8.0.6.2 验证报告',
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
    assert.deepEqual(received.json(), { accepted: true, requestId: 'FREEZE-1', idempotent: false });

    const legacyEnvelope = { ...envelope, requestId: 'FREEZE-LEGACY', freezeId: 'FREEZE-LEGACY' };
    delete legacyEnvelope.productName;
    delete legacyEnvelope.version;
    delete legacyEnvelope.roundNo;
    delete legacyEnvelope.reportTitle;
    const legacyReceived = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: legacyEnvelope });
    assert.equal(legacyReceived.statusCode, 202, legacyReceived.body);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests/FREEZE-LEGACY/sync', headers, payload: {} })).statusCode, 404);

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
    const receipt = await app.inject({ method: 'POST', url: '/api/v1/gate/receipts', headers, payload: { requestId: 'FREEZE-1', transferTaskId: 'TR-1', manifestSha256 } });
    assert.equal(receipt.statusCode, 200, receipt.body);
    assert.equal(receipt.json().item.status, 'RECEIVED');
    const artifacts = await app.inject({ method: 'GET', url: '/api/v1/artifacts' });
    assert.equal(artifacts.statusCode, 200);
    assert.equal(artifacts.json().items.length, 1);
    assert.equal(artifacts.json().items[0].requestId, 'FREEZE-1');
    assert.equal(artifacts.json().items[0].releaseId, 'REL-1');
    assert.equal(artifacts.json().items[0].productName, '曙光云 Stack');
    assert.equal(artifacts.json().items[0].version, '8.0.6.2');
    assert.equal(artifacts.json().items[0].roundNo, 2);
    assert.equal(artifacts.json().items[0].transferTaskId, 'TR-1');
    assert.equal(artifacts.json().items[0].manifestSha256, manifestSha256);
    assert.ok(artifacts.json().items[0].receivedAt);

    const replay = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: envelope });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().idempotent, true);
    assert.equal(calls.filter(([kind]) => kind === 'create').length, 2, 'each accepted request gets its own cloud work order; replaying the first is idempotent');

    const closed = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/close', payload: { reason: 'imported' } });
    assert.equal(closed.statusCode, 200, closed.body);
    assert.equal(closed.json().item.status, 'CLOSED');
    assert.deepEqual(calls.at(-1), ['close', 'APR-1']);
    const syncAfterClose = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-1/sync', payload: {} });
    assert.equal(syncAfterClose.json().item.status, 'CLOSED');
    assert.equal(calls.filter(([kind]) => kind === 'get').length, 2, 'the cloud approval is queried only when explicitly synchronized');
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
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false, fetchImpl, approvalResultRetryBaseMs: 5, workerIntervalMs: 10 });
  app.gateConfigStore.save({ edgeControlUrl: 'http://edge-map:3101', edgeTransferUrl: 'http://edge-map:3101' }, 'test');
  const headers = { 'x-cam-gate-secret': Buffer.from('gate-test').toString('base64url') };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: { ...envelope, requestId: 'FREEZE-CALLBACK', freezeId: 'FREEZE-CALLBACK' } });
    assert.equal(accepted.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    cloudStatus = 'APPROVED';
    const synced = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-CALLBACK/sync', payload: {} });
    assert.equal(synced.statusCode, 200, synced.body);
    for (let i = 0; i < 100 && callbacks.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(callbacks.length, 2, 'Core retains and retries the decision callback after a temporary Edge failure');
    assert.equal(callbacks[0].url, 'http://edge-map:3101/api/v1/gate/approval-results');
    assert.equal(callbacks[0].options.headers['x-cam-gate-secret'], Buffer.from('gate-test').toString('base64url'));
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
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false });
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: { ...envelope, requestId: 'FREEZE-SLOW', freezeId: 'FREEZE-SLOW' } });
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
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false, cloudRetryDelayMs: 300, workerIntervalMs: 10 });
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  const payload = { schemaVersion: 1, type: 'VERIFICATION_APPROVAL_REQUEST', requestId: 'FREEZE-RETRY', freezeId: 'FREEZE-RETRY', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), reportFileName: 'report.pdf', conclusion: 'PASS' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload });
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
    assert.equal(options.headers['x-cam-gate-secret'], Buffer.from('gate-test').toString('base64url'));
    return new Response(pdf, { status: 206, headers: { 'content-type': 'application/pdf', 'content-range': `bytes 0-${pdf.length - 1}/${pdf.length}`, 'x-report-sha256': pdfSha } });
  };
  const app = await buildCoreApp({ dataDir, cloudAdapter: cloud, gateSecret: 'gate-test', enableAuth: false, fetchImpl });
  app.gateConfigStore.save({ edgeControlUrl: 'http://edge-control', edgeTransferUrl: 'http://edge-transfer' }, 'test');
  const headers = { 'x-cam-gate-secret': 'gate-test' };
  try {
    const accepted = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers, payload: { ...envelope, requestId: 'FREEZE-REPORT', freezeId: 'FREEZE-REPORT', reportSha256: pdfSha, reportFileName: 'verification.pdf', reportSize: pdf.length } });
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
