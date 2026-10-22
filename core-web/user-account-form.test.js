import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core account editor uses a single-column form and explicit local/AAA controls', async () => {
  const [html, css, script] = await Promise.all([read('./index.html'), read('./core.css'), read('./core.js')]);
  const start = html.indexOf('<div id="user-editor"');
  const end = html.indexOf('<div id="user-reset"', start);
  assert.notEqual(start, -1);
  const form = html.slice(start, end);
  assert.match(form, /name="user-auth-source" id="user-auth-local" value="LOCAL"/u);
  assert.match(form, /name="user-auth-source" id="user-auth-aaa" value="AAA"/u);
  assert.doesNotMatch(form, /id="user-auth-source"|class="row g-3"|col-md-6/u);
  assert.match(form, /id="user-core-enabled"[^>]*type="checkbox"[\s\S]*?允许登录 CAM Core/u);
  assert.doesNotMatch(form, /id="user-status"/u);
  assert.match(form, /id="user-password" type="text"/u);
  assert.match(form, /id="user-edge-enabled"/u);
  assert.doesNotMatch(form, /仅控制 Core 登录|启用 Edge 还需要至少一个 Edge 角色|CAM 不自动同步 AAA 用户/u);
  assert.match(html, /id="reset-password" type="text"/u);
  assert.match(css, /\.cam-user-modal \{[^}]*width: min\(560px/u);
  assert.match(css, /\.cam-user-modal > \.card \{[^}]*width: 100%; min-width: 0; max-width: 100%;/u);
  assert.match(script, /user-password-field'\)\.classList\.toggle\('d-none', editing\)/u);
  assert.match(script, /password\.disabled = editing \|\| aaa/u);
  assert.match(script, /password\.required = !editing && !aaa/u);
  assert.match(script, /coreEnabled: \$\('#user-core-enabled'\)\.checked/u);
  assert.match(script, /user-edge-enabled/u);
});
