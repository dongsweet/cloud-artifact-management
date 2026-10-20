import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCoreApp } from '../src/server.js';
import { buildEdgeApp } from '../../cam-edge/src/app.js';

test('Core and Edge pair by identity signatures and rotate either side own identity keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cam-http-pairing-'));
  let loseRotationReceipt = false;
  let proposals = 0;
  const core = await buildCoreApp({ dataDir: join(dir, 'core'), enableKeyRotation: false, fetchImpl: async (url, options) => {
    if (url.endsWith('/identity-rotation/proposals')) proposals++;
    const response = await fetch(url, options);
    if (loseRotationReceipt && url.endsWith('/identity-rotation/proposals')) {
      loseRotationReceipt = false;
      await response.arrayBuffer();
      throw new Error('rotation receipt lost');
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
    const trusted = await edge.inject({ method: 'PUT', url: '/api/v1/gate/keys/trusted-peer', payload: { identityBundle: await core.gateKeyring.identity() } });
    assert.equal(trusted.statusCode, 200, trusted.body);
    assert.equal((await call('/api/v1/gate/keys/test')).statusCode, 200);
    assert.equal((await edge.inject({ method: 'POST', url: '/api/v1/gate/keys/test', payload: {} })).statusCode, 200);
    assert.equal((await core.gateKeyring.status()).businessReady, true);
    assert.equal((await edge.gateKeyring.status()).businessReady, true);

    const oldCoreFingerprint = (await core.gateKeyring.identity()).signingFingerprint;
    loseRotationReceipt = true;
    const failed = await call('/api/v1/gate/keys/rotate');
    assert.equal(failed.statusCode, 502, failed.body);
    assert.notEqual((await edge.gateKeyring.status()).peerFingerprint, oldCoreFingerprint, `Edge trusts the signed transition even if Core loses the receipt: ${failed.body}`);
    assert.ok((await core.gateKeyring.status()).lastRotationError);
    const recovered = await call('/api/v1/gate/keys/rotate');
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal((await core.gateKeyring.identity()).signingFingerprint, (await edge.gateKeyring.status()).peerFingerprint);
    const before = proposals;
    const results = await Promise.all([call('/api/v1/gate/keys/rotate'), call('/api/v1/gate/keys/rotate')]);
    for (const result of results) assert.equal(result.statusCode, 200, result.body);
    assert.equal(proposals, before + 1, 'simultaneous Core rotation requests share one operation');

    const oldEdgeFingerprint = (await edge.gateKeyring.identity()).signingFingerprint;
    const rotatedEdge = await edge.inject({ method: 'POST', url: '/api/v1/gate/keys/rotate', payload: {} });
    assert.equal(rotatedEdge.statusCode, 200, rotatedEdge.body);
    assert.notEqual((await core.gateKeyring.status()).peerFingerprint, oldEdgeFingerprint);
    assert.equal((await edge.gateKeyring.identity()).signingFingerprint, (await core.gateKeyring.status()).peerFingerprint);
  } finally {
    await Promise.all([core.close(), edge.close()]);
    await rm(dir, { recursive: true, force: true });
  }
});
