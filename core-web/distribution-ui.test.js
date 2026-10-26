import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core Agent distribution keeps the information panel and aligns scheduling action right', async () => {
  const [html, css] = await Promise.all([read('./index.html'), read('./core.css')]);
  assert.match(html, /class="cam-distribution-intro"/u);
  assert.match(html, /安排传输/u);
  assert.match(css, /\.cam-distribution-footer \{[^}]*justify-content:\s*flex-start/u);
  assert.match(css, /\.cam-distribution-footer \.btn \{[^}]*margin-left:\s*auto/u);
  assert.match(css, /\.cam-distribution-footer \.btn \{ width: 100%; margin-left: 0; \}/u);
});
