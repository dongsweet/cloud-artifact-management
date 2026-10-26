import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core Agent distribution keeps the information panel and aligns scheduling action right', async () => {
  const [html, css, script, sharedJs, sharedCss] = await Promise.all([read('./index.html'), read('./core.css'), read('./core.js'), read('../web-shared/transfer-file-table.js'), read('../web-shared/transfer-file-table.css')]);
  assert.match(html, /class="cam-distribution-intro"/u);
  assert.match(html, /安排传输/u);
  assert.match(css, /\.cam-distribution-footer \{[^}]*justify-content:\s*flex-start/u);
  assert.match(css, /\.cam-distribution-footer \.btn \{[^}]*margin-left:\s*auto/u);
  assert.match(css, /\.cam-distribution-footer \.btn \{ width: 100%; margin-left: 0; \}/u);
  assert.match(html, /id="distribution-detail-close"/u);
  assert.match(css, /\.cam-detail-modal #distribution-detail-close \{[^}]*right:\s*\.9rem/u);
  assert.match(html, /transfer-file-table\.css/u);
  assert.match(script, /renderTransferFileTable/u);
  assert.match(sharedJs, /状态 \/ 分块进度/u);
  assert.match(sharedCss, /\.cam-transfer-file-table \{ table-layout: fixed; width: 100%; \}/u);
  assert.match(sharedCss, /nth-child\(1\)[\s\S]*?width: 44%;/u);
  assert.match(sharedCss, /nth-child\(2\)[\s\S]*?width: 10%;/u);
  assert.match(sharedCss, /nth-child\(3\)[\s\S]*?width: 18%;/u);
  assert.match(sharedCss, /nth-child\(4\)[\s\S]*?width: 28%;/u);
  assert.doesNotMatch(css, /#distribution-detail \.card-body > \.table-responsive > table/u);
});
