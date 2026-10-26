import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeGateConfig } from '../src/config.js';

test('gate configuration accepts mapping URLs and rejects unsafe URL forms', () => {
  const config = normalizeGateConfig({
    coreControlUrl: 'http://gate.example:3201/',
    coreTransferUrl: 'https://gate.example:3202',
    edgeControlUrl: 'http://gate.example:3203',
    edgeTransferUrl: 'http://gate.example:3204'
  }, { requireUrls: true });
  assert.equal(config.mode, 'mapping');
  assert.equal(config.coreControlUrl, 'http://gate.example:3201');
  assert.throws(() => normalizeGateConfig({ coreControlUrl: 'http://user:pass@gate.example' }), /不能包含凭据/);
  assert.doesNotThrow(() => normalizeGateConfig({ coreControlUrl: 'http://gate.example:3201', coreTransferUrl: 'http://gate.example:3202' }, { requireUrls: true, requiredUrlFields: ['coreControlUrl', 'coreTransferUrl'] }));
  assert.throws(() => normalizeGateConfig({ coreControlUrl: 'http://gate.example:3201' }, { requireUrls: true, requiredUrlFields: ['coreControlUrl', 'coreTransferUrl'] }), /本端需要访问/);
  assert.throws(() => normalizeGateConfig({ coreControlUrl: 'ftp://gate.example' }), /HTTP\/HTTPS/);
});

test('gate configuration enforces bounded transfer settings', () => {
  assert.throws(() => normalizeGateConfig({ chunkSizeBytes: 1024 }), /1 MiB/);
  assert.throws(() => normalizeGateConfig({ connectTimeoutMs: 10_000, transferStartTimeoutMs: 9_999 }), /开始超时/);
  assert.throws(() => normalizeGateConfig({ transferTimeoutMs: 60_000, transferIdleTimeoutMs: 59_999 }), /空闲超时/);
  assert.throws(() => normalizeGateConfig({ maxInFlightChunks: 33 }), /安全上限/);
  assert.throws(() => normalizeGateConfig({ mode: 'bridge' }), /mapping/);
});
