import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('AAA configuration exposes opt-in TLS verification bypass and saves its current value', async () => {
  const [script, html] = await Promise.all([read('./core.js'), read('./index.html')]);
  assert.match(script, /id="aaa-skip-tls-verification"[^>]*type="checkbox"/u);
  assert.match(script, /aaa-skip-tls-verification[^;]*item\.skipTlsVerification === true/u);
  assert.match(script, /skipTlsVerification: \$\('#aaa-skip-tls-verification'\)\.checked/u);
  assert.match(script, /勾选后不验证证书颁发机构、有效期和主机名/u);
  assert.match(html, /core\.js\?v=20261022-aaa-tls-verification/u);
});
