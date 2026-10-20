import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { renderGatePairing } from './gate-pairing.js';

test('Core and Edge pairing screens share the same component structure and role-specific controls', () => {
  const core = renderGatePairing('core');
  const edge = renderGatePairing('edge');
  const ids = (html) => [...html.matchAll(/\bid="([^"]+)"/gu)].map((match) => match[1]);
  const coreIds = ids(core);
  const edgeIds = ids(edge);
  assert.equal(new Set(coreIds).size, coreIds.length, 'Core component IDs are unique');
  assert.equal(new Set(edgeIds).size, edgeIds.length, 'Edge component IDs are unique');
  const edgeHooks = new Set(edgeIds);
  for (const id of edgeHooks) assert.ok(coreIds.includes(id), `Core includes shared hook ${id}`);
  assert.match(core, /本端 Core 身份/u);
  assert.match(core, /保存 Edge 身份/u);
  assert.match(core, /gate-schedule/u);
  assert.match(core, /立即轮换/u);
  assert.match(edge, /本端 Edge 身份/u);
  assert.match(edge, /保存 Core 身份/u);
  assert.match(edge, /由 Core 统一设置并发起密钥轮换/u);
  assert.doesNotMatch(edge, /gate-schedule/u);
  assert.ok(core.indexOf('id="gate-trust-peer"') < core.indexOf('id="gate-peer-edit"'), 'save action is beside and before re-pair');
  assert.ok(edge.indexOf('id="gate-trust-peer"') < edge.indexOf('id="gate-peer-edit"'), 'save action is beside and before re-pair');
  assert.throws(() => renderGatePairing('agent'), TypeError);
});

test('Core confirmation dialog is outside the requests page so it works from settings pages', async () => {
  const html = await readFile(new URL('../core-web/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="confirm-dialog"') < html.indexOf('id="page-requests"'));
});
