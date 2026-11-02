import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Core cloud config page displays field-specific test and save errors', async () => {
  const script = await readFile(new URL('./core.js', import.meta.url), 'utf8');
  assert.match(script, /校验失败：\$\{error\.message\}/u);
  assert.match(script, /保存失败：\$\{error\.message\}/u);
  assert.doesNotMatch(script, /校验失败，请检查填写项后重新测试/u);
});
