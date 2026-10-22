import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('AAA configuration exposes TLS bypass and keeps test results in its username modal', async () => {
  const [script, html, css] = await Promise.all([read('./core.js'), read('./index.html'), read('./core.css')]);
  assert.match(script, /id="aaa-skip-tls-verification"[^>]*type="checkbox"/u);
  assert.match(script, /aaa-skip-tls-verification[^;]*item\.skipTlsVerification === true/u);
  assert.match(script, /skipTlsVerification: \$\('#aaa-skip-tls-verification'\)\.checked/u);
  assert.match(script, /id="aaa-test-dialog"[^]*id="aaa-test-login-name"/u);
  assert.match(script, /<\/form><\/div><dialog id="aaa-test-dialog"/u);
  assert.match(script, /id="aaa-test-result" class="alert d-none mt-3 mb-0"[^>]*role="status"/u);
  assert.match(script, /setAaaTestResult\('success'/u);
  assert.match(script, /setAaaTestResult\('danger'/u);
  assert.match(script, /正在校验 AAA 用户和配置/u);
  assert.match(script, /JSON\.stringify\(\{ \.\.\.aaaConfigFormBody\(\), testLoginName \}\)/u);
  assert.match(script, /校验成功，已读取用户/u);
  assert.match(css, /\.cam-aaa-test-modal/u);
  assert.match(html, /core\.js\?v=20261022-session-expiry/u);
});
