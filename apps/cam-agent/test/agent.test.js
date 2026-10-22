import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';
import { AuthStore } from '../../cam-core/src/core-auth-store.js';
import { createIdentityRotation } from '../src/identity-rotation.js';
import { buildCoreApp } from '../../cam-core/src/server.js';
import { generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

test('cam-agent requires a local login, forces initial password change, and protects local task APIs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-local-auth-'));
  const app = await buildAgentApp({ dataDir, startWorker: false });
  try {
    await app.agentAuthStore.createUser({ username: 'agentadmin', displayName: 'Agent Admin', password: 'Initial-Agent-Password-2026', roles: ['AGENT_OPERATOR'] }, null, { bootstrap: true });
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

test('Agent upgrades the legacy AGENT_ADMIN role to AGENT_SYSTEM_ADMIN without losing access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-role-migration-'));
  let app = await buildAgentApp({ dataDir, startWorker: false });
  try {
    await app.agentAuthStore.createUser({ username: 'legacyadmin', displayName: 'Legacy Admin', password: 'Legacy-Agent-Password-2026', roles: ['AGENT_SYSTEM_ADMIN'] }, null, { bootstrap: true });
    app.agentAuthStore.db.prepare('UPDATE core_users SET roles_json = ?, must_change_password = 0 WHERE username = ?').run(JSON.stringify(['AGENT_ADMIN']), 'legacyadmin');
  } finally { await app.close(); }
  app = await buildAgentApp({ dataDir, startWorker: false });
  try {
    assert.deepEqual(app.agentAuthStore.listUsers()[0].roles, ['AGENT_SYSTEM_ADMIN']);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'legacyadmin', password: 'Legacy-Agent-Password-2026' } });
    const cookie = login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; ');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: { cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers: { cookie } })).statusCode, 200);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent AAA-backed accounts authenticate directly through the configured adapter', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-aaa-login-'));
  let authenticated = null;
  const app = await buildAgentApp({ dataDir, startWorker: false, aaaAdapter: { enabled: () => true, authenticate: async (credentials) => { authenticated = credentials; return { username: credentials.loginName }; } } });
  try {
    await app.agentAuthStore.createUser({ username: 'aaaoperator', displayName: 'AAA Operator', authSource: 'AAA', roles: ['AGENT_OPERATOR'] });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'aaaoperator', password: 'AAA-password' } });
    assert.equal(login.statusCode, 200, login.body);
    assert.deepEqual(authenticated, { loginName: 'aaaoperator', password: 'AAA-password' });
    assert.deepEqual(login.json().user.roles, ['AGENT_OPERATOR']);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent security administrators manage local and AAA users while other roles are denied', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-user-admin-'));
  const app = await buildAgentApp({ dataDir, startWorker: false });
  try {
    const securityAdmin = await app.agentAuthStore.createUser({ username: 'security1', displayName: '安全管理员', password: 'Initial-Agent-Password-2026', roles: ['AGENT_SECURITY_ADMIN'] }, null, { bootstrap: true });
    await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE user_id = ?').run(securityAdmin.id);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'security1', password: 'Initial-Agent-Password-2026' } });
    assert.equal(login.statusCode, 200, login.body);
    const adminHeaders = { cookie: login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': login.json().csrfToken };

    const listing = await app.inject({ method: 'GET', url: '/api/v1/users', headers: adminHeaders });
    assert.equal(listing.statusCode, 200, listing.body);
    assert.equal(listing.json().items.length, 1);
    assert.equal(listing.json().roles.AGENT_SECURITY_ADMIN, '安全管理员');

    const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: adminHeaders, payload: { username: 'operator1', displayName: '运维操作员', password: 'Initial-Operator-Password-2026', roles: ['AGENT_OPERATOR'], authSource: 'LOCAL' } });
    assert.equal(created.statusCode, 201, created.body);
    const userId = created.json().user.id;
    assert.equal(created.json().user.mustChangePassword, true);

    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/users/${encodeURIComponent(userId)}`, headers: adminHeaders, payload: { displayName: '云平台操作员', roles: ['AGENT_OPERATOR'], status: 'ACTIVE' } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().user.displayName, '云平台操作员');

    const reset = await app.inject({ method: 'POST', url: `/api/v1/users/${encodeURIComponent(userId)}/password`, headers: adminHeaders, payload: { password: 'Reset-Operator-Password-2026' } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(app.agentAuthStore.getUser(userId).mustChangePassword, true);

    const selfDisable = await app.inject({ method: 'PATCH', url: `/api/v1/users/${encodeURIComponent(securityAdmin.id)}`, headers: adminHeaders, payload: { status: 'DISABLED' } });
    assert.equal(selfDisable.statusCode, 400);

    const systemAdmin = await app.agentAuthStore.createUser({ username: 'system1', displayName: '系统管理员', password: 'Initial-System-Password-2026', roles: ['AGENT_SYSTEM_ADMIN'] });
    await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE user_id = ?').run(systemAdmin.id);
    const systemLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'system1', password: 'Initial-System-Password-2026' } });
    const systemHeaders = { cookie: systemLogin.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': systemLogin.json().csrfToken };
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: systemHeaders })).statusCode, 403);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent roles separate configuration, user administration, operations and audit access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-role-boundaries-'));
  const app = await buildAgentApp({ dataDir, startWorker: false });
  try {
    const roleAccounts = [
      ['security', 'AGENT_SECURITY_ADMIN'],
      ['system', 'AGENT_SYSTEM_ADMIN'],
      ['operator', 'AGENT_OPERATOR'],
      ['auditor', 'AGENT_AUDITOR']
    ];
    for (const [username, role] of roleAccounts) {
      await app.agentAuthStore.createUser({ username, displayName: username, password: 'Initial-Role-Password-2026', roles: [role] }, null, { bootstrap: username === 'security' });
      app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE username = ?').run(username);
    }
    const sessions = {};
    for (const [username] of roleAccounts) {
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'Initial-Role-Password-2026' } });
      assert.equal(login.statusCode, 200, login.body);
      sessions[username] = { cookie: login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': login.json().csrfToken };
    }

    const security = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: sessions.security })).json();
    assert.equal(security.permissions.userAdmin, true);
    assert.equal(security.permissions.businessRead, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: sessions.security })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: sessions.security })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers: sessions.security })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth-events', headers: sessions.security })).statusCode, 403);

    const system = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: sessions.system })).json();
    assert.equal(system.permissions.configRead, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: sessions.system })).statusCode, 200);
    assert.equal(system.permissions.businessRead, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers: sessions.system })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: sessions.system })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: sessions.system })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: sessions.security })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: sessions.operator })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: sessions.auditor })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth-events', headers: sessions.system })).statusCode, 403);

    const operator = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: sessions.operator })).json();
    assert.equal(operator.permissions.businessWrite, true);
    assert.equal(operator.permissions.deliveryWrite, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: sessions.operator })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers: sessions.operator })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/auth-events', headers: sessions.operator })).statusCode, 403);

    const auditor = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: sessions.auditor })).json();
    assert.equal(auditor.permissions.businessRead, true);
    assert.equal(auditor.permissions.businessWrite, false);
    assert.equal(auditor.permissions.auditRead, true);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/tasks', headers: sessions.auditor })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/tasks/pull', headers: sessions.auditor, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/delivery-grants', headers: sessions.auditor })).statusCode, 200);
    const events = await app.inject({ method: 'GET', url: '/api/v1/auth-events?limit=10', headers: sessions.auditor });
    assert.equal(events.statusCode, 200, events.body);
    assert.ok(events.json().items.some((event) => event.event_type === 'LOGIN_SUCCEEDED'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers: sessions.auditor })).statusCode, 403);
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
    dataDir: join(dataDir, 'agent'), startWorker: false,
    coreUrl: await core.listen({ host: '127.0.0.1', port: 0 }), corePublicKey: core.agentServiceIdentity.publicKeyPem
  };
  let app = await buildAgentApp(options);
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/identity/rotate', payload: {} })).statusCode, 401);
    await app.agentAuthStore.createUser({ username: 'admin', displayName: 'Admin', password: 'Agent-Integration-2026', roles: ['CORE_SYSTEM_ADMIN'] }, null, { bootstrap: true });
    await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0').run();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Agent-Integration-2026' } });
    assert.equal(login.statusCode, 200, login.body);
    const headers = { cookie: login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': login.json().csrfToken };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/identity/test', headers, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers })).json().agentId, registered.agentId, 'Core assigned ID is echoed to the Agent after signed key discovery');
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
    const relogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Agent-Integration-2026' } });
    const restartedHeaders = { cookie: relogin.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': relogin.json().csrfToken };
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/identity', headers: restartedHeaders })).json().agentId, registered.agentId, 'the echoed ID survives an Agent restart');
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

test('Agent upgrades the previously cached Core Agent ID into its local echo state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-id-migration-'));
  const identityPath = join(dataDir, 'identity.json');
  const agentId = 'AG-LEGACY-STABLE';
  await writeFile(`${identityPath}.rotation`, JSON.stringify({ policy: { agentId }, attempts: 0, retryAt: null }));
  try {
    let echoedId;
    const rotation = await createIdentityRotation({ identityPath, identity: generateIdentity(), request: async () => { throw new Error('not called'); }, onAgentId: (id) => { echoedId = id; } });
    assert.equal(rotation.status().agentId, agentId);
    assert.equal(echoedId, agentId);
    const legacy = await createIdentityRotation({ identityPath: join(dataDir, 'legacy.json'), identity: generateIdentity(), request: async () => { throw new Error('not called'); }, initialAgentId: 'AG-LEGACY-ENV' });
    assert.equal(legacy.status().agentId, 'AG-LEGACY-ENV');
  } finally { await rm(dataDir, { recursive: true, force: true }); }
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
  const signIn = async (app) => { await app.agentAuthStore.createUser({ username: 'admin', displayName: 'Admin', password: 'Agent-Integration-2026', roles: ['CORE_SYSTEM_ADMIN'] }, null, { bootstrap: true }); await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0').run(); const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: 'Agent-Integration-2026' } }); return { cookie: login.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': login.json().csrfToken }; };
  try { const response = await missing.inject({ method: 'POST', url: '/api/v1/identity/test', headers: await signIn(missing), payload: {} }); assert.equal(response.statusCode, 503); assert.equal(response.json().error.code, 'core_public_key_missing'); } finally { await missing.close(); }
  const tamperedDir = join(dataDir, 'tampered-agent'); await mkdir(tamperedDir); await writeFile(join(tamperedDir, 'identity.json'), JSON.stringify(identity));
  const tampered = await buildAgentApp({ ...options, dataDir: tamperedDir, corePublicKey: core.agentServiceIdentity.publicKeyPem, fetchImpl: async (...args) => { const response = await fetch(...args); const body = await response.arrayBuffer(); const bytes = Buffer.from(body); if (bytes.length) bytes[0] ^= 1; return new Response(bytes, { status: response.status, headers: response.headers }); } });
  try { const response = await tampered.inject({ method: 'POST', url: '/api/v1/identity/test', headers: await signIn(tampered), payload: {} }); assert.equal(response.statusCode, 502); assert.equal(response.json().error.code, 'core_response_signature_invalid'); }
  finally { await tampered.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});
