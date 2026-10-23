import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildAgentApp } from '../src/server.js';
import { buildCoreApp } from '../../cam-core/src/server.js';
import { generateIdentity } from '../../../libs/cam-agent-auth/src/protocol.js';

async function login(app) {
  await app.agentAuthStore.createUser({ username: 'operator', displayName: 'Agent Operator', password: 'Agent-Delivery-Password-2026', roles: ['AGENT_OPERATOR'] }, null, { bootstrap: true });
  app.agentAuthStore.db.prepare('UPDATE core_users SET must_change_password = 0').run();
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'operator', password: 'Agent-Delivery-Password-2026' } });
  return { cookie: response.headers['set-cookie'].map((value) => value.split(';')[0]).join('; '), 'x-cam-agent-csrf': response.json().csrfToken };
}

test('Agent creates human delivery grants for cached formal artifacts and records resumable downloads', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cam-agent-delivery-'));
  const coreDir = join(dataDir, 'core'); const agentDir = join(dataDir, 'agent'); await mkdir(agentDir, { recursive: true });
  const core = await buildCoreApp({ dataDir: coreDir, enableAuth: false });
  const payload = Buffer.from('formal artifact for local delivery'); const sha256 = createHash('sha256').update(payload).digest('hex'); const cachePath = join(agentDir, 'cache', sha256); await mkdir(join(agentDir, 'cache'), { recursive: true }); await writeFile(cachePath, payload);
  const identity = generateIdentity(); await writeFile(join(agentDir, 'identity.json'), JSON.stringify(identity));
  const registered = core.coreStore.registerAgent({ centerId: 'CENTER-1', name: 'delivery-agent', publicKey: identity.publicKeyPem }); core.coreStore.confirmAgentIdentity({ agentId: registered.agentId, currentKey: true, signingKeyId: identity.fingerprint });
  const db = core.coreStore.db; db.prepare(`INSERT INTO core_approval_requests (request_id, freeze_id, round_id, release_id, status, manifest_sha256, envelope_json, created_at, updated_at) VALUES ('REQ-DELIVERY', 'FREEZE-DELIVERY', 'ROUND-DELIVERY', 'REL-DELIVERY', 'APPROVED', ?, ?, '2026-01-01', '2026-01-01')`).run('a'.repeat(64), JSON.stringify({ productName: '曙光云 Stack', version: '8.0.6.2', roundNo: 2 })); db.prepare(`INSERT INTO core_transfer_tasks (transfer_task_id, request_id, status, manifest_sha256, created_at, updated_at) VALUES ('TR-DELIVERY', 'REQ-DELIVERY', 'RECEIVED', ?, '2026-01-01', '2026-01-01')`).run('a'.repeat(64)); db.prepare('INSERT INTO core_artifacts (sha256, size_bytes, file_path, received_at) VALUES (?, ?, ?, ?)').run(sha256, payload.length, cachePath, '2026-01-01'); db.prepare(`INSERT INTO core_release_artifacts (request_id, package_key, file_name, size_bytes, sha256) VALUES ('REQ-DELIVERY', 'control-node', 'control-node.tar.gz', ?, ?)`).run(payload.length, sha256);
  const coreUrl = await core.listen({ host: '127.0.0.1', port: 0 }); const app = await buildAgentApp({ dataDir: agentDir, agentId: registered.agentId, coreUrl, corePublicKey: core.agentServiceIdentity.publicKeyPem, startWorker: false });
  try {
    const headers = await login(app); const artifactId = 'BASELINE-REQ-DELIVERY';
    const available = await app.inject({ method: 'GET', url: '/api/v1/available-artifacts', headers });
    assert.equal(available.statusCode, 200, available.body); assert.equal(available.json().cacheSummary.totalVersionCount, 1); assert.equal(available.json().cacheSummary.cachedFileCount, 1); assert.equal(available.json().items[0].files[0].cacheState, 'READY'); assert.equal(available.json().items[0].agentStatus, 'CACHED');
    const summary = await app.inject({ method: 'GET', url: '/api/v1/cache/summary', headers });
    assert.equal(summary.statusCode, 200, summary.body); assert.equal(summary.json().item.cachedVersionCount, 1); assert.equal(summary.json().item.objectCount, 1);
    const taskId = 'DIST-DETAIL-DELIVERY'; const taskDb = app.agentAuthStore.db;
    taskDb.prepare(`INSERT INTO agent_tasks (task_id, artifact_id, status, progress_json, attempts, retry_at, last_error, updated_at) VALUES (?, ?, 'QUEUED', ?, 2, ?, ?, ?)`).run(taskId, artifactId, JSON.stringify({ state: 'downloading' }), new Date(Date.now() + 60_000).toISOString(), '模拟链路中断', new Date().toISOString());
    taskDb.prepare(`INSERT INTO agent_task_files (task_id, sha256, package_key, file_name, size_bytes, status, reused, completed_parts, total_parts, bytes_downloaded, last_error, updated_at) VALUES (?, ?, 'control-node', 'control-node.tar.gz', ?, 'COMPLETED', 1, 1, 1, ?, NULL, ?)`).run(taskId, sha256, payload.length, payload.length, new Date().toISOString());
    const taskDetail = await app.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}`, headers });
    assert.equal(taskDetail.statusCode, 200, taskDetail.body); assert.equal(taskDetail.json().item.displayStatus, 'RETRY_WAIT'); assert.equal(taskDetail.json().item.files[0].reused, true); assert.equal(taskDetail.json().item.files[0].completedParts, 1);
    assert.equal(available.json().items[0].roundId, 'ROUND-DELIVERY'); assert.equal(available.json().items[0].roundNo, 2);
    const created = await app.inject({ method: 'POST', url: '/api/v1/delivery-grants', headers, payload: { artifactId, expiresAt: new Date(Date.now() + 60_000).toISOString(), maxTotalSessions: 2, maxSessionsPerFile: 2 } });
    assert.equal(created.statusCode, 201, created.body); const grant = created.json(); assert.equal(grant.items.length, 1); assert.equal(grant.roundId, 'ROUND-DELIVERY'); assert.equal(grant.roundNo, 2); assert.match(grant.items[0].downloadUrl, /token=/);
    const listed = await app.inject({ method: 'GET', url: '/api/v1/delivery-grants', headers }); assert.equal(listed.statusCode, 200); assert.equal(listed.json().items[0].roundId, 'ROUND-DELIVERY'); assert.equal(listed.json().items[0].responsiblePerson.displayName, 'Agent Operator'); assert.equal(listed.json().items[0].responsiblePerson.username, 'operator');
    const first = await app.inject({ method: 'GET', url: grant.items[0].downloadUrl, headers: { range: 'bytes=0-5' } }); assert.equal(first.statusCode, 206, first.body); assert.deepEqual(first.rawPayload, payload.subarray(0, 6)); const sessionId = first.headers['x-cam-download-session'];
    const resumed = await app.inject({ method: 'GET', url: grant.items[0].downloadUrl, headers: { range: `bytes=6-${payload.length - 1}`, 'x-cam-download-session': sessionId } }); assert.equal(resumed.statusCode, 206, resumed.body); assert.deepEqual(resumed.rawPayload, payload.subarray(6));
    const detail = await app.inject({ method: 'GET', url: `/api/v1/delivery-grants/${grant.grantId}`, headers }); assert.equal(detail.statusCode, 200); assert.equal(detail.json().sessions.length, 1); assert.equal(detail.json().sessions[0].status, 'COMPLETED'); assert.equal(detail.json().responsiblePerson.displayName, 'Agent Operator'); assert.equal(detail.json().responsiblePerson.username, 'operator');
    const eventTypes = app.agentDeliveryStore.db.prepare('SELECT event_type FROM agent_delivery_events WHERE grant_id = ? ORDER BY rowid').all(grant.grantId).map((row) => row.event_type);
    assert.ok(eventTypes.includes('DOWNLOAD_INTERRUPTED'), eventTypes.join(',')); assert.ok(eventTypes.includes('DOWNLOAD_COMPLETED'), eventTypes.join(','));
    const revoked = await app.inject({ method: 'DELETE', url: `/api/v1/delivery-grants/${grant.grantId}`, headers }); assert.equal(revoked.statusCode, 200); assert.equal((await app.inject({ method: 'GET', url: grant.items[0].downloadUrl })).statusCode, 403);
    const manifest = await app.inject({ method: 'GET', url: `/api/v1/delivery-grants/${grant.grantId}/manifest?token=${grant.token}` }); assert.equal(manifest.statusCode, 403);
  } finally { await app.close(); await core.close(); await rm(dataDir, { recursive: true, force: true }); }
});

