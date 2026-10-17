import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';
import { trustTestPeer } from '../../../libs/cam-gate/test-helper.js';

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
    const account = await app.authStore.createUser({ username: 'core-admin', displayName: 'Core Admin', password: 'Initial-Password-123', roles: ['CORE_ADMIN'] }, null, { bootstrap: true });
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
    const users = await app.inject({ method: 'GET', url: '/api/v1/users', headers: { cookie: coreCookie } });
    assert.equal(users.statusCode, 200, users.body);
    assert.equal(users.json().items.length, 1);
    assert.equal(users.json().roles.CORE_ADMIN, '内网发布审批管理员');
    const created = await app.inject({ method: 'POST', url: '/api/v1/users', headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: { username: 'operator1', displayName: '发布操作员', password: 'Operator-Password-123', roles: ['CORE_ADMIN'] } });
    assert.equal(created.statusCode, 201, created.body);
    const userId = created.json().user.id;
    const updated = await app.inject({ method: 'PATCH', url: `/api/v1/users/${encodeURIComponent(userId)}`, headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: { displayName: '云管审批操作员', roles: ['CORE_ADMIN'], status: 'ACTIVE' } });
    assert.equal(updated.statusCode, 200, updated.body);
    assert.equal(updated.json().user.displayName, '云管审批操作员');
    const reset = await app.inject({ method: 'POST', url: `/api/v1/users/${encodeURIComponent(userId)}/password`, headers: { cookie: coreCookie, 'x-cam-core-csrf': coreCsrf }, payload: { password: 'Reset-Password-789' } });
    assert.equal(reset.statusCode, 200, reset.body);
    assert.equal(reset.json().mustChangePassword, true);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/UNKNOWN/sync', headers: { cookie: coreCookie }, payload: {} })).statusCode, 403);

    const gate = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: { 'x-cam-gate-secret': 'gate-test' }, payload: { schemaVersion: 1, requestId: 'R-1', freezeId: 'F-1', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) } });
    assert.equal(gate.statusCode, 202, gate.body);
    assert.equal(cookieValue(relogin, 'cam_core_csrf'), coreCsrf);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('gate key authentication accepts the negotiated key and rejects unknown keys', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-gate-rotation-'));
  const app = await buildCoreApp({ dataDir, enableAuth: false, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) } });
  await trustTestPeer(app.gateKeyring, dataDir, 'edge');
  const payload = { schemaVersion: 1, requestId: 'R-ROTATE', freezeId: 'F-ROTATE', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) };
  try {
    for (const [index, secret] of ['gate-test', 'gate-test'].entries()) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: { 'x-cam-gate-secret': secret }, payload });
      assert.equal(response.statusCode, index === 0 ? 202 : 200, response.body);
    }
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: { 'x-cam-gate-secret': 'retired-gate-key' }, payload: { ...payload, requestId: 'R-ROTATE-2', freezeId: 'F-ROTATE-2' } });
    assert.equal(rejected.statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
