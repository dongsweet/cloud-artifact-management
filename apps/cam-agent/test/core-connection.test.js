import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';
import { buildCoreApp } from '../../cam-core/src/server.js';
import { rotateAgentServiceIdentity, stageAgentServiceIdentityRotation } from '../../cam-core/src/agent-service-identity.js';
import { generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

async function login(app, create = true) {
  if (create) {
    await app.agentAuthStore.createUser({ username: 'admin', displayName: 'Admin', password: 'Agent-Config-Test-2026', roles: ['CORE_SYSTEM_ADMIN'] }, null, { bootstrap: true });
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
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/core-config', headers })).json().item.source, 'unconfigured');
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
    const localIdentity = (await app.inject({ method: 'GET', url: '/api/v1/identity', headers })).json();
    assert.equal(localIdentity.rotation.paired, true);
    assert.equal(localIdentity.centerId, 'TEST');
    assert.equal(localIdentity.agentName, 'config-agent');
    assert.equal(localIdentity.agentId, registered.agentId);
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

test('Core identity rotation is proposed under the old key and activated after each Agent confirms', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-agent-mutual-rotation-'));
  const coreDir = join(dataDir, 'core');
  const core = await buildCoreApp({ dataDir: coreDir, enableAuth: false });
  const identity = generateIdentity();
  const registered = core.coreStore.registerAgent({ name: 'rotation-agent', centerId: 'TEST', publicKey: identity.publicKeyPem });
  const secondIdentity = generateIdentity();
  const secondRegistered = core.coreStore.registerAgent({ name: 'offline-rotation-agent', centerId: 'TEST', publicKey: secondIdentity.publicKeyPem });
  const pendingIdentity = generateIdentity();
  const pendingRegistered = core.coreStore.registerAgent({ name: 'pending-rotation-agent', centerId: 'TEST', publicKey: pendingIdentity.publicKeyPem });
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  core.coreStore.confirmAgentIdentity({ agentId: registered.agentId, currentKey: true, signingKeyId: identity.fingerprint });
  core.coreStore.confirmAgentIdentity({ agentId: secondRegistered.agentId, currentKey: true, signingKeyId: secondIdentity.fingerprint });
  const agentDir = join(dataDir, 'agent');
  const secondAgentDir = join(dataDir, 'second-agent');
  const pendingAgentDir = join(dataDir, 'pending-agent');
  await mkdir(agentDir);
  await mkdir(secondAgentDir);
  await mkdir(pendingAgentDir);
  await writeFile(join(agentDir, 'identity.json'), JSON.stringify(identity));
  await writeFile(join(secondAgentDir, 'identity.json'), JSON.stringify(secondIdentity));
  await writeFile(join(pendingAgentDir, 'identity.json'), JSON.stringify(pendingIdentity));
  const oldFingerprint = core.agentServiceIdentity.fingerprint;
  const app = await buildAgentApp({ dataDir: agentDir, agentId: registered.agentId, coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem, startWorker: false });
  const secondApp = await buildAgentApp({ dataDir: secondAgentDir, agentId: secondRegistered.agentId, coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem, startWorker: false });
  const pendingApp = await buildAgentApp({ dataDir: pendingAgentDir, agentId: pendingRegistered.agentId, coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem, startWorker: false });
  try {
    await stageAgentServiceIdentityRotation(join(coreDir, 'core-agent-identity.json'), core.agentServiceIdentity);
    assert.equal(core.agentServiceIdentity.fingerprint, oldFingerprint, 'Core keeps signing with the old identity until all registered Agents confirm');
    await app.agentPoll();
    assert.equal(core.coreStore.getCoreIdentityRotationStatus(core.agentServiceIdentity.pendingIdentity.rotationId).pending, 2, 'the offline and not-yet-enabled Agents keep the Core rotation staged');
    assert.equal(core.agentServiceIdentity.fingerprint, oldFingerprint, 'Core does not switch globally while one Agent is still offline');
    await secondApp.agentPoll();
    assert.equal(core.coreStore.getCoreIdentityRotationStatus(core.agentServiceIdentity.pendingIdentity.rotationId).pending, 1, 'the not-yet-enabled Agent can confirm the staged Core identity');
    await pendingApp.agentPoll();
    const settings = app.agentAuthStore.db.prepare('SELECT setting_value FROM agent_settings WHERE setting_key = ?').get('corePublicKey');
    assert.equal(JSON.parse(settings.setting_value).trim(), (core.agentServiceIdentity.fingerprint === oldFingerprint ? core.agentServiceIdentity.pendingIdentity.publicKeyPem : core.agentServiceIdentity.publicKeyPem).trim());
    assert.equal(core.coreStore.getCoreIdentityRotationStatus(core.agentServiceIdentity.rotationId).pending, 0);
    assert.notEqual(core.agentServiceIdentity.fingerprint, oldFingerprint, 'Core activates the new identity after Agent confirmation');
    assert.equal(core.agentServiceIdentity.pendingIdentity, null);
  } finally { await app.close(); await secondApp.close(); await pendingApp.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core activates a staged identity after its deadline when an Agent stays offline', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-agent-rotation-deadline-'));
  const core = await buildCoreApp({ dataDir, enableAuth: false });
  try {
    const agentIdentity = generateIdentity();
    core.coreStore.registerAgent({ name: 'offline-deadline-agent', centerId: 'TEST', publicKey: agentIdentity.publicKeyPem });
    const oldFingerprint = core.agentServiceIdentity.fingerprint;
    const pending = await stageAgentServiceIdentityRotation(join(dataDir, 'core-agent-identity.json'), core.agentServiceIdentity, 1);
    pending.activationDeadlineAt = new Date(Date.now() - 1_000).toISOString();
    await writeFile(join(dataDir, 'core-agent-identity.json'), JSON.stringify(core.agentServiceIdentity), { mode: 0o600 });
    await core.close();

    const restartedCore = await buildCoreApp({ dataDir, enableAuth: false });
    try {
      assert.notEqual(restartedCore.agentServiceIdentity.fingerprint, oldFingerprint, 'Core activates the pending identity after the deadline');
      assert.equal(restartedCore.agentServiceIdentity.pendingIdentity, null);
      assert.equal(restartedCore.agentServiceIdentity.lastRotationSkippedAgentCount, 1, 'offline Agent is recorded as skipped');
      assert.equal(restartedCore.agentServiceIdentity.previousFingerprint, oldFingerprint);
    } finally { await restartedCore.close(); }
  } finally { if (core.server?.listening) await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent automatically rotates on the cycle configured by Core', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-agent-policy-cycle-'));
  const coreDir = join(dataDir, 'core');
  const agentDir = join(dataDir, 'agent');
  const core = await buildCoreApp({ dataDir: coreDir, enableAuth: false });
  const identity = generateIdentity();
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'identity.json'), JSON.stringify(identity));
  const registered = core.coreStore.registerAgent({ name: 'core-policy-agent', centerId: 'TEST', publicKey: identity.publicKeyPem });
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  try {
    core.coreStore.confirmAgentIdentity({ agentId: registered.agentId, currentKey: true, signingKeyId: identity.fingerprint });
    core.coreStore.setAgentRotationPolicy({ rotationDays: 1, graceHours: 24 });
    core.coreStore.db.prepare('UPDATE core_agents SET key_rotated_at = ? WHERE agent_id = ?').run(new Date(Date.now() - 2 * 86400_000).toISOString(), registered.agentId);
    const app = await buildAgentApp({ dataDir: agentDir, agentId: registered.agentId, coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem, startWorker: false });
    try {
      await app.agentPoll();
      assert.notEqual(core.coreStore.getAgentIdentity(registered.agentId).keyId, identity.fingerprint, 'Agent follows Core rotationDue and creates a new identity automatically');
      const localState = JSON.parse(await readFile(join(agentDir, 'identity.json.rotation'), 'utf8'));
      assert.equal(localState.policy.rotationDays, 1, 'Agent persists the cycle supplied by Core');
      assert.equal(localState.policy.graceHours, 24, 'Agent persists the transition period supplied by Core');
    } finally { await app.close(); }
  } finally { await core.close(); await rm(dataDir, { recursive: true, force: true }); }
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
