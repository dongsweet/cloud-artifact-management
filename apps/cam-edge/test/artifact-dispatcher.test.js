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

test('artifact dispatcher registers the local manifest before repairing a legacy Core task', async () => {
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
    assert.equal(calls.some((call) => call.url.endsWith('/receipts')), false);
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
