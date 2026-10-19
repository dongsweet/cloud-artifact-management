import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoreApp } from '../src/server.js';
import { buildEdgeApp } from '../../cam-edge/src/app.js';

test('HTTP pairing recovers lost confirmations and coalesces simultaneous rotation requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-http-pairing-'));
  let loseConfirmation = false;
  let proposals = 0;
  const core = await buildCoreApp({ dataDir: join(dir, 'core'), enableKeyRotation: false, fetchImpl: async (url, options) => {
    if (url.endsWith('/key-rotation/proposals')) {
      proposals++;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    const response = await fetch(url, options);
    if (loseConfirmation && url.endsWith('/confirm')) {
      loseConfirmation = false;
      await response.arrayBuffer();
      throw new Error('confirmation response lost');
    }
    return response;
  } });
  const edge = await buildEdgeApp({ dataDir: join(dir, 'edge'), principalProvider: async () => ({ id: 'test-admin', type: 'TEST', roles: ['EDGE_ADMIN'] }) });
  try {
    const admin = await core.authStore.createUser({ username: 'admin', displayName: '管理员', password: 'Pairing-test-password-2026!', roles: ['CORE_ADMIN'] });
    core.authStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE user_id = ?').run(admin.id);
    const login = await core.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Pairing-test-password-2026!' } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: login.cookies.map(({ name, value }) => `${name}=${value}`).join('; '), 'x-cam-core-csrf': login.json().csrfToken };
    await core.listen({ host: '127.0.0.1', port: 0 });
    await edge.listen({ host: '127.0.0.1', port: 0 });
    const coreUrl = `http://127.0.0.1:${core.server.address().port}`;
    const edgeUrl = `http://127.0.0.1:${edge.server.address().port}`;
    core.gateConfigStore.save({ edgeControlUrl: edgeUrl, edgeTransferUrl: edgeUrl });
    edge.gateConfigStore.save({ coreControlUrl: coreUrl, coreTransferUrl: coreUrl });
    const call = (url) => core.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal((await core.inject({ method: 'POST', url: '/api/v1/gate/keys/rotate', payload: {} })).statusCode, 401);
    const saved = await core.inject({ method: 'PUT', url: '/api/v1/gate/keys/trusted-peer', headers, payload: { identityBundle: await edge.gateKeyring.identity() } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().item.businessReady, false);
    assert.ok(saved.json().item.lastRotationError);
    assert.ok(saved.json().item.retryAt);
    const trusted = await edge.inject({ method: 'PUT', url: '/api/v1/gate/keys/trusted-peer', payload: { identityBundle: await core.gateKeyring.identity() } });
    assert.equal(trusted.statusCode, 200, trusted.body);
    loseConfirmation = true;
    const failed = await call('/api/v1/gate/keys/test');
    assert.equal(failed.statusCode, 502, failed.body);
    assert.equal((await core.gateKeyring.status()).pairingState, 'CONFIRMING');
    const probe = await core.inject({ url: '/api/v1/gate/pairing-probe', headers: { 'x-cam-gate-secret': (await core.gateKeyring.currentSecret()).toString('base64url') } });
    assert.equal(probe.statusCode, 503, probe.body);
    const recovered = await call('/api/v1/gate/keys/test');
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().checks.authenticated, true);
    assert.equal((await core.gateKeyring.status()).lastRotationError, null);
    const edgeProbe = await edge.inject({ method: 'POST', url: '/api/v1/gate/keys/test', payload: {} });
    assert.equal(edgeProbe.statusCode, 200, edgeProbe.body);
    // Existing business keys must also allow a failed rotation to be resumed.
    loseConfirmation = true;
    assert.equal((await call('/api/v1/gate/keys/rotate')).statusCode, 502);
    assert.equal((await core.gateKeyring.status()).businessReady, true);
    assert.equal((await call('/api/v1/gate/keys/test')).statusCode, 200);
    const before = proposals;
    const results = await Promise.all([call('/api/v1/gate/keys/rotate'), call('/api/v1/gate/keys/rotate')]);
    for (const result of results) assert.equal(result.statusCode, 200, result.body);
    assert.equal(proposals, before + 1);
    assert.equal((await core.gateKeyring.status()).activeKeyId, (await edge.gateKeyring.status()).activeKeyId);
    assert.equal(await edge.gateKeyring.verifySecret(await core.gateKeyring.currentSecret()), (await core.gateKeyring.status()).activeKeyId);
  } finally {
    await Promise.all([core.close(), edge.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
