import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { buildCoreApp } from '../src/server.js';
import { CoreStore } from '../src/core-store.js';
import { generateIdentity, randomNonce, signRequest } from '../../../libs/cam-agent-auth/src/protocol.js';

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
    const westIdentity = generateIdentity(); const eastIdentity = generateIdentity();
    const west = app.coreStore.registerAgent({ centerId: 'CENTER-WEST', name: 'west-agent', publicKey: westIdentity.publicKeyPem });
    const east = app.coreStore.registerAgent({ centerId: 'CENTER-EAST', name: 'east-agent', publicKey: eastIdentity.publicKeyPem });
    assert.equal(west.status, 'PENDING');
    app.coreStore.confirmAgentIdentity({ agentId: west.agentId, currentKey: true, signingKeyId: westIdentity.fingerprint });
    app.coreStore.confirmAgentIdentity({ agentId: east.agentId, currentKey: true, signingKeyId: eastIdentity.fingerprint });
    const task = app.coreStore.createDistributionTask({ agentId: west.agentId, artifactId: 'BASELINE-REQ-AGENT' });

    const auth = (agent, identity, method, path, body = '') => { const timestamp = new Date().toISOString(); const nonce = randomNonce(); return { 'x-cam-agent-id': agent.agentId, 'x-cam-agent-timestamp': timestamp, 'x-cam-agent-nonce': nonce, 'x-cam-agent-signature': signRequest(identity.privateKeyPem, method, path, timestamp, nonce, body) }; };
    const availablePath = '/api/v1/agent/available-artifacts';
    const available = await app.inject({ method: 'GET', url: availablePath, headers: auth(east, eastIdentity, 'GET', availablePath) });
    assert.equal(available.statusCode, 200, available.body);
    assert.equal(available.json().items[0].artifactId, 'BASELINE-REQ-AGENT');
    const requestPath = '/api/v1/agent/distribution-tasks'; const requestBody = JSON.stringify({ artifactId: 'BASELINE-REQ-AGENT' });
    const requested = await app.inject({ method: 'POST', url: requestPath, headers: { ...auth(east, eastIdentity, 'POST', requestPath, requestBody), 'content-type': 'application/json' }, payload: JSON.parse(requestBody) });
    assert.equal(requested.statusCode, 201, requested.body);
    assert.equal(requested.json().item.agentId, east.agentId, 'Agent-requested pulls remain scoped to the authenticated Agent');

    const noIdentity = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull' });
    assert.equal(noIdentity.statusCode, 401);
    const eastTasks = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth(east, eastIdentity, 'POST', '/api/v1/agent/tasks/pull') });
    assert.equal(eastTasks.statusCode, 200, eastTasks.body); assert.equal(eastTasks.json().items[0].taskId, requested.json().item.taskId);
    const westTasks = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth(west, westIdentity, 'POST', '/api/v1/agent/tasks/pull') });
    assert.equal(westTasks.statusCode, 200, westTasks.body); assert.equal(westTasks.json().items[0].taskId, task.taskId);
    const replayTimestamp = new Date().toISOString(); const replayNonce = randomNonce();
    const replayHeaders = { 'x-cam-agent-id': west.agentId, 'x-cam-agent-timestamp': replayTimestamp, 'x-cam-agent-nonce': replayNonce, 'x-cam-agent-signature': signRequest(westIdentity.privateKeyPem, 'POST', '/api/v1/agent/tasks/pull', replayTimestamp, replayNonce, '') };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: replayHeaders })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: replayHeaders })).statusCode, 401, 'a nonce must not be reusable');
    const futureTimestamp = new Date(Date.now() + 4 * 60_000).toISOString(); const futureNonce = randomNonce();
    const futureHeaders = { 'x-cam-agent-id': west.agentId, 'x-cam-agent-timestamp': futureTimestamp, 'x-cam-agent-nonce': futureNonce, 'x-cam-agent-signature': signRequest(westIdentity.privateKeyPem, 'POST', '/api/v1/agent/tasks/pull', futureTimestamp, futureNonce) };
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: futureHeaders })).statusCode, 200);
    const futureExpiry = db.prepare('SELECT expires_at FROM core_agent_nonces WHERE agent_id = ? AND nonce = ?').get(west.agentId, futureNonce).expires_at;
    assert.ok(Date.parse(futureExpiry) >= Date.parse(futureTimestamp) + 5 * 60_000, 'retain nonces for the full validity period of a future timestamp');
    const rotatedIdentity = generateIdentity(); app.coreStore.rotateAgentKey(west.agentId, rotatedIdentity.publicKeyPem);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth(west, rotatedIdentity, 'POST', '/api/v1/agent/tasks/pull') })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth(west, westIdentity, 'POST', '/api/v1/agent/tasks/pull') })).statusCode, 200, 'the previous identity remains valid during the grace period');
    const finalIdentity = generateIdentity(); app.coreStore.rotateAgentKey(west.agentId, finalIdentity.publicKeyPem, new Date(Date.now() - 1_000).toISOString());
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth(west, rotatedIdentity, 'POST', '/api/v1/agent/tasks/pull') })).statusCode, 401, 'an expired previous identity must be rejected');

    const chunkPath = `/api/v1/agent/tasks/${task.taskId}/files/${sha}/parts/1`; const chunk = await app.inject({ method: 'GET', url: chunkPath, headers: { ...auth(west, finalIdentity, 'GET', chunkPath), 'x-cam-chunk-size': '10' } });
    assert.equal(chunk.statusCode, 206, chunk.body); assert.equal(chunk.headers['content-range'], `bytes 10-19/${payload.length}`);
    assert.deepEqual(chunk.rawPayload, payload.subarray(10, 20));
    const crossedPath = `/api/v1/agent/tasks/${task.taskId}/files/${sha}/parts/0`; const crossed = await app.inject({ method: 'GET', url: crossedPath, headers: { ...auth(east, eastIdentity, 'GET', crossedPath), 'x-cam-chunk-size': '10' } });
    assert.equal(crossed.statusCode, 404);
    const progressPath = `/api/v1/agent/tasks/${task.taskId}/progress`; const progressBody = JSON.stringify({ status: 'COMPLETED', progress: { state: 'ready' } }); const completed = await app.inject({ method: 'POST', url: progressPath, headers: { ...auth(west, finalIdentity, 'POST', progressPath, progressBody), 'content-type': 'application/json' }, payload: JSON.parse(progressBody) });
    assert.equal(completed.statusCode, 200, completed.body); assert.equal(completed.json().item.status, 'COMPLETED');

    const retryTask = app.coreStore.createDistributionTask({ agentId: east.agentId, artifactId: 'BASELINE-REQ-AGENT' });
    const retryProgressPath = `/api/v1/agent/tasks/${retryTask.taskId}/progress`;
    const retryProgressBody = JSON.stringify({ status: 'FAILED', progress: { state: 'downloading', completedParts: 0, totalParts: 1 }, error: '模拟链路中断' });
    const failed = await app.inject({ method: 'POST', url: retryProgressPath, headers: { ...auth(east, eastIdentity, 'POST', retryProgressPath, retryProgressBody), 'content-type': 'application/json' }, payload: JSON.parse(retryProgressBody) });
    assert.equal(failed.statusCode, 200, failed.body); assert.equal(failed.json().item.status, 'QUEUED'); assert.equal(failed.json().item.attempts, 1); assert.equal(failed.json().item.lastError, '模拟链路中断');
    const retryPath = `/api/v1/agent/tasks/${retryTask.taskId}/retry`;
    const retryBody = '{}';
    const retried = await app.inject({ method: 'POST', url: retryPath, headers: { ...auth(east, eastIdentity, 'POST', retryPath, retryBody), 'content-type': 'application/json' }, payload: {} });
    assert.equal(retried.statusCode, 200, retried.body); assert.equal(retried.json().item.status, 'QUEUED'); assert.equal(retried.json().item.lastError, '模拟链路中断'); assert.ok(Date.parse(retried.json().item.retryAt) <= Date.now());
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('Agent public-key registration works with the legacy NOT NULL token column', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE core_agents (
      agent_id TEXT PRIMARY KEY, center_id TEXT NOT NULL, security_domain TEXT NOT NULL,
      name TEXT NOT NULL, token_sha256 TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL, last_seen_at TEXT
    )`);
    const store = new CoreStore(db);
    const identity = generateIdentity();
    const first = store.registerAgent({ centerId: 'TEST', name: 'first', publicKey: identity.publicKeyPem });
    const second = store.registerAgent({ centerId: 'TEST', name: 'second', publicKey: generateIdentity().publicKeyPem });
    assert.notEqual(first.agentId, second.agentId);
    assert.throws(() => store.registerAgent({ centerId: 'TEST', name: 'duplicate-key', publicKey: identity.publicKeyPem }), { code: 'agent_public_key_duplicate' });
    assert.equal(Object.hasOwn(first, 'securityDomain'), false);
    assert.equal(Object.hasOwn(store.listAgents()[0], 'securityDomain'), false);
    assert.ok(!db.prepare('PRAGMA table_info(core_agents)').all().some((column) => column.name === 'security_domain'));
    const timestamp = new Date().toISOString(); const nonce = randomNonce(); const path = '/api/v1/agent/tasks/pull';
    assert.equal(first.status, 'PENDING');
    assert.equal(store.authenticateAgent({ agentId: first.agentId, timestamp, nonce, method: 'POST', path, signature: signRequest(identity.privateKeyPem, 'POST', path, timestamp, nonce) }), null);
    store.confirmAgentIdentity({ agentId: first.agentId, currentKey: true, signingKeyId: first.fingerprint });
    assert.equal(store.authenticateAgent({ agentId: first.agentId, timestamp, nonce: `${nonce}-active`, method: 'POST', path, signature: signRequest(identity.privateKeyPem, 'POST', path, timestamp, `${nonce}-active`) }).agentId, first.agentId);
    assert.equal(store.authenticateAgent({ token: db.prepare('SELECT token_sha256 FROM core_agents WHERE agent_id = ?').get(first.agentId).token_sha256 }), null);
  } finally { db.close(); }
});

test('Core applies one persisted rotation policy to every Agent and its next rotation', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-rotation-policy-'));
  const app = await buildCoreApp({ dataDir, enableAuth: false });
  try {
    const firstIdentity = generateIdentity();
    const first = app.coreStore.registerAgent({ centerId: 'TEST', name: 'policy-agent-1', publicKey: firstIdentity.publicKeyPem });
    app.coreStore.confirmAgentIdentity({ agentId: first.agentId, currentKey: true, signingKeyId: firstIdentity.fingerprint });
    assert.deepEqual(app.coreStore.getAgentRotationPolicy(), { rotationDays: 90, graceHours: 24 });

    assert.deepEqual(app.coreStore.setAgentRotationPolicy({ rotationDays: 30, graceHours: 12 }), { rotationDays: 30, graceHours: 12 });
    assert.equal(app.coreStore.getAgentIdentity(first.agentId).rotationDays, 30);
    assert.equal(app.coreStore.getAgentIdentity(first.agentId).graceHours, 12);
    const nextIdentity = generateIdentity();
    const rotated = app.coreStore.rotateAgentKey(first.agentId, nextIdentity.publicKeyPem);
    const graceMs = Date.parse(rotated.previousKeyExpiresAt) - Date.now();
    assert.ok(graceMs > 11.9 * 3600_000 && graceMs <= 12 * 3600_000);

    const second = app.coreStore.registerAgent({ centerId: 'TEST', name: 'policy-agent-2', publicKey: generateIdentity().publicKeyPem });
    assert.equal(app.coreStore.getAgentIdentity(second.agentId).rotationDays, 30);
    assert.equal(app.coreStore.getAgentIdentity(second.agentId).graceHours, 12);
    app.coreStore.setAgentRotationPolicy({ rotationDays: 7, graceHours: 6 });
    assert.equal(Date.parse(app.coreStore.getAgentIdentity(first.agentId).nextRotationAt), Date.parse(rotated.rotatedAt) + 7 * 86400_000);
    assert.equal(app.coreStore.getAgentIdentity(second.agentId).rotationDays, 7);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('disabling and re-enabling an Agent requires a fresh signed identity probe before business access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-reenable-'));
  const app = await buildCoreApp({ dataDir, enableAuth: false });
  try {
    const identity = generateIdentity();
    const agent = app.coreStore.registerAgent({ centerId: 'TEST', name: 'reenable-agent', publicKey: identity.publicKeyPem });
    const auth = (method, path, body = '') => {
      const timestamp = new Date().toISOString(); const nonce = randomNonce();
      return { 'x-cam-agent-id': agent.agentId, 'x-cam-agent-timestamp': timestamp, 'x-cam-agent-nonce': nonce, 'x-cam-agent-signature': signRequest(identity.privateKeyPem, method, path, timestamp, nonce, body) };
    };
    const probe = await app.inject({ method: 'GET', url: '/api/v1/agent/identity', headers: auth('GET', '/api/v1/agent/identity') });
    assert.equal(probe.statusCode, 200, probe.body);
    assert.equal(probe.headers['x-cam-core-signature']?.length > 20, true, 'identity probe response is signed by Core');
    const confirmBody = '';
    const confirmed = await app.inject({ method: 'POST', url: '/api/v1/agent/identity/confirm', headers: auth('POST', '/api/v1/agent/identity/confirm', confirmBody) });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal(confirmed.json().item.status, 'ACTIVE');
    assert.equal(app.coreStore.getAgentIdentity(agent.agentId).confirmedAt !== null, true);

    assert.equal(app.coreStore.setAgentStatus(agent.agentId, 'DISABLED'), true);
    assert.equal(app.coreStore.getAgentIdentity(agent.agentId).confirmedAt, null);
    assert.equal(app.coreStore.setAgentStatus(agent.agentId, 'ACTIVE'), true);
    assert.equal(app.coreStore.getAgentIdentity(agent.agentId).status, 'PENDING');
    assert.equal(app.coreStore.getAgentIdentity(agent.agentId).confirmedAt, null);
    const tasks = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth('POST', '/api/v1/agent/tasks/pull') });
    assert.equal(tasks.statusCode, 401);
    const pendingProbe = await app.inject({ method: 'GET', url: '/api/v1/agent/identity', headers: auth('GET', '/api/v1/agent/identity') });
    assert.equal(pendingProbe.statusCode, 200, pendingProbe.body);
    const pendingConfirm = await app.inject({ method: 'POST', url: '/api/v1/agent/identity/confirm', headers: auth('POST', '/api/v1/agent/identity/confirm') });
    assert.equal(pendingConfirm.statusCode, 200, pendingConfirm.body);
    assert.equal(pendingConfirm.json().item.status, 'ACTIVE');
    const resumedTasks = await app.inject({ method: 'POST', url: '/api/v1/agent/tasks/pull', headers: auth('POST', '/api/v1/agent/tasks/pull') });
    assert.equal(resumedTasks.statusCode, 200, resumedTasks.body);
    app.coreStore.setAgentStatus(agent.agentId, 'DISABLED');
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agent/identity', headers: auth('GET', '/api/v1/agent/identity') })).statusCode, 401);
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
