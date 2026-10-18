import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildCoreApp } from '../src/server.js';

test('Core scopes queued distribution tasks and parallel file chunks to each Agent identity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-distribution-'));
  const payload = Buffer.from('a multi-chunk agent artifact');
  const sha = createHash('sha256').update(payload).digest('hex');
  const filePath = join(dataDir, 'artifact.bin'); await writeFile(filePath, payload);
  const app = await buildCoreApp({ dataDir, enableAuth: false });
  try {
    const db = app.coreStore.db;
    db.prepare(`INSERT INTO core_approval_requests (request_id, freeze_id, round_id, release_id, status, manifest_sha256, envelope_json, created_at, updated_at) VALUES ('REQ-AGENT', 'FREEZE-AGENT', 'ROUND-AGENT', 'REL-AGENT', 'APPROVED', ?, '{}', '2026-01-01', '2026-01-01')`).run('a'.repeat(64));
    db.prepare(`INSERT INTO core_transfer_tasks (transfer_task_id, request_id, status, manifest_sha256, created_at, updated_at) VALUES ('TR-AGENT', 'REQ-AGENT', 'RECEIVED', ?, '2026-01-01', '2026-01-01')`).run('a'.repeat(64));
    db.prepare('INSERT INTO core_artifacts (sha256, size_bytes, file_path, received_at) VALUES (?, ?, ?, ?)').run(sha, payload.length, filePath, '2026-01-01');
    db.prepare(`INSERT INTO core_release_artifacts (request_id, package_key, file_name, size_bytes, sha256) VALUES ('REQ-AGENT', 'pkg', 'artifact.bin', ?, ?)`).run(payload.length, sha);
    const west = app.coreStore.registerAgent({ centerId: 'CENTER-WEST', securityDomain: 'PROD', name: 'west-agent' });
    const east = app.coreStore.registerAgent({ centerId: 'CENTER-EAST', securityDomain: 'PROD', name: 'east-agent' });
    const task = app.coreStore.createDistributionTask({ agentId: west.agentId, artifactId: 'BASELINE-REQ-AGENT' });

    const noIdentity = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull' });
    assert.equal(noIdentity.statusCode, 401);
    const eastTasks = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: { 'x-cam-agent-token': east.token } });
    assert.equal(eastTasks.statusCode, 200, eastTasks.body); assert.deepEqual(eastTasks.json().items, []);
    const westTasks = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: { 'x-cam-agent-token': west.token } });
    assert.equal(westTasks.statusCode, 200, westTasks.body); assert.equal(westTasks.json().items[0].taskId, task.taskId);

    const chunk = await app.inject({ method: 'GET', url: `/api/v1/agent/tasks/${task.taskId}/files/${sha}/parts/1`, headers: { 'x-cam-agent-token': west.token, 'x-cam-chunk-size': '10' } });
    assert.equal(chunk.statusCode, 206, chunk.body); assert.equal(chunk.headers['content-range'], `bytes 10-19/${payload.length}`);
    assert.deepEqual(chunk.rawPayload, payload.subarray(10, 20));
    const crossed = await app.inject({ method: 'GET', url: `/api/v1/agent/tasks/${task.taskId}/files/${sha}/parts/0`, headers: { 'x-cam-agent-token': east.token, 'x-cam-chunk-size': '10' } });
    assert.equal(crossed.statusCode, 404);
    const completed = await app.inject({ method: 'POST', url: `/api/v1/agent/tasks/${task.taskId}/progress`, headers: { 'x-cam-agent-token': west.token }, payload: { status: 'COMPLETED', progress: { state: 'ready' } } });
    assert.equal(completed.statusCode, 200, completed.body); assert.equal(completed.json().item.status, 'COMPLETED');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
