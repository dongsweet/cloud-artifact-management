import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core account editor uses a single-column form and explicit local/AAA controls', async () => {
  const [html, script] = await Promise.all([read('./index.html'), read('./core.js')]);
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
  const sharedLayout = await read('../web-shared/layout.css');
  assert.match(sharedLayout, /\.cam-account-modal \{[^}]*width: min\(560px/u);
  assert.match(sharedLayout, /\.cam-account-modal > \.card \{[^}]*width: 100%; min-width: 0; max-width: 100%;/u);
  const coreCss = await read('./core.css');
  assert.match(coreCss, /\.app-main \.cam-account-modal > \.card \{ min-width: 0; \}/u);
  assert.match(script, /user-password-field'\)\.classList\.toggle\('d-none', editing\)/u);
  assert.match(script, /password\.disabled = editing \|\| aaa/u);
  assert.match(script, /password\.required = !editing && !aaa/u);
  assert.match(script, /coreEnabled: \$\('#user-core-enabled'\)\.checked/u);
  assert.match(script, /user-edge-enabled/u);
});

test('Core account list separates account type and uses matching login and password action styles', async () => {
  const [html, css, script] = await Promise.all([read('./index.html'), read('./core.css'), read('./core.js')]);
  assert.match(html, /<th>用户名 \/ 姓名<\/th><th>账号类型<\/th><th>角色<\/th><th>登录权限<\/th><th>最后登录<\/th><th class="text-end">操作<\/th>/u);
  assert.match(script, /const accountType = user\.authSource === 'AAA' \? 'AAA' : '本地'/u);
  assert.match(script, /cam-user-login-permissions[\s\S]*?Core：\\?\$\{coreEnabled \? '允许登录' : '已禁用'\}[\s\S]*?Edge：\\?\$\{edgeEnabled \? '允许登录' : '已禁用'\}/u);
  assert.match(script, /cam-user-password-action[\s\S]*?密码由 AAA 管理/u);
  assert.match(script, /data-user-reset="\\?\$\{escapeHtml\(user\.id\)\}"/u);
  assert.match(script, /colspan="6"[^>]*>暂无账号/u);
  assert.match(css, /\.cam-user-password-action \{ width: 8\.75rem; white-space: nowrap; \}/u);
});
