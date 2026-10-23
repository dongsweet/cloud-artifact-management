import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Edge sidebar groups business, management, security and audit pages like Core', async () => {
  const [html, script] = await Promise.all([read('./index.html'), read('./account-ui.js')]);
  assert.match(html, /<span class="brand-text">CAM Edge<\/span>/u);
  assert.doesNotMatch(html, /<span class="brand-text fw-light">CAM Edge<\/span>/u);
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

test('download grant form binds the current operator and derives its total session limit', async () => {
  const [script, routes] = await Promise.all([read('./account-ui.js'), read('../apps/cam-edge/src/routes.js')]);
  assert.match(script, /id="grant-owner" class="form-control bg-body-secondary mb-3" readonly/u);
  assert.doesNotMatch(script, /id="grant-recipient"/u);
  assert.match(script, /input\('grant-total',[^\n]*readonly/u);
  assert.match(script, /selectedCount \* \(Number\.isSafeInteger\(perFile\)/u);
  assert.match(script, /maxSessionsPerFile: Number\(\$\('#grant-per-file'\)\.value\)/u);
  assert.match(script, /openGrant\(context\(\)\.roundId, context\(\)\.candidateId\)/u);
  assert.match(script, /roundId: grantScopeRoundId \|\| \$\('#grant-round'\)\.value \|\| null/u);
  assert.doesNotMatch(script, /redownload-grant-list/u);
  assert.doesNotMatch(script, /测试服务器下载/u);
  assert.doesNotMatch(script, /recipientId: \$\('#grant-recipient'\)\.value/u);
  assert.match(routes, /principalId: actor\.principalId,[\s\S]*?maxTotalSessions: Array\.isArray\(body\.candidateIds\) \? body\.candidateIds\.length \* body\.maxSessionsPerFile/u);
});
