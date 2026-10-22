import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from 'undici';
import { DkeyAmAdapter, readAaaConfig } from '../src/aaa-adapter.js';

const baseEnv = {
  CAM_AAA_BASE_URL: 'https://aaa.test:8443',
  CAM_AAA_TENANT_NAME: 'CAM',
  CAM_AAA_ACCESS_SERVER_NAME: 'CAM API',
  CAM_AAA_SHARED_SECRET: 'shared-secret',
};

test('DKEY AM configuration validates HTTPS and only reads real-time authentication settings', () => {
  const config = readAaaConfig(baseEnv);
  assert.equal(config.baseUrl, 'https://aaa.test:8443');
  assert.equal(config.skipTlsVerification, false);
  assert.equal(new DkeyAmAdapter({ config, fetchImpl: async () => new Response('{}') }).enabled(), true);
  assert.equal(readAaaConfig({ ...baseEnv, CAM_AAA_SKIP_TLS_VERIFICATION: 'true' }).skipTlsVerification, true);
  assert.throws(() => readAaaConfig({ ...baseEnv, CAM_AAA_BASE_URL: 'http://aaa.test:8443' }), /必须使用 HTTPS/);
});

test('skipping AAA TLS verification is opt-in and applies to probe and authentication requests', async () => {
  const requests = [];
  const adapter = new DkeyAmAdapter({ env: baseEnv, fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ success: true, errorCode: 0, data: {} }), { status: 200 });
  } });
  try {
    const config = readAaaConfig(baseEnv);
    await adapter.probe({ ...config, skipTlsVerification: true });
    assert.ok(requests[0].options.dispatcher instanceof Agent, 'unsaved probe option uses a temporary permissive TLS dispatcher');
    assert.equal(adapter.insecureDispatcher, undefined, 'temporary dispatcher is not retained');

    adapter.updateConfig({ ...config, skipTlsVerification: true });
    await adapter.authenticate({ loginName: 'u', password: 'p' });
    assert.ok(requests[1].options.dispatcher instanceof Agent, 'saved option is used for authentication');
    assert.equal(requests[1].options.dispatcher, adapter.insecureDispatcher);
  } finally { await adapter.close(); }
});

test('DKEY AM adapter sends real-time credentials as a form body', async () => {
  let request;
  const adapter = new DkeyAmAdapter({ env: baseEnv, fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ success: true, errorCode: 0, data: { username: 'zhangsan' } }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const result = await adapter.authenticate({ loginName: 'zhangsan', password: 'secret' });
  assert.equal(result.username, 'zhangsan');
  assert.equal(new URL(request.url).pathname, '/am/webauth/1/strong/authenticate');
  assert.match(request.options.headers['content-type'], /application\/x-www-form-urlencoded/);
  const form = new URLSearchParams(String(request.options.body));
  assert.equal(form.get('tenantName'), 'CAM');
  assert.equal(form.get('accessServerName'), 'CAM API');
  assert.equal(form.get('sharedSecret'), 'shared-secret');
  assert.equal(form.get('loginName'), 'zhangsan');
  assert.equal(form.get('password'), 'secret');
});

test('DKEY AM business rejection becomes an authentication failure; service failures stay retryable', async () => {
  const rejected = new DkeyAmAdapter({ env: baseEnv, fetchImpl: async () => new Response(JSON.stringify({ success: false, errorCode: 1001, message: 'invalid user' }), { status: 200 }) });
  await assert.rejects(() => rejected.authenticate({ loginName: 'u', password: 'wrong' }), (error) => error.statusCode === 401 && error.code === 'aaa_rejected');
  const unavailable = new DkeyAmAdapter({ env: baseEnv, fetchImpl: async () => new Response('{}', { status: 503 }) });
  await assert.rejects(() => unavailable.authenticate({ loginName: 'u', password: 'p' }), (error) => error.statusCode === 503 && error.code === 'aaa_api_error');
});

test('DKEY AM adapter never includes secrets in connection errors', async () => {
  const adapter = new DkeyAmAdapter({ env: baseEnv, fetchImpl: async () => { throw Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }); } });
  await assert.rejects(() => adapter.authenticate({ loginName: 'u', password: 'p' }), (error) => {
    assert.match(error.message, /AAA 连接失败/);
    assert.doesNotMatch(error.message, /shared-secret/);
    return true;
  });
});

