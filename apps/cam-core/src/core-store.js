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
const transferRecoveryDelay = (attempt) => Math.min(300_000, 5_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));

function deadlineAfter(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

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
    environment: envelope.environment ?? null,
    submittedBy: envelope.submittedBy ?? null, submittedByUsername: envelope.submittedByUsername ?? null,
    submittedByDisplayName: envelope.submittedByDisplayName ?? null,
    status: row.status, manifestSha256: row.manifest_sha256, reportSha256: row.report_sha256,
    reportFileName: row.report_file_name, reportSize: row.report_size,
    reportReceived: Boolean(row.report_received_at), reportReceivedSha256: row.report_received_sha256,
    cloudAttachmentId: row.cloud_attachment_id, cloudApprovalId: row.cloud_approval_id,
    cloudTransferTaskId: row.cloud_transfer_task_id, cloudStatus: row.cloud_status,
    cloudWorkflowStep: row.cloud_workflow_step, cloudCheckedAt: row.cloud_checked_at, cloudResponseSummary: maskApprovalCode(row.cloud_response_summary, envelope.approvalCode),
    cloudMappingSnapshot: row.cloud_mapping_json ? JSON.parse(row.cloud_mapping_json) : null,
    cloudRequestSnapshot: row.cloud_request_json ? JSON.parse(maskApprovalCode(row.cloud_request_json, envelope.approvalCode)) : null,
    approvedAt: row.approved_at, expiresAt: row.expires_at, closeStatus: row.close_status,
    withdrawnAt: row.withdrawn_at, withdrawnBy: row.withdrawn_by,
    closeCheckedAt: row.close_checked_at, createdAt: row.created_at, updatedAt: row.updated_at,
    lastError: row.last_error, cloudSubmissionAttempts: row.cloud_submission_attempts ?? 0,
    cloudSubmissionState: row.cloud_submission_state ?? 'IDLE', cloudSubmissionAttemptedAt: row.cloud_submission_attempted_at ?? null,
    cloudRetryAt: row.cloud_retry_at ?? null,
    transferTaskId: row.transfer_task_id, transferStatus: row.transfer_status ?? null,
    transferEdgeStatus: row.transfer_edge_status ?? null, transferEdgeAttempts: row.transfer_edge_attempts ?? 0,
    transferEdgeRetryAt: row.transfer_edge_retry_at ?? null, transferEdgeErrorCode: row.transfer_edge_error_code ?? null,
    transferEdgeLastError: row.transfer_edge_last_error ?? null, transferEdgeFailureTerminal: Boolean(row.transfer_edge_failure_terminal),
    transferEdgeAttemptStartedAt: row.transfer_edge_attempt_started_at ?? null,
    transferEdgeLastActivityAt: row.transfer_edge_last_activity_at ?? null,
    transferEdgeStartDeadlineAt: row.transfer_edge_start_deadline_at ?? null,
    transferEdgeIdleDeadlineAt: row.transfer_edge_idle_deadline_at ?? null,
    transferEdgeRecoveryAttempts: row.transfer_edge_recovery_attempts ?? 0,
    transferNotificationState: row.transfer_notification_state ?? 'IDLE', transferNotificationAttempts: row.transfer_notification_attempts ?? 0,
    transferNotificationLastError: row.transfer_notification_error ?? null, transferNotificationNextAttemptAt: row.transfer_notification_next_attempt_at ?? null
  };
}

export class CoreStore {
  constructor(db, { dataDir = join(process.cwd(), 'data', 'core') } = {}) {
    this.db = db;
    this.dataDir = dataDir;
    this.transferAssemblyLocks = new Map();
    this.reportDir = join(dataDir, 'verification-reports');
    this.artifactDir = join(dataDir, 'artifacts', 'sha256');
    db.exec(`
      CREATE TABLE IF NOT EXISTS core_approval_requests (
        request_id TEXT PRIMARY KEY, freeze_id TEXT NOT NULL UNIQUE, round_id TEXT NOT NULL, release_id TEXT NOT NULL,
        status TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, report_sha256 TEXT, report_file_name TEXT, report_size INTEGER, report_received_sha256 TEXT, report_path TEXT, report_received_at TEXT, envelope_json TEXT NOT NULL,
        cloud_approval_id TEXT, cloud_transfer_task_id TEXT, cloud_status TEXT, cloud_workflow_step TEXT, cloud_checked_at TEXT,
        cloud_mapping_json TEXT, cloud_request_json TEXT,
        approved_at TEXT, expires_at TEXT, close_status TEXT, close_checked_at TEXT, withdrawn_at TEXT, withdrawn_by TEXT, last_error TEXT,
        transfer_task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS core_approval_status_idx ON core_approval_requests(status, updated_at);
      CREATE TABLE IF NOT EXISTS core_message_inbox (
        message_id TEXT PRIMARY KEY, message_type TEXT NOT NULL, request_id TEXT, payload_sha256 TEXT NOT NULL,
        received_at TEXT NOT NULL, status TEXT NOT NULL, UNIQUE(message_type, request_id, payload_sha256)
      );
      CREATE TABLE IF NOT EXISTS core_transfer_tasks (
        transfer_task_id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE REFERENCES core_approval_requests(request_id),
        status TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
        edge_status TEXT NOT NULL DEFAULT 'IDLE', edge_attempts INTEGER NOT NULL DEFAULT 0,
        edge_retry_at TEXT, edge_error_code TEXT, edge_last_error TEXT,
        edge_failure_terminal INTEGER NOT NULL DEFAULT 0,
        edge_attempt_started_at TEXT, edge_last_activity_at TEXT,
        edge_start_deadline_at TEXT, edge_idle_deadline_at TEXT,
        edge_recovery_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS core_transfer_file_states (
        transfer_task_id TEXT NOT NULL, sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ASSEMBLY_PENDING', 'ASSEMBLING', 'VERIFYING', 'VERIFY_FAILED')),
        error_code TEXT, last_error TEXT, assembly_bytes INTEGER NOT NULL DEFAULT 0,
        assembly_parts INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
        PRIMARY KEY (transfer_task_id, sha256)
      );
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
        status TEXT NOT NULL CHECK (status IN ('APPROVED','REJECTED','WITHDRAWN')),
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
        status TEXT NOT NULL, control_state TEXT NOT NULL DEFAULT 'RUN', progress_json TEXT NOT NULL DEFAULT '{}', last_error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT NOT NULL,
        scheduled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
        chunk_concurrency INTEGER NOT NULL DEFAULT 4,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS core_distribution_queue_idx ON core_distribution_tasks(agent_id, status, created_at);
    `);
    const approvalOutboxSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'core_approval_result_outbox'").get()?.sql ?? '';
    if (approvalOutboxSchema && !approvalOutboxSchema.includes("'WITHDRAWN'")) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          DROP INDEX IF EXISTS core_approval_result_outbox_pending_idx;
          ALTER TABLE core_approval_result_outbox RENAME TO core_approval_result_outbox_legacy;
          CREATE TABLE core_approval_result_outbox (
            request_id TEXT PRIMARY KEY REFERENCES core_approval_requests(request_id),
            event_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN ('APPROVED','REJECTED','WITHDRAWN')),
            payload_json TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            next_attempt_at TEXT NOT NULL,
            last_error TEXT,
            delivered_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO core_approval_result_outbox
            (request_id, event_id, status, payload_json, attempts, next_attempt_at, last_error, delivered_at, created_at, updated_at)
          SELECT request_id, event_id, status, payload_json, attempts, next_attempt_at, last_error, delivered_at, created_at, updated_at
          FROM core_approval_result_outbox_legacy;
          DROP TABLE core_approval_result_outbox_legacy;
          CREATE INDEX core_approval_result_outbox_pending_idx ON core_approval_result_outbox(delivered_at, next_attempt_at);
        `);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    const columns = new Set(db.prepare('PRAGMA table_info(core_approval_requests)').all().map((column) => column.name));
    const agentColumns = new Set(db.prepare('PRAGMA table_info(core_agents)').all().map((column) => column.name));
    if (agentColumns.has('security_domain')) {
      db.exec('DROP INDEX IF EXISTS core_agents_scope_idx; ALTER TABLE core_agents DROP COLUMN security_domain');
    }
    for (const [name, definition] of Object.entries({ public_key: 'TEXT', key_id: 'TEXT', previous_public_key: 'TEXT', previous_key_expires_at: 'TEXT', token_sha256: 'TEXT' })) if (!agentColumns.has(name)) db.exec(`ALTER TABLE core_agents ADD COLUMN ${name} ${definition}`);
    for (const [name, definition] of Object.entries({ rotation_days: 'INTEGER NOT NULL DEFAULT 90', grace_hours: 'INTEGER NOT NULL DEFAULT 24', key_rotated_at: 'TEXT', key_confirmed_at: 'TEXT', rotation_requested_at: 'TEXT', rotation_error: 'TEXT', rotation_attempts: 'INTEGER NOT NULL DEFAULT 0', rotation_retry_at: 'TEXT' })) if (!agentColumns.has(name)) db.exec(`ALTER TABLE core_agents ADD COLUMN ${name} ${definition}`);
    for (const [name, definition] of Object.entries({ core_identity_rotation_id: 'TEXT', core_identity_confirmed_at: 'TEXT', core_identity_error: 'TEXT', core_identity_attempts: 'INTEGER NOT NULL DEFAULT 0', core_identity_retry_at: 'TEXT' })) if (!agentColumns.has(name)) db.exec(`ALTER TABLE core_agents ADD COLUMN ${name} ${definition}`);
    db.exec('UPDATE core_agents SET key_rotated_at = created_at WHERE key_rotated_at IS NULL');
    db.exec(`
      CREATE TABLE IF NOT EXISTS core_agent_rotation_policy (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        rotation_days INTEGER NOT NULL DEFAULT 90,
        grace_hours INTEGER NOT NULL DEFAULT 24
      );
      INSERT OR IGNORE INTO core_agent_rotation_policy (singleton, rotation_days, grace_hours)
      VALUES (1, COALESCE((SELECT rotation_days FROM core_agents ORDER BY created_at LIMIT 1), 90), COALESCE((SELECT grace_hours FROM core_agents ORDER BY created_at LIMIT 1), 24));
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS core_agent_nonces (agent_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TEXT NOT NULL, PRIMARY KEY (agent_id, nonce));
      CREATE TABLE IF NOT EXISTS core_log_collection_jobs (
        job_id TEXT PRIMARY KEY, from_at TEXT NOT NULL, to_at TEXT NOT NULL, categories_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COLLECTING', bundle_path TEXT, bundle_sha256 TEXT, bundle_size INTEGER,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS core_log_collection_agents (
        job_id TEXT NOT NULL REFERENCES core_log_collection_jobs(job_id), agent_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', bundle_path TEXT, bundle_sha256 TEXT, bundle_size INTEGER,
        last_error TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (job_id, agent_id)
      );
      CREATE INDEX IF NOT EXISTS core_log_collection_jobs_status_idx ON core_log_collection_jobs(status, updated_at);
    `);
    const distributionColumns = new Set(db.prepare('PRAGMA table_info(core_distribution_tasks)').all().map((column) => column.name));
    if (!distributionColumns.has('control_state')) db.exec("ALTER TABLE core_distribution_tasks ADD COLUMN control_state TEXT NOT NULL DEFAULT 'RUN'");
    if (!distributionColumns.has('attempts')) db.exec('ALTER TABLE core_distribution_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
    if (!distributionColumns.has('retry_at')) db.exec(`ALTER TABLE core_distribution_tasks ADD COLUMN retry_at TEXT NOT NULL DEFAULT '${now()}'`);
    if (!distributionColumns.has('scheduled_at')) db.exec("ALTER TABLE core_distribution_tasks ADD COLUMN scheduled_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z'");
    if (!distributionColumns.has('chunk_concurrency')) db.exec('ALTER TABLE core_distribution_tasks ADD COLUMN chunk_concurrency INTEGER NOT NULL DEFAULT 4');
    const transferTaskColumns = new Set(db.prepare('PRAGMA table_info(core_transfer_tasks)').all().map((column) => column.name));
    for (const [name, definition] of Object.entries({ edge_status: "TEXT NOT NULL DEFAULT 'IDLE'", edge_attempts: 'INTEGER NOT NULL DEFAULT 0', edge_retry_at: 'TEXT', edge_error_code: 'TEXT', edge_last_error: 'TEXT', edge_failure_terminal: 'INTEGER NOT NULL DEFAULT 0', edge_attempt_started_at: 'TEXT', edge_last_activity_at: 'TEXT', edge_start_deadline_at: 'TEXT', edge_idle_deadline_at: 'TEXT', edge_recovery_attempts: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!transferTaskColumns.has(name)) db.exec(`ALTER TABLE core_transfer_tasks ADD COLUMN ${name} ${definition}`);
    }
    const transferFileStateColumns = new Set(db.prepare('PRAGMA table_info(core_transfer_file_states)').all().map((column) => column.name));
    for (const [name, definition] of Object.entries({ assembly_bytes: 'INTEGER NOT NULL DEFAULT 0', assembly_parts: 'INTEGER NOT NULL DEFAULT 0' })) {
      if (!transferFileStateColumns.has(name)) db.exec(`ALTER TABLE core_transfer_file_states ADD COLUMN ${name} ${definition}`);
    }
    if (!columns.has('cloud_mapping_json')) db.exec('ALTER TABLE core_approval_requests ADD COLUMN cloud_mapping_json TEXT');
    if (!columns.has('cloud_request_json')) db.exec('ALTER TABLE core_approval_requests ADD COLUMN cloud_request_json TEXT');
    if (!columns.has('cloud_workflow_step')) db.exec('ALTER TABLE core_approval_requests ADD COLUMN cloud_workflow_step TEXT');
    for (const [name, definition] of Object.entries({ report_file_name: 'TEXT', report_size: 'INTEGER', report_received_sha256: 'TEXT', report_path: 'TEXT', report_received_at: 'TEXT', cloud_attachment_id: 'TEXT', cloud_response_summary: 'TEXT', withdrawn_at: 'TEXT', withdrawn_by: 'TEXT' })) if (!columns.has(name)) db.exec(`ALTER TABLE core_approval_requests ADD COLUMN ${name} ${definition}`);
    for (const [name, definition] of Object.entries({ cloud_submission_attempts: 'INTEGER NOT NULL DEFAULT 0', cloud_submission_state: "TEXT NOT NULL DEFAULT 'IDLE'", cloud_submission_attempted_at: 'TEXT', cloud_retry_at: 'TEXT', transfer_notification_state: "TEXT NOT NULL DEFAULT 'IDLE'", transfer_notification_attempts: 'INTEGER NOT NULL DEFAULT 0' })) if (!columns.has(name)) db.exec(`ALTER TABLE core_approval_requests ADD COLUMN ${name} ${definition}`);
  }

  registerAgent({ centerId, name, publicKey }) {
    for (const [field, value] of Object.entries({ centerId, name })) if (typeof value !== 'string' || !value.trim() || value.length > 128) throw Object.assign(new Error(`${field} is required and must be at most 128 characters`), { code: 'agent_invalid' });
    if (typeof publicKey !== 'string' || !publicKey.includes('PUBLIC KEY')) throw Object.assign(new Error('publicKey is required; paste the Agent identity public key'), { code: 'agent_public_key_required' });
    let keyId; try { keyId = fingerprint(publicKey); } catch { throw Object.assign(new Error('Agent public key is invalid'), { code: 'agent_public_key_invalid' }); }
    const knownKey = this.db.prepare('SELECT public_key AS publicKey, previous_public_key AS previousPublicKey FROM core_agents WHERE public_key IS NOT NULL OR previous_public_key IS NOT NULL').all()
      .some((row) => (row.publicKey && fingerprint(row.publicKey) === keyId) || (row.previousPublicKey && fingerprint(row.previousPublicKey) === keyId));
    if (knownKey) throw Object.assign(new Error('该 Agent 公钥已登记或仍处于身份过渡期，请勿重复配对'), { code: 'agent_public_key_duplicate' });
    const agentId = `AG-${randomUUID()}`;
    const timestamp = now();
    // Old databases require a unique token hash. Keep an inert value for that
    // constraint; authentication accepts signed identities only.
    this.db.prepare('INSERT INTO core_agents (agent_id, center_id, name, public_key, key_id, token_sha256, status, created_at) VALUES (?, ?, ?, ?, ?, ?, \'PENDING\', ?)')
      .run(agentId, centerId.trim(), name.trim(), publicKey, keyId, digest(agentId), timestamp);
    return { agentId, centerId: centerId.trim(), name: name.trim(), keyId, fingerprint: keyId, status: 'PENDING', createdAt: timestamp };
  }
  authenticateAgent({ agentId, keyId, timestamp, nonce, signature, method, path, body = '', allowPendingIdentity = false } = {}) {
    // Signature verification is intentionally independent of browser sessions.
    if ((!agentId && !keyId) || typeof timestamp !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') return null;
    let row = agentId ? this.db.prepare("SELECT agent_id AS agentId, center_id AS centerId, name, public_key AS publicKey, key_id AS keyId, previous_public_key AS previousPublicKey, previous_key_expires_at AS previousKeyExpiresAt, status FROM core_agents WHERE agent_id = ?").get(agentId) : this.db.prepare("SELECT agent_id AS agentId, center_id AS centerId, name, public_key AS publicKey, key_id AS keyId, previous_public_key AS previousPublicKey, previous_key_expires_at AS previousKeyExpiresAt, status FROM core_agents WHERE key_id = ?").get(keyId);
    if (!row && keyId) {
      row = this.db.prepare("SELECT agent_id AS agentId, center_id AS centerId, name, public_key AS publicKey, key_id AS keyId, previous_public_key AS previousPublicKey, previous_key_expires_at AS previousKeyExpiresAt, status FROM core_agents WHERE previous_public_key IS NOT NULL AND previous_key_expires_at > ?").all(now()).find((candidate) => fingerprint(candidate.previousPublicKey) === keyId);
    }
    const pendingIdentityRequest = allowPendingIdentity && row?.status === 'PENDING' && ((method === 'GET' && path === '/api/v1/agent/identity') || (method === 'POST' && ['/api/v1/agent/identity/confirm', '/api/v1/agent/core-identity/confirm'].includes(path)));
    if (!row || (row.status !== 'ACTIVE' && !pendingIdentityRequest) || !Number.isFinite(Date.parse(timestamp)) || Math.abs(Date.now() - Date.parse(timestamp)) > 5 * 60_000) return null;
    const currentKey = verifyRequest(row.publicKey, signature, method, path, timestamp, nonce, body);
    const keyOk = currentKey || (row.previousPublicKey && row.previousKeyExpiresAt && Date.parse(row.previousKeyExpiresAt) > Date.now() && verifyRequest(row.previousPublicKey, signature, method, path, timestamp, nonce, body));
    if (!keyOk || (keyId && keyId !== fingerprint(currentKey ? row.publicKey : row.previousPublicKey))) return null;
    this.db.prepare('DELETE FROM core_agent_nonces WHERE expires_at <= ?').run(now());
    try { this.db.prepare('INSERT INTO core_agent_nonces (agent_id, nonce, expires_at) VALUES (?, ?, ?)').run(row.agentId, nonce, new Date(Math.max(Date.now(), Date.parse(timestamp)) + 5 * 60_000).toISOString()); } catch { return null; }
    this.db.prepare('UPDATE core_agents SET last_seen_at = ? WHERE agent_id = ?').run(now(), row.agentId);
    row.signingKeyId = fingerprint(currentKey ? row.publicKey : row.previousPublicKey);
    row.currentKey = currentKey;
    delete row.publicKey; delete row.previousPublicKey; delete row.previousKeyExpiresAt; return row;
  }
  listAgents() {
    return this.db.prepare('SELECT agent_id FROM core_agents ORDER BY created_at DESC').all().map((row) => this.getAgentIdentity(row.agent_id));
  }
  createLogCollection({ fromAt, toAt, categories = ['runtime'], retentionDays = 7 } = {}) {
    const from = Date.parse(fromAt); const to = Date.parse(toAt);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw Object.assign(new Error('日志时间范围无效'), { code: 'log_collection_range_invalid' });
    if (to - from > 7 * 86400_000) throw Object.assign(new Error('单次日志收集时间范围不能超过 7 天'), { code: 'log_collection_range_too_large' });
    const allowed = new Set(['runtime', 'transfer', 'error']);
    const selected = [...new Set(Array.isArray(categories) ? categories.filter((item) => allowed.has(item)) : [])];
    if (!selected.length) throw Object.assign(new Error('至少选择一种日志范围'), { code: 'log_collection_category_required' });
    const timestamp = now(); const jobId = id('LOG'); const expiresAt = new Date(Date.now() + Math.max(1, Math.min(30, retentionDays)) * 86400_000).toISOString();
    const agents = this.db.prepare("SELECT agent_id FROM core_agents WHERE status = 'ACTIVE' ORDER BY created_at").all();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO core_log_collection_jobs (job_id, from_at, to_at, categories_json, status, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, new Date(from).toISOString(), new Date(to).toISOString(), JSON.stringify(selected), agents.length ? 'COLLECTING' : 'PACKAGING', timestamp, timestamp, expiresAt);
      const statement = this.db.prepare('INSERT INTO core_log_collection_agents (job_id, agent_id, status, updated_at) VALUES (?, ?, ?, ?)');
      for (const agent of agents) statement.run(jobId, agent.agent_id, 'PENDING', timestamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.getLogCollection(jobId);
  }
  getLogCollection(jobId) {
    const row = this.db.prepare('SELECT * FROM core_log_collection_jobs WHERE job_id = ?').get(jobId);
    if (!row) return null;
    const counts = this.db.prepare("SELECT count(*) AS total, sum(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed, sum(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed FROM core_log_collection_agents WHERE job_id = ?").get(jobId);
    return { jobId: row.job_id, fromAt: row.from_at, toAt: row.to_at, categories: JSON.parse(row.categories_json), status: row.status, bundleSha256: row.bundle_sha256, bundleSize: row.bundle_size, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, agentTotal: counts.total ?? 0, agentCompleted: counts.completed ?? 0, agentFailed: counts.failed ?? 0 };
  }
  listPendingLogCollections(agentId) {
    return this.db.prepare("SELECT j.job_id AS jobId, j.from_at AS fromAt, j.to_at AS toAt, j.categories_json AS categories FROM core_log_collection_jobs j JOIN core_log_collection_agents a ON a.job_id = j.job_id WHERE a.agent_id = ? AND a.status = 'PENDING' AND j.status IN ('COLLECTING','PACKAGING') ORDER BY j.created_at").all(agentId).map((row) => ({ ...row, categories: JSON.parse(row.categories) }));
  }
  saveAgentLogCollection(jobId, agentId, filePath, sha256, size) {
    const task = this.db.prepare('SELECT status FROM core_log_collection_agents WHERE job_id = ? AND agent_id = ?').get(jobId, agentId);
    if (!task) throw Object.assign(new Error('日志收集任务不存在或未授权'), { code: 'log_collection_not_found' });
    if (task.status === 'COMPLETED') return this.getLogCollection(jobId);
    const timestamp = now();
    this.db.prepare("UPDATE core_log_collection_agents SET status = 'COMPLETED', bundle_path = ?, bundle_sha256 = ?, bundle_size = ?, last_error = NULL, updated_at = ? WHERE job_id = ? AND agent_id = ?").run(filePath, sha256, size, timestamp, jobId, agentId);
    const pending = this.db.prepare("SELECT count(*) AS total FROM core_log_collection_agents WHERE job_id = ? AND status <> 'COMPLETED'").get(jobId).total;
    this.db.prepare('UPDATE core_log_collection_jobs SET status = ?, updated_at = ? WHERE job_id = ?').run(pending ? 'COLLECTING' : 'PACKAGING', timestamp, jobId);
    return this.getLogCollection(jobId);
  }
  listAgentLogCollectionFiles(jobId) {
    return this.db.prepare("SELECT a.agent_id AS agentId, c.center_id AS centerId, c.name AS agentName, a.bundle_path AS bundlePath, a.bundle_sha256 AS bundleSha256, a.bundle_size AS bundleSize FROM core_log_collection_agents a LEFT JOIN core_agents c ON c.agent_id = a.agent_id WHERE a.job_id = ? AND a.status = 'COMPLETED' ORDER BY a.agent_id").all(jobId);
  }
  setLogCollectionBundle(jobId, { status, path = null, sha256 = null, size = null, error = null } = {}) { this.db.prepare('UPDATE core_log_collection_jobs SET status = ?, bundle_path = ?, bundle_sha256 = ?, bundle_size = ?, last_error = ?, updated_at = ? WHERE job_id = ?').run(status, path, sha256, size, error, now(), jobId); return this.getLogCollection(jobId); }
  getLogCollectionBundle(jobId) { const row = this.db.prepare("SELECT bundle_path AS path, bundle_sha256 AS sha256, bundle_size AS size, expires_at AS expiresAt FROM core_log_collection_jobs WHERE job_id = ? AND status = 'READY'").get(jobId); return row ?? null; }
  expireLogCollections(at = now()) {
    const rows = this.db.prepare("SELECT job_id AS jobId FROM core_log_collection_jobs WHERE expires_at <= ? AND status <> 'EXPIRED'").all(at);
    if (!rows.length) return [];
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const updateJob = this.db.prepare("UPDATE core_log_collection_jobs SET status = 'EXPIRED', bundle_path = NULL, bundle_sha256 = NULL, bundle_size = NULL, updated_at = ? WHERE job_id = ?");
      const updateAgent = this.db.prepare("UPDATE core_log_collection_agents SET status = 'EXPIRED', bundle_path = NULL, bundle_sha256 = NULL, bundle_size = NULL, updated_at = ? WHERE job_id = ?");
      for (const row of rows) { updateJob.run(timestamp, row.jobId); updateAgent.run(timestamp, row.jobId); }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return rows.map((row) => row.jobId);
  }
  // 分发页只需要安全的业务摘要；完整身份和轮换详情继续留在配置接口。
  listDistributionAgents() {
    return this.db.prepare('SELECT agent_id AS agentId, center_id AS centerId, name, status FROM core_agents ORDER BY created_at DESC').all().map((row) => ({ ...row }));
  }
  getAgentRotationPolicy() {
    const row = this.db.prepare('SELECT rotation_days AS rotationDays, grace_hours AS graceHours FROM core_agent_rotation_policy WHERE singleton = 1').get();
    return { rotationDays: row.rotationDays, graceHours: row.graceHours };
  }
  confirmCoreIdentity(agentId, { rotationId, fingerprint }) {
    if (typeof rotationId !== 'string' || !rotationId || typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(fingerprint)) throw Object.assign(new Error('Core 身份轮换确认信息无效'), { code: 'core_identity_confirmation_invalid' });
    const result = this.db.prepare("UPDATE core_agents SET core_identity_rotation_id = ?, core_identity_confirmed_at = ?, core_identity_error = NULL, core_identity_attempts = 0, core_identity_retry_at = NULL WHERE agent_id = ? AND status IN ('ACTIVE', 'PENDING')").run(rotationId, now(), agentId);
    if (!result.changes) throw Object.assign(new Error('Agent 不存在或未启用'), { code: 'agent_disabled' });
    return this.getCoreIdentityRotationStatus(rotationId);
  }
  getCoreIdentityRotationStatus(rotationId) {
    const totals = this.db.prepare("SELECT count(*) AS total, sum(CASE WHEN core_identity_rotation_id = ? THEN 1 ELSE 0 END) AS confirmed FROM core_agents WHERE status <> 'DISABLED'").get(rotationId);
    return { total: totals.total, confirmed: totals.confirmed ?? 0, pending: totals.total - (totals.confirmed ?? 0) };
  }
  getAgentIdentity(agentId) {
    const row = this.db.prepare('SELECT * FROM core_agents WHERE agent_id = ?').get(agentId);
    if (!row) throw Object.assign(new Error('Agent 不存在'), { code: 'agent_not_found' });
    const rotatedAt = row.key_rotated_at ?? row.created_at;
    const policy = this.getAgentRotationPolicy();
    const nextRotationAt = new Date(Date.parse(rotatedAt) + policy.rotationDays * 86400_000).toISOString();
    const rotationDue = Boolean(row.rotation_requested_at) || Date.parse(nextRotationAt) <= Date.now();
    return { agentId: row.agent_id, centerId: row.center_id, name: row.name, keyId: row.key_id, fingerprint: row.key_id, status: row.status, createdAt: row.created_at, lastSeenAt: row.last_seen_at,
      previousKeyExpiresAt: row.previous_key_expires_at, rotationDays: policy.rotationDays, graceHours: policy.graceHours, rotatedAt, confirmedAt: row.key_confirmed_at, nextRotationAt, rotationRequestedAt: row.rotation_requested_at, rotationDue,
      coreIdentityRotationId: row.core_identity_rotation_id, coreIdentityConfirmedAt: row.core_identity_confirmed_at, coreIdentityError: row.core_identity_error, coreIdentityAttempts: row.core_identity_attempts ?? 0, coreIdentityRetryAt: row.core_identity_retry_at,
      rotationState: row.rotation_error ? 'RETRY_WAIT' : !row.key_confirmed_at ? 'AWAITING_CONFIRMATION' : rotationDue ? 'REQUESTED' : 'CURRENT', rotationError: row.rotation_error, rotationAttempts: row.rotation_attempts, rotationRetryAt: row.rotation_retry_at };
  }
  reportCoreIdentityFailure(agentId, { rotationId, message, attempts, retryAt }) {
    if (typeof rotationId !== 'string' || !rotationId || typeof message !== 'string' || !message || !Number.isSafeInteger(attempts) || attempts < 1 || !Number.isFinite(Date.parse(retryAt))) throw Object.assign(new Error('Core 身份轮换失败状态无效'), { code: 'core_identity_failure_invalid' });
    this.db.prepare("UPDATE core_agents SET core_identity_error = ?, core_identity_attempts = ?, core_identity_retry_at = ? WHERE agent_id = ? AND status IN ('ACTIVE', 'PENDING')").run(message.slice(0, 1000), attempts, new Date(retryAt).toISOString(), agentId);
    return this.getAgentIdentity(agentId);
  }
  beginCoreIdentityRotation() {
    this.db.prepare("UPDATE core_agents SET core_identity_error = NULL, core_identity_attempts = 0, core_identity_retry_at = NULL WHERE status IN ('ACTIVE', 'PENDING')").run();
  }
  setAgentRotationPolicy({ rotationDays, graceHours }) {
    if (!Number.isInteger(rotationDays) || rotationDays < 1 || rotationDays > 365 || !Number.isInteger(graceHours) || graceHours < 1 || graceHours > 168) throw Object.assign(new Error('轮换周期应为 1–365 天，过渡期应为 1–168 小时'), { code: 'agent_policy_invalid' });
    this.db.prepare('UPDATE core_agent_rotation_policy SET rotation_days = ?, grace_hours = ? WHERE singleton = 1').run(rotationDays, graceHours);
    this.db.prepare('UPDATE core_agents SET rotation_days = ?, grace_hours = ?').run(rotationDays, graceHours);
    return this.getAgentRotationPolicy();
  }
  requestAgentRotation(agentId) {
    const agent = this.getAgentIdentity(agentId);
    if (agent.status !== 'ACTIVE') throw Object.assign(new Error('请先启用 Agent'), { code: 'agent_disabled' });
    if (!agent.confirmedAt) throw Object.assign(new Error('请等待 Agent 确认当前身份后再轮换'), { code: 'agent_rotation_unconfirmed' });
    this.db.prepare('UPDATE core_agents SET rotation_requested_at = COALESCE(rotation_requested_at, ?) WHERE agent_id = ?').run(now(), agentId);
    return this.getAgentIdentity(agentId);
  }
  confirmAgentIdentity(principal) {
    if (!principal.currentKey || principal.signingKeyId !== this.getAgentIdentity(principal.agentId).keyId) throw Object.assign(new Error('必须使用当前身份确认'), { code: 'agent_current_key_required' });
    const result = this.db.prepare("UPDATE core_agents SET status = CASE WHEN status = 'PENDING' THEN 'ACTIVE' ELSE status END, key_confirmed_at = COALESCE(key_confirmed_at, ?), rotation_error = NULL, rotation_attempts = 0, rotation_retry_at = NULL WHERE agent_id = ? AND status IN ('ACTIVE', 'PENDING')").run(now(), principal.agentId);
    if (!result.changes) throw Object.assign(new Error('Agent 已禁用，不能确认身份'), { code: 'agent_disabled' });
    return this.getAgentIdentity(principal.agentId);
  }
  reportAgentRotationFailure(agentId, { message, attempts, retryAt }) {
    if (typeof message !== 'string' || !message || !Number.isSafeInteger(attempts) || attempts < 1 || !Number.isFinite(Date.parse(retryAt))) throw Object.assign(new Error('轮换重试状态无效'), { code: 'agent_rotation_report_invalid' });
    this.db.prepare('UPDATE core_agents SET rotation_error = ?, rotation_attempts = ?, rotation_retry_at = ? WHERE agent_id = ?').run(message.slice(0, 1000), attempts, new Date(retryAt).toISOString(), agentId);
    return this.getAgentIdentity(agentId);
  }
  rotateAgentKey(agentId, publicKey, previousKeyExpiresAt, { signingKeyId, expectedKeyId } = {}) {
    let keyId; try { keyId = fingerprint(publicKey); } catch { throw Object.assign(new Error('Agent public key is invalid'), { code: 'agent_public_key_invalid' }); }
    const agent = this.getAgentIdentity(agentId);
    if (agent.status !== 'ACTIVE') throw Object.assign(new Error('Agent 已禁用'), { code: 'agent_disabled' });
    // A retry of the same persisted key must not renew the grace period or
    // overwrite the previous key. Grace keys may only retry that exact change.
    if (keyId === agent.keyId) return agent;
    if (signingKeyId !== undefined && (signingKeyId !== agent.keyId || expectedKeyId !== agent.keyId)) throw Object.assign(new Error('当前身份已变化，拒绝使用旧身份再次换钥'), { code: 'agent_rotation_conflict' });
    previousKeyExpiresAt ??= new Date(Date.now() + this.getAgentRotationPolicy().graceHours * 3600_000).toISOString();
    const timestamp = now();
    const result = this.db.prepare("UPDATE core_agents SET previous_public_key = public_key, previous_key_expires_at = ?, public_key = ?, key_id = ?, last_seen_at = ?, key_rotated_at = ?, key_confirmed_at = NULL, rotation_requested_at = NULL, rotation_error = NULL, rotation_attempts = 0, rotation_retry_at = NULL WHERE agent_id = ? AND status = 'ACTIVE'").run(previousKeyExpiresAt, publicKey, keyId, timestamp, timestamp, agentId);
    if (!result.changes) throw Object.assign(new Error('active agent not found'), { code: 'agent_not_found' });
    return this.getAgentIdentity(agentId);
  }
  setAgentStatus(agentId, status) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw Object.assign(new Error('invalid agent status'), { code: 'agent_invalid' });
    const exists = this.db.prepare('SELECT status FROM core_agents WHERE agent_id = ?').get(agentId);
    if (!exists) return false;
    if (status === 'ACTIVE' && exists.status === 'DISABLED') {
      this.db.prepare("UPDATE core_agents SET status = 'PENDING', key_confirmed_at = NULL, rotation_error = NULL, rotation_attempts = 0, rotation_retry_at = NULL WHERE agent_id = ?").run(agentId);
    } else if (status === 'DISABLED') {
      this.db.prepare("UPDATE core_agents SET status = 'DISABLED', key_confirmed_at = NULL, rotation_error = NULL, rotation_attempts = 0, rotation_retry_at = NULL WHERE agent_id = ?").run(agentId);
    }
    return true;
  }
  createDistributionTask({ agentId, artifactId, scheduledAt = null, chunkConcurrency = 4 }) {
    const agent = this.db.prepare("SELECT agent_id FROM core_agents WHERE agent_id = ? AND status = 'ACTIVE'").get(agentId);
    if (!agent) throw Object.assign(new Error('active agent not found'), { code: 'agent_not_found' });
    const artifact = this.getArtifact(artifactId);
    if (!artifact) throw Object.assign(new Error('正式制品版本不存在或尚未完成入库'), { code: 'artifact_not_found' });
    const files = artifact.files.map(({ packageKey, fileName, sizeBytes, sha256 }) => ({ packageKey, fileName, sizeBytes, sha256 }));
    if (!files.length || files.some((file) => !this.artifactPath(file.sha256))) throw Object.assign(new Error('正式制品文件未全部入库'), { code: 'artifact_incomplete' });
    const parsedSchedule = scheduledAt == null || scheduledAt === '' ? Date.now() : Date.parse(scheduledAt);
    if (!Number.isFinite(parsedSchedule)) throw Object.assign(new Error('开始时间无效'), { code: 'distribution_schedule_invalid' });
    const concurrency = Number(chunkConcurrency);
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw Object.assign(new Error('并发线程数必须是 1 到 16 之间的整数'), { code: 'distribution_concurrency_invalid' });
    const scheduled = new Date(parsedSchedule).toISOString();
    const taskId = `DIST-${randomUUID()}`;
    const timestamp = now();
    this.db.prepare("INSERT INTO core_distribution_tasks (task_id, agent_id, artifact_id, manifest_sha256, files_json, status, retry_at, scheduled_at, chunk_concurrency, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'SCHEDULED', ?, ?, ?, ?, ?)")
      .run(taskId, agentId, artifactId, artifact.manifestSha256, JSON.stringify(files), timestamp, scheduled, concurrency, timestamp, timestamp);
    return this.getDistributionTask(taskId);
  }
  getDistributionTask(taskId) {
    const row = this.db.prepare('SELECT * FROM core_distribution_tasks WHERE task_id = ?').get(taskId);
    return row ? { taskId: row.task_id, agentId: row.agent_id, artifactId: row.artifact_id, manifestSha256: row.manifest_sha256, files: JSON.parse(row.files_json), status: row.status, controlState: row.control_state ?? 'RUN', progress: JSON.parse(row.progress_json), attempts: row.attempts, retryAt: row.retry_at, scheduledAt: row.scheduled_at, chunkConcurrency: row.chunk_concurrency, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at } : null;
  }
  listLatestAgentDistributionTasks(agentId) {
    const latest = new Map();
    for (const { task_id: taskId } of this.db.prepare('SELECT task_id FROM core_distribution_tasks WHERE agent_id = ? ORDER BY updated_at DESC').all(agentId)) {
      const task = this.getDistributionTask(taskId);
      if (task && !latest.has(task.artifactId)) latest.set(task.artifactId, task);
    }
    return latest;
  }
  listDistributionTasks() { return this.db.prepare('SELECT task_id FROM core_distribution_tasks ORDER BY created_at DESC LIMIT 500').all().map(({ task_id }) => this.getDistributionTask(task_id)); }
  listTransferMonitor({ recoveryLimit = null } = {}) {
    const edgeToCore = this.list().filter((item) => item.status === 'APPROVED' || item.status === 'CLOSED' || item.transferTaskId).map((item) => {
      const progress = this.getTransferProgress(item.requestId, { recoveryLimit });
      const failure = progress?.edgeFailure ?? null;
      return {
        requestId: item.requestId,
        freezeId: item.freezeId,
        roundId: item.roundId,
        roundNo: item.roundNo,
        releaseId: item.releaseId,
        productName: item.productName,
        version: item.version,
        displayVersion: item.displayVersion,
        transferTaskId: progress?.transferTaskId ?? item.transferTaskId ?? null,
        status: progress?.status ?? 'WAITING_AUTHORIZATION',
        notification: progress?.notification ?? {
          state: item.transferNotificationState,
          attempts: item.transferNotificationAttempts,
          lastError: item.transferNotificationLastError,
          nextAttemptAt: item.transferNotificationNextAttemptAt
        },
        edgeStatus: progress?.edge?.status ?? item.transferEdgeStatus ?? null,
        terminal: Boolean(failure?.terminal ?? item.transferEdgeFailureTerminal),
        recoveryAttempts: progress?.edge?.recoveryAttempts ?? item.transferEdgeRecoveryAttempts ?? 0,
        attempts: progress?.edge?.attempts ?? failure?.attempts ?? item.transferEdgeAttempts ?? 0,
        retryAt: failure?.retryAt ?? item.transferEdgeRetryAt ?? null,
        lastError: failure?.message ?? item.transferEdgeLastError ?? item.transferNotificationLastError ?? null,
        errorCode: failure?.code ?? item.transferEdgeErrorCode ?? (item.transferNotificationState === 'FAILED' ? 'transfer_ready_delivery_failed' : null),
        attemptStartedAt: progress?.edge?.attemptStartedAt ?? item.transferEdgeAttemptStartedAt ?? null,
        lastActivityAt: progress?.edge?.lastActivityAt ?? item.transferEdgeLastActivityAt ?? null,
        startDeadlineAt: progress?.edge?.startDeadlineAt ?? item.transferEdgeStartDeadlineAt ?? null,
        idleDeadlineAt: progress?.edge?.idleDeadlineAt ?? item.transferEdgeIdleDeadlineAt ?? null,
        recoveryLimit: progress?.edge?.recoveryLimit ?? recoveryLimit,
        updatedAt: progress?.updatedAt ?? item.updatedAt,
        summary: progress?.summary ?? null,
        progress
      };
    });
    const coreToAgent = this.listDistributionTasks().map((task) => {
      const agent = this.db.prepare('SELECT name, center_id AS centerId FROM core_agents WHERE agent_id = ?').get(task.agentId);
      const artifact = this.getArtifact(task.artifactId);
      const displayStatus = task.status === 'SCHEDULED'
        ? 'SCHEDULED'
        : task.status === 'PAUSED'
          ? 'PAUSED'
          : task.status === 'CANCELLED'
            ? 'CANCELLED'
            : task.controlState === 'PAUSE_REQUESTED'
              ? 'PAUSE_REQUESTED'
              : task.controlState === 'CANCEL_REQUESTED'
                ? 'CANCEL_REQUESTED'
                : task.status === 'COMPLETED'
                  ? 'COMPLETED'
                  : task.status === 'RUNNING'
                    ? 'RUNNING'
                    : task.lastError && task.retryAt && Date.parse(task.retryAt) > Date.now() ? 'RETRY_WAIT' : task.status;
      return {
        ...task,
        displayStatus,
        agentName: agent?.name ?? task.agentId,
        centerId: agent?.centerId ?? null,
        productName: artifact?.productName ?? null,
        version: artifact?.version ?? null,
        displayVersion: artifact?.displayVersion ?? null,
        roundNo: artifact?.roundNo ?? null,
        fileCount: task.files?.length ?? 0,
        completedFiles: Number(task.progress?.completedFiles ?? 0),
        totalBytes: (task.files ?? []).reduce((sum, file) => sum + Number(file.sizeBytes ?? 0), 0),
        completedBytes: Number(task.progress?.completedBytes ?? task.progress?.bytesDownloaded ?? 0)
      };
    });
    const count = (items, value) => items.filter((item) => item.status === value || item.displayStatus === value).length;
    return {
      edgeToCore,
      coreToAgent,
      summary: {
        edgeToCore: { waiting: count(edgeToCore, 'WAITING_EDGE') + count(edgeToCore, 'WAITING_AUTHORIZATION'), transferring: count(edgeToCore, 'RECEIVING') + count(edgeToCore, 'VERIFYING'), recovering: count(edgeToCore, 'RECOVERY_SENDING'), retry: count(edgeToCore, 'RETRY_WAIT'), failed: count(edgeToCore, 'FAILED') + count(edgeToCore, 'NOTIFICATION_FAILED'), completed: count(edgeToCore, 'COMPLETED') },
        coreToAgent: { scheduled: count(coreToAgent, 'SCHEDULED'), queued: count(coreToAgent, 'QUEUED'), transferring: count(coreToAgent, 'RUNNING'), retry: count(coreToAgent, 'RETRY_WAIT'), paused: count(coreToAgent, 'PAUSED') + count(coreToAgent, 'PAUSE_REQUESTED'), cancelled: count(coreToAgent, 'CANCELLED') + count(coreToAgent, 'CANCEL_REQUESTED'), completed: count(coreToAgent, 'COMPLETED') }
      }
    };
  }
  listAgentTasks(agentId) {
    const timestamp = now();
    this.db.prepare("UPDATE core_distribution_tasks SET status = 'QUEUED', updated_at = ? WHERE agent_id = ? AND status = 'SCHEDULED' AND control_state = 'RUN' AND scheduled_at <= ? AND retry_at <= ?").run(timestamp, agentId, timestamp, timestamp);
    return this.db.prepare("SELECT task_id FROM core_distribution_tasks WHERE agent_id = ? AND status IN ('QUEUED','RUNNING') AND control_state = 'RUN' AND scheduled_at <= ? AND retry_at <= ? ORDER BY created_at LIMIT 20").all(agentId, timestamp, timestamp).map(({ task_id }) => this.getDistributionTask(task_id));
  }
  updateDistributionTask(agentId, taskId, { status, progress = {}, error = null }) {
    const task = this.getDistributionTask(taskId);
    if (!task || task.agentId !== agentId) throw Object.assign(new Error('task not found for this agent'), { code: 'distribution_task_not_found' });
    if (!['RUNNING', 'COMPLETED', 'FAILED', 'PAUSED', 'CANCELLED'].includes(status)) throw Object.assign(new Error('invalid distribution task status'), { code: 'distribution_status_invalid' });
    if (task.status === 'COMPLETED' && status !== 'COMPLETED') return task;
    if (status === 'RUNNING' && ['PAUSE_REQUESTED', 'CANCEL_REQUESTED'].includes(task.controlState)) return task;
    if (status === 'PAUSED' && !['PAUSE_REQUESTED', 'PAUSED'].includes(task.controlState)) throw Object.assign(new Error('任务尚未请求暂停'), { code: 'distribution_pause_not_requested' });
    if (status === 'CANCELLED' && !['CANCEL_REQUESTED', 'CANCELLED'].includes(task.controlState)) throw Object.assign(new Error('任务尚未请求取消'), { code: 'distribution_cancel_not_requested' });
    const timestamp = now();
    const attempts = status === 'FAILED' ? task.attempts + 1 : task.attempts;
    const requestedControl = status === 'FAILED' ? task.controlState : null;
    const retryAt = status === 'FAILED' && !['PAUSE_REQUESTED', 'CANCEL_REQUESTED'].includes(requestedControl) ? new Date(Date.now() + Math.min(300_000, 5_000 * (2 ** Math.min(attempts - 1, 6)))).toISOString() : timestamp;
    const persistedStatus = status === 'FAILED' ? 'QUEUED' : status;
    const controlledStatus = status === 'FAILED' && requestedControl === 'PAUSE_REQUESTED' ? 'PAUSED' : status === 'FAILED' && requestedControl === 'CANCEL_REQUESTED' ? 'CANCELLED' : ['PAUSED', 'CANCELLED'].includes(status) ? status : persistedStatus;
    const controlState = status === 'PAUSED' || (status === 'FAILED' && requestedControl === 'PAUSE_REQUESTED') ? 'PAUSED' : status === 'CANCELLED' || (status === 'FAILED' && requestedControl === 'CANCEL_REQUESTED') ? 'CANCELLED' : 'RUN';
    this.db.prepare('UPDATE core_distribution_tasks SET status = ?, control_state = ?, attempts = ?, retry_at = ?, progress_json = ?, last_error = ?, updated_at = ?, completed_at = ? WHERE task_id = ? AND agent_id = ?')
      .run(controlledStatus, controlState, attempts, retryAt, JSON.stringify(progress), typeof error === 'string' ? error.slice(0, 1000) : null, timestamp, status === 'COMPLETED' ? timestamp : null, taskId, agentId);
    return this.getDistributionTask(taskId);
  }
  retryDistributionTask(agentId, taskId) {
    const task = this.getDistributionTask(taskId);
    if (!task || task.agentId !== agentId) throw Object.assign(new Error('task not found for this agent'), { code: 'distribution_task_not_found' });
    if (task.status === 'COMPLETED') throw Object.assign(new Error('已完成的分发任务不能重试'), { code: 'distribution_task_completed' });
    if (task.status === 'CANCELLED') throw Object.assign(new Error('已取消的分发任务不能重试'), { code: 'distribution_task_cancelled' });
    if (task.status === 'RUNNING') throw Object.assign(new Error('分发任务正在传输，不能重复重试'), { code: 'distribution_task_active' });
    const timestamp = now();
    this.db.prepare("UPDATE core_distribution_tasks SET status = 'QUEUED', control_state = 'RUN', retry_at = ?, updated_at = ? WHERE task_id = ? AND agent_id = ?").run(timestamp, timestamp, taskId, agentId);
    return this.getDistributionTask(taskId);
  }
  startDistributionTask(taskId) {
    const task = this.getDistributionTask(taskId);
    if (!task) throw Object.assign(new Error('分发任务不存在'), { code: 'distribution_task_not_found' });
    if (task.status === 'COMPLETED') throw Object.assign(new Error('已完成的分发任务不能重新开始'), { code: 'distribution_task_completed' });
    if (task.status === 'CANCELLED') throw Object.assign(new Error('已取消的分发任务不能重新开始'), { code: 'distribution_task_cancelled' });
    if (task.status === 'RUNNING') throw Object.assign(new Error('分发任务正在传输'), { code: 'distribution_task_active' });
    const timestamp = now();
    this.db.prepare("UPDATE core_distribution_tasks SET status = 'QUEUED', control_state = 'RUN', scheduled_at = ?, retry_at = ?, updated_at = ? WHERE task_id = ?").run(timestamp, timestamp, timestamp, taskId);
    return this.getDistributionTask(taskId);
  }
  retryDistributionTaskFromCore(taskId) {
    const task = this.getDistributionTask(taskId);
    if (!task) throw Object.assign(new Error('分发任务不存在'), { code: 'distribution_task_not_found' });
    if (task.status === 'COMPLETED') throw Object.assign(new Error('已完成的分发任务不能重试'), { code: 'distribution_task_completed' });
    if (task.status === 'CANCELLED') throw Object.assign(new Error('已取消的分发任务不能重试'), { code: 'distribution_task_cancelled' });
    if (task.status === 'RUNNING') throw Object.assign(new Error('分发任务正在传输，不能重复重试'), { code: 'distribution_task_active' });
    const timestamp = now();
    this.db.prepare("UPDATE core_distribution_tasks SET status = 'QUEUED', control_state = 'RUN', retry_at = ?, updated_at = ? WHERE task_id = ?").run(timestamp, timestamp, taskId);
    return this.getDistributionTask(taskId);
  }
  controlDistributionTask(taskId, action) {
    const task = this.getDistributionTask(taskId);
    if (!task) throw Object.assign(new Error('分发任务不存在'), { code: 'distribution_task_not_found' });
    if (!['pause', 'resume', 'cancel'].includes(action)) throw Object.assign(new Error('任务控制操作无效'), { code: 'distribution_control_invalid' });
    if (task.status === 'COMPLETED' || task.status === 'CANCELLED') throw Object.assign(new Error('当前任务已结束，不能控制'), { code: 'distribution_task_terminal' });
    const timestamp = now();
    if (action === 'resume') {
      if (task.status !== 'PAUSED') throw Object.assign(new Error('只有已暂停任务可以继续'), { code: 'distribution_resume_invalid' });
      this.db.prepare("UPDATE core_distribution_tasks SET status = 'QUEUED', control_state = 'RUN', scheduled_at = ?, retry_at = ?, updated_at = ? WHERE task_id = ?").run(timestamp, timestamp, timestamp, taskId);
    } else if (action === 'pause') {
      if (task.status === 'PAUSED' || task.controlState === 'PAUSE_REQUESTED') return task;
      if (task.status === 'RUNNING') this.db.prepare("UPDATE core_distribution_tasks SET control_state = 'PAUSE_REQUESTED', updated_at = ? WHERE task_id = ?").run(timestamp, taskId);
      else this.db.prepare("UPDATE core_distribution_tasks SET status = 'PAUSED', control_state = 'PAUSED', updated_at = ? WHERE task_id = ?").run(timestamp, taskId);
    } else if (task.status === 'RUNNING') {
      this.db.prepare("UPDATE core_distribution_tasks SET control_state = 'CANCEL_REQUESTED', updated_at = ? WHERE task_id = ?").run(timestamp, taskId);
    } else {
      this.db.prepare("UPDATE core_distribution_tasks SET status = 'CANCELLED', control_state = 'CANCELLED', retry_at = ?, updated_at = ? WHERE task_id = ?").run(timestamp, timestamp, taskId);
    }
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
    const item = response(this.db.prepare('SELECT r.*, t.status AS transfer_status, t.edge_status AS transfer_edge_status, t.edge_attempts AS transfer_edge_attempts, t.edge_retry_at AS transfer_edge_retry_at, t.edge_error_code AS transfer_edge_error_code, t.edge_last_error AS transfer_edge_last_error, t.edge_failure_terminal AS transfer_edge_failure_terminal, t.edge_attempt_started_at AS transfer_edge_attempt_started_at, t.edge_last_activity_at AS transfer_edge_last_activity_at, t.edge_start_deadline_at AS transfer_edge_start_deadline_at, t.edge_idle_deadline_at AS transfer_edge_idle_deadline_at, t.edge_recovery_attempts AS transfer_edge_recovery_attempts, o.last_error AS transfer_notification_error, o.next_attempt_at AS transfer_notification_next_attempt_at FROM core_approval_requests r LEFT JOIN core_transfer_tasks t ON t.request_id = r.request_id LEFT JOIN core_transfer_outbox o ON o.request_id = r.request_id WHERE r.request_id = ?').get(requestId));
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
  list() { return this.db.prepare('SELECT r.*, t.status AS transfer_status, t.edge_status AS transfer_edge_status, t.edge_attempts AS transfer_edge_attempts, t.edge_retry_at AS transfer_edge_retry_at, t.edge_error_code AS transfer_edge_error_code, t.edge_last_error AS transfer_edge_last_error, t.edge_failure_terminal AS transfer_edge_failure_terminal, t.edge_attempt_started_at AS transfer_edge_attempt_started_at, t.edge_last_activity_at AS transfer_edge_last_activity_at, t.edge_start_deadline_at AS transfer_edge_start_deadline_at, t.edge_idle_deadline_at AS transfer_edge_idle_deadline_at, t.edge_recovery_attempts AS transfer_edge_recovery_attempts, o.last_error AS transfer_notification_error, o.next_attempt_at AS transfer_notification_next_attempt_at FROM core_approval_requests r LEFT JOIN core_transfer_tasks t ON t.request_id = r.request_id LEFT JOIN core_transfer_outbox o ON o.request_id = r.request_id ORDER BY r.created_at DESC LIMIT 500').all().map(response); }
  listCloudApprovalPending() {
    return this.db.prepare(`SELECT r.request_id FROM core_approval_requests r
      WHERE (r.status IN ('CLOUD_SUBMITTED','CLOUD_STATUS_UNCONFIRMED') AND r.cloud_approval_id IS NOT NULL)
          OR (r.status IN ('APPROVED','WITHDRAWN') AND NOT EXISTS (SELECT 1 FROM core_approval_result_outbox o WHERE o.request_id = r.request_id))
          OR (r.status = 'REJECTED' AND (r.close_status IS NULL OR r.close_status <> 'CLOSED'))
      ORDER BY COALESCE(r.cloud_checked_at, r.created_at) ASC LIMIT 100`).all().map((row) => row.request_id);
  }
  enqueueApprovalResult(requestId) {
    const item = this.get(requestId);
    if (!item || !['APPROVED', 'REJECTED', 'WITHDRAWN'].includes(item.status)) return null;
    const existing = this.db.prepare('SELECT * FROM core_approval_result_outbox WHERE request_id = ?').get(requestId);
    if (existing) {
      if (existing.status !== item.status) throw Object.assign(new Error('approval result changed after notification was queued'), { code: 'approval_result_conflict' });
      return { ...existing, payload: JSON.parse(existing.payload_json) };
    }
    const timestamp = now();
    const payload = {
      schemaVersion: 1, type: 'APPROVAL_RESULT', eventId: id('DECISION'),
      requestId: item.requestId, freezeId: item.freezeId, status: item.status,
      decidedAt: item.withdrawnAt ?? item.cloudCheckedAt ?? item.updatedAt
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
  markTransferDelivered(eventId, { transferStartTimeoutMs = 300_000 } = {}) {
    const timestamp = now();
    this.db.prepare('UPDATE core_transfer_outbox SET delivered_at = ?, last_error = NULL, updated_at = ? WHERE event_id = ?').run(timestamp, timestamp, eventId);
    this.db.prepare("UPDATE core_approval_requests SET transfer_notification_state = 'DELIVERED', updated_at = ? WHERE request_id = (SELECT request_id FROM core_transfer_outbox WHERE event_id = ?)").run(timestamp, eventId);
    // Edge starts its data-plane work asynchronously after acknowledging the
    // request. A STARTED/PROGRESS report can therefore arrive before this
    // HTTP acknowledgement is processed. Do not move that newer state back
    // to ACCEPTED, otherwise Core would apply the wrong timeout watchdog.
    this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'ACCEPTED', edge_last_activity_at = ?, edge_start_deadline_at = ?, edge_idle_deadline_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE request_id = (SELECT request_id FROM core_transfer_outbox WHERE event_id = ?) AND status <> 'RECEIVED' AND edge_status IN ('IDLE', 'ACCEPTED')")
      .run(timestamp, deadlineAfter(transferStartTimeoutMs), timestamp, eventId);
  }
  markTransferFailure(eventId, error, retryAt, { retryLimit = 5 } = {}) {
    const entry = this.db.prepare('SELECT request_id, attempts FROM core_transfer_outbox WHERE event_id = ? AND delivered_at IS NULL').get(eventId);
    if (!entry) return null;
    const terminal = Number(entry.attempts ?? 0) >= Math.max(1, Number(retryLimit) || 5);
    const timestamp = now();
    const lastError = String(error?.message ?? error).slice(0, 1000);
    this.db.prepare('UPDATE core_transfer_outbox SET last_error = ?, next_attempt_at = ?, updated_at = ? WHERE event_id = ? AND delivered_at IS NULL')
      .run(lastError, terminal ? null : retryAt, timestamp, eventId);
    this.db.prepare('UPDATE core_approval_requests SET transfer_notification_state = ?, updated_at = ? WHERE request_id = ?')
      .run(terminal ? 'FAILED' : 'RETRY_WAIT', timestamp, entry.request_id);
    return { terminal, attempts: Number(entry.attempts ?? 0), lastError };
  }
  retryTransferReady(requestId) {
    const item = this.get(requestId);
    if (!item || item.status !== 'APPROVED' || !item.transferTaskId) throw Object.assign(new Error('当前申请没有可重新通知的 Edge 传输任务'), { code: 'transfer_notification_retry_unavailable' });
    if (item.transferNotificationState !== 'FAILED') throw Object.assign(new Error('只有 Edge 传输任务通知终止失败后才能手动重试'), { code: 'transfer_notification_retry_unavailable' });
    const timestamp = now();
    const result = this.db.prepare("UPDATE core_transfer_outbox SET attempts = 0, next_attempt_at = ?, updated_at = ? WHERE request_id = ? AND delivered_at IS NULL")
      .run(timestamp, timestamp, requestId);
    if (!result.changes) throw Object.assign(new Error('Edge 已确认接收该传输任务，不能重新通知'), { code: 'transfer_notification_retry_unavailable' });
    this.db.prepare("UPDATE core_approval_requests SET transfer_notification_state = 'RETRY_WAIT', updated_at = ? WHERE request_id = ?").run(timestamp, requestId);
    return { item: this.get(requestId), idempotent: false };
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
  listArtifacts({ includeRoundMetadata = false } = {}) {
    return this.db.prepare(`SELECT r.*, t.status AS transfer_status, t.updated_at AS transfer_received_at
      FROM core_approval_requests r JOIN core_transfer_tasks t ON t.request_id = r.request_id
      WHERE r.status IN ('APPROVED', 'CLOSED') AND t.status = 'RECEIVED'
      ORDER BY t.updated_at DESC LIMIT 500`).all().map((row) => this.serializeArtifact(row, { includeRoundMetadata }));
  }
  getArtifact(artifactId) {
    const prefix = 'BASELINE-';
    if (typeof artifactId !== 'string' || !artifactId.startsWith(prefix) || artifactId.length === prefix.length) return null;
    const row = this.db.prepare(`SELECT r.*, t.status AS transfer_status, t.updated_at AS transfer_received_at
      FROM core_approval_requests r JOIN core_transfer_tasks t ON t.request_id = r.request_id
      WHERE r.request_id = ? AND r.status IN ('APPROVED', 'CLOSED') AND t.status = 'RECEIVED'`).get(artifactId.slice(prefix.length));
    return row ? this.serializeArtifact(row) : null;
  }
  serializeArtifact(row, { includeRoundMetadata = false } = {}) {
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
    const artifact = {
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
    // The generic formal-artifact API intentionally keeps Edge collection
    // round metadata private for backward compatibility. Agent's dedicated
    // catalog endpoint opts in because delivery and cache views need to show
    // the authorization round.
    if (includeRoundMetadata) {
      artifact.roundId = metadata.roundId;
      artifact.roundNo = metadata.roundNo;
    }
    return artifact;
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
  getTransferFileState(transferTaskId, sha256) {
    return this.db.prepare('SELECT status, error_code AS errorCode, last_error AS lastError, assembly_bytes AS assemblyBytes, assembly_parts AS assemblyParts, updated_at AS updatedAt FROM core_transfer_file_states WHERE transfer_task_id = ? AND sha256 = ?').get(transferTaskId, String(sha256).toLowerCase()) ?? null;
  }
  setTransferFileState(transferTaskId, sha256, status, error = null, { assemblyBytes = 0, assemblyParts = 0 } = {}) {
    if (!['ASSEMBLY_PENDING', 'ASSEMBLING', 'VERIFYING', 'VERIFY_FAILED'].includes(status)) throw Object.assign(new Error('invalid transfer file state'), { code: 'transfer_file_state_invalid' });
    const timestamp = now();
    this.db.prepare(`INSERT INTO core_transfer_file_states (transfer_task_id, sha256, status, error_code, last_error, assembly_bytes, assembly_parts, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(transfer_task_id, sha256) DO UPDATE SET status = excluded.status,
      error_code = excluded.error_code, last_error = excluded.last_error, assembly_bytes = excluded.assembly_bytes,
      assembly_parts = excluded.assembly_parts, updated_at = excluded.updated_at`)
      .run(transferTaskId, String(sha256).toLowerCase(), status, error?.code ?? null, error?.message ? String(error.message).slice(0, 1000) : null,
        Math.max(0, Number(assemblyBytes) || 0), Math.max(0, Number(assemblyParts) || 0), timestamp);
  }
  updateTransferFileAssemblyProgress(transferTaskId, sha256, assemblyBytes, assemblyParts) {
    this.db.prepare(`UPDATE core_transfer_file_states SET assembly_bytes = ?, assembly_parts = ?, updated_at = ?
      WHERE transfer_task_id = ? AND sha256 = ? AND status = 'ASSEMBLING'`)
      .run(Math.max(0, Number(assemblyBytes) || 0), Math.max(0, Number(assemblyParts) || 0), now(), transferTaskId, String(sha256).toLowerCase());
  }
  clearTransferFileState(transferTaskId, sha256) {
    this.db.prepare('DELETE FROM core_transfer_file_states WHERE transfer_task_id = ? AND sha256 = ?').run(transferTaskId, String(sha256).toLowerCase());
  }
  async reconcileTransferParts(transferTaskId) {
    const existing = this.transferAssemblyLocks.get(transferTaskId);
    if (existing) return existing;
    const operation = (async () => {
      const transfer = this.expectedTransferArtifacts(transferTaskId);
      const errors = [];
      const assembled = [];
      for (const sha256 of new Set(transfer.items.map((item) => String(item.actualSha256 ?? '').toLowerCase()))) {
        if (!/^[a-f0-9]{64}$/.test(sha256) || this.artifactPath(sha256)) continue;
        const parts = this.listTransferParts(transferTaskId, sha256);
        const chunkCount = parts[0]?.chunkCount;
        if (!Number.isInteger(chunkCount) || chunkCount <= 0 || parts.length !== chunkCount) continue;
        const state = this.getTransferFileState(transferTaskId, sha256);
        if (state?.status === 'VERIFY_FAILED') {
          errors.push({ sha256, code: state.errorCode ?? 'artifact_assembly_failed', message: state.lastError ?? '制品校验不通过' });
          continue;
        }
        try {
          const result = await this.assembleTransferParts(transferTaskId, sha256);
          if (result.complete) assembled.push(sha256);
        } catch (error) {
          errors.push({ sha256, code: error.code ?? 'artifact_assembly_failed', message: error.message });
        }
      }
      return { assembled, errors };
    })();
    this.transferAssemblyLocks.set(transferTaskId, operation);
    try { return await operation; }
    finally {
      if (this.transferAssemblyLocks.get(transferTaskId) === operation) this.transferAssemblyLocks.delete(transferTaskId);
    }
  }
  async reconcilePendingTransfers(limit = 20) {
    // Assembly is local recovery work. It must not depend on a browser
    // opening the transfer detail after a process interruption.
    const rows = this.db.prepare(`SELECT transfer_task_id FROM core_transfer_tasks
      WHERE status <> 'RECEIVED' ORDER BY updated_at ASC LIMIT ?`)
      .all(Math.max(1, Math.min(Number(limit) || 20, 100)));
    const results = [];
    for (const { transfer_task_id: transferTaskId } of rows) {
      try {
        results.push({ transferTaskId, ...(await this.reconcileTransferParts(transferTaskId)) });
      } catch (error) {
        results.push({ transferTaskId, error: { code: error.code ?? 'artifact_reconcile_failed', message: error.message } });
      }
    }
    return results;
  }
  getTransferProgress(requestId, { recoveryLimit = null } = {}) {
    const current = this.get(requestId);
    if (!current) return null;
    const task = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE request_id = ?').get(requestId);
    const envelope = this.envelope(requestId) ?? {};
    const manifestItems = Array.isArray(envelope.manifest?.items) && envelope.manifest.items.length
      ? envelope.manifest.items
      : this.listReleaseArtifacts(requestId).map((item) => ({
        packageKey: item.packageKey, candidateId: item.candidateId, fileName: item.fileName,
        sizeBytes: item.sizeBytes, actualSha256: item.sha256, source: item.source,
        inheritedFromRoundId: item.inheritedFromRoundId
      }));
    const taskId = task?.transfer_task_id ?? current.transferTaskId ?? null;
    const artifactRows = new Map();
    for (const item of manifestItems) {
      const sha256 = String(item.actualSha256 ?? item.sha256 ?? '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(sha256)) continue;
      if (!artifactRows.has(sha256)) artifactRows.set(sha256, { parts: taskId ? this.listTransferParts(taskId, sha256) : [] });
    }
    const seenDigests = new Set();
    const files = manifestItems.map((item) => {
      const sha256 = String(item.actualSha256 ?? item.sha256 ?? '').toLowerCase();
      const entry = artifactRows.get(sha256) ?? { parts: [] };
      const stored = /^[a-f0-9]{64}$/.test(sha256) && Boolean(this.artifactPath(sha256));
      const parts = entry.parts;
      const chunkSize = parts[0]?.chunkSize ?? Math.max(1, Number(item.sizeBytes ?? 0));
      const chunkCount = stored ? (parts[0]?.chunkCount ?? Math.max(1, Math.ceil(Number(item.sizeBytes ?? 0) / chunkSize))) : (parts[0]?.chunkCount ?? null);
      const receivedParts = stored ? (chunkCount ?? 1) : parts.length;
      const receivedBytes = stored ? Number(item.sizeBytes ?? 0) : parts.reduce((total, part) => total + Number(part.size ?? 0), 0);
      // A complete set of chunks can remain briefly while Core assembles and
      // verifies the file. It is not another active upload; keep that state
      // distinct from RECEIVING so the UI does not suggest file concurrency.
      const chunksComplete = !stored && Number.isInteger(chunkCount) && chunkCount > 0 && receivedParts === chunkCount;
      const fileState = taskId ? this.getTransferFileState(taskId, sha256) : null;
      const status = stored ? 'COMPLETED' : fileState?.status ?? (chunksComplete ? 'ASSEMBLY_PENDING' : parts.length ? 'RECEIVING' : 'WAITING');
      const reused = stored && (seenDigests.has(sha256) || Boolean(this.db.prepare('SELECT 1 FROM core_artifacts WHERE sha256 = ? AND received_at < ?').get(sha256, task?.created_at ?? now())));
      seenDigests.add(sha256);
      return {
        packageKey: item.packageKey ?? null, candidateId: item.candidateId ?? null, fileName: item.fileName ?? item.packageKey ?? sha256,
        sizeBytes: Number(item.sizeBytes ?? 0), sha256, source: item.source ?? null,
        inheritedFromRoundId: item.inheritedFromRoundId ?? null, stored, reused,
        status, errorCode: fileState?.errorCode ?? null, lastError: fileState?.lastError ?? null,
        receivedParts, chunkCount, receivedBytes,
        assemblyBytes: Math.min(Number(item.sizeBytes ?? 0), Number(fileState?.assemblyBytes ?? 0)),
        assemblyParts: Math.min(chunkCount ?? 0, Number(fileState?.assemblyParts ?? 0)),
        updatedAt: fileState?.updatedAt ?? task?.updated_at ?? current.updatedAt
      };
    });
    const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
    const receivedBytes = files.reduce((total, file) => total + Math.min(file.sizeBytes, file.receivedBytes), 0);
    const storedBytes = files.reduce((total, file) => total + (file.stored ? file.sizeBytes : 0), 0);
    const completedFiles = files.filter((file) => file.stored).length;
    const receivingFiles = files.filter((file) => file.status === 'RECEIVING').length;
    const assemblyPendingFiles = files.filter((file) => file.status === 'ASSEMBLY_PENDING').length;
    const assemblingFiles = files.filter((file) => ['ASSEMBLY_PENDING', 'ASSEMBLING'].includes(file.status)).length;
    const activeAssemblyFiles = files.filter((file) => file.status === 'ASSEMBLING').length;
    const verifyingFiles = files.filter((file) => file.status === 'VERIFYING').length;
    const failedFiles = files.filter((file) => file.status === 'VERIFY_FAILED').length;
    const allStored = files.length > 0 && completedFiles === files.length;
    let status = 'WAITING_AUTHORIZATION';
    if (taskId) {
      if (task?.status === 'RECEIVED') status = 'COMPLETED';
      else if (task?.edge_status === 'FAILED' && task.edge_failure_terminal) status = 'FAILED';
      // Once every chunk is present, Core is doing local assembly/verification.
      // Keep that visible even if Edge has already reported the previous retry
      // window; otherwise the page falsely suggests that Core is idle.
      else if (activeAssemblyFiles || assemblyPendingFiles || verifyingFiles || allStored) status = 'VERIFYING';
      else if (task?.edge_status === 'RECOVERY_SENDING') status = 'RECOVERY_SENDING';
      else if (task?.edge_status === 'RETRY_WAIT') status = 'RETRY_WAIT';
      else if (task?.edge_status === 'STARTED') status = 'EDGE_STARTED';
      else if (task?.edge_status === 'WAITING_RECEIPT') status = 'WAITING_RECEIPT';
      else if (task?.edge_status === 'IDLE' && current.transferNotificationState === 'FAILED') status = 'NOTIFICATION_FAILED';
      else if (task?.edge_status === 'IDLE' && current.transferNotificationState === 'RETRY_WAIT') status = 'NOTIFICATION_RETRY_WAIT';
      else status = failedFiles ? 'FAILED' : receivingFiles ? 'RECEIVING' : 'WAITING_EDGE';
    }
    // receivedBytes tracks chunks on disk, while storedBytes tracks files
    // that passed assembly and verification. The progress bar is an
    // ingestion (stored) progress bar, so it cannot reach 100% early just
    // because all chunks have arrived.
    const percent = totalBytes ? Math.round(storedBytes * 100 / totalBytes) : (allStored ? 100 : 0);
    return {
      requestId, transferTaskId: taskId, status, updatedAt: task?.updated_at ?? current.updatedAt,
      notification: { state: current.transferNotificationState, attempts: current.transferNotificationAttempts, lastError: current.transferNotificationLastError, nextAttemptAt: current.transferNotificationNextAttemptAt },
      edge: task ? {
        status: task.edge_status, attempts: task.edge_attempts ?? 0,
        attemptStartedAt: task.edge_attempt_started_at ?? null, lastActivityAt: task.edge_last_activity_at ?? null,
        startDeadlineAt: task.edge_start_deadline_at ?? null, idleDeadlineAt: task.edge_idle_deadline_at ?? null,
        recoveryAttempts: task.edge_recovery_attempts ?? 0, recoveryLimit
      } : null,
      edgeFailure: task?.edge_last_error ? { status: task.edge_status, attempts: task.edge_attempts ?? 0, retryAt: task.edge_retry_at ?? null, code: task.edge_error_code ?? null, message: task.edge_last_error, terminal: Boolean(task.edge_failure_terminal), recoveryAttempts: task.edge_recovery_attempts ?? 0, recoveryLimit } : null,
      report: { received: current.reportReceived, fileName: current.reportFileName, sizeBytes: current.reportSize },
      summary: { fileCount: files.length, completedFiles, assemblingFiles, assemblyPendingFiles, activeAssemblyFiles, verifyingFiles, failedFiles, receivingFiles, totalBytes, receivedBytes, storedBytes, percent },
      files
    };
  }
  async saveTransferPart(transferTaskId, sha256, part, { transferIdleTimeoutMs = 300_000 } = {}) {
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
    this.clearTransferFileState(transferTaskId, digestValue);
    const timestamp = now();
    this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'RECEIVING', edge_attempt_started_at = COALESCE(edge_attempt_started_at, ?), edge_last_activity_at = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = ?, edge_recovery_attempts = 0, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE transfer_task_id = ? AND status <> 'RECEIVED'")
      .run(timestamp, timestamp, deadlineAfter(transferIdleTimeoutMs), timestamp, transferTaskId);
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
    this.setTransferFileState(transferTaskId, digestValue, 'ASSEMBLING', null, { assemblyBytes: 0, assemblyParts: 0 });
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
        this.updateTransferFileAssemblyProgress(transferTaskId, digestValue, totalSize, index + 1);
      }
      output.end();
      await once(output, 'close');
      this.setTransferFileState(transferTaskId, digestValue, 'VERIFYING');
      const fullDigest = hash.digest('hex');
      if (totalSize !== Number(expected.sizeBytes) || fullDigest !== digestValue) throw Object.assign(new Error('组装后的制品大小或 SHA-256 与获批清单不一致'), { code: 'artifact_integrity_failed' });
      const received = await this.receiveArtifact(transferTaskId, digestValue, temporaryPath, totalSize, fullDigest);
      for (const row of rows) await rm(row.file_path, { force: true });
      this.db.prepare('DELETE FROM core_transfer_parts WHERE transfer_task_id = ? AND sha256 = ?').run(transferTaskId, digestValue);
      this.clearTransferFileState(transferTaskId, digestValue);
      return { complete: true, ...received };
    } catch (error) {
      this.setTransferFileState(transferTaskId, digestValue, 'VERIFY_FAILED', error);
      output.destroy();
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
  expectedTransferArtifacts(transferTaskId) {
    const task = this.db.prepare(`SELECT t.*, r.status AS approval_status, r.envelope_json
      FROM core_transfer_tasks t JOIN core_approval_requests r ON r.request_id = t.request_id
      WHERE t.transfer_task_id = ?`).get(transferTaskId);
    // A closed approval remains readable for idempotent reconciliation. Edge may
    // have retried its manifest/receipt after Core closed the cloud work order;
    // rejecting those retries would incorrectly turn an already received transfer
    // into a failed one. Creation and approval actions still require APPROVED.
    if (!task || !['APPROVED', 'CLOSED'].includes(task.approval_status)) throw Object.assign(new Error('transfer task is not approved'), { code: 'approval_required' });
    const envelope = JSON.parse(task.envelope_json ?? '{}');
    const manifest = envelope.manifest;
    if (!manifest || !Array.isArray(manifest.items)) return { requestId: task.request_id, manifestSha256: task.manifest_sha256, items: [] };
    return { requestId: task.request_id, manifestSha256: task.manifest_sha256, items: manifest.items };
  }
  setTransferManifest(transferTaskId, manifest) {
    const task = this.db.prepare(`SELECT t.*, r.status AS approval_status, r.envelope_json
      FROM core_transfer_tasks t JOIN core_approval_requests r ON r.request_id = t.request_id
      WHERE t.transfer_task_id = ?`).get(transferTaskId);
    if (!task || !['APPROVED', 'CLOSED'].includes(task.approval_status)) throw Object.assign(new Error('transfer task is not approved'), { code: 'approval_required' });
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
  async receiveArtifact(transferTaskId, sha256, temporaryPath, actualSize, actualSha256, { transferIdleTimeoutMs = 300_000 } = {}) {
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
    this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'RECEIVING', edge_attempt_started_at = COALESCE(edge_attempt_started_at, ?), edge_last_activity_at = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = ?, edge_recovery_attempts = 0, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE transfer_task_id = ? AND status <> 'RECEIVED'")
      .run(timestamp, timestamp, deadlineAfter(transferIdleTimeoutMs), timestamp, transferTaskId);
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
    this.db.prepare("UPDATE core_approval_requests SET cloud_approval_id = ?, cloud_status = ?, cloud_mapping_json = ?, cloud_request_json = ?, status = 'CLOUD_SUBMITTED', cloud_submission_state = 'SUBMITTED', cloud_retry_at = NULL, last_error = NULL, updated_at = ? WHERE request_id = ? AND status = 'CLOUD_PENDING' AND cloud_approval_id IS NULL")
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
    if (current.status === 'WITHDRAWN') return current;
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

  refreshCloudDetail(requestId, result = {}) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    const timestamp = now();
    this.db.prepare('UPDATE core_approval_requests SET cloud_workflow_step = COALESCE(?, cloud_workflow_step), cloud_response_summary = COALESCE(?, cloud_response_summary), cloud_checked_at = ?, last_error = NULL, updated_at = ? WHERE request_id = ?')
      .run(result.workflowStep ?? null, result.cloudResponseSummary ?? null, timestamp, timestamp, requestId);
    return this.get(requestId);
  }

  markError(requestId, error) { this.db.prepare('UPDATE core_approval_requests SET last_error = ?, updated_at = ? WHERE request_id = ?').run(String(error?.message ?? error).slice(0, 1000), now(), requestId); return this.get(requestId); }

  markCloudClosed(requestId) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET close_status = 'CLOSED', close_checked_at = ?, last_error = NULL, updated_at = ? WHERE request_id = ?").run(timestamp, timestamp, requestId);
    return this.get(requestId);
  }

  withdraw(requestId, actorId = null) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (current.status === 'WITHDRAWN') return current;
    if (!['CLOUD_PENDING', 'CLOUD_SUBMITTED', 'CLOUD_STATUS_UNCONFIRMED'].includes(current.status)) {
      throw Object.assign(new Error('只有尚未审批的固化申请可以撤回'), { code: 'approval_withdraw_not_available' });
    }
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET status = 'WITHDRAWN', withdrawn_at = ?, withdrawn_by = ?, cloud_submission_state = 'IDLE', cloud_retry_at = NULL, last_error = NULL, updated_at = ? WHERE request_id = ? AND status IN ('CLOUD_PENDING', 'CLOUD_SUBMITTED', 'CLOUD_STATUS_UNCONFIRMED')").run(timestamp, actorId ?? null, timestamp, requestId);
    return this.get(requestId);
  }

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

  recordEdgeTransferStatus(input = {}, { transferStartTimeoutMs = 300_000, transferIdleTimeoutMs = 300_000, retryLimit = 5 } = {}) {
    const requestId = required(input.requestId, 'requestId');
    const freezeId = required(input.freezeId, 'freezeId');
    const transferTaskId = required(input.transferTaskId, 'transferTaskId');
    const manifestSha256 = required(input.manifestSha256, 'manifestSha256').toLowerCase();
    const state = required(input.state, 'state').toUpperCase();
    const attempt = Number(input.attempt);
    const code = typeof input.code === 'string' && input.code.trim() ? input.code.trim().slice(0, 128) : null;
    const message = typeof input.message === 'string' && input.message.trim() ? input.message.trim().slice(0, 1000) : null;
    const states = new Set(['ACCEPTED', 'STARTED', 'PROGRESS', 'RETRY_WAIT', 'FAILED', 'COMPLETED']);
    const failedState = ['RETRY_WAIT', 'FAILED'].includes(state);
    if (requestId !== freezeId || !/^[a-f0-9]{64}$/.test(manifestSha256) || !states.has(state) || !Number.isSafeInteger(attempt) || attempt < 0 || attempt > 100000 || (failedState && (!code || !message))) {
      throw Object.assign(new Error('Edge 传输状态报告格式无效'), { code: 'invalid_transfer_status' });
    }
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (!['APPROVED', 'CLOSED'].includes(current.status) || current.freezeId !== freezeId || current.transferTaskId !== transferTaskId || current.manifestSha256.toLowerCase() !== manifestSha256) {
      throw Object.assign(new Error('传输状态报告与当前审批任务不匹配'), { code: 'transfer_status_conflict' });
    }
    const task = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE request_id = ? AND transfer_task_id = ?').get(requestId, transferTaskId);
    if (!task) throw Object.assign(new Error('传输任务不存在'), { code: 'transfer_task_not_found' });
    // A terminal Core decision is authoritative. A delayed Edge control
    // report must not restart a task after its bounded recovery budget is
    // exhausted; an operator-initiated fallback recovery clears this flag.
    if (task.status === 'RECEIVED' || task.edge_failure_terminal || attempt < Number(task.edge_attempts ?? 0)) return { item: this.get(requestId), idempotent: true };
    // Edge replays persisted failures after restart.  Counting the same
    // report repeatedly would exhaust Core's recovery budget without a new
    // transmission attempt, so make the report idempotent in storage too.
    if (failedState && ['RETRY_WAIT', 'RECOVERY_SENDING'].includes(task.edge_status)
      && attempt === Number(task.edge_attempts ?? 0)
      && code === task.edge_error_code && message === task.edge_last_error) return { item: this.get(requestId), idempotent: true };
    // Control messages are delivered independently from data chunks. Never let
    // an older ACCEPTED/STARTED message overwrite a later progress/completion
    // fact from the same Edge attempt.
    const stateRank = { ACCEPTED: 0, STARTED: 1, PROGRESS: 2, COMPLETED: 3, RETRY_WAIT: 4, FAILED: 5 };
    const currentRank = { ACCEPTED: 0, STARTED: 1, RECEIVING: 2, WAITING_RECEIPT: 3, RETRY_WAIT: 4, FAILED: 5, RECEIVED: 6 }[task.edge_status];
    if (attempt === Number(task.edge_attempts ?? 0) && currentRank !== undefined && stateRank[state] !== undefined && stateRank[state] < currentRank) {
      return { item: this.get(requestId), idempotent: true };
    }
    const timestamp = now();
    if (state === 'ACCEPTED') {
      this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'ACCEPTED', edge_attempts = ?, edge_attempt_started_at = NULL, edge_last_activity_at = ?, edge_start_deadline_at = ?, edge_idle_deadline_at = NULL, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE transfer_task_id = ?")
        .run(attempt, timestamp, deadlineAfter(transferStartTimeoutMs), timestamp, transferTaskId);
    } else if (state === 'STARTED') {
      this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'STARTED', edge_attempts = ?, edge_attempt_started_at = COALESCE(edge_attempt_started_at, ?), edge_last_activity_at = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = ?, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE transfer_task_id = ?")
        .run(attempt, timestamp, timestamp, deadlineAfter(transferIdleTimeoutMs), timestamp, transferTaskId);
    } else if (state === 'PROGRESS') {
      // Data-plane progress proves that a coordinated recovery genuinely
      // resumed. Until then, keep the recovery counter so an Edge that only
      // accepts control commands cannot reset its retry limit indefinitely.
      this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'RECEIVING', edge_attempts = ?, edge_attempt_started_at = COALESCE(edge_attempt_started_at, ?), edge_last_activity_at = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = ?, edge_recovery_attempts = 0, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE transfer_task_id = ?")
        .run(attempt, timestamp, timestamp, deadlineAfter(transferIdleTimeoutMs), timestamp, transferTaskId);
    } else if (state === 'COMPLETED') {
      this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'WAITING_RECEIPT', edge_attempts = ?, edge_attempt_started_at = COALESCE(edge_attempt_started_at, ?), edge_last_activity_at = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = ?, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE transfer_task_id = ?")
        .run(attempt, timestamp, timestamp, deadlineAfter(transferIdleTimeoutMs), timestamp, transferTaskId);
    } else {
      // Edge only reports why an attempt stopped.  Retry timing and the
      // bounded recovery budget are Core policy and must not be influenced by
      // an Edge retryAt/terminal flag.
      const recoveryAttempts = Number(task.edge_recovery_attempts ?? 0) + 1;
      const terminal = recoveryAttempts >= Math.max(1, Number(retryLimit) || 5);
      const retryAt = terminal ? null : new Date(Date.now() + transferRecoveryDelay(recoveryAttempts)).toISOString();
      this.db.prepare("UPDATE core_transfer_tasks SET edge_status = ?, edge_attempts = ?, edge_attempt_started_at = NULL, edge_last_activity_at = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = NULL, edge_retry_at = ?, edge_error_code = ?, edge_last_error = ?, edge_failure_terminal = ?, edge_recovery_attempts = ?, updated_at = ? WHERE transfer_task_id = ?")
        .run(terminal ? 'FAILED' : 'RETRY_WAIT', attempt, timestamp, retryAt, code, message, terminal ? 1 : 0, recoveryAttempts, timestamp, transferTaskId);
    }
    return { item: this.get(requestId), idempotent: false };
  }

  // Compatibility endpoint used by older Edge instances during rolling upgrades.
  recordEdgeTransferFailure(input = {}, config = {}) {
    return this.recordEdgeTransferStatus({ ...input, state: input.terminal ? 'FAILED' : 'RETRY_WAIT' }, config);
  }

  beginEdgeRecovery(requestId, { resetRecoveryBudget = false } = {}) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (current.status !== 'APPROVED' || !current.transferTaskId) throw Object.assign(new Error('当前申请没有可恢复的 Edge → Core 传输任务'), { code: 'transfer_recovery_unavailable' });
    const task = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE request_id = ? AND transfer_task_id = ?').get(requestId, current.transferTaskId);
    if (!task) throw Object.assign(new Error('传输任务不存在'), { code: 'transfer_task_not_found' });
    if (task.status === 'RECEIVED' || task.edge_status === 'RECEIVED') return { item: current, idempotent: true };
    if (task.edge_status === 'RECOVERY_SENDING') return { item: current, idempotent: true };
    const terminal = Boolean(task.edge_failure_terminal);
    if (terminal && !resetRecoveryBudget) throw Object.assign(new Error('自动恢复已停止，请使用兜底恢复'), { code: 'transfer_fallback_required' });
    if (!terminal && resetRecoveryBudget) throw Object.assign(new Error('当前传输仍可由普通恢复处理，无需兜底恢复'), { code: 'transfer_fallback_not_required' });
    if (!terminal && task.edge_status !== 'RETRY_WAIT') throw Object.assign(new Error('当前传输不在可恢复状态'), { code: 'transfer_recovery_unavailable' });
    const timestamp = now();
    // A fallback recovery only resets Core's coordination budget. The Edge
    // attempt counter, its partial chunks, and already received artifacts are
    // deliberately retained so the next command resumes rather than restarts.
    this.db.prepare(`UPDATE core_transfer_tasks SET edge_status = ?,
      edge_retry_at = NULL, edge_start_deadline_at = NULL, edge_idle_deadline_at = NULL,
      edge_failure_terminal = CASE WHEN ? THEN 0 ELSE edge_failure_terminal END,
      edge_recovery_attempts = CASE WHEN ? THEN 0 ELSE edge_recovery_attempts END,
      updated_at = ? WHERE request_id = ? AND transfer_task_id = ? AND edge_status IN ('RETRY_WAIT', 'FAILED')`)
      .run('RECOVERY_SENDING', resetRecoveryBudget ? 1 : 0, resetRecoveryBudget ? 1 : 0, timestamp, requestId, current.transferTaskId);
    return { item: this.get(requestId), idempotent: false, task: { ...task, edge_status: 'RECOVERY_SENDING' } };
  }

  expireEdgeTransferTimeouts({ transferStartTimeoutMs = 300_000, retryLimit = 5 } = {}) {
    const timestamp = now();
    const recoveryDispatchCutoff = new Date(Date.now() - transferStartTimeoutMs).toISOString();
    const due = this.db.prepare(`SELECT * FROM core_transfer_tasks
      WHERE status <> 'RECEIVED' AND edge_failure_terminal = 0 AND (
        (edge_status = 'ACCEPTED' AND edge_start_deadline_at IS NOT NULL AND edge_start_deadline_at <= ?) OR
        (edge_status IN ('STARTED', 'RECEIVING', 'WAITING_RECEIPT') AND edge_idle_deadline_at IS NOT NULL AND edge_idle_deadline_at <= ?) OR
        (edge_status = 'RECOVERY_SENDING' AND updated_at <= ?)
      )`).all(timestamp, timestamp, recoveryDispatchCutoff);
    for (const task of due) {
      const startTimeout = task.edge_status === 'ACCEPTED';
      const dispatchTimeout = task.edge_status === 'RECOVERY_SENDING';
      const attempts = Number(task.edge_recovery_attempts ?? 0) + 1;
      const terminal = attempts >= retryLimit;
      const retryAt = terminal ? null : new Date(Date.now() + transferRecoveryDelay(attempts)).toISOString();
      const code = dispatchTimeout ? 'edge_recovery_dispatch_timeout' : startTimeout ? 'edge_start_timeout' : 'edge_idle_timeout';
      const message = dispatchTimeout
        ? 'Core 发出的 Edge 恢复指令长时间未得到确认，已转入下一次协调恢复'
        : startTimeout
        ? '等待 Edge 开始传输超时，未收到开始或首个分块信号'
        : 'Edge → Core 传输空闲超时，未收到控制进度或新的分块数据';
      this.db.prepare("UPDATE core_transfer_tasks SET edge_status = ?, edge_retry_at = ?, edge_error_code = ?, edge_last_error = ?, edge_failure_terminal = ?, edge_recovery_attempts = ?, edge_start_deadline_at = NULL, edge_idle_deadline_at = NULL, updated_at = ? WHERE transfer_task_id = ?")
        .run(terminal ? 'FAILED' : 'RETRY_WAIT', retryAt, code, message, terminal ? 1 : 0, attempts, timestamp, task.transfer_task_id);
    }
    return due.length;
  }

  claimDueEdgeRecoveries(limit = 20) {
    const timestamp = now();
    const rows = this.db.prepare(`SELECT * FROM core_transfer_tasks
      WHERE status <> 'RECEIVED' AND edge_status = 'RETRY_WAIT' AND edge_failure_terminal = 0
        AND edge_retry_at IS NOT NULL AND edge_retry_at <= ?
      ORDER BY edge_retry_at ASC LIMIT ?`).all(timestamp, Math.max(1, Math.min(Number(limit) || 20, 100)));
    const claim = this.db.prepare("UPDATE core_transfer_tasks SET edge_status = 'RECOVERY_SENDING', updated_at = ? WHERE transfer_task_id = ? AND edge_status = 'RETRY_WAIT'");
    const claimed = [];
    for (const task of rows) if (claim.run(timestamp, task.transfer_task_id).changes) claimed.push({ ...task, edge_status: 'RECOVERY_SENDING' });
    return claimed;
  }

  markEdgeRecoveryDispatchResult(transferTaskId, { ok, error = null, edgeState = null, transferStartTimeoutMs = 300_000, transferIdleTimeoutMs = 300_000, retryLimit = 5 } = {}) {
    const task = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE transfer_task_id = ?').get(transferTaskId);
    if (!task) throw Object.assign(new Error('传输任务不存在'), { code: 'transfer_task_not_found' });
    if (task.status === 'RECEIVED') return { item: this.get(task.request_id), idempotent: true };
    const timestamp = now();
    if (ok) {
      // This acknowledgement means that Edge accepted the control request,
      // not that it is transferring. Keep the accumulated coordination count
      // until a later PROGRESS report arrives.
      const alreadySending = edgeState === 'SENDING' || edgeState === 'RECEIVED';
      const nextStatus = edgeState === 'RECEIVED' ? 'WAITING_RECEIPT' : alreadySending ? 'STARTED' : 'ACCEPTED';
      this.db.prepare(`UPDATE core_transfer_tasks SET edge_status = ?,
        edge_attempt_started_at = CASE WHEN ? THEN COALESCE(edge_attempt_started_at, ?) ELSE NULL END,
        edge_last_activity_at = ?, edge_start_deadline_at = CASE WHEN ? THEN NULL ELSE ? END,
        edge_idle_deadline_at = CASE WHEN ? THEN ? ELSE NULL END,
        edge_retry_at = NULL, edge_failure_terminal = 0, updated_at = ?
        WHERE transfer_task_id = ? AND edge_status = 'RECOVERY_SENDING'`)
        .run(nextStatus, alreadySending ? 1 : 0, timestamp, timestamp, alreadySending ? 1 : 0, deadlineAfter(transferStartTimeoutMs), alreadySending ? 1 : 0, deadlineAfter(transferIdleTimeoutMs), timestamp, transferTaskId);
      return { item: this.get(task.request_id), idempotent: false };
    }
    // A command that could not be delivered is itself a failed coordination
    // cycle. Count it so an unavailable Edge cannot leave Core retrying
    // forever without surfacing a recoverable terminal state.
    const attempts = Number(task.edge_recovery_attempts ?? 0) + 1;
    const terminal = attempts >= retryLimit;
    const retryAt = terminal ? null : new Date(Date.now() + transferRecoveryDelay(attempts)).toISOString();
    this.db.prepare("UPDATE core_transfer_tasks SET edge_status = ?, edge_retry_at = ?, edge_error_code = 'edge_recovery_dispatch_failed', edge_last_error = ?, edge_failure_terminal = ?, edge_recovery_attempts = ?, updated_at = ? WHERE transfer_task_id = ?")
      .run(terminal ? 'FAILED' : 'RETRY_WAIT', retryAt, String(error?.message ?? error ?? 'Core 无法向 Edge 发送恢复指令').slice(0, 1000), terminal ? 1 : 0, attempts, timestamp, transferTaskId);
    return { item: this.get(task.request_id), idempotent: false };
  }

  receiveReceipt(input = {}) {
    const requestId = required(input.requestId, 'requestId');
    const transferTaskId = required(input.transferTaskId, 'transferTaskId');
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    // CLOSED is a terminal cloud state, but receipt delivery is deliberately
    // idempotent so a late/retried Edge receipt can reconcile successfully.
    if (!['APPROVED', 'CLOSED'].includes(current.status)) throw Object.assign(new Error('cloud approval is not confirmed'), { code: 'approval_required' });
    if (current.cloudTransferTaskId !== transferTaskId) throw Object.assign(new Error('transfer task does not match cloud approval'), { code: 'transfer_task_mismatch' });
    if (input.manifestSha256?.toLowerCase() !== current.manifestSha256) throw Object.assign(new Error('received manifest does not match approved manifest'), { code: 'manifest_mismatch' });
    const existing = this.db.prepare('SELECT * FROM core_transfer_tasks WHERE request_id = ?').get(requestId);
    if (!existing) this.authorizeTransfer(requestId, { manifestSha256: current.manifestSha256, transferTaskId });
    const timestamp = now();
    if (JSON.parse(this.db.prepare('SELECT envelope_json FROM core_approval_requests WHERE request_id = ?').get(requestId).envelope_json ?? '{}').manifest?.items?.length) this.assertTransferComplete(transferTaskId);
    this.db.prepare("UPDATE core_transfer_tasks SET status = 'RECEIVED', edge_status = 'RECEIVED', edge_start_deadline_at = NULL, edge_idle_deadline_at = NULL, edge_retry_at = NULL, edge_error_code = NULL, edge_last_error = NULL, edge_failure_terminal = 0, updated_at = ? WHERE request_id = ? AND transfer_task_id = ?").run(timestamp, requestId, transferTaskId);
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
