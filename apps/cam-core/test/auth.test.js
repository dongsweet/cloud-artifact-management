import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';

function cookies(response) { return response.headers['set-cookie'].map((value) => value.split(';', 1)[0]).join('; '); }
function cookieValue(response, name) { return response.headers['set-cookie'].map((value) => value.split(';', 1)[0]).find((value) => value.startsWith(`${name}=`)).slice(name.length + 1); }

test('Core local accounts are isolated, require password change, CSRF, and leave gate authentication independent', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-local-auth-'));
  const app = await buildCoreApp({ dataDir, gateSecret: 'gate-test', cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) } });
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
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/approval-requests', headers: { cookie: coreCookie } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/approval-requests/UNKNOWN/sync', headers: { cookie: coreCookie }, payload: {} })).statusCode, 403);

    const gate = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: { 'x-cam-gate-secret': 'gate-test' }, payload: { schemaVersion: 1, requestId: 'R-1', freezeId: 'F-1', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) } });
    assert.equal(gate.statusCode, 202, gate.body);
    assert.equal(cookieValue(relogin, 'cam_core_csrf'), coreCsrf);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('gate key rotation accepts current and previous keys during overlap, but rejects retired keys', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-core-gate-rotation-'));
  const app = await buildCoreApp({ dataDir, gateSecret: 'new-gate-key', previousGateSecret: 'old-gate-key', enableAuth: false, cloudAdapter: { createApproval: async () => ({ approvalId: 'APR-1' }) } });
  const payload = { schemaVersion: 1, requestId: 'R-ROTATE', freezeId: 'F-ROTATE', roundId: 'ROUND-1', releaseId: 'REL-1', manifestSha256: 'a'.repeat(64) };
  try {
    for (const [index, secret] of ['new-gate-key', 'old-gate-key'].entries()) {
      const response = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: { 'x-cam-gate-secret': secret }, payload });
      assert.equal(response.statusCode, index === 0 ? 202 : 200, response.body);
    }
    const rejected = await app.inject({ method: 'POST', url: '/api/v1/gate/approval-requests', headers: { 'x-cam-gate-secret': 'retired-gate-key' }, payload: { ...payload, requestId: 'R-ROTATE-2', freezeId: 'F-ROTATE-2' } });
    assert.equal(rejected.statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
