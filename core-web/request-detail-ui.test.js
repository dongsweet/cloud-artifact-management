import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core approval details keep the primary workflow visible and technical data collapsed', async () => {
  const [html, css, script] = await Promise.all([read('./index.html'), read('./core.css'), read('./core.js')]);
  assert.match(html, /<th>清单摘要<\/th><th>更新时间<\/th><th class="text-end">云管审批<\/th><th>操作<\/th>/u);
  assert.match(script, /cloudStatusBadge\(item\.cloudStatus\)/u);
  assert.match(script, /技术标识与摘要/u);
  assert.match(script, /正式制品文件清单/u);
  assert.match(script, /cloudResponseSummary/u);
  assert.match(css, /\.cam-detail-advanced > summary \{[\s\S]*?cursor: pointer/u);
});
