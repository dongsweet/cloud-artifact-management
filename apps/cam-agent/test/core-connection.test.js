import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';
import { buildCoreApp } from '../../cam-core/src/server.js';
import { rotateAgentServiceIdentity } from '../../cam-core/src/agent-service-identity.js';
import { generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

async function login(app, create = true) {
  if (create) {
    await app.agentAuthStore.createUser({ username: 'admin', displayName: 'Admin', password: 'Agent-Config-Test-2026', roles: ['CORE_ADMIN'] }, null, { bootstrap: true });
    app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0').run();
  }
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Agent-Config-Test-2026' } });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: response.headers['set-cookie'].map(value => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': response.json().csrfToken };
}

test('Agent configures Core through authenticated APIs and preserves trust across restart and rotation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-core-config-'));
  const core = await buildCoreApp({ dataDir: join(dataDir, 'core'), enableAuth: false });
  const identity = generateIdentity();
  const agentDir = join(dataDir, 'agent');
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'identity.json'), JSON.stringify(identity));
  const registered = core.coreStore.registerAgent({ name: 'config-agent', centerId: 'TEST', publicKey: identity.publicKeyPem });
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  const options = { dataDir: agentDir, agentId: registered.agentId, startWorker: false, corePublicKey: '', coreUrl: 'http://unconfigured.invalid' };
  let app = await buildAgentApp(options);
  try {
    for (const method of ['GET', 'PUT', 'POST']) {
      assert.equal((await app.inject({ method, url: '/api/v1/core-config' + (method === 'POST' ? '/test' : ''), ...(method === 'GET' ? {} : { payload: {} }) })).statusCode, 401);
    }
    let headers = await login(app);
    const initial = (await app.inject({ method: 'GET', url: '/api/v1/core-config', headers })).json().item;
    assert.equal(initial.configured, false);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} });
    assert.equal(missing.statusCode, 503, missing.body);
    assert.equal(missing.json().error.code, 'core_public_key_missing');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/core-config', headers })).json().item.source, 'environment');
    const payload = { coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem };
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers: { cookie: headers.cookie }, payload })).statusCode, 403);
    for (const invalid of [{ coreUrl: 'file:///tmp/core' }, { coreUrl: 'https://user:secret@example.com' }, { coreUrl: coreUrl + '?x=1' }, { corePublicKey: 'invalid' }, { corePublicKey: '' }]) {
      assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers, payload: { ...payload, ...invalid } })).statusCode, 400);
    }
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers, payload });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().item.source, 'database');
    assert.equal(saved.json().item.lastTestState, 'NOT_TESTED');
    const connected = await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} });
    assert.equal(connected.statusCode, 200, connected.body);
    assert.equal(connected.json().item.lastTestState, 'PASSED');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers })).json().rotation.paired, true);
    await app.close();
    app = await buildAgentApp({ ...options, coreUrl: 'http://new-default.invalid', corePublicKey: generateIdentity().publicKeyPem });
    headers = await login(app, false);
    const persisted = (await app.inject({ method: 'GET', url: '/api/v1/core-config', headers })).json().item;
    assert.equal(persisted.coreUrl, coreUrl);
    assert.equal(persisted.fingerprint, connected.json().item.fingerprint);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} })).statusCode, 200);

    const oldCoreIdentity = { ...core.agentServiceIdentity };
    const rotated = await rotateAgentServiceIdentity(join(dataDir, 'core', 'core-agent-identity.json'), core.agentServiceIdentity);
    Object.assign(core.agentServiceIdentity, rotated);
    const newKey = rotated.publicKeyPem;
    const beforeUpdate = await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} });
    assert.equal(beforeUpdate.statusCode, 502);
    assert.equal(beforeUpdate.json().error.code, 'core_response_signature_invalid');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/core-config', headers })).json().item.lastTestState, 'FAILED');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers })).json().rotation.paired, false);

    const replacement = { corePublicKey: newKey, previousPublicKey: persisted.corePublicKey, previousPublicKeyExpiresAt: new Date(Date.now() + 86400_000).toISOString() };
    const notConfirmed = await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers, payload: replacement });
    assert.equal(notConfirmed.json().error.code, 'core_trust_change_confirmation_required');
    for (const expires of ['', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 31 * 86400_000).toISOString()]) {
      const invalid = await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers, payload: { ...replacement, previousPublicKeyExpiresAt: expires, confirmTrustChange: true } });
      assert.equal(invalid.statusCode, 400, invalid.body);
    }
    const changed = await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers, payload: { ...replacement, confirmTrustChange: true } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().item.previousFingerprint, persisted.fingerprint);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers })).json().rotation.paired, false, 'saving config invalidates old confirmation');
    const reconnected = await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} });
    assert.equal(reconnected.statusCode, 200, reconnected.body);
    assert.equal(reconnected.json().item.fingerprint, rotated.fingerprint);
    Object.assign(core.agentServiceIdentity, oldCoreIdentity);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} })).statusCode, 200, 'old Core signer is accepted only during grace');
    app.agentAuthStore.db.prepare('UPDATE agent_settings SET setting_value = ? WHERE setting_key = ?').run(JSON.stringify(new Date(Date.now() - 1000).toISOString()), 'previousPublicKeyExpiresAt');
    const expired = await app.inject({ method: 'POST', url: '/api/v1/core-config/test', headers, payload: {} });
    assert.equal(expired.statusCode, 502, expired.body);
    assert.equal(expired.json().error.code, 'core_response_signature_invalid');
  } finally { await app.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent does not change Core endpoint or trust while a poll is in flight', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-config-busy-'));
  let release;
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  const app = await buildAgentApp({ dataDir, agentId: 'AG-TEST', corePublicKey: generateIdentity().publicKeyPem, startWorker: false, fetchImpl: async () => { started(); await new Promise(resolve => { release = resolve; }); throw new Error('test disconnected'); } });
  try {
    const headers = await login(app);
    const poll = app.agentPoll();
    await fetching;
    const response = await app.inject({ method: 'PUT', url: '/api/v1/core-config', headers, payload: { coreUrl: 'http://new-core.invalid' } });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().error.code, 'core_connection_busy');
    // Rotation reports failure using a second request; release both requests.
    const unblock = setInterval(() => release?.(), 5);
    try { release(); await poll; } finally { clearInterval(unblock); }
  } finally { release?.(); await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
