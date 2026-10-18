import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';

test('cam-agent requires a local login, forces initial password change, and protects local task APIs', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-local-auth-'));
  const app = await buildAgentApp({ dataDir, agentToken: '', startWorker: false });
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
