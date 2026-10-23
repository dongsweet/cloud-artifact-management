import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core session expiry returns to a usable login screen', async () => {
  const script = await read('./core.js');
  assert.match(script, /function showLogin\(\) \{[\s\S]*?currentUser = null;/u);
  assert.match(script, /function showLogin\(\) \{[\s\S]*?csrf = null;/u);
  assert.match(script, /document\.querySelectorAll\('dialog\[open\]'\)\.forEach\(\(dialog\) => dialog\.close\('session-expired'\)\)/u);
  assert.match(script, /document\.body\.classList\.remove\('modal-open'\)/u);
  assert.match(script, /document\.querySelectorAll\('\.modal-backdrop'\)\.forEach\(\(backdrop\) => backdrop\.remove\(\)\)/u);
  assert.match(script, /if \(response\.status === 401[^\n]+showLogin\(\)/u);
});

test('Core login screen contains no account type explanation', async () => {
  const html = await read('./index.html');
  const login = html.slice(html.indexOf('<div id="login"'), html.indexOf('<div id="password-change"'));
  assert.match(login, /id="login-form"/u);
  assert.doesNotMatch(login, /Core 本地应急账号|AAA 账号/u);
});

test('Core password change overlays the visible app and blocks dismissal until logout when forced', async () => {
  const [html, script, style] = await Promise.all([read('./index.html'), read('./core.js'), read('./core.css')]);
  assert.match(html, /<dialog id="password-change" class="cam-password-modal"/u);
  assert.match(script, /const dialog = \$\('#password-change'\); if \(!dialog\.open\) dialog\.showModal\(\)/u);
  assert.match(script, /if \(forcedPasswordChange\) event\.preventDefault\(\)/u);
  assert.match(script, /showPage\(pageFromHash\(\), !result\.user\.mustChangePassword\)/u);
  assert.doesNotMatch(style, /#password-change\s*\{/u);
});
