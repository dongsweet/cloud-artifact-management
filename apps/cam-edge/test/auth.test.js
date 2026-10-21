import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AuthStore } from '../src/auth-store.js';
import { buildEdgeApp } from '../src/app.js';

async function createPair() {
  const coreData = await mkdtemp(join(tmpdir(), 'cam-core-auth-'));
  const edgeData = await mkdtemp(join(tmpdir(), 'cam-edge-auth-'));
  const { buildCoreApp } = await import('../../cam-core/src/server.js');
  const core = await buildCoreApp({ dataDir: coreData, enableAuth: true, cloudAdapter: {} });
  const originalFetch = async (_url, init) => {
    const path = new URL(_url).pathname;
    const response = await core.inject({ method: init.method, url: path, headers: init.headers, ...(init.body ? { payload: init.body } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: response.headers });
  };
  const edge = await buildEdgeApp({ dataDir: edgeData, secureCookies: false, fetchImpl: originalFetch });
  await core.gateKeyring.trustPeer(await edge.gateKeyring.identity());
  await edge.gateKeyring.trustPeer(await core.gateKeyring.identity());
  await core.gateKeyring.markPeerConfirmed(); await edge.gateKeyring.markPeerConfirmed();
  edge.gateConfigStore.save({ coreControlUrl: 'http://core.test', coreTransferUrl: 'http://core.test' });
  return { core, edge, coreData, edgeData };
}

function headers(response) {
  return { cookie: response.headers['set-cookie'].map((value) => value.split(';', 1)[0]).join('; '), 'x-cam-csrf': response.json().csrfToken };
}

test('Edge 数据库不再创建本地账号和本地会话表', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const auth = new AuthStore(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('edge_users', 'edge_sessions')").all();
    assert.deepEqual(tables, []);
    assert.equal(typeof auth.createUser, 'undefined');
    assert.equal(typeof auth.login, 'undefined');
    assert.equal(typeof auth.changePassword, 'undefined');
  } finally { db.close(); }
});

test('Edge 系统管理员不能通过 Edge 管理账号', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-edge-system-admin-'));
  const app = await buildEdgeApp({ dataDir, principalProvider: () => ({ id: 'system-admin', type: 'TEST_IDP', roles: ['EDGE_SYSTEM_ADMIN'] }) });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/v1/users', payload: { username: 'should-deny' } });
    assert.equal(response.statusCode, 403);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Edge 委托 Core 登录，且角色变更对已有会话立即生效', async () => {
  const { core, edge, coreData, edgeData } = await createPair();
  try {
    const admin = await core.authStore.createUser({ username: 'core-admin', displayName: 'Core Admin', password: 'Core-Admin-Password-2026', roles: ['CORE_SYSTEM_ADMIN'] });
    await core.authStore.changePassword(admin.id, 'Core-Admin-Password-2027', admin.id, 'Core-Admin-Password-2026');
    const operator = await core.authStore.createUser({ username: 'edge-operator', displayName: 'Edge Operator', password: 'Edge-Operator-Password-2026', roles: [], edgeEnabled: true, edgeRoles: ['EDGE_OPERATOR'] });
    await core.authStore.changePassword(operator.id, 'Edge-Operator-Password-2027', operator.id, 'Edge-Operator-Password-2026');
    const loginResponse = await edge.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'edge-operator', password: 'Edge-Operator-Password-2027' } });
    assert.equal(loginResponse.statusCode, 200, loginResponse.body);
    const sessionHeaders = headers(loginResponse);
    assert.equal((await edge.inject({ url: '/api/v1/auth/me', headers: sessionHeaders })).statusCode, 200);
    const products = await edge.inject({ method: 'POST', url: '/api/v1/products', headers: sessionHeaders, payload: { name: 'role-test' } });
    assert.equal(products.statusCode, 201, products.body);

    core.authStore.updateUser(operator.id, { edgeRoles: ['EDGE_AUDITOR'] }, admin.id);
    assert.equal((await edge.inject({ method: 'POST', url: '/api/v1/products', headers: sessionHeaders, payload: { name: 'should-deny' } })).statusCode, 403);
    const productRead = await edge.inject({ url: '/api/v1/products', headers: sessionHeaders });
    assert.equal(productRead.statusCode, 200, productRead.body);

    core.authStore.updateUser(operator.id, { edgeEnabled: false, edgeRoles: [] }, admin.id);
    assert.equal((await edge.inject({ url: '/api/v1/auth/me', headers: sessionHeaders })).statusCode, 401);
  } finally { await edge.close(); await core.close(); await rm(coreData, { recursive: true, force: true }); await rm(edgeData, { recursive: true, force: true }); }
});

test('Edge 账号密码修改仍由 Core 完成', async () => {
  const { core, edge, coreData, edgeData } = await createPair();
  try {
    const operator = await core.authStore.createUser({ username: 'edge-password', displayName: 'Edge Password', password: 'Initial-Password-2026', roles: [], edgeEnabled: true, edgeRoles: ['EDGE_OPERATOR'] });
    const response = await edge.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'edge-password', password: 'Initial-Password-2026' } });
    assert.equal(response.statusCode, 200);
    const sessionHeaders = headers(response);
    assert.equal(response.json().user.mustChangePassword, true);
    const changed = await edge.inject({ method: 'POST', url: '/api/v1/auth/password', headers: sessionHeaders, payload: { oldPassword: 'Initial-Password-2026', password: 'Permanent-Password-2026' } });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal((await edge.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'edge-password', password: 'Permanent-Password-2026' } })).statusCode, 200);
    assert.equal((await core.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'edge-password', password: 'Permanent-Password-2026' } })).statusCode, 403);
    assert.ok(operator.id);
  } finally { await edge.close(); await core.close(); await rm(coreData, { recursive: true, force: true }); await rm(edgeData, { recursive: true, force: true }); }
});
