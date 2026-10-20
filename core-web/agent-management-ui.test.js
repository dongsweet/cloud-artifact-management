import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Core Agent registration and service identity share one responsive card', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const start = html.indexOf('<section id="page-agents"');
  const end = html.indexOf('<dialog id="agent-rotation-dialog"', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const section = html.slice(start, end);
  assert.equal([...section.matchAll(/<div class="card(?: mt-3)?">/gu)].length, 2, 'one combined setup card plus the registered-Agent table');
  for (const id of ['agents-refresh', 'agent-form', 'agent-center', 'agent-name', 'agent-public-key', 'agent-default-rotation-days', 'agent-default-grace-hours', 'agent-service-public-key', 'agent-service-fingerprint', 'agent-service-rotate', 'agent-service-copy', 'agent-rows']) {
    assert.equal([...section.matchAll(new RegExp(`\\bid="${id}"`, 'gu'))].length, 1, `${id} remains present once`);
  }
  assert.match(section, /col-xl-6/u);
  assert.match(section, /agent-service-public-key" class="form-control font-monospace cam-gate-bundle" rows="7" readonly/u);
  assert.ok(section.indexOf('id="agent-service-rotate"') < section.indexOf('id="agent-service-public-key"'), 'service key action stays with its key block');
  assert.match(section, /button class="btn btn-primary btn-sm" type="submit" form="agent-form"/u, 'registration action stays in the section header');
  assert.ok(section.indexOf('id="agent-default-rotation-days"') < section.indexOf('id="agent-service-public-key"'), 'Agent rotation defaults sit in the row above the Core key, aligned with Agent connection fields');
  assert.match(section, /粘贴 Agent 身份公钥并登记/u);
  assert.match(section, /所有 Agent 信任同一份 Core 公钥/u);
});
