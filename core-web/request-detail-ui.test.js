import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core approval details keep the primary workflow visible and the file list compact', async () => {
  const [html, css, script] = await Promise.all([read('./index.html'), read('./core.css'), read('./core.js')]);
  assert.match(html, /<th>清单摘要<\/th><th>更新时间<\/th><th class="text-end">云管审批<\/th><th>操作<\/th>/u);
  assert.match(html, /id="detail-kicker"/u);
  assert.match(html, /id="detail-request-id"/u);
  assert.match(script, /const cloudKicker = .*cloudStatusLabels/su);
  assert.doesNotMatch(script, /技术标识与摘要/u);
  assert.doesNotMatch(script, /审批暗号/u);
  assert.doesNotMatch(script, /云管附件标识/u);
  assert.match(script, /正式制品文件清单/u);
  assert.match(script, /cloudResponseSummary/u);
  assert.match(script, /WITHDRAWN:'已撤回'/u);
  assert.match(script, /approval-requests\/\$\{encodeURIComponent\(id\)\}\/withdraw/u);
  assert.match(script, /撤回只改变 Core 本地审批状态/u);
  assert.match(script, /\$\('#withdraw-button'\)\?\.addEventListener\('click', async \(event\) => \{\s*const button = event\.currentTarget;\s*if \(!await confirmDialog/u);
  assert.doesNotMatch(script, /const parentDialog = \[\.\.\.document\.querySelectorAll\('dialog\[open\]'\)\]/u);
  assert.doesNotMatch(script, /parentDialog\.close\('confirmation'\)/u);
  assert.match(script, /openDetailSections/u);
  assert.match(script, /transfer-progress/u);
  assert.match(script, /Edge → Core 接收进度/u);
  assert.match(script, /文件与分块明细/u);
  assert.match(script, /ASSEMBLY_PENDING: '恢复中'/u);
  assert.match(script, /ASSEMBLING: '组装中'/u);
  assert.match(script, /VERIFY_FAILED: '校验不通过'/u);
  const transferPanel = script.match(/const transferPanel = ([\s\S]*?)const transferProgressPanel/u)?.[1] ?? '';
  assert.doesNotMatch(transferPanel, /Edge 最近错误|transferEdgeLastError|Edge 传输失败/u);
  assert.match(script, /edge-transfer-retry-button/u);
  assert.match(script, /approval-requests\/\$\{encodeURIComponent\(id\)\}\/transfer\/retry/u);
  assert.match(css, /\.cam-detail-advanced > summary \{[\s\S]*?cursor: pointer/u);
  assert.match(css, /\.cam-transfer-progress-summary/u);
});
