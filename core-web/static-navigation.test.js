import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core declares all navigation groups and mounted pages in the HTML template', async () => {
  const [html, script] = await Promise.all([read('./index.html'), read('./core.js')]);
  for (const group of ['business', 'management', 'security', 'audit']) {
    assert.match(html, new RegExp(`data-menu-group="${group}"`));
  }
  assert.match(html, /data-menu-group-item="management"><a href="#aaa-config" class="nav-link" data-page="aaa-config"/u);
  assert.match(html, /data-menu-group-item="security"><a href="#users" class="nav-link" data-page="users"/u);
  assert.match(html, /data-menu-group-item="audit"><a href="#audit" class="nav-link" data-page="audit"/u);
  assert.match(html, /<section id="page-aaa-config" class="d-none"><div id="aaa-config-mount"><\/div><\/section>/u);
  assert.match(html, /<div id="audit-events-mount"><\/div>/u);
  assert.doesNotMatch(script, /cloudLink\.parentElement\.insertAdjacentHTML/u);
  assert.doesNotMatch(script, /usersItem\.insertAdjacentHTML/u);
  assert.doesNotMatch(script, /\$\('#page-cloud-config'\)\.insertAdjacentHTML/u);
  assert.match(script, /mountAaaConfig\(mount,/u);
  assert.match(script, /mountAuditEvents\(\$\('#audit-events-mount'\)/u);
  assert.match(script, /name="edgeTransferUrl"/u);
  assert.match(script, /legacyTransferInput\.readOnly = true/u);
  assert.match(script, /Edge 制品\/回执地址（内侧，暂不启用）/u);
});
