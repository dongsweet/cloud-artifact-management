import assert from 'node:assert/strict';
import test from 'node:test';
import { agentPage } from '../src/web.js';

test('Agent identity page makes trust direction and Core-owned rotation policy explicit', () => {
  const html = agentPage();
  assert.match(html, /Agent 公钥（登记到 Core）/);
  assert.match(html, /Core 服务公钥（从 Core 的“Agent 管理”复制）/);
  assert.match(html, /轮换周期和旧密钥过渡期由 Core 下发/);
  assert.match(html, /测试配对并同步状态/);
  assert.doesNotMatch(html, /立即轮换/);
});
