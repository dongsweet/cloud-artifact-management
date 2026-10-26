import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('Core and Agent use a single AAA config UI module', async () => {
  const [coreScript, sharedUi, coreCss, agentScript] = await Promise.all([
    read('./core.js'), read('../web-shared/aaa-config.js'), read('./core.css'), read('../agent-web/index.html')
  ]);
  assert.match(coreScript, /mountAaaConfig\(/u);
  assert.match(agentScript, /mountAaaConfig\(/u);
  assert.match(sharedUi, /id="aaa-skip-tls-verification"/u);
  assert.match(sharedUi, /id="aaa-test-dialog"[^]*id="aaa-test-login-name"/u);
  assert.match(sharedUi, /id="aaa-test-result" class="alert d-none mt-3 mb-0"[^]*role="status"/u);
  assert.match(sharedUi, /正在校验 AAA 用户和配置/u);
  assert.match(sharedUi, /校验成功，已读取用户/u);
  assert.doesNotMatch(sharedUi, /配置尚未保存/u);
  assert.match(coreCss, /\.cam-aaa-test-modal/u);
  assert.match(agentScript, /\.cam-aaa-test-modal/u);
});
