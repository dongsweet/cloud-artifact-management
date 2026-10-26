import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createArtifactDispatcher } from '../src/artifact-dispatcher.js';

test('artifact dispatcher skips stored objects, resumes missing chunks and submits a receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-transfer-'));
  const sourcePath = join(dir, 'artifact.bin');
  const bytes = Buffer.from('approved binary');
  await writeFile(sourcePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const state = { freezeId: 'FREEZE-1', status: 'APPROVED', transferTaskId: 'TASK-1', manifestSha256: 'a'.repeat(64), transferStatus: 'READY', transferAttempts: 0 };
  const freezes = {
    get: () => state,
    listTransferPending: () => [state],
    markTransferAttempt: () => { state.transferStatus = 'SENDING'; state.transferAttempts += 1; },
    markTransferSuccess: () => { state.transferStatus = 'RECEIVED'; },
    markTransferFailure: (_id, error) => { state.transferStatus = 'FAILED'; state.transferLastError = error.message; }
  };
  const calls = [];
  const dispatcher = createArtifactDispatcher({
    freezes,
    candidates: { get: () => ({ status: 'COMPLETED', source_path: sourcePath, final_sha256: sha256, expected_size: bytes.length }) },
    gateConfig: { get: () => ({ coreTransferUrl: 'http://core.example', transferTimeoutMs: 1_000, chunkSizeBytes: 1024 * 1024 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/manifest') && options.method === 'POST') return { ok: true, json: async () => ({ item: { fileCount: 1 } }) };
      if (url.endsWith('/manifest')) return { ok: true, json: async () => ({ requestId: state.freezeId, transferTaskId: state.transferTaskId, manifestSha256: state.manifestSha256, items: [
        { candidateId: 'C1', fileName: 'existing.iso', sizeBytes: 12, actualSha256: 'b'.repeat(64), stored: true },
        { candidateId: 'C2', fileName: 'artifact.bin', sizeBytes: bytes.length, actualSha256: sha256, stored: false, receivedParts: [] }
      ] }) };
      return { ok: true, json: async () => ({}) };
    },
    logger: { warn() {} }
  });
  try {
    await dispatcher.deliver(state.freezeId);
    assert.equal(state.transferStatus, 'RECEIVED');
    assert.equal(calls.filter(({ url }) => url.includes('/parts/')).length, 1);
    assert.equal(calls.some(({ url }) => url.includes(`${'b'.repeat(64)}/parts/`)), false);
    assert.match(calls.at(-1).url, /\/api\/v1\/gate\/receipts$/);
  } finally {
    await dispatcher.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('artifact dispatcher registers the local manifest and repairs a legacy Core task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-transfer-'));
  const sourcePath = join(dir, 'legacy.bin');
  const bytes = Buffer.from('legacy binary');
  await writeFile(sourcePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifest = { releaseId: 'REL-1', items: [{ packageKey: 'legacy', candidateId: 'C1', fileName: 'legacy.bin', sizeBytes: bytes.length, actualSha256: sha256 }] };
  const state = { freezeId: 'FREEZE-LEGACY', status: 'APPROVED', transferTaskId: 'TASK-LEGACY', manifestSha256: 'd'.repeat(64), manifest, transferStatus: 'RECEIVED', transferAttempts: 1 };
  const freezes = { get: () => state, listTransferPending: () => [], markTransferAttempt() { state.transferAttempts += 1; }, markTransferSuccess() { state.transferStatus = 'RECEIVED'; }, markTransferFailure(_id, error) { throw error; } };
  const calls = [];
  const dispatcher = createArtifactDispatcher({
    freezes, candidates: { get: () => ({ status: 'COMPLETED', source_path: sourcePath, final_sha256: sha256, expected_size: bytes.length }) },
    gateConfig: { get: () => ({ coreTransferUrl: 'http://core.example', transferTimeoutMs: 1_000, chunkSizeBytes: 1024 * 1024 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url, options });
      if (url.endsWith('/manifest') && options.method === 'POST') return { ok: true, json: async () => ({ item: { fileCount: 1 } }) };
      if (url.endsWith('/manifest')) {
        const repaired = calls.some((call) => call.url.endsWith('/manifest') && call.options.method === 'POST');
        return { ok: true, json: async () => ({ requestId: state.freezeId, transferTaskId: state.transferTaskId, manifestSha256: state.manifestSha256, items: repaired ? [{ ...manifest.items[0], stored: true }] : [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }, logger: { warn() {} }
  });
  try {
    await dispatcher.deliver(state.freezeId);
    assert.equal(calls.filter((call) => call.options.method === 'POST' && call.url.endsWith('/manifest')).length, 1);
    assert.equal(calls.some((call) => call.url.endsWith('/receipts')), true);
  } finally { await dispatcher.close(); await rm(dir, { recursive: true, force: true }); }
});

test('artifact dispatcher exposes a failed attempt for retry after a Core connection failure', async () => {
  const state = { freezeId: 'FREEZE-2', status: 'APPROVED', transferTaskId: 'TASK-2', manifestSha256: 'c'.repeat(64), transferStatus: 'READY', transferAttempts: 0 };
  const freezes = {
    get: () => state,
    listTransferPending: () => [state],
    markTransferAttempt: () => { state.transferStatus = 'SENDING'; state.transferAttempts += 1; },
    markTransferSuccess: () => { state.transferStatus = 'RECEIVED'; },
    markTransferFailure: (_id, error) => { state.transferStatus = 'FAILED'; state.transferLastError = error.message; }
  };
  const dispatcher = createArtifactDispatcher({
    freezes, candidates: { get() { throw new Error('unexpected source lookup'); } },
    gateConfig: { get: () => ({ coreTransferUrl: 'http://core.example', transferTimeoutMs: 1_000, chunkSizeBytes: 1024 * 1024 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async () => { throw new Error('connection refused'); }, logger: { warn() {} }
  });
  try {
    await dispatcher.deliver(state.freezeId);
    assert.equal(state.transferStatus, 'FAILED');
    assert.equal(state.transferAttempts, 1);
    assert.match(state.transferLastError, /connection refused/);
  } finally { await dispatcher.close(); }
});

test('artifact dispatcher reports failures to Core and leaves retry budget coordination to Core', async () => {
  const state = { freezeId: 'FREEZE-LIMIT', status: 'APPROVED', transferTaskId: 'TASK-LIMIT', manifestSha256: 'e'.repeat(64), transferStatus: 'READY', transferAttempts: 0 };
  const reports = [];
  const freezes = {
    get: () => state,
    listTransferPending: () => [state],
    markTransferAttempt: () => { state.transferStatus = 'SENDING'; state.transferAttempts += 1; },
    markTransferSuccess: () => { state.transferStatus = 'RECEIVED'; },
    markTransferFailure: (_id, error, options = {}) => { state.transferStatus = 'FAILED'; state.transferLastError = error.message; state.transferErrorCode = error.code; state.transferRetryAt = options.retryAt; state.transferRetryExhausted = Boolean(options.exhausted); }
  };
  const dispatcher = createArtifactDispatcher({
    freezes,
    candidates: { get() { throw new Error('unexpected source lookup'); } },
    gateConfig: { get: () => ({ coreControlUrl: 'http://core.example', coreTransferUrl: 'http://core.example', connectTimeoutMs: 1_000, transferTimeoutMs: 1_000, chunkSizeBytes: 1024 * 1024, retryLimit: 2 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/transfer-status')) { reports.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ accepted: true }) }; }
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    }, logger: { warn() {} }
  });
  try {
    await dispatcher.deliver(state.freezeId);
    assert.equal(state.transferAttempts, 1);
    assert.equal(state.transferRetryExhausted, false);
    assert.equal(reports.some((report) => report.state === 'STARTED'), true);
    assert.equal(reports.some((report) => report.state === 'RETRY_WAIT' && report.terminal === false), true);
    await dispatcher.deliver(state.freezeId);
    assert.equal(state.transferAttempts, 2);
    assert.equal(state.transferRetryExhausted, false);
    assert.equal(state.transferRetryAt, undefined);
    assert.equal(reports.some((report) => report.state === 'RETRY_WAIT' && report.terminal === false && report.attempt === 2 && report.code === 'ENOSPC'), true);
  } finally { await dispatcher.close(); }
});

test('artifact dispatcher replays persisted failures to Core after startup', async () => {
  const state = {
    freezeId: 'FREEZE-RECONCILE', status: 'APPROVED', transferTaskId: 'TASK-RECONCILE',
    manifestSha256: 'f'.repeat(64), transferStatus: 'FAILED', transferAttempts: 3,
    transferLastError: 'The operation was aborted due to timeout', transferErrorCode: '23',
    transferRetryAt: null, transferRetryExhausted: true
  };
  const reports = [];
  const dispatcher = createArtifactDispatcher({
    freezes: { listTransferStates: () => [state], listTransferPending: () => [], get: () => state },
    candidates: { get() { throw new Error('unexpected source lookup'); } },
    gateConfig: { get: () => ({ coreControlUrl: 'http://core.example', connectTimeoutMs: 1_000, transferTimeoutMs: 1_000 }) },
    keyring: { requestHeaders: async (_method, _path, _body, headers = {}) => ({ ...headers, 'x-cam-gate-signature': 'signed-request' }) },
    fetchImpl: async (url, options = {}) => {
      reports.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ accepted: true }) };
    },
    logger: { warn() {} }, intervalMs: 60_000
  });
  try {
    dispatcher.start();
    for (let i = 0; i < 20 && reports.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].payload.attempt, 3);
    assert.equal(reports[0].payload.terminal, false);
    assert.equal(reports[0].payload.code, 'ETIMEDOUT');
    assert.equal(reports[0].payload.message, state.transferLastError);
  } finally { await dispatcher.close(); }
});
