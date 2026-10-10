import { createHash, randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${Date.now()}-${randomUUID()}`;
const digest = (value) => createHash('sha256').update(value).digest('hex');

function required(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw Object.assign(new Error(`${name} is required`), { code: 'invalid_message' });
  return value.trim();
}

function response(row) {
  if (!row) return null;
  return { requestId: row.request_id, freezeId: row.freeze_id, roundId: row.round_id, releaseId: row.release_id, status: row.status, manifestSha256: row.manifest_sha256, reportSha256: row.report_sha256, cloudApprovalId: row.cloud_approval_id, cloudTransferTaskId: row.cloud_transfer_task_id, cloudStatus: row.cloud_status, cloudCheckedAt: row.cloud_checked_at, approvedAt: row.approved_at, expiresAt: row.expires_at, closeStatus: row.close_status, closeCheckedAt: row.close_checked_at, createdAt: row.created_at, updatedAt: row.updated_at, lastError: row.last_error, transferTaskId: row.transfer_task_id };
}

export class CoreStore {
  constructor(db) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS core_approval_requests (
        request_id TEXT PRIMARY KEY, freeze_id TEXT NOT NULL UNIQUE, round_id TEXT NOT NULL, release_id TEXT NOT NULL,
        status TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, report_sha256 TEXT, envelope_json TEXT NOT NULL,
        cloud_approval_id TEXT, cloud_transfer_task_id TEXT, cloud_status TEXT, cloud_checked_at TEXT,
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
    `);
  }

  get(requestId) { return response(this.db.prepare('SELECT * FROM core_approval_requests WHERE request_id = ?').get(requestId)); }
  getByFreeze(freezeId) { return response(this.db.prepare('SELECT * FROM core_approval_requests WHERE freeze_id = ?').get(freezeId)); }

  receiveApproval(envelope) {
    const requestId = required(envelope.requestId, 'requestId');
    const freezeId = required(envelope.freezeId, 'freezeId');
    const roundId = required(envelope.roundId, 'roundId');
    const releaseId = required(envelope.releaseId, 'releaseId');
    const manifestSha256 = required(envelope.manifestSha256, 'manifestSha256').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(manifestSha256)) throw Object.assign(new Error('manifestSha256 must be SHA-256'), { code: 'invalid_message' });
    if (envelope.reportSha256 && !/^[a-f0-9]{64}$/i.test(envelope.reportSha256)) throw Object.assign(new Error('reportSha256 must be SHA-256'), { code: 'invalid_message' });
    const payload = JSON.stringify({ ...envelope, manifestSha256, reportSha256: envelope.reportSha256?.toLowerCase() ?? null });
    const payloadSha256 = digest(payload);
    const existing = this.get(requestId);
    if (existing) {
      if (existing.manifestSha256 !== manifestSha256 || existing.releaseId !== releaseId) throw Object.assign(new Error('requestId is already bound to another release or manifest'), { code: 'request_conflict' });
      return { item: existing, idempotent: true };
    }
    const timestamp = now();
    this.db.prepare('INSERT INTO core_message_inbox (message_id, message_type, request_id, payload_sha256, received_at, status) VALUES (?, ?, ?, ?, ?, \'ACCEPTED\')').run(id('MSG'), envelope.type ?? 'VERIFICATION_APPROVAL_REQUEST', requestId, payloadSha256, timestamp);
    this.db.prepare('INSERT INTO core_approval_requests (request_id, freeze_id, round_id, release_id, status, manifest_sha256, report_sha256, envelope_json, created_at, updated_at) VALUES (?, ?, ?, ?, \'CLOUD_PENDING\', ?, ?, ?, ?, ?)').run(requestId, freezeId, roundId, releaseId, manifestSha256, envelope.reportSha256?.toLowerCase() ?? null, payload, timestamp, timestamp);
    return { item: this.get(requestId), idempotent: false };
  }

  markCloudSubmitted(requestId, result) {
    const approvalId = required(result.approvalId, 'approvalId');
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET cloud_approval_id = ?, cloud_status = ?, status = 'CLOUD_SUBMITTED', last_error = NULL, updated_at = ? WHERE request_id = ?").run(approvalId, result.status ?? 'PENDING', timestamp, requestId);
    return this.get(requestId);
  }

  applyCloudStatus(requestId, result) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    const cloudStatus = required(result.status, 'status').toUpperCase();
    if (result.approvalId && current.cloudApprovalId && result.approvalId !== current.cloudApprovalId) throw Object.assign(new Error('cloud approval ID does not match request'), { code: 'cloud_identity_mismatch' });
    if (cloudStatus === 'APPROVED') {
      if (result.manifestSha256 && result.manifestSha256.toLowerCase() !== current.manifestSha256) throw Object.assign(new Error('cloud approved manifest does not match request'), { code: 'cloud_manifest_mismatch' });
      if (!result.transferTaskId) throw Object.assign(new Error('approved result must include transferTaskId'), { code: 'cloud_result_invalid' });
    }
    const status = cloudStatus === 'APPROVED' ? 'APPROVED' : cloudStatus === 'REJECTED' ? 'REJECTED' : 'CLOUD_SUBMITTED';
    const timestamp = now();
    this.db.prepare("UPDATE core_approval_requests SET status = ?, cloud_status = ?, cloud_approval_id = COALESCE(?, cloud_approval_id), cloud_transfer_task_id = COALESCE(?, cloud_transfer_task_id), cloud_checked_at = ?, approved_at = ?, expires_at = ?, last_error = NULL, updated_at = ? WHERE request_id = ?").run(status, cloudStatus, result.approvalId ?? null, result.transferTaskId ?? null, timestamp, status === 'APPROVED' ? (result.approvedAt ?? timestamp) : null, result.expiresAt ?? null, timestamp, requestId);
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
    this.db.prepare("UPDATE core_transfer_tasks SET status = 'RECEIVED', updated_at = ? WHERE request_id = ? AND transfer_task_id = ?").run(timestamp, requestId, transferTaskId);
    return { requestId, transferTaskId, status: 'RECEIVED', manifestSha256: current.manifestSha256, receivedAt: timestamp };
  }

  close(requestId, result = {}) {
    const current = this.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    const timestamp = now();
    const status = result.status ?? 'CLOSED';
    this.db.prepare("UPDATE core_approval_requests SET close_status = ?, close_checked_at = ?, status = CASE WHEN ? = 'CLOSED' THEN 'CLOSED' ELSE status END, updated_at = ? WHERE request_id = ?").run(status, timestamp, status, timestamp, requestId);
    return this.get(requestId);
  }
}
