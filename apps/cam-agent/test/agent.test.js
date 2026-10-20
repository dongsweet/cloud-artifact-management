import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';
import { buildCoreApp } from '../../cam-core/src/server.js';
import { generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

test('cam-agent requires a local login, forces initial password change, and protects local task APIs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-local-auth-'));
  const app = await buildAgentApp({ dataDir, startWorker: false });
  try {
    await app.agentAuthStore.createUser({ username: 'agentadmin', displayName: 'Agent Admin', password: 'Initial-Agent-Password-2026', roles: ['CORE_ADMIN'] }, null, { bootstrap: true });
    const noLogin = await app.inject({ method: 'GET', url: '/api/v1/tasks' }); assert.equal(noLogin.statusCode, 401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'agentadmin', password: 'Initial-Agent-Password-2026' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookies = login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { cookie: cookies } })).statusCode, 403);
    const password = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: { cookie: cookies, 'x-cam-agent-csrf': login.json().csrfToken }, payload: { oldPassword: 'Initial-Agent-Password-2026', password: 'Changed-Agent-Password-2026' } });
    assert.equal(password.statusCode, 200, password.body);
    const relogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'agentadmin', password: 'Changed-Agent-Password-2026' } });
    assert.equal(relogin.statusCode, 200);
    const freshCookies = relogin.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { cookie: freshCookies } })).json(), { items: [] });
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent tests its signed Core pairing and persists a rotated identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-core-identity-'));
  const core = await buildCoreApp({ dataDir: join(dataDir, 'core'), enableAuth: false });
  const identity = generateIdentity();
  await mkdir(join(dataDir, 'agent'));
  await writeFile(join(dataDir, 'agent', 'identity.json'), JSON.stringify(identity));
  const registered = core.coreStore.registerAgent({ name: 'paired-agent', centerId: 'TEST', publicKey: identity.publicKeyPem });
  const options = {
    dataDir: join(dataDir, 'agent'), agentId: registered.agentId, startWorker: false,
    coreUrl: await core.listen({ host: '127.0.0.1', port: 0 }), corePublicKey: core.agentServiceIdentity.publicKeyPem
  };
  let app = await buildAgentApp(options);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/identity/rotate', payload: {} })).statusCode, 401);
    await app.agentAuthStore.createUser({ username: 'admin', displayName: 'Admin', password: 'Agent-Integration-2026', roles: ['CORE_ADMIN'] }, null, { bootstrap: true });
    await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0').run();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Agent-Integration-2026' } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': login.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/identity/test', headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/identity/rotate', headers: { cookie: headers.cookie }, payload: {} })).statusCode, 403);
    const rotated = await app.inject({ method: 'POST', url: '/api/v1/identity/rotate', headers, payload: {} });
    assert.equal(rotated.statusCode, 200, rotated.body);
    assert.notEqual(rotated.json().fingerprint, identity.fingerprint);
    assert.equal(core.coreStore.listAgents()[0].fingerprint, rotated.json().fingerprint);
    const saved = JSON.parse(await readFile(join(dataDir, 'agent', 'identity.json'), 'utf8'));
    assert.equal(saved.fingerprint, rotated.json().fingerprint);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/identity/test', headers, payload: {} })).statusCode, 200);
    await app.close(); app = await buildAgentApp(options);
    await app.agentPoll();
    assert.equal(core.coreStore.listAgents()[0].fingerprint, saved.fingerprint);
  } finally { await app.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent without a trusted Core public key cannot complete initial or re-enable verification', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-no-core-key-'));
  const core = await buildCoreApp({ dataDir: join(dataDir, 'core'), enableAuth: false });
  const identity = generateIdentity();
  await mkdir(join(dataDir, 'agent'));
  await writeFile(join(dataDir, 'agent', 'identity.json'), JSON.stringify(identity));
  const agentRecord = core.coreStore.registerAgent({ centerId: 'TEST', name: 'no-core-key', publicKey: identity.publicKeyPem });
  const options = { dataDir: join(dataDir, 'agent'), agentId: agentRecord.agentId, startWorker: false, coreUrl: 'http://127.0.0.1:1' };
  let app = await buildAgentApp(options);
  try {
    await app.agentPoll();
    assert.equal(core.coreStore.getAgentIdentity(agentRecord.agentId).status, 'PENDING');
    core.coreStore.setAgentStatus(agentRecord.agentId, 'DISABLED');
    core.coreStore.setAgentStatus(agentRecord.agentId, 'ACTIVE');
    await app.agentPoll();
    assert.equal(core.coreStore.getAgentIdentity(agentRecord.agentId).status, 'PENDING');
    assert.equal(core.coreStore.getAgentIdentity(agentRecord.agentId).confirmedAt, null);
  } finally { await app.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core-triggered Agent rotation recovers the same pending key after a lost response and restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-rotation-recovery-'));
  const agentDir = join(dataDir, 'agent');
  const core = await buildCoreApp({ dataDir: join(dataDir, 'core'), enableAuth: false });
  const initial = generateIdentity();
  await mkdir(agentDir);
  await writeFile(join(agentDir, 'identity.json'), JSON.stringify(initial));
  const registered = core.coreStore.registerAgent({ name: 'recover-agent', centerId: 'TEST', publicKey: initial.publicKeyPem });
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  core.coreStore.confirmAgentIdentity({ agentId: registered.agentId, currentKey: true, signingKeyId: initial.fingerprint });
  core.coreStore.requestAgentRotation(registered.agentId);
  let loseResponse = true;
  const fetchImpl = async (...args) => {
    const response = await fetch(...args);
    if (loseResponse && String(args[0]).endsWith('/api/v1/agent/key-rotation')) { loseResponse = false; throw new Error('simulated response loss'); }
    return response;
  };
  const options = { dataDir: agentDir, agentId: registered.agentId, startWorker: false, coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem, fetchImpl };
  let app = await buildAgentApp(options);
  try {
    await app.agentPoll();
    const switched = core.coreStore.getAgentIdentity(registered.agentId);
    assert.notEqual(switched.keyId, initial.fingerprint, 'Core accepted the public key before the response was lost');
    const pending = JSON.parse(await readFile(join(agentDir, 'identity.json.pending'), 'utf8'));
    await app.close();
    app = await buildAgentApp({ ...options, fetchImpl: fetch });
    await app.agentPoll();
    const saved = JSON.parse(await readFile(join(agentDir, 'identity.json'), 'utf8'));
    assert.equal(saved.fingerprint, pending.fingerprint, 'restart reuses the durable pending key');
    assert.equal(core.coreStore.getAgentIdentity(registered.agentId).confirmedAt !== null, true);
    assert.equal(core.coreStore.getAgentIdentity(registered.agentId).rotationRequestedAt, null);
  } finally { await app.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent rejects Core responses without a trusted key or with a modified body', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-response-signature-'));
  const identity = generateIdentity();
  const core = await buildCoreApp({ dataDir: join(dataDir, 'core'), enableAuth: false });
  const agentDir = join(dataDir, 'agent'); await mkdir(agentDir); await writeFile(join(agentDir, 'identity.json'), JSON.stringify(identity));
  const registered = core.coreStore.registerAgent({ name: 'signature-agent', centerId: 'TEST', publicKey: identity.publicKeyPem });
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 });
  const options = { dataDir: agentDir, agentId: registered.agentId, coreUrl, startWorker: false };
  const missing = await buildAgentApp(options);
  const signIn = async (app) => { await app.agentAuthStore.createUser({ username: 'admin', displayName: 'Admin', password: 'Agent-Integration-2026', roles: ['CORE_ADMIN'] }, null, { bootstrap: true }); await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0').run(); const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Agent-Integration-2026' } }); return { cookie: login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': login.json().csrfToken }; };
  try { const response = await missing.inject({ method: 'POST', url: '/api/v1/identity/test', headers: await signIn(missing), payload: {} }); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'core_public_key_missing'); } finally { await missing.close(); }
  const tamperedDir = join(dataDir, 'tampered-agent'); await mkdir(tamperedDir); await writeFile(join(tamperedDir, 'identity.json'), JSON.stringify(identity));
  const tampered = await buildAgentApp({ ...options, dataDir: tamperedDir, corePublicKey: core.agentServiceIdentity.publicKeyPem, fetchImpl: async (...args) => { const response = await fetch(...args); const body = await response.arrayBuffer(); const bytes = Buffer.from(body); if (bytes.length) bytes[0] ^= 1; return new Response(bytes, { status: response.status, headers: response.headers }); } });
  try { const response = await tampered.inject({ method: 'POST', url: '/api/v1/identity/test', headers: await signIn(tampered), payload: {} }); assert.equal(response.statusCode, 502); assert.equal(response.json().error.code, 'core_response_signature_invalid'); }
  finally { await tampered.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});
