import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('.', import.meta.url);
const read = (name) => readFile(new URL(name, root), 'utf8');

test('Core transfer monitor has separate Edge/Core-Agent task tables and task-level controls', async () => {
  const [html, script] = await Promise.all([read('index.html'), read('core.js')]);
  assert.match(html, /data-page="transfer-monitor"/u);
  assert.match(html, /id="monitor-edge-rows"/u);
  assert.match(html, /id="monitor-agent-rows"/u);
  assert.match(script, /\/api\/v1\/transfer-monitor/u);
  assert.match(script, /transfer\/retry/u);
  assert.match(script, /monitor-agent-retry/u);
  assert.match(script, /distribution-tasks\/.+\/control/u);
  assert.match(script, /data-action="pause"/u);
  assert.match(script, /data-action="cancel"/u);
  assert.match(script, /canCore\('businessWrite'\)/u);
  assert.match(html, /文件级只展示/u);
  assert.match(script, /已重新发起传输/u);
});

