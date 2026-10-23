import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Edge sidebar groups business, management, security and audit pages like Core', async () => {
  const [html, script] = await Promise.all([read('./index.html'), read('./account-ui.js')]);
  for (const [group, label] of [['business', '业务'], ['management', '系统管理']]) {
    assert.match(html, new RegExp(`<li class="nav-header" data-menu-group="${group}">${label}</li>`, 'u'));
  }
  for (const [group, label] of [['security', '账号安全'], ['audit', '审计']]) {
    assert.match(script, new RegExp(`data-menu-group="${group}">${label}</li>`, 'u'));
  }
  for (const route of ['products', 'releases', 'rounds', 'candidates']) {
    assert.match(html, new RegExp(`data-menu-group-item="business"><a href="#${route}"`, 'u'));
  }
  assert.match(html, /id="gate-config-nav" data-menu-group-item="management"/u);
  assert.match(script, /id="grants-nav" data-menu-group-item="business"/u);
  assert.match(script, /id="users-nav" data-menu-group-item="security"/u);
  assert.match(script, /id="audit-nav" data-menu-group-item="audit"/u);
  assert.match(script, /\[data-menu-group\][\s\S]*?header\.classList\.toggle\('d-none', !items\.some\(\(item\) => !item\.classList\.contains\('d-none'\)\)\)/u);
});
