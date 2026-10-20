import assert from 'node:assert/strict';
import test from 'node:test';
import { agentPage } from '../src/web.js';

test('Agent identity page makes trust direction and Core-owned rotation policy explicit', () => {
  const html = agentPage();
  assert.match(html, /Agent 身份公钥/);
  assert.match(html, /Core 服务公钥/);
  assert.match(html, /Agent 接入与 Core 身份/);
  assert.match(html, /cam-agent-identity-panel/);
  assert.match(html, /轮换周期和旧密钥过渡期由 Core 下发/);
  assert.match(html, /测试配对并同步状态/);
  assert.doesNotMatch(html, /立即轮换/);
});
