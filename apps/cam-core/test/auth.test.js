import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';
import { signedTestHeaders, trustTestPeer } from '../../../libs/cam-gate/test-helper.js';

function cookies(response) { return response.headers['set-cookie'].map((value) => value.split(';', 1)[0]).join('; '); }
function cookieValue(response, name) { return response.headers['set-cookie'].map((value) => value.split(';', 1)[0]).find((value) => value.startsWith(`${name}=`)).slice(name.length + 1); }

test('Core local accounts are isolated, require password change, CSRF, and leave gate authentication independent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-local-auth-'));
  const app = await buildCoreApp({ dataDir, cloudAdapter: {
    createApproval: async () => ({ approvalId: 'APR-1' }),
    resolveMappings: async () => ({ priority: { id: '394', label: '常规变更' }, source: { id: '402', label: '内部需求' }, businessType: { id: '231', path: '平台类/其他' }, dept: { id: '215', label: '成都' }, team: { id: '3', label: '运维团队' }, processUserIds: ['2308'], processUsers: [{ userId: '2308', username: 'zhuren_luan' }], resolvedAt: new Date().toISOString() })
  } });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/approval-requests' })).statusCode, 401);
    assert.deepEqual(app.coreStore.list(), []);
    const account = await app.authStore.createUser({ username: 'core-admin', displayName: 'Core Admin', password: 'Initial-Password-123', roles: ['CORE_SYSTEM_ADMIN'] }, null, { bootstrap: true });
    assert.equal(account.mustChangePassword, true);

    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'core-admin', password: 'Initial-Password-123' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = cookies(login);
    const csrf = login.json().csrfToken;
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/approval-requests', headers: { cookie } })).statusCode, 403);
    const changed = await app.inject({ method: 'POST', url: '/api/v1/auth/password', headers: { cookie, 'x-cam-core-csrf': csrf }, payload: { oldPassword: 'Initial-Password-123', password: 'Updated-Password-456' } });
    assert.equal(changed.statusCode, 200, changed.body);

    const relogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'core-admin', password: 'Updated-Password-456' } });
    assert.equal(relogin.statusCode, 200, relogin.body);
    const coreCookie = cookies(relogin);
    const coreCsrf = relogin.json().csrfToken;
    app.coreStore.receiveApproval({ schemaVersion: 1, type: 'VERIFICATION_APPROVAL_REQUEST', requestId: 'FREEZE-MANUAL-RETRY', freezeId: 'FREEZE-MANUAL-RETRY', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) });
    const retryDenied = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-MANUAL-RETRY/retry', headers: { cookie: coreCookie }, payload: {} });
    assert.equal(retryDenied.statusCode, 403, 'manual retry requires CSRF');
    const retry = await app.inject({ method: 'POST', url: '/api/v1/approval-requests/FREEZE-MANUAL-RETRY/retry', headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: {} });
    assert.equal(retry.statusCode, 202, retry.body);
    assert.equal(retry.json().queued, true);
    for (let attempt = 0; attempt < 20 && app.coreStore.get('FREEZE-MANUAL-RETRY').status === 'CLOUD_PENDING'; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(app.coreStore.get('FREEZE-MANUAL-RETRY').cloudSubmissionState, 'SUBMITTED');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/approval-requests', headers: { cookie: coreCookie } })).statusCode, 200);
    const cloudConfig = { priorityLabel: '常规变更', sourceLabel: '内部需求', businessTypePath: '平台类/其他', deptName: '成都', teamName: '运维团队', processUserNames: 'zhuren_luan', titlePrefix: '发布审批' };
    const configSaved = await app.inject({ method: 'PUT', url: '/api/v1/cloud/config', headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: cloudConfig });
    assert.equal(configSaved.statusCode, 200, configSaved.body);
    assert.equal(configSaved.json().item.processUserNames, 'zhuren_luan');
    assert.deepEqual(configSaved.json().item.resolvedMappings.processUserIds, ['2308']);
    const invalidConfig = await app.inject({ method: 'PUT', url: '/api/v1/cloud/config', headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: { ...cloudConfig, processUserNames: '2308' } });
    assert.equal(invalidConfig.statusCode, 400);
    const systemUsers = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: coreCookie } });
    assert.equal(systemUsers.statusCode, 403, systemUsers.body);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: { username: 'system-must-not-create', displayName: '禁止创建', password: 'System-Forbidden-Password-2026', roles: ['CORE_OPERATOR'] } })).statusCode, 403);
    await app.authStore.createUser({ username: 'security-admin', displayName: '安全管理员', password: 'Security-Admin-Password-2026', roles: ['CORE_SECURITY_ADMIN'] });
    app.authStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE username = ?').run('security-admin');
    const securityLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'security-admin', password: 'Security-Admin-Password-2026' } });
    const securityCookie = cookies(securityLogin);
    const securityCsrf = securityLogin.json().csrfToken;
    const users = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: securityCookie } });
    assert.equal(users.statusCode, 200, users.body);
    assert.equal(users.json().items.length, 2);
    assert.equal(users.json().roles.CORE_SYSTEM_ADMIN, '系统管理员');
    const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: securityCookie, 'x-cam-core-csrf': securityCsrf }, payload: { username: 'operator1', displayName: '发布操作员', password: 'Operator-Password-123', roles: ['CORE_OPERATOR'] } });
    assert.equal(created.statusCode, 201, created.body);
    const userId = created.json().user.id;
    assert.equal(created.json().user.coreEnabled, true);
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/users/${encodeURIComponent(userId)}`, headers: { cookie: securityCookie, 'x-cam-core-csrf': securityCsrf }, payload: { displayName: '云管审批操作员', roles: ['CORE_OPERATOR'], coreEnabled: true } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().user.displayName, '云管审批操作员');
    assert.equal(updated.json().user.coreEnabled, true);
    const coreDisabled = await app.inject({ method: 'PATCH', url: `/api/v1/users/${encodeURIComponent(userId)}`, headers: { cookie: securityCookie, 'x-cam-core-csrf': securityCsrf }, payload: { coreEnabled: false } });
    assert.equal(coreDisabled.statusCode, 200, coreDisabled.body);
    assert.equal(coreDisabled.json().user.status, 'DISABLED');
    assert.equal(coreDisabled.json().user.coreEnabled, false);
    const reset = await app.inject({ method: 'POST', url: `/api/v1/users/${encodeURIComponent(userId)}/password`, headers: { cookie: securityCookie, 'x-cam-core-csrf': securityCsrf }, payload: { password: 'Reset-Password-789' } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.json().mustChangePassword, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/UNKNOWN/sync', headers: { cookie: coreCookie }, payload: {} })).statusCode, 403);

    const gatePayload = { schemaVersion: 1, requestId: 'R-1', freezeId: 'F-1', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) };
    const gatePath = '/api/v1/gate/approval-requests';
    const gate = await app.inject({ method: 'POST', url: gatePath, headers: await signedTestHeaders(app.gateKeyring, 'POST', gatePath, gatePayload), payload: gatePayload });
    assert.equal(gate.statusCode, 202, gate.body);
    assert.equal(cookieValue(relogin, 'cam_core_csrf'), coreCsrf);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('AAA accounts authenticate in real time but receive CAM roles from Core account management', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-aaa-auth-'));
  const calls = [];
  let aaaEnabled = true;
  const app = await buildCoreApp({ dataDir, aaaAdapter: {
    enabled: () => aaaEnabled,
    authenticate: async (credentials) => { calls.push(credentials); if (credentials.password !== 'AAA-password-123') throw Object.assign(new Error('rejected'), { statusCode: 401, code: 'aaa_rejected' }); return { username: credentials.loginName }; }
  } });
  try {
    await app.authStore.createUser({ username: 'local-admin', displayName: '本地管理员', password: 'Local-admin-123', roles: ['CORE_SYSTEM_ADMIN'] }, null, { bootstrap: true });
    app.authStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE username = ?').run('local-admin');
    const adminLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'local-admin', password: 'Local-admin-123' } });
    assert.equal(adminLogin.statusCode, 200);
    const adminHeaders = { cookie: cookies(adminLogin), 'x-cam-core-csrf': adminLogin.json().csrfToken };
    const initialAaaConfig = await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: adminHeaders });
    assert.equal(initialAaaConfig.statusCode, 200);
    const savedAaaConfig = await app.inject({ method: 'PUT', url: '/api/v1/aaa/config', headers: adminHeaders, payload: { baseUrl: 'https://aaa.example.test:8443', tenantName: 'CAM', accessServerName: 'CAM API', sharedSecret: 'page-managed-secret', timeoutMs: 12000, skipTlsVerification: true } });
    assert.equal(savedAaaConfig.statusCode, 200, savedAaaConfig.body);
    assert.equal(savedAaaConfig.json().item.baseUrl, 'https://aaa.example.test:8443');
    assert.equal(savedAaaConfig.json().item.secretConfigured, true);
    assert.equal(savedAaaConfig.json().item.skipTlsVerification, true);
    assert.equal(savedAaaConfig.json().item.sharedSecret, undefined);
    assert.equal(app.aaaConfigStore.get().config.sharedSecret, 'page-managed-secret');
    assert.equal(app.aaaConfigStore.get().config.skipTlsVerification, true);
    const loadedAaaConfig = await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: adminHeaders });
    assert.equal(loadedAaaConfig.json().item.skipTlsVerification, true);
    assert.equal(loadedAaaConfig.json().item.sharedSecret, undefined);
    const aaaTest = await app.inject({ method: 'POST', url: '/api/v1/aaa/test', headers: adminHeaders, payload: { baseUrl: 'https://aaa.example.test:8443', tenantName: 'CAM', accessServerName: 'CAM API', timeoutMs: 12000, skipTlsVerification: true } });
    assert.equal(aaaTest.statusCode, 200, aaaTest.body);
    const deniedAccountResponse = await app.inject({ method: 'POST', url: '/api/v1/users', headers: adminHeaders, payload: { username: 'aaa-denied', displayName: '不应创建', authSource: 'AAA', roles: ['CORE_OPERATOR'] } });
    assert.equal(deniedAccountResponse.statusCode, 403);
    await app.authStore.createUser({ username: 'aaa-security', displayName: 'AAA 安全管理员', password: 'AAA-Security-Password-2026', roles: ['CORE_SECURITY_ADMIN'] });
    app.authStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE username = ?').run('aaa-security');
    const securityLogin = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'aaa-security', password: 'AAA-Security-Password-2026' } });
    const securityHeaders = { cookie: cookies(securityLogin), 'x-cam-core-csrf': securityLogin.json().csrfToken };
    const accountResponse = await app.inject({ method: 'POST', url: '/api/v1/users', headers: securityHeaders, payload: { username: 'aaa-operator', displayName: 'AAA 操作员', authSource: 'AAA', roles: ['CORE_OPERATOR'] } });
    assert.equal(accountResponse.statusCode, 201, accountResponse.body);
    const account = accountResponse.json().user;
    assert.equal(account.authSource, 'AAA');
    assert.equal(account.mustChangePassword, false);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'aaa-operator', password: 'AAA-password-123' } });
    assert.equal(login.statusCode, 200, login.body);
    assert.deepEqual(calls, [{ loginName: 'aaa-operator', password: 'AAA-password-123' }]);
    const noRole = await app.authStore.createUser({ username: 'aaa-no-role', displayName: '无 Core 角色 AAA', authSource: 'AAA', roles: [], edgeEnabled: true, edgeRoles: ['EDGE_SYSTEM_ADMIN'] });
    assert.equal(noRole.authSource, 'AAA');
    const denied = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'aaa-no-role', password: 'AAA-password-123' } });
    assert.equal(denied.statusCode, 403);
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'aaa-operator', password: 'wrong-password' } });
    assert.equal(rejected.statusCode, 401);
    aaaEnabled = false;
    const unconfigured = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'aaa-operator', password: 'AAA-password-123' } });
    assert.equal(unconfigured.statusCode, 503);
    await assert.rejects(() => app.authStore.changePassword(account.id, 'Local-should-not-work-123', null), (error) => error.statusCode === 403 && error.code === 'external_password_managed');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Core roles separate business operations, platform configuration, and account administration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-role-auth-'));
  const app = await buildCoreApp({ dataDir, enableAuth: true });
  async function login(username, password) {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
    assert.equal(response.statusCode, 200, response.body);
    return { cookie: cookies(response), csrf: response.json().csrfToken };
  }
  try {
    await app.authStore.createUser({ username: 'bootstrap-admin', displayName: '初始化管理员', password: 'Bootstrap-admin-123', roles: ['CORE_SYSTEM_ADMIN'] }, null, { bootstrap: true });
    app.authStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE username = ?').run('bootstrap-admin');
    for (const [username, displayName, role] of [['business-operator', '业务操作员', 'CORE_OPERATOR'], ['security-admin', '安全管理员', 'CORE_SECURITY_ADMIN'], ['business-auditor', '业务审计员', 'CORE_AUDITOR']]) {
      await app.authStore.createUser({ username, displayName, password: 'Role-account-123', roles: [role] });
      app.authStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE username = ?').run(username);
    }
    await assert.rejects(() => app.authStore.createUser({ username: 'legacy-config', displayName: '无效角色', password: 'Role-account-123', roles: ['CORE_CONFIG_ADMIN'] }), /有效且不重复/);
    const operator = await login('business-operator', 'Role-account-123');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/approval-requests', headers: { cookie: operator.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/cloud/config', headers: { cookie: operator.cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: operator.cookie } })).statusCode, 403);
    const system = await login('bootstrap-admin', 'Bootstrap-admin-123');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: system.cookie } })).statusCode, 403);
    const config = await login('security-admin', 'Role-account-123');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agents', headers: { cookie: config.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/approval-requests', headers: { cookie: config.cookie } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: config.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: { cookie: config.cookie } })).statusCode, 200);
    const auditor = await login('business-auditor', 'Role-account-123');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/artifacts', headers: { cookie: auditor.cookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/unknown/retry', headers: { cookie: auditor.cookie }, payload: {} })).statusCode, 403);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('gate request authentication requires a fresh signature from the trusted Edge identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-gate-rotation-'));
  const app = await buildCoreApp({ dataDir, enableAuth: false, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) } });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const payload = { schemaVersion: 1, requestId: 'R-ROTATE', freezeId: 'F-ROTATE', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) };
  try {
    for (const [index] of [0, 1].entries()) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: await signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-requests', payload), payload });
      assert.equal(response.statusCode, index === 0 ? 202 : 200, response.body);
    }
    const forged = { ...await signedTestHeaders(app.gateKeyring, 'POST', '/api/v1/gate/approval-requests', payload), 'x-cam-gate-signature': 'forged' };
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: forged, payload: { ...payload, requestId: 'R-ROTATE-2', freezeId: 'F-ROTATE-2' } });
    assert.equal(rejected.statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
