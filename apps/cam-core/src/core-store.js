import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { attachmentExtension, validAttachmentFileName } from '../../../libs/cam-server/src/attachment-types.js';
import { fingerprint, verifyRequest } from '../../../libs/cam-agent-auth/src/protocol.js';
import { maskApprovalCode } from './approval-code.js';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${Date.now()}-${randomUUID()}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw Object.assign(new Error(`${name} is required`), { code: 'invalid_message' });
  return value.trim();
}

function response(row) {
  if (!row) return null;
  const envelope = JSON.parse(row.envelope_json ?? '{}');
  return {
    requestId: row.request_id, freezeId: row.freeze_id, roundId: row.round_id, releaseId: row.release_id,
    productName: envelope.productName ?? null, version: envelope.version ?? null,
    approvalCodeConfigured: typeof envelope.approvalCode === 'string' && envelope.approvalCode.length > 0,
    revision: Number.isInteger(envelope.revision) ? envelope.revision : 0,
    displayVersion: envelope.displayVersion ?? (Number.isInteger(envelope.revision) && envelope.revision > 0 ? `${envelope.version}-r${envelope.revision}` : envelope.version),
    roundNo: Number.isInteger(envelope.roundNo) ? envelope.roundNo : null, reportTitle: envelope.reportTitle ?? null,
    status: row.status, manifestSha256: row.manifest_sha256, reportSha256: row.report_sha256,
    reportFileName: row.report_file_name, reportSize: row.report_size,
    reportReceived: Boolean(row.report_received_at), reportReceivedSha256: row.report_received_sha256,
    cloudAttachmentId: row.cloud_attachment_id, cloudApprovalId: row.cloud_approval_id,
    cloudTransferTaskId: row.cloud_transfer_task_id, cloudStatus: row.cloud_status,
    cloudWorkflowStep: row.cloud_workflow_step, cloudCheckedAt: row.cloud_checked_at, cloudResponseSummary: maskApprovalCode(row.cloud_response_summary, envelope.approvalCode),
    cloudMappingSnapshot: row.cloud_mapping_json ? JSON.parse(row.cloud_mapping_json) : null,
    cloudRequestSnapshot: row.cloud_request_json ? JSON.parse(maskApprovalCode(row.cloud_request_json, envelope.approvalCode)) : null,
    approvedAt: row.approved_at, expiresAt: row.expires_at, closeStatus: row.close_status,
    closeCheckedAt: row.close_checked_at, createdAt: row.created_at, updatedAt: row.updated_at,
    lastError: row.last_error, cloudSubmissionAttempts: row.cloud_submission_attempts ?? 0,
    cloudSubmissionState: row.cloud_submission_state ?? 'IDLE', cloudSubmissionAttemptedAt: row.cloud_submission_attempted_at ?? null,
    cloudRetryAt: row.cloud_retry_at ?? null,
    transferTaskId: row.transfer_task_id, transferStatus: row.transfer_status ?? null,
    transferNotificationState: row.transfer_notification_state ?? 'IDLE', transferNotificationAttempts: row.transfer_notification_attempts ?? 0,
    transferNotificationLastError: row.transfer_notification_error ?? null, transferNotificationNextAttemptAt: row.transfer_notification_next_attempt_at ?? null
  };
}

export class CoreStore {
  constructor(db, { dataDir = join(process.cwd(), 'data', 'core') } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this.reportDir = join(dataDir, 'verification-reports');
    this.artifactDir = join(dataDir, 'artifacts', 'sha256');
    db.exec(`
      CREATE TABLE IF NOT EXISTS core_approval_requests (
        request_id TEXT PRIMARY KEY, freeze_id TEXT NOT NULL UNIQUE, round_id TEXT NOT NULL, release_id TEXT NOT NULL,
        status TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, report_sha256 TEXT, report_file_name TEXT, report_size INTEGER, report_received_sha256 TEXT, report_path TEXT, report_received_at TEXT, envelope_json TEXT NOT NULL,
        cloud_approval_id TEXT, cloud_transfer_task_id TEXT, cloud_status TEXT, cloud_workflow_step TEXT, cloud_checked_at TEXT,
        cloud_mapping_json TEXT, cloud_request_json TEXT,
        approved_at TEXT, expires_at TEXT, close_status TEXT, close_checked_at TEXT, last_error TEXT,
        transfer_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_approval_status_idx ON core_approval_requests(status, updated_at);
      CREATE TABLE IF NOT EXISTS core_message_inbox (
        message_id TEXT PRIMARY KEY, message_type TEXT NOT NULL, request_id TEXT, payload_sha256 TEXT NOT NULL,
        received_at TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(message_type, request_id, payload_sha256)
      );
      CREATE TABLE IF NOT EXISTS core_transfer_tasks (
        transfer_task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES core_approval_requests(request_id),
        status TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_artifacts (
        sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
        size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
        file_path TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_release_artifacts (
        request_id TEXT NOT NULL REFERENCES core_approval_requests(request_id),
        package_key TEXT NOT NULL,
        candidate_id TEXT,
        file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        source TEXT,
        inherited_from_round_id TEXT,
        PRIMARY KEY (request_id, package_key)
      );
      CREATE INDEX IF NOT EXISTS core_release_artifacts_sha_idx ON core_release_artifacts(sha256);
      CREATE TABLE IF NOT EXISTS core_transfer_parts (
        transfer_task_id TEXT NOT NULL, sha256 TEXT NOT NULL, part_index INTEGER NOT NULL,
        chunk_size INTEGER NOT NULL, chunk_count INTEGER NOT NULL, byte_offset INTEGER NOT NULL,
        size_bytes INTEGER NOT NULL, part_sha256 TEXT NOT NULL, file_path TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (transfer_task_id, sha256, part_index)
      );
      CREATE INDEX IF NOT EXISTS core_transfer_parts_digest_idx ON core_transfer_parts(transfer_task_id, sha256);
      CREATE TABLE IF NOT EXISTS core_cloud_config (
        config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
        config_json TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_cloud_config_events (
        event_id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL,
        config_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_approval_result_outbox (
        request_id TEXT PRIMARY KEY REFERENCES core_approval_requests(request_id),
        event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('APPROVED','REJECTED')),
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT,
        delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_approval_result_outbox_pending_idx ON core_approval_result_outbox(delivered_at, next_attempt_at);
      CREATE TABLE IF NOT EXISTS core_transfer_outbox (
        request_id TEXT PRIMARY KEY REFERENCES core_approval_requests(request_id),
        event_id TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
        last_error TEXT, delivered_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_transfer_outbox_pending_idx ON core_transfer_outbox(delivered_at, next_attempt_at);
      CREATE TABLE IF NOT EXISTS core_agents (
        agent_id TEXT PRIMARY KEY, center_id TEXT NOT NULL,
        name TEXT NOT NULL, public_key TEXT, key_id TEXT, previous_public_key TEXT, previous_key_expires_at TEXT,
        token_sha256 TEXT, status TEXT NOT NULL DEFAULT 'ACTIVE',
        created_at TEXT NOT NULL, last_seen_at TEXT
      );
      CREATE INDEX IF NOT EXISTS core_agents_center_idx ON core_agents(center_id, status);
      CREATE TABLE IF NOT EXISTS core_distribution_tasks (
        task_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES core_agents(agent_id),
        artifact_id TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, files_json TEXT NOT NULL,
        status TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}', last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS core_distribution_queue_idx ON core_distribution_tasks(agent_id, status, created_at);
    `);
    const columns = new Set(db.prepare('PRAGMA table_info(core_approval_requests)').all().map((column) => column.name));
    const agentColumns = new Set(db.prepare('PRAGMA table_info(core_agents)').all().map((column) => column.name));
    if (agentColumns.has('security_domain')) {
      db.exec('DROP INDEX IF EXISTS core_agents_scope_idx; ALTER TABLE core_agents DROP COLUMN security_domain');
    }
    for (const [name, definition] of Object.entries({ public_key: 'TEXT', key_id: 'TEXT', previous_public_key: 'TEXT', previous_key_expires_at: 'TEXT', token_sha256: 'TEXT' })) if (!agentColumns.has(name)) db.exec(`ALTER TABLE core_agents ADD COLUMN ${name} ${definition}`);
    db.exec('CREATE TABLE IF NOT EXISTS core_agent_nonces (agent_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (agent_id, nonce))');
    const distributionColumns = new Set(db.prepare('PRAGMA table_info(core_distribution_tasks)').all().map((column) => column.name));
    if (!distributionColumns.has('attempts')) db.exec('ALTER TABLE core_distribution_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!distributionColumns.has('retry_at')) db.exec(`ALTER TABLE core_distribution_tasks ADD COLUMN retry_at TEXT NOT NULL DEFAULT '${now()}'`);
    if (!columns.has('cloud_mapping_json')) db.exec('ALTER TABLE core_approval_requests ADD COLUMN cloud_mapping_json TEXT');
    if (!columns.has('cloud_request_json')) db.exec('ALTER TABLE core_approval_requests ADD COLUMN cloud_request_json TEXT');
    if (!columns.has('cloud_workflow_step')) db.exec('ALTER TABLE core_approval_requests ADD COLUMN cloud_workflow_step TEXT');
    for (const [name, definition] of Object.entries({ report_file_name: 'TEXT', report_size: 'INTEGER', report_received_sha256: 'TEXT', report_path: 'TEXT', report_received_at: 'TEXT', cloud_attachment_id: 'TEXT', cloud_response_summary: 'TEXT' })) if (!columns.has(name)) db.exec(`ALTER TABLE core_approval_requests ADD COLUMN ${name} ${definition}`);
    for (const [name, definition] of Object.entries({ cloud_submission_attempts: 'INTEGER NOT NULL DEFAULT 0', cloud_submission_state: "TEXT NOT NULL DEFAULT 'IDLE'", cloud_submission_attempted_at: 'TEXT', cloud_retry_at: 'TEXT', transfer_notification_state: "TEXT NOT NULL DEFAULT 'IDLE'", transfer_notification_attempts: 'INTEGER NOT NULL DEFAULT 0' })) if (!columns.has(name)) db.exec(`ALTER TABLE core_approval_requests ADD COLUMN ${name} ${definition}`);
  }

  registerAgent({ centerId, name, publicKey }) {
    for (const [field, value] of Object.entries({ centerId, name })) if (typeof value !== 'string' || !value.trim() || value.length > 128) throw Object.assign(new Error(`${field} is required and must be at most 128 characters`), { code: 'agent_invalid' });
    if (typeof publicKey !== 'string' || !publicKey.includes('PUBLIC KEY')) throw Object.assign(new Error('publicKey is required; paste the Agent identity public key'), { code: 'agent_public_key_required' });
    let keyId; try { keyId = fingerprint(publicKey); } catch { throw Object.assign(new Error('Agent public key is invalid'), { code: 'agent_public_key_invalid' }); }
    const agentId = `AG-${randomUUID()}`;
    const timestamp = now();
    // Old databases require a unique token hash. Keep an inert value for that
    // constraint; authentication accepts signed identities only.
    this.db.prepare('INSERT INTO core_agents (agent_id, center_id, name, public_key, key_id, token_sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'ACTIVE\', ?)')
      .run(agentId, centerId.trim(), name.trim(), publicKey, keyId, digest(agentId), timestamp);
    return { agentId, centerId: centerId.trim(), name: name.trim(), keyId, fingerprint: keyId, status: 'ACTIVE', createdAt: timestamp };
  }
  authenticateAgent({ agentId, timestamp, nonce, signature, method, path, body = '' } = {}) {
    // Signature verification is intentionally independent of browser sessions.
    if (typeof agentId !== 'string' || typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') return null;
    const row = this.db.prepare("SELECT agent_id AS agentId, center_id AS centerId, name, public_key AS publicKey, previous_public_key AS previousPublicKey, previous_key_expires_at AS previousKeyExpiresAt, status FROM core_agents WHERE agent_id = ?").get(agentId);
    if (!row || row.status !== 'ACTIVE' || !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) return null;
    const keyOk = verifyRequest(row.publicKey, signature, method, path, timestamp, nonce, body) || (row.previousPublicKey && row.previousKeyExpiresAt && Date.parse(row.previousKeyExpiresAt) > Date.now() && verifyRequest(row.previousPublicKey, signature, method, path, timestamp, nonce, body));
    if (!keyOk) return null;
    this.db.prepare('DELETE FROM core_agent_nonces WHERE expires_at <= ?').run(now());
    try { this.db.prepare('INSERT INTO core_agent_nonces (agent_id, nonce, expires_at) VALUES (?, ?, ?)').run(row.agentId, nonce, new Date(Math.max(Date.now(), Date.parse(timestamp)) + 5 * 60_000).toISOString()); } catch { return null; }
    this.db.prepare('UPDATE core_agents SET last_seen_at = ? WHERE agent_id = ?').run(now(), row.agentId);
    delete row.publicKey; delete row.previousPublicKey; delete row.previousKeyExpiresAt; return row;
  }
  listAgents() {
    return this.db.prepare('SELECT agent_id AS agentId, center_id AS centerId, name, key_id AS keyId, key_id AS fingerprint, status, created_at AS createdAt, last_seen_at AS lastSeenAt, previous_key_expires_at AS previousKeyExpiresAt FROM core_agents ORDER BY created_at DESC').all();
  }
  rotateAgentKey(agentId, publicKey, previousKeyExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString()) {
    let keyId; try { keyId = fingerprint(publicKey); } catch { throw Object.assign(new Error('Agent public key is invalid'), { code: 'agent_public_key_invalid' }); }
    const result = this.db.prepare("UPDATE core_agents SET previous_public_key = public_key, previous_key_expires_at = ?, public_key = ?, key_id = ?, last_seen_at = ? WHERE agent_id = ? AND status = 'ACTIVE'").run(previousKeyExpiresAt, publicKey, keyId, now(), agentId);
    if (!result.changes) throw Object.assign(new Error('active agent not found'), { code: 'agent_not_found' });
    return { agentId, keyId, fingerprint: keyId, previousKeyExpiresAt };
  }
  setAgentStatus(agentId, status) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw Object.assign(new Error('invalid agent status'), { code: 'agent_invalid' });
    const result = this.db.prepare('UPDATE core_agents SET status = ? WHERE agent_id = ?').run(status, agentId);
    return result.changes > 0;
  }
  createDistributionTask({ agentId, artifactId }) {
    const agent = this.db.prepare("SELECT agent_id FROM core_agents WHERE agent_id = ? AND status = 'ACTIVE'").get(agentId);
    if (!agent) throw Object.assign(new Error('active agent not found'), { code: 'agent_not_found' });
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw Object.assign(new Error('正式制品版本不存在或尚未完成入库'), { code: 'artifact_not_found' });
    const files = artifact.files.map(({ packageKey, fileName, sizeBytes, sha256 }) => ({ packageKey, fileName, sizeBytes, sha256 }));
    if (!files.length || files.some((file) => !this.artifactPath(file.sha256))) throw Object.assign(new Error('正式制品文件未全部入库'), { code: 'artifact_incomplete' });
    const taskId = `DIST-${randomUUID()}`;
    const timestamp = now();
    this.db.prepare("INSERT INTO core_distribution_tasks (task_id, agent_id, artifact_id, manifest_sha256, files_json, status, retry_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?)")
      .run(taskId, agentId, artifactId, artifact.manifestSha256, JSON.stringify(files), timestamp, timestamp, timestamp);
    return this.getDistributionTask(taskId);
  }
  getDistributionTask(taskId) {
    const row = this.db.prepare('SELECT * FROM core_distribution_tasks WHERE task_id = ?').get(taskId);
    return row ? { taskId: row.task_id, agentId: row.agent_id, artifactId: row.artifact_id, manifestSha256: row.manifest_sha256, files: JSON.parse(row.files_json), status: row.status, progress: JSON.parse(row.progress_json), attempts: row.attempts, retryAt: row.retry_at, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at } : null;
  }
  listDistributionTasks() { return this.db.prepare('SELECT task_id FROM core_distribution_tasks ORDER BY created_at DESC LIMIT 500').all().map(({ task_id }) => this.getDistributionTask(task_id)); }
  listAgentTasks(agentId) {
    return this.db.prepare("SELECT task_id FROM core_distribution_tasks WHERE agent_id = ? AND status IN ('QUEUED','RUNNING') AND retry_at <= ? ORDER BY created_at LIMIT 20").all(agentId, now()).map(({ task_id }) => this.getDistributionTask(task_id));
  }
  updateDistributionTask(agentId, taskId, { status, progress = {}, error = null }) {
    const task = this.getDistributionTask(taskId);
    if (!task || task.agentId !== agentId) throw Object.assign(new Error('task not found for this agent'), { code: 'distribution_task_not_found' });
    if (!['RUNNING', 'COMPLETED', 'FAILED'].includes(status)) throw Object.assign(new Error('invalid distribution task status'), { code: 'distribution_status_invalid' });
    if (task.status === 'COMPLETED' && status !== 'COMPLETED') return task;
    const timestamp = now();
    const attempts = status === 'FAILED' ? task.attempts + 1 : task.attempts;
    const retryAt = status === 'FAILED' ? new Date(Date.now() + Math.min(300_000, 5_000 * (2 ** Math.min(attempts - 1, 6)))).toISOString() : timestamp;
    const persistedStatus = status === 'FAILED' ? 'QUEUED' : status;
    this.db.prepare('UPDATE core_distribution_tasks SET status = ?, attempts = ?, retry_at = ?, progress_json = ?, last_error = ?, updated_at = ?, completed_at = ? WHERE task_id = ? AND agent_id = ?')
      .run(persistedStatus, attempts, retryAt, JSON.stringify(progress), typeof error === 'string' ? error.slice(0, 1000) : null, timestamp, status === 'COMPLETED' ? timestamp : null, taskId, agentId);
    return this.getDistributionTask(taskId);
  }
  getAuthorizedDistributionFile(agentId, taskId, sha256) {
    const task = this.getDistributionTask(taskId);
    if (!task || task.agentId !== agentId || !['QUEUED', 'RUNNING'].includes(task.status)) return null;
    const file = task.files.find((entry) => entry.sha256 === String(sha256).toLowerCase());
    if (!file) return null;
    const path = this.artifactPath(file.sha256);
    return path ? { ...file, path } : null;
  }

  get(requestId) {
    const item = response(this.db.prepare('SELECT r.*, t.status AS transfer_status, o.last_error AS transfer_notification_error, o.next_attempt_at AS transfer_notification_next_attempt_at FROM core_approval_requests r LEFT JOIN core_transfer_tasks t ON t.request_id = r.request_id LEFT JOIN core_transfer_outbox o ON o.request_id = r.request_id WHERE r.request_id = ?').get(requestId));
    return item ? { ...item, artifacts: this.listReleaseArtifacts(requestId) } : null;
  }

  envelope(requestId) {
    const row = this.db.prepare('SELECT envelope_json FROM core_approval_requests WHERE request_id = ?').get(requestId);
    return row ? JSON.parse(row.envelope_json) : null;
  }
  approvalCode(requestId) {
    const row = this.db.prepare('SELECT envelope_json FROM core_approval_requests WHERE request_id = ?').get(requestId);
    const value = row ? JSON.parse(row.envelope_json ?? '{}').approvalCode : null;
    return typeof value === 'string' && value ? value : null;
  }
  updatePresentationMetadata(requestId, incoming) {
    const current = this.envelope(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (incoming?.releaseId !== current.releaseId || incoming?.roundId !== current.roundId || typeof incoming?.manifestSha256 !== 'string' || incoming.manifestSha256.toLowerCase() !== current.manifestSha256.toLowerCase()) {
      throw Object.assign(new Error('presentation metadata does not match the approved release, round, and manifest'), { code: 'presentation_mismatch' });
    }
    const productName = typeof incoming.productName === 'string' ? incoming.productName.trim().slice(0, 128) : '';
    const version = typeof incoming.version === 'string' ? incoming.version.trim().slice(0, 128) : '';
    const roundNo = Number.isInteger(incoming.roundNo) && incoming.roundNo > 0 ? incoming.roundNo : null;
    const reportTitle = typeof incoming.reportTitle === 'string' ? incoming.reportTitle.trim().slice(0, 200) : '';
    if (!productName || !version || !roundNo) throw Object.assign(new Error('productName, version, and roundNo are required'), { code: 'invalid_presentation' });
    const updated = { ...current, productName, version, roundNo, ...(reportTitle ? { reportTitle } : {}) };
    this.db.prepare('UPDATE core_approval_requests SET envelope_json = ? WHERE request_id = ?').run(JSON.stringify(updated), requestId);
    return this.get(requestId);
  }
  list() { return this.db.prepare('SELECT r.*, t.status AS transfer_status, o.last_error AS transfer_notification_error, o.next_attempt_at AS transfer_notification_next_attempt_at FROM core_approval_requests r LEFT JOIN core_transfer_tasks t ON t.request_id = r.request_id LEFT JOIN core_transfer_outbox o ON o.request_id = r.request_id ORDER BY r.created_at DESC LIMIT 500').all().map(response); }
  listCloudApprovalPending() {
    return this.db.prepare(`SELECT r.request_id FROM core_approval_requests r
      WHERE (r.status IN ('CLOUD_SUBMITTED','CLOUD_STATUS_UNCONFIRMED') AND r.cloud_approval_id IS NOT NULL)
         OR (r.status IN ('APPROVED','REJECTED') AND NOT EXISTS (SELECT 1 FROM core_approval_result_outbox o WHERE o.request_id = r.request_id))
      ORDER BY COALESCE(r.cloud_checked_at, r.created_at) ASC LIMIT 100`).all().map((row) => row.request_id);
  }
  enqueueApprovalResult(requestId) {
    const item = this.get(requestId);
    if (!item || !['APPROVED', 'REJECTED'].includes(item.status)) return null;
    const existing = this.db.prepare('SELECT * FROM core_approval_result_outbox WHERE request_id = ?').get(requestId);
    if (existing) {
      if (existing.status !== item.status) throw Object.assign(new Error('approval result changed after notification was queued'), { code: 'approval_result_conflict' });
      return { ...existing, payload: JSON.parse(existing.payload_json) };
    }
    const timestamp = now();
    const payload = {
      schemaVersion: 1, type: 'APPROVAL_RESULT', eventId: id('DECISION'),
      requestId: item.requestId, freezeId: item.freezeId, status: item.status,
      decidedAt: item.cloudCheckedAt ?? item.updatedAt
    };
    this.db.prepare('INSERT INTO core_approval_result_outbox (request_id, event_id, status, payload_json, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(requestId, payload.eventId, item.status, JSON.stringify(payload), timestamp, timestamp, timestamp);
    return { request_id: requestId, event_id: payload.eventId, status: item.status, payload_json: JSON.stringify(payload), attempts: 0, next_attempt_at: timestamp, last_error: null, delivered_at: null, created_at: timestamp, updated_at: timestamp, payload };
  }
  enqueueTransferReady(requestId) {
    const item = this.get(requestId);
    if (!item || item.status !== 'APPROVED' || !item.transferTaskId) return null;
    const existing = this.db.prepare('SELECT * FROM core_transfer_outbox WHERE request_id = ?').get(requestId);
    if (existing) return { ...existing, payload: JSON.parse(existing.payload_json) };
    const timestamp = now();
    const payload = {
      schemaVersion: 1, type: 'TRANSFER_READY', eventId: id('TRANSFER'),
      requestId: item.requestId, freezeId: item.freezeId, releaseId: item.releaseId,
      transferTaskId: item.transferTaskId, manifestSha256: item.manifestSha256,
      expiresAt: item.expiresAt ?? null
    };
    this.db.prepare('INSERT INTO core_transfer_outbox (request_id, event_id, payload_json, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(requestId, payload.eventId, JSON.stringify(payload), timestamp, timestamp, timestamp);
    return { request_id: requestId, event_id: payload.eventId, payload, attempts: 0, next_attempt_at: timestamp, last_error: null, delivered_at: null };
  }
  listPendingTransferReady(limit = 100) {
    return this.db.prepare('SELECT * FROM core_transfer_outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?').all(now(), limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }
  markTransferAttempt(eventId) {
    this.db.prepare('UPDATE core_transfer_outbox SET attempts = attempts + 1, updated_at = ? WHERE event_id = ? AND delivered_at IS NULL').run(now(), eventId);
    this.db.prepare("UPDATE core_approval_requests SET transfer_notification_state = 'SENDING', transfer_notification_attempts = transfer_notification_attempts + 1, updated_at = ? WHERE request_id = (SELECT request_id FROM core_transfer_outbox WHERE event_id = ?)").run(now(), eventId);
    return this.db.prepare('SELECT * FROM core_transfer_outbox WHERE event_id = ?').get(eventId);
  }
  markTransferDelivered(eventId) {
    const timestamp = now();
    this.db.prepare('UPDATE core_transfer_outbox SET delivered_at = ?, last_error = NULL, updated_at = ? WHERE event_id = ?').run(timestamp, timestamp, eventId);
    this.db.prepare("UPDATE core_approval_requests SET transfer_notification_state = 'DELIVERED', updated_at = ? WHERE request_id = (SELECT request_id FROM core_transfer_outbox WHERE event_id = ?)").run(timestamp, eventId);
  }
  markTransferFailure(eventId, error, retryAt) {
    this.db.prepare('UPDATE core_transfer_outbox SET last_error = ?, next_attempt_at = ?, updated_at = ? WHERE event_id = ? AND delivered_at IS NULL')
      .run(String(error?.message ?? error).slice(0, 1000), retryAt, now(), eventId);
    this.db.prepare("UPDATE core_approval_requests SET transfer_notification_state = 'RETRY_WAIT', updated_at = ? WHERE request_id = (SELECT request_id FROM core_transfer_outbox WHERE event_id = ?)").run(now(), eventId);
  }
  listPendingApprovalResults(limit = 100) {
    return this.db.prepare('SELECT * FROM core_approval_result_outbox WHERE delivered_at IS NULL AND next_attempt_at <= ? ORDER BY created_at ASC LIMIT ?').all(now(), limit)
      .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }
  markApprovalResultAttempt(eventId) {
    this.db.prepare('UPDATE core_approval_result_outbox SET attempts = attempts + 1, updated_at = ? WHERE event_id = ? AND delivered_at IS NULL').run(now(), eventId);
    return this.db.prepare('SELECT * FROM core_approval_result_outbox WHERE event_id = ?').get(eventId);
  }
  markApprovalResultDelivered(eventId) {
    const timestamp = now();
    this.db.prepare('UPDATE core_approval_result_outbox SET delivered_at = ?, last_error = NULL, updated_at = ? WHERE event_id = ?').run(timestamp, timestamp, eventId);
  }
  markApprovalResultFailure(eventId, error, retryAt) {
    this.db.prepare('UPDATE core_approval_result_outbox SET last_error = ?, next_attempt_at = ?, updated_at = ? WHERE event_id = ? AND delivered_at IS NULL')
      .run(String(error?.message ?? error).slice(0, 1000), retryAt, now(), eventId);
  }
  listArtifacts() {
    return this.db.prepare(`SELECT r.*, t.status AS transfer_status, t.updated_at AS transfer_received_at
      FROM core_approval_requests r JOIN core_transfer_tasks t ON t.request_id = r.request_id
      WHERE r.status IN ('APPROVED', 'CLOSED') AND t.status = 'RECEIVED'
      ORDER BY t.updated_at DESC LIMIT 500`).all().map((row) => this.serializeArtifact(row));
  }
  getArtifact(artifactId) {
    const prefix = 'BASELINE-';
    if (typeof artifactId !== 'string' || !artifactId.startsWith(prefix) || artifactId.length === prefix.length) return null;
    const row = this.db.prepare(`SELECT r.*, t.status AS transfer_status, t.updated_at AS transfer_received_at
      FROM core_approval_requests r JOIN core_transfer_tasks t ON t.request_id = r.request_id
      WHERE r.request_id = ? AND r.status IN ('APPROVED', 'CLOSED') AND t.status = 'RECEIVED'`).get(artifactId.slice(prefix.length));
    return row ? this.serializeArtifact(row) : null;
  }
  serializeArtifact(row) {
    const files = this.listReleaseArtifacts(row.request_id).map((file) => ({
      packageKey: file.packageKey,
      candidateId: file.candidateId,
      fileName: file.fileName,
      sizeBytes: file.sizeBytes,
      sha256: file.sha256,
      source: file.source,
      stored: file.stored,
      downloadUrl: file.stored ? `/api/v1/artifacts/${file.sha256}/content` : null
    }));
    const metadata = response(row);
    return {
      artifactId: `BASELINE-${row.request_id}`,
      artifactType: 'RELEASE_BASELINE',
      requestId: metadata.requestId,
      freezeId: metadata.freezeId,
      releaseId: metadata.releaseId,
      productName: metadata.productName,
      version: metadata.version,
      revision: metadata.revision,
      displayVersion: metadata.displayVersion,
      status: metadata.status,
      manifestSha256: metadata.manifestSha256,
      cloudApprovalId: metadata.cloudApprovalId,
      transferTaskId: metadata.transferTaskId,
      approvedAt: metadata.approvedAt,
      receivedAt: row.transfer_received_at,
      files
    };
  }
  listReleaseArtifacts(requestId) {
    return this.db.prepare(`SELECT ra.package_key AS packageKey, ra.candidate_id AS candidateId,
      ra.file_name AS fileName, ra.size_bytes AS sizeBytes, ra.sha256,
      ra.source, ra.inherited_from_round_id AS inheritedFromRoundId,
      (a.sha256 IS NOT NULL) AS stored
      FROM core_release_artifacts ra LEFT JOIN core_artifacts a ON a.sha256 = ra.sha256
      WHERE ra.request_id = ? ORDER BY ra.package_key`).all(requestId).map((item) => ({ ...item, stored: Boolean(item.stored) }));
  }
  artifactPath(sha256) {
    if (!/^[a-f0-9]{64}$/i.test(String(sha256))) return null;
    const normalized = sha256.toLowerCase();
    return this.db.prepare('SELECT file_path FROM core_artifacts WHERE sha256 = ?').get(normalized)?.file_path ?? null;
  }
  listTransferParts(transferTaskId, sha256) {
    return this.db.prepare('SELECT part_index AS partIndex, chunk_size AS chunkSize, chunk_count AS chunkCount, byte_offset AS offset, size_bytes AS size, part_sha256 AS sha256 FROM core_transfer_parts WHERE transfer_task_id = ? AND sha256 = ? ORDER BY part_index')
      .all(transferTaskId, String(sha256).toLowerCase());
  }
  async saveTransferPart(transferTaskId, sha256, part) {
    const transfer = this.expectedTransferArtifacts(transferTaskId);
    const digestValue = String(sha256).toLowerCase();
    const expected = transfer.items.find((item) => String(item.actualSha256 ?? '').toLowerCase() === digestValue);
    if (!expected) throw Object.assign(new Error('artifact digest is not in the approved manifest'), { code: 'artifact_not_approved' });
    const existing = this.db.prepare('SELECT * FROM core_transfer_parts WHERE transfer_task_id = ? AND sha256 = ? LIMIT 1').get(transferTaskId, digestValue);
    if (existing && (existing.chunk_size !== part.chunkSize || existing.chunk_count !== part.chunkCount)) throw Object.assign(new Error('分块参数与已有断点不一致'), { code: 'artifact_chunk_conflict' });
    if (!Number.isSafeInteger(part.index) || part.index < 0 || !Number.isSafeInteger(part.chunkSize) || part.chunkSize <= 0 || !Number.isSafeInteger(part.chunkCount) || part.chunkCount <= 0 || !Number.isSafeInteger(part.offset) || part.offset < 0 || !Number.isSafeInteger(part.size) || part.size < 0 || !/^[a-f0-9]{64}$/i.test(String(part.sha256 ?? ''))) throw Object.assign(new Error('制品分块参数无效'), { code: 'artifact_chunk_invalid' });
    const expectedCount = Math.ceil(Number(expected.sizeBytes) / part.chunkSize);
    const expectedOffset = part.index * part.chunkSize;
    const expectedSize = Math.min(part.chunkSize, Number(expected.sizeBytes) - expectedOffset);
    if (!Number.isSafeInteger(Number(expected.sizeBytes)) || part.chunkCount !== expectedCount || part.index >= expectedCount || part.offset !== expectedOffset || part.size !== expectedSize) throw Object.assign(new Error('制品分块位置或大小与清单不匹配'), { code: 'artifact_chunk_invalid' });
    const path = join(this.dataDir, 'transfers', transferTaskId, 'parts', digestValue, String(part.index).padStart(8, '0'));
    await mkdir(dirname(path), { recursive: true });
    await rm(path, { force: true });
    await rename(part.temporaryPath, path);
    this.db.prepare(`INSERT INTO core_transfer_parts (transfer_task_id, sha256, part_index, chunk_size, chunk_count, byte_offset, size_bytes, part_sha256, file_path, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transfer_task_id, sha256, part_index) DO UPDATE SET
      chunk_size = excluded.chunk_size, chunk_count = excluded.chunk_count, byte_offset = excluded.byte_offset,
      size_bytes = excluded.size_bytes, part_sha256 = excluded.part_sha256, file_path = excluded.file_path, updated_at = excluded.updated_at`)
      .run(transferTaskId, digestValue, part.index, part.chunkSize, part.chunkCount, part.offset, part.size, part.sha256, path, now());
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM core_transfer_parts WHERE transfer_task_id = ? AND sha256 = ?').get(transferTaskId, digestValue).count;
    return { path, receivedParts: count, chunkCount: part.chunkCount, complete: count === part.chunkCount };
  }
  async assembleTransferParts(transferTaskId, sha256) {
    const digestValue = String(sha256).toLowerCase();
    const transfer = this.expectedTransferArtifacts(transferTaskId);
    const expected = transfer.items.find((item) => String(item.actualSha256 ?? '').toLowerCase() === digestValue);
    if (!expected) throw Object.assign(new Error('artifact digest is not in the approved manifest'), { code: 'artifact_not_approved' });
    const rows = this.db.prepare('SELECT * FROM core_transfer_parts WHERE transfer_task_id = ? AND sha256 = ? ORDER BY part_index').all(transferTaskId, digestValue);
    if (!rows.length || rows.length !== rows[0].chunk_count) return { complete: false, receivedParts: rows.length, chunkCount: rows[0]?.chunk_count ?? 0 };
    const temporaryPath = join(this.dataDir, 'tmp', `artifact-${randomUUID()}.assembled`);
    await mkdir(dirname(temporaryPath), { recursive: true });
    const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
    const hash = createHash('sha256');
    let totalSize = 0;
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        if (row.part_index !== index || row.chunk_size !== rows[0].chunk_size || row.chunk_count !== rows[0].chunk_count) throw Object.assign(new Error('制品分块记录不连续'), { code: 'artifact_chunk_incomplete' });
        const partHash = createHash('sha256');
        let partSize = 0;
        for await (const chunk of createReadStream(row.file_path)) {
          partHash.update(chunk); hash.update(chunk); partSize += chunk.length; totalSize += chunk.length;
          if (!output.write(chunk)) await once(output, 'drain');
        }
        if (partSize !== row.size_bytes || partHash.digest('hex') !== row.part_sha256) throw Object.assign(new Error(`制品分块 ${index} 文件校验失败`), { code: 'artifact_chunk_integrity_failed' });
      }
      output.end();
      await once(output, 'close');
      const fullDigest = hash.digest('hex');
      if (totalSize !== Number(expected.sizeBytes) || fullDigest !== digestValue) throw Object.assign(new Error('组装后的制品大小或 SHA-256 与获批清单不一致'), { code: 'artifact_integrity_failed' });
      const received = await this.receiveArtifact(transferTaskId, digestValue, temporaryPath, totalSize, fullDigest);
      for (const row of rows) await rm(row.file_path, { force: true });
      this.db.prepare('DELETE FROM core_transfer_parts WHERE transfer_task_id = ? AND sha256 = ?').run(transferTaskId, digestValue);
      return { complete: true, ...received };
    } catch (error) {
      output.destroy();
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  expectedTransferArtifacts(transferTaskId) {
    const task = this.db.prepare(`SELECT t.*, r.status AS approval_status, r.envelope_json
      FROM core_transfer_tasks t JOIN core_approval_requests r ON r.request_id = t.request_id
      WHERE t.transfer_task_id = ?`).get(transferTaskId);
    if (!task || task.approval_status !== 'APPROVED') throw Object.assign(new Error('transfer task is not approved'), { code: 'approval_required' });
    const envelope = JSON.parse(task.envelope_json ?? '{}');
    const manifest = envelope.manifest;
    if (!manifest || !Array.isArray(manifest.items)) return { requestId: task.request_id, manifestSha256: task.manifest_sha256, items: [] };
    return { requestId: task.request_id, manifestSha256: task.manifest_sha256, items: manifest.items };
  }
  setTransferManifest(transferTaskId, manifest) {
    const task = this.db.prepare(`SELECT t.*, r.status AS approval_status, r.envelope_json
      FROM core_transfer_tasks t JOIN core_approval_requests r ON r.request_id = t.request_id
      WHERE t.transfer_task_id = ?`).get(transferTaskId);
    if (!task || task.approval_status !== 'APPROVED') throw Object.assign(new Error('transfer task is not approved'), { code: 'approval_required' });
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.items) || manifest.items.length === 0 || manifest.items.length > 20_000) throw Object.assign(new Error('manifest.items must contain 1 to 20000 entries'), { code: 'artifact_manifest_invalid' });
    if (digest(JSON.stringify(manifest)) !== task.manifest_sha256) throw Object.assign(new Error('manifest content does not match approved SHA-256'), { code: 'manifest_mismatch' });
    const packageKeys = new Set();
    for (const item of manifest.items) {
      if (!item || typeof item.packageKey !== 'string' || !item.packageKey.trim() || item.packageKey.length > 255 || typeof item.fileName !== 'string' || !item.fileName.trim() || item.fileName.length > 255 || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || typeof item.actualSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.actualSha256)) throw Object.assign(new Error('manifest contains an invalid artifact entry'), { code: 'artifact_manifest_invalid' });
      const key = item.packageKey.trim().toLowerCase();
      if (packageKeys.has(key)) throw Object.assign(new Error('manifest contains duplicate packageKey values'), { code: 'artifact_manifest_invalid' });
      packageKeys.add(key);
    }
    const envelope = JSON.parse(task.envelope_json ?? '{}');
    if (envelope.manifest && digest(JSON.stringify(envelope.manifest)) !== task.manifest_sha256) throw Object.assign(new Error('a different manifest is already bound to this approval'), { code: 'manifest_mismatch' });
    envelope.manifest = manifest;
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE core_approval_requests SET envelope_json = ?, updated_at = ? WHERE request_id = ?').run(JSON.stringify(envelope), timestamp, task.request_id);
      for (const item of manifest.items) {
        this.db.prepare(`INSERT INTO core_release_artifacts (request_id, package_key, candidate_id, file_name, size_bytes, sha256, source, inherited_from_round_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id, package_key) DO UPDATE SET candidate_id = excluded.candidate_id,
          file_name = excluded.file_name, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, source = excluded.source,
          inherited_from_round_id = excluded.inherited_from_round_id`)
          .run(task.request_id, String(item.packageKey), item.candidateId ?? null, String(item.fileName), Number(item.sizeBytes), String(item.actualSha256).toLowerCase(), item.source ?? null, item.inheritedFromRoundId ?? null);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { requestId: task.request_id, transferTaskId, manifestSha256: task.manifest_sha256, fileCount: manifest.items.length };
  }
  async receiveArtifact(transferTaskId, sha256, temporaryPath, actualSize, actualSha256) {
    const transfer = this.expectedTransferArtifacts(transferTaskId);
    const digestValue = String(sha256).toLowerCase();
    const expected = transfer.items.filter((item) => String(item.actualSha256 ?? '').toLowerCase() === digestValue);
    if (!expected.length) throw Object.assign(new Error('artifact digest is not in the approved manifest'), { code: 'artifact_not_approved' });
    const expectedSize = Number(expected[0].sizeBytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize !== actualSize || actualSha256 !== digestValue || expected.some((item) => Number(item.sizeBytes) !== expectedSize)) {
      throw Object.assign(new Error('artifact size or SHA-256 does not match approved manifest'), { code: 'artifact_integrity_failed' });
    }
    const destination = join(this.artifactDir, digestValue.slice(0, 2), digestValue.slice(2, 4), digestValue);
    await mkdir(dirname(destination), { recursive: true });
    const existing = this.db.prepare('SELECT * FROM core_artifacts WHERE sha256 = ?').get(digestValue);
    if (existing) {
      const info = await stat(existing.file_path).catch(() => null);
      let existingDigest = null;
      if (info?.isFile() && info.size === actualSize) {
        const existingHash = createHash('sha256');
        for await (const chunk of createReadStream(existing.file_path)) existingHash.update(chunk);
        existingDigest = existingHash.digest('hex');
      }
      if (existingDigest === digestValue) await rm(temporaryPath, { force: true });
      else await rename(temporaryPath, destination);
    } else await rename(temporaryPath, destination);
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO core_artifacts (sha256, size_bytes, file_path, received_at) VALUES (?, ?, ?, ?) ON CONFLICT(sha256) DO UPDATE SET size_bytes = excluded.size_bytes, file_path = excluded.file_path')
        .run(digestValue, actualSize, destination, timestamp);
      for (const item of expected) {
        this.db.prepare(`INSERT INTO core_release_artifacts (request_id, package_key, candidate_id, file_name, size_bytes, sha256, source, inherited_from_round_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id, package_key) DO UPDATE SET candidate_id = excluded.candidate_id,
          file_name = excluded.file_name, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, source = excluded.source,
          inherited_from_round_id = excluded.inherited_from_round_id`)
          .run(transfer.requestId, String(item.packageKey), item.candidateId ?? null, String(item.fileName), expectedSize, digestValue, item.source ?? null, item.inheritedFromRoundId ?? null);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { sha256: digestValue, sizeBytes: actualSize, reused: Boolean(existing), packages: expected.map((item) => item.packageKey) };
  }
  assertTransferComplete(transferTaskId) {
    const transfer = this.expectedTransferArtifacts(transferTaskId);
    const hashes = [...new Set(transfer.items.map((item) => String(item.actualSha256 ?? '').toLowerCase()))];
    const missing = hashes.filter((sha256) => !this.artifactPath(sha256));
    if (missing.length) throw Object.assign(new Error(`approved artifacts are not all stored (${missing.length} missing)`), { code: 'artifacts_incomplete' });
    return transfer;
  }
  listCloudPending() { return this.db.prepare("SELECT request_id FROM core_approval_requests WHERE status = 'CLOUD_PENDING' AND cloud_approval_id IS NULL AND (cloud_retry_at IS NULL OR cloud_retry_at <= ?) ORDER BY created_at ASC LIMIT 100").all(now()).map((row) => row.request_id); }
  getByFreeze(freezeId) { return response(this.db.prepare('SELECT * FROM core_approval_requests WHERE freeze_id = ?').get(freezeId)); }

  getCloudConfig() {
    const row = this.db.prepare('SELECT * FROM core_cloud_config WHERE config_id = 1').get();
    if (!row) return null;
    return { ...JSON.parse(row.config_json), updatedBy: row.updated_by, updatedAt: row.updated_at };
  }

  saveCloudConfig(input, actorId, resolvedMappings) {
    const keys = ['priorityLabel', 'sourceLabel', 'businessTypePath', 'deptName', 'teamName', 'processUserNames', 'titlePrefix'];
    const config = Object.fromEntries(keys.map((key) => [key, String(input?.[key] ?? '').trim()]));
    if (!config.priorityLabel || !config.sourceLabel || !config.businessTypePath || !config.deptName || !config.teamName) {
      throw Object.assign(new Error('工单级别、来源、业务类型、部门和团队不能为空'), { code: 'cloud_config_invalid' });
    }
    if (!/^[^,\s]+(,[^,\s]+)*$/.test(config.processUserNames) || config.processUserNames.split(',').some((name) => /^\d+$/.test(name))) throw Object.assign(new Error('请填写一个或多个审批处理人用户名，多个用户名用逗号分隔'), { code: 'cloud_config_invalid' });
    if (!config.titlePrefix) config.titlePrefix = '云平台制品验证报告审批';
    if (!resolvedMappings) throw Object.assign(new Error('请先测试云管连接并解析工单参数'), { code: 'cloud_mapping_required' });
    config.resolvedMappings = resolvedMappings;
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO core_cloud_config (config_id, config_json, updated_by, updated_at) VALUES (1, ?, ?, ?)
        ON CONFLICT(config_id) DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(JSON.stringify(config), actorId ?? null, timestamp);
      this.db.prepare('INSERT INTO core_cloud_config_events VALUES (?, ?, ?, ?, ?)').run(id('CFG'), actorId ?? null, 'UPDATED', JSON.stringify(config), timestamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getCloudConfig();
  }

  receiveApproval(envelope) {
    const requestId = required(envelope.requestId, 'requestId');
    const freezeId = required(envelope.freezeId, 'freezeId');
    const roundId = required(envelope.roundId, 'roundId');
    const releaseId = required(envelope.releaseId, 'releaseId');
    const manifestSha256 = required(envelope.manifestSha256, 'manifestSha256').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw Object.assign(new Error('manifestSha256 must be SHA-256'), { code: 'invalid_message' });
    if (envelope.manifest !== undefined) {
      if (!envelope.manifest || typeof envelope.manifest !== 'object' || !Array.isArray(envelope.manifest.items) || envelope.manifest.items.length === 0 || envelope.manifest.items.length > 20_000) throw Object.assign(new Error('manifest.items must contain 1 to 20000 entries'), { code: 'artifact_manifest_invalid' });
      const packageKeys = new Set();
      for (const item of envelope.manifest.items) {
        if (!item || typeof item.packageKey !== 'string' || !item.packageKey.trim() || item.packageKey.length > 255 || typeof item.fileName !== 'string' || !item.fileName.trim() || item.fileName.length > 255 || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0 || typeof item.actualSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.actualSha256)) throw Object.assign(new Error('manifest contains an invalid artifact entry'), { code: 'artifact_manifest_invalid' });
        const key = item.packageKey.trim().toLowerCase();
        if (packageKeys.has(key)) throw Object.assign(new Error('manifest contains duplicate packageKey values'), { code: 'artifact_manifest_invalid' });
        packageKeys.add(key);
      }
      if (digest(JSON.stringify(envelope.manifest)) !== manifestSha256) throw Object.assign(new Error('manifest content does not match manifestSha256'), { code: 'manifest_mismatch' });
    }
    if (envelope.reportSha256 && !/^[a-f0-9]{64}$/i.test(envelope.reportSha256)) throw Object.assign(new Error('reportSha256 must be SHA-256'), { code: 'invalid_message' });
    const approvalCode = randomBytes(32).toString('hex');
    const payload = JSON.stringify({ ...envelope, approvalCode, manifestSha256, reportSha256: envelope.reportSha256?.toLowerCase() ?? null });
    const payloadSha256 = digest(payload);
    const existing = this.get(requestId);
    if (existing) {
      if (existing.manifestSha256 !== manifestSha256 || existing.releaseId !== releaseId) throw Object.assign(new Error('requestId is already bound to another release or manifest'), { code: 'request_conflict' });
      return { item: existing, idempotent: true };
    }
    const timestamp = now();
    this.db.prepare('INSERT INTO core_message_inbox (message_id, message_type, request_id, payload_sha256, received_at, status) VALUES (?, ?, ?, ?, ?, \'ACCEPTED\')').run(id('MSG'), envelope.type ?? 'VERIFICATION_APPROVAL_REQUEST', requestId, payloadSha256, timestamp);
    this.db.prepare('INSERT INTO core_approval_requests (request_id, freeze_id, round_id, release_id, status, manifest_sha256, report_sha256, report_file_name, report_size, envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, \'CLOUD_PENDING\', ?, ?, ?, ?, ?, ?, ?)').run(requestId, freezeId, roundId, releaseId, manifestSha256, envelope.reportSha256?.toLowerCase() ?? null, envelope.reportFileName ?? null, Number.isSafeInteger(envelope.reportSize) ? envelope.reportSize : null, payload, timestamp, timestamp);
    return { item: this.get(requestId), idempotent: false };
  }

  async saveReport(requestId, bytes) {
    const current = this.db.prepare('SELECT * FROM core_approval_requests WHERE request_id = ?').get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (!validAttachmentFileName(current.report_file_name)) throw Object.assign(new Error('验证报告仅支持 DOCX、PDF、WPS、TXT、MD'), { code: 'report_invalid' });
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw Object.assign(new Error('验证报告必须大于 0 且不超过 20 MiB'), { code: 'report_invalid' });
    if (attachmentExtension(current.report_file_name) === '.pdf' && (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')) throw Object.assign(new Error('报告文件内容不是有效 PDF'), { code: 'report_invalid' });
    if (current.report_size && current.report_size !== bytes.length) throw Object.assign(new Error(`报告大小不匹配（声明 ${current.report_size}，实际 ${bytes.length}）`), { code: 'report_integrity_failed' });
    const actual = digest(bytes);
    if (current.report_sha256 && current.report_sha256.toLowerCase() !== actual) throw Object.assign(new Error(`报告 SHA-256 不匹配（声明 ${current.report_sha256}，实际 ${actual}）`), { code: 'report_integrity_failed' });
    await mkdir(this.reportDir, { recursive: true });
    const destination = join(this.reportDir, `${requestId}${attachmentExtension(current.report_file_name)}`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 }); await rename(temporary, destination); } catch (error) { await rm(temporary, { force: true }); throw error; }
    const timestamp = now();
    this.db.prepare('UPDATE core_approval_requests SET report_path = ?, report_received_sha256 = ?, report_received_at = ?, last_error = NULL, updated_at = ? WHERE request_id = ?').run(destination, actual, timestamp, timestamp, requestId);
    return this.get(requestId);
  }

  reportPath(requestId) { return this.db.prepare('SELECT report_path FROM core_approval_requests WHERE request_id = ?').get(requestId)?.report_path ?? null; }
  markReportAttachment(requestId, attachmentId) { this.db.prepare('UPDATE core_approval_requests SET cloud_attachment_id = ?, updated_at = ? WHERE request_id = ?').run(attachmentId, now(), requestId); return this.get(requestId); }

  markCloudSubmitted(requestId, result) {
    const approvalId = required(result.approvalId, 'approvalId');
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET cloud_approval_id = ?, cloud_status = ?, cloud_mapping_json = ?, cloud_request_json = ?, status = 'CLOUD_SUBMITTED', cloud_submission_state = 'SUBMITTED', cloud_retry_at = NULL, last_error = NULL, updated_at = ? WHERE request_id = ?")
      .run(approvalId, result.status ?? 'PENDING', result.mappingSnapshot ? JSON.stringify(result.mappingSnapshot) : null, result.requestBody ? JSON.stringify(result.requestBody) : null, timestamp, requestId);
    return this.get(requestId);
  }

  markCloudSubmissionAttempt(requestId) {
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET cloud_submission_attempts = cloud_submission_attempts + 1, cloud_submission_state = 'SUBMITTING', cloud_submission_attempted_at = ?, cloud_retry_at = NULL, updated_at = ? WHERE request_id = ? AND status = 'CLOUD_PENDING' AND cloud_approval_id IS NULL")
      .run(timestamp, timestamp, requestId);
    return this.get(requestId);
  }

  queueCloudRetry(requestId) {
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET cloud_submission_state = 'QUEUED', cloud_retry_at = NULL, updated_at = ? WHERE request_id = ? AND status = 'CLOUD_PENDING' AND cloud_approval_id IS NULL")
      .run(timestamp, requestId);
    return this.get(requestId);
  }

  markCloudSubmissionFailure(requestId, error, retryAt) {
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET last_error = ?, cloud_submission_state = 'RETRY_WAIT', cloud_retry_at = ?, updated_at = ? WHERE request_id = ? AND status = 'CLOUD_PENDING' AND cloud_approval_id IS NULL")
      .run(String(error?.message ?? error).slice(0, 1000), retryAt, timestamp, requestId);
    return this.get(requestId);
  }

  applyCloudStatus(requestId, result) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    const cloudStatus = required(result.status, 'status').toUpperCase();
    if (result.approvalId && current.cloudApprovalId && result.approvalId !== current.cloudApprovalId) throw Object.assign(new Error('cloud approval ID does not match request'), { code: 'cloud_identity_mismatch' });
    if (cloudStatus === 'APPROVED') {
      if (!result.manifestSha256) throw Object.assign(new Error('cloud approved result does not include the approved manifest'), { code: 'cloud_result_invalid' });
      if (result.manifestSha256.toLowerCase() !== current.manifestSha256) throw Object.assign(new Error('cloud approved manifest does not match request'), { code: 'cloud_manifest_mismatch' });
      if (!result.transferTaskId) throw Object.assign(new Error('approved result must include transferTaskId'), { code: 'cloud_result_invalid' });
    }
    const status = cloudStatus === 'APPROVED' ? 'APPROVED' : cloudStatus === 'REJECTED' ? 'REJECTED' : cloudStatus === 'UNKNOWN' ? 'CLOUD_STATUS_UNCONFIRMED' : 'CLOUD_SUBMITTED';
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET status = ?, cloud_status = ?, cloud_workflow_step = ?, cloud_response_summary = ?, cloud_approval_id = COALESCE(?, cloud_approval_id), cloud_transfer_task_id = COALESCE(?, cloud_transfer_task_id), cloud_checked_at = ?, approved_at = ?, expires_at = ?, last_error = NULL, updated_at = ? WHERE request_id = ?").run(status, cloudStatus, result.workflowStep ?? null, result.cloudResponseSummary ?? result.rejectionReason ?? null, result.approvalId ?? null, result.transferTaskId ?? null, timestamp, status === 'APPROVED' ? (result.approvedAt ?? timestamp) : null, result.expiresAt ?? null, timestamp, requestId);
    return this.get(requestId);
  }

  markError(requestId, error) { this.db.prepare('UPDATE core_approval_requests SET last_error = ?, updated_at = ? WHERE request_id = ?').run(String(error?.message ?? error).slice(0, 1000), now(), requestId); return this.get(requestId); }

  authorizeTransfer(requestId, input = {}) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (current.status !== 'APPROVED' || current.cloudStatus !== 'APPROVED') throw Object.assign(new Error('cloud approval is not confirmed'), { code: 'approval_required' });
    if (current.expiresAt && Date.parse(current.expiresAt) <= Date.now()) throw Object.assign(new Error('cloud approval has expired'), { code: 'approval_expired' });
    if (input.manifestSha256 && input.manifestSha256.toLowerCase() !== current.manifestSha256) throw Object.assign(new Error('transfer manifest does not match approved manifest'), { code: 'manifest_mismatch' });
    if (input.transferTaskId && input.transferTaskId !== current.cloudTransferTaskId) throw Object.assign(new Error('transfer task does not match cloud approval'), { code: 'transfer_task_mismatch' });
    const old = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE request_id = ?').get(requestId);
    if (old) return { transferTaskId: old.transfer_task_id, requestId, status: old.status, manifestSha256: old.manifest_sha256, idempotent: true };
    if (!current.cloudTransferTaskId) throw Object.assign(new Error('approved result has no transferTaskId'), { code: 'cloud_result_invalid' });
    const transferTaskId = current.cloudTransferTaskId;
    const timestamp = now();
    this.db.prepare("INSERT INTO core_transfer_tasks (transfer_task_id, request_id, status, manifest_sha256, created_at, updated_at) VALUES (?, ?, 'READY', ?, ?, ?)").run(transferTaskId, requestId, current.manifestSha256, timestamp, timestamp);
    const manifestItems = JSON.parse(this.db.prepare('SELECT envelope_json FROM core_approval_requests WHERE request_id = ?').get(requestId).envelope_json ?? '{}').manifest?.items ?? [];
    for (const item of manifestItems) {
      const sha256 = String(item.actualSha256 ?? '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(Number(item.sizeBytes)) || Number(item.sizeBytes) < 0 || typeof item.packageKey !== 'string' || typeof item.fileName !== 'string') {
        throw Object.assign(new Error('approved artifact manifest is invalid'), { code: 'artifact_manifest_invalid' });
      }
      this.db.prepare(`INSERT INTO core_release_artifacts (request_id, package_key, candidate_id, file_name, size_bytes, sha256, source, inherited_from_round_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id, package_key) DO UPDATE SET candidate_id = excluded.candidate_id,
        file_name = excluded.file_name, size_bytes = excluded.size_bytes, sha256 = excluded.sha256, source = excluded.source,
        inherited_from_round_id = excluded.inherited_from_round_id`)
        .run(requestId, item.packageKey, item.candidateId ?? null, item.fileName, Number(item.sizeBytes), sha256, item.source ?? null, item.inheritedFromRoundId ?? null);
    }
    this.db.prepare('UPDATE core_approval_requests SET transfer_task_id = ?, updated_at = ? WHERE request_id = ?').run(transferTaskId, timestamp, requestId);
    return { transferTaskId, requestId, status: 'READY', manifestSha256: current.manifestSha256, idempotent: false };
  }

  receiveReceipt(input = {}) {
    const requestId = required(input.requestId, 'requestId');
    const transferTaskId = required(input.transferTaskId, 'transferTaskId');
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (current.status !== 'APPROVED') throw Object.assign(new Error('cloud approval is not confirmed'), { code: 'approval_required' });
    if (current.cloudTransferTaskId !== transferTaskId) throw Object.assign(new Error('transfer task does not match cloud approval'), { code: 'transfer_task_mismatch' });
    if (input.manifestSha256?.toLowerCase() !== current.manifestSha256) throw Object.assign(new Error('received manifest does not match approved manifest'), { code: 'manifest_mismatch' });
    const existing = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE request_id = ?').get(requestId);
    if (!existing) this.authorizeTransfer(requestId, { manifestSha256: current.manifestSha256, transferTaskId });
    const timestamp = now();
    if (JSON.parse(this.db.prepare('SELECT envelope_json FROM core_approval_requests WHERE request_id = ?').get(requestId).envelope_json ?? '{}').manifest?.items?.length) this.assertTransferComplete(transferTaskId);
    this.db.prepare("UPDATE core_transfer_tasks SET status = 'RECEIVED', updated_at = ? WHERE request_id = ? AND transfer_task_id = ?").run(timestamp, requestId, transferTaskId);
    return { requestId, transferTaskId, status: 'RECEIVED', manifestSha256: current.manifestSha256, receivedAt: timestamp };
  }

  close(requestId, result = {}) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (current.status !== 'APPROVED' || current.transferStatus !== 'RECEIVED') throw Object.assign(new Error('approved artifact transfer receipt is required before closing'), { code: 'transfer_not_received' });
    const timestamp = now();
    const status = result.status ?? 'CLOSED';
    this.db.prepare("UPDATE core_approval_requests SET close_status = ?, close_checked_at = ?, status = CASE WHEN ? = 'CLOSED' THEN 'CLOSED' ELSE status END, updated_at = ? WHERE request_id = ?").run(status, timestamp, status, timestamp, requestId);
    return this.get(requestId);
  }
}
