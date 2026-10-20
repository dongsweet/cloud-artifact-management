import assert from 'node:assert/strict';
import test from 'node:test';
import { createApprovalDispatcher } from '../src/approval-dispatcher.js';

function fixture() {
  const state = {
    freezeId: 'FREEZE-1', status: 'PENDING_APPROVAL', dispatchStatus: 'PENDING', dispatchAttempts: 0,
    manifestSha256: 'a'.repeat(64), reportSha256: 'b'.repeat(64), reportFileName: 'report.pdf',
    roundId: 'ROUND-1', submittedBy: 'validator', conclusion: 'PASS', manifest: { releaseId: 'REL-1' }
  };
  const freezes = {
    get: () => state,
    list: () => [state],
    listDispatchPending: () => state.dispatchStatus === 'PENDING' || state.dispatchStatus === 'FAILED' ? [state] : [],
    approvalEnvelope: () => ({ schemaVersion: 1, type: 'VERIFICATION_APPROVAL_REQUEST', requestId: state.freezeId, releaseId: 'REL-1', roundId: 'ROUND-1', productName: '曙光云 Stack', version: '8.0.6.2', roundNo: 2, reportTitle: '验证报告', manifestSha256: 'a'.repeat(64) }),
    markDispatchAttempt: () => { state.dispatchStatus = 'SENDING'; state.dispatchAttempts += 1; return state; },
    markDispatchSuccess: () => { state.dispatchStatus = 'DELIVERED'; return state; },
    markDispatchFailure: (_id, error) => { state.dispatchStatus = 'FAILED'; state.dispatchLastError = error.message; return state; },
    markCoreStatus: () => { throw new Error('Edge must not poll Core for approval status'); }
  };
  return { state, freezes };
}

test('approval dispatcher sends an outbox request through the mapped Core control address', async () => {
  const { state, freezes } = fixture();
  let request;
  const dispatcher = createApprovalDispatcher({
    freezes,
    gateConfig: { get: () => ({ coreControlUrl: 'http://gate.example:3201', connectTimeoutMs: 1000 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async (url, options) => { request = { url, options }; return { ok: true, status: 202, json: async () => ({ accepted: true, requestId: state.freezeId, idempotent: false }) }; },
    logger: { warn() {} }
  });
  const result = await dispatcher.dispatchOne(state.freezeId);
  assert.equal(result.dispatchStatus, 'DELIVERED');
  assert.equal(request.url, 'http://gate.example:3201/api/v1/gate/approval-requests');
  assert.equal(request.options.headers['x-cam-gate-signature'], 'signed-request');
  assert.equal(JSON.parse(request.options.body).requestId, state.freezeId);
  await dispatcher.close();
});

test('approval dispatcher keeps a failed outbox request retryable', async () => {
  const { state, freezes } = fixture();
  const dispatcher = createApprovalDispatcher({
    freezes,
    gateConfig: { get: () => ({ coreControlUrl: 'http://gate.example:3201', connectTimeoutMs: 1000 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async () => { throw new Error('connection refused'); },
    logger: { warn() {} }
  });
  const result = await dispatcher.dispatchOne(state.freezeId);
  assert.equal(result.dispatchStatus, 'FAILED');
  assert.equal(result.dispatchAttempts, 1);
  assert.match(result.dispatchLastError, /connection refused/);
  await dispatcher.close();
});

test('approval dispatcher never polls Core after request delivery', async () => {
  const { state, freezes } = fixture();
  state.dispatchStatus = 'DELIVERED';
  state.dispatchAttempts = 1;
  let requests = 0;
  const dispatcher = createApprovalDispatcher({
    freezes,
    gateConfig: { get: () => ({ coreControlUrl: 'http://gate.example:3201', connectTimeoutMs: 1000 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async () => { requests += 1; throw new Error('delivered request must not be resent'); },
    logger: { warn() {} }
  });
  await dispatcher.pump();
  assert.equal(requests, 0);
  await dispatcher.close();
});
