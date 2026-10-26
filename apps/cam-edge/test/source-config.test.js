import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { buildEdgeApp } from '../src/app.js';

test('Edge persists trusted download sources in the integration configuration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-source-config-'));
  let roles = ['EDGE_SYSTEM_ADMIN'];
  const app = await buildEdgeApp({ dataDir, allowlist: ['127.0.0.1'], principalProvider: () => ({ id: 'system-admin', type: 'TEST_IDP', roles }) });
  try {
    const initial = await app.inject({ method: 'GET', url: '/api/v1/gate/config' });
    assert.equal(initial.statusCode, 200, initial.body);
    assert.deepEqual(initial.json().item.sourceAllowlist, ['127.0.0.1']);

    const saved = await app.inject({ method: 'PUT', url: '/api/v1/gate/config', payload: {
      coreControlUrl: 'http://core-control.test',
      coreTransferUrl: 'http://core-transfer.test',
      sourceAllowlist: '10.0.0.8\n*.packages.example.com\npackages.example.com'
    } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().item.sourceAllowlist, ['10.0.0.8', '*.packages.example.com', 'packages.example.com']);
    assert.equal(saved.json().item.sourceAllowlistSource, 'database');
    assert.deepEqual(app.sourceConfigStore.get().allowlist, ['10.0.0.8', '*.packages.example.com', 'packages.example.com']);

    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/gate/config', payload: {
      coreControlUrl: 'http://core-control.test',
      coreTransferUrl: 'http://core-transfer.test',
      sourceAllowlist: 'https://packages.example.com/download'
    } });
    assert.equal(invalid.statusCode, 400, invalid.body);
    assert.equal(invalid.json().error.code, 'source_allowlist_invalid');

    roles = ['EDGE_OPERATOR'];
    const denied = await app.inject({ method: 'PUT', url: '/api/v1/gate/config', payload: { sourceAllowlist: '127.0.0.1' } });
    assert.equal(denied.statusCode, 403);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
