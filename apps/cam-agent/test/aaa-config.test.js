import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';

test('Agent AAA config uses system-admin RBAC, shared config behavior, persistence and secret redaction', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-aaa-config-'));
  const testCalls = [];
  const adapter = {
    enabled: () => true,
    authenticate: async ({ loginName }) => ({ username: loginName }),
    updateConfig: (config) => testCalls.push({ type: 'update', config }),
    testConfiguration: async (config, loginName) => { testCalls.push({ type: 'test', config, loginName }); return { valid: true, loginName, policy: { staticPasswordRequired: true } }; },
    fetch: async () => async () => {}
  };
  let app = await buildAgentApp({ dataDir, startWorker: false, aaaAdapter: adapter, fetchImpl: async () => ({}) });
  try {
    const system = await app.agentAuthStore.createUser({ username: 'aaa-system', displayName: '系统管理员', password: 'Initial-System-Password-2026', roles: ['AGENT_SYSTEM_ADMIN'] }, null, { bootstrap: true });
    await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE user_id = ?').run(system.id);
    const security = await app.agentAuthStore.createUser({ username: 'aaa-security', displayName: '安全管理员', password: 'Initial-Security-Password-2026', roles: ['AGENT_SECURITY_ADMIN'] });
    await app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0 WHERE user_id = ?').run(security.id);
    const login = async (username, password) => {
      const result = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password } });
      assert.equal(result.statusCode, 200, result.body);
      return { cookie: result.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': result.json().csrfToken };
    };
    const systemHeaders = await login('aaa-system', 'Initial-System-Password-2026');
    const securityHeaders = await login('aaa-security', 'Initial-Security-Password-2026');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: securityHeaders })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: systemHeaders })).statusCode, 200);
    const body = { baseUrl: 'https://aaa.example.test:8443', tenantName: 'CAM', accessServerName: 'Agent API', sharedSecret: 'agent-aaa-secret', timeoutMs: 12000, skipTlsVerification: true };
    const saved = await app.inject({ method: 'PUT', url: '/api/v1/aaa/config', headers: systemHeaders, payload: body });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().item.configured, true);
    assert.equal(saved.json().item.secretConfigured, true);
    assert.equal(JSON.stringify(saved.json()).includes('agent-aaa-secret'), false);
    assert.deepEqual(testCalls.find((call) => call.type === 'update').config, { ...body, allowHttp: false });
    const checked = await app.inject({ method: 'POST', url: '/api/v1/aaa/test', headers: systemHeaders, payload: { ...body, testLoginName: 'operator1' } });
    assert.equal(checked.statusCode, 200, checked.body);
    assert.equal(checked.json().check.loginName, 'operator1');
    assert.equal(testCalls.find((call) => call.type === 'test').config.sharedSecret, body.sharedSecret);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/v1/aaa/config', headers: securityHeaders, payload: body })).statusCode, 403);
    await app.close();
    app = await buildAgentApp({ dataDir, startWorker: false, aaaAdapter: adapter });
    const persisted = (await app.inject({ method: 'GET', url: '/api/v1/aaa/config', headers: systemHeaders })).json().item;
    assert.equal(persisted.baseUrl, body.baseUrl);
    assert.equal(persisted.secretConfigured, true);
    assert.equal(JSON.stringify(persisted).includes(body.sharedSecret), false);
    const moduleUi = await readFile(new URL('../../../web-shared/aaa-config.js', import.meta.url), 'utf8');
    assert.match(moduleUi, /mountAaaConfig/u);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
