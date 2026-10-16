import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachmentExtension, validAttachmentFileName } from '../../../libs/cam-server/src/attachment-types.js';

const now = () => new Date().toISOString();
const makeId = () => `FREEZE-${Date.now()}-${randomUUID()}`;
const hash = (value) => createHash('sha256').update(value).digest('hex');

export class FreezeStore {
  constructor({ db, dataDir, candidateStore }) {
    this.db = db;
    this.dataDir = join(dataDir, 'verification-reports');
    this.exchangeDir = join(dataDir, 'exchange', 'outbox', 'approval-requests');
    this.candidates = candidateStore;
    db.exec(`CREATE TABLE IF NOT EXISTS round_freezes (
      freeze_id TEXT PRIMARY KEY,
      round_id TEXT NOT NULL REFERENCES release_rounds(round_id),
      status TEXT NOT NULL,
      report_title TEXT NOT NULL,
      conclusion TEXT NOT NULL,
      environment TEXT NOT NULL,
      report_file_name TEXT,
      report_path TEXT,
      report_sha256 TEXT,
      manifest_json TEXT NOT NULL,
      manifest_sha256 TEXT NOT NULL,
      submitted_by TEXT NOT NULL,
      submitted_at TEXT,
      decided_by TEXT,
      decided_at TEXT,
      decision_reference TEXT,
      decision_comment TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS round_freezes_round_idx ON round_freezes(round_id, created_at DESC);`);
    const columns = new Set(db.prepare('PRAGMA table_info(round_freezes)').all().map((column) => column.name));
    const additions = {
      dispatch_status: "TEXT NOT NULL DEFAULT 'PENDING'",
      dispatch_attempts: 'INTEGER NOT NULL DEFAULT 0',
      dispatch_last_error: 'TEXT',
      dispatch_at: 'TEXT',
      core_approval_id: 'TEXT',
      core_status: 'TEXT',
      core_response_json: 'TEXT',
      report_size: 'INTEGER'
    };
    for (const [name, definition] of Object.entries(additions)) if (!columns.has(name)) db.exec(`ALTER TABLE round_freezes ADD COLUMN ${name} ${definition}`);
    db.prepare("UPDATE round_freezes SET dispatch_status = 'PENDING' WHERE status = 'PENDING_APPROVAL' AND dispatch_status = 'SENDING'").run();
  }

  snapshot(roundId) {
    const round = this.candidates.getRound(roundId);
    if (!round) throw Object.assign(new Error('round not found'), { code: 'round_not_found' });
    const rows = this.candidates.listRoundCandidates(roundId);
    if (!rows.length) throw Object.assign(new Error('轮次没有候选包，不能申请固化'), { code: 'round_empty' });
    const incomplete = rows.filter((candidate) => candidate.status !== 'COMPLETED' || !candidate.final_sha256);
    if (incomplete.length) throw Object.assign(new Error(`所有候选包必须完成接收并生成实测 SHA-256：${incomplete.map((item) => item.file_name).join('、')}`), { code: 'round_incomplete' });
    return {
      product: round.productName,
      productId: round.productId,
      releaseId: round.releaseId,
      version: round.version,
      roundId: round.roundId,
      roundNo: round.roundNo,
      createdAt: now(),
      items: rows.map((item) => ({
        packageKey: item.package_key,
        candidateId: item.candidate_id,
        fileName: item.file_name,
        version: item.version,
        architecture: item.architecture,
        sizeBytes: item.expected_size,
        expectedMd5: item.expected_md5,
        expectedSha256: item.expected_sha256,
        actualMd5: item.final_md5,
        actualSha256: item.final_sha256,
        targets: item.targets,
        type: item.metadata?.type ?? null,
        source: item.mapping_source,
        inheritedFromRoundId: item.inherited_from_round_id
      }))
    };
  }

  locked(roundId) {
    return Boolean(this.db.prepare("SELECT 1 FROM round_freezes WHERE round_id = ? AND status IN ('PENDING_APPROVAL','APPROVED') LIMIT 1").get(roundId));
  }

  get(freezeId) {
    const row = this.db.prepare('SELECT * FROM round_freezes WHERE freeze_id = ?').get(freezeId);
    return row ? this.parse(row) : null;
  }

  parse(row) {
    if (!row) return null;
    return {
      freezeId: row.freeze_id, roundId: row.round_id, status: row.status,
      reportTitle: row.report_title, conclusion: row.conclusion, environment: row.environment,
      reportFileName: row.report_file_name, reportSha256: row.report_sha256, reportSize: row.report_size ?? null,
      manifest: JSON.parse(row.manifest_json), manifestSha256: row.manifest_sha256,
      submittedBy: row.submitted_by, submittedAt: row.submitted_at,
      decidedBy: row.decided_by, decidedAt: row.decided_at,
      decisionReference: row.decision_reference, decisionComment: row.decision_comment,
      dispatchStatus: row.dispatch_status ?? 'PENDING', dispatchAttempts: row.dispatch_attempts ?? 0,
      dispatchLastError: row.dispatch_last_error, dispatchAt: row.dispatch_at,
      coreApprovalId: row.core_approval_id, coreStatus: row.core_status,
      coreResponse: row.core_response_json ? JSON.parse(row.core_response_json) : null,
      createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  latest(roundId) {
    return this.parse(this.db.prepare('SELECT * FROM round_freezes WHERE round_id = ? ORDER BY created_at DESC LIMIT 1').get(roundId));
  }

  list() {
    return this.db.prepare('SELECT * FROM round_freezes ORDER BY created_at DESC').all().map((row) => this.parse(row));
  }

  createDraft(roundId, { reportTitle, conclusion, environment }, actorId) {
    if (this.locked(roundId)) throw Object.assign(new Error('该轮次已有待审批或已固化申请，内容已锁定'), { code: 'round_locked' });
    const title = String(reportTitle ?? '').trim();
    const env = String(environment ?? '').trim();
    if (!title || title.length > 200) throw new Error('验证报告标题必填，且不超过 200 字');
    if (!['PASS', 'PASS_WITH_LIMITATIONS'].includes(conclusion)) throw new Error('验证结论必须为 PASS 或 PASS_WITH_LIMITATIONS');
    if (!env || env.length > 1000) throw new Error('验证环境必填，且不超过 1000 字');
    const snapshot = this.snapshot(roundId);
    const manifestJson = JSON.stringify(snapshot);
    const freezeId = makeId();
    const timestamp = now();
    this.db.prepare(`INSERT INTO round_freezes
      (freeze_id, round_id, status, report_title, conclusion, environment, manifest_json, manifest_sha256, submitted_by, created_at, updated_at)
      VALUES (?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(freezeId, roundId, title, conclusion, env, manifestJson, hash(manifestJson), actorId, timestamp, timestamp);
    return this.get(freezeId);
  }

  async saveReport(freezeId, fileName, bytes, actorId) {
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('freeze request not found'), { code: 'freeze_not_found' });
    if (freeze.submittedBy !== actorId) throw Object.assign(new Error('只有草稿创建人可以上传验证报告'), { code: 'freeze_owner_required' });
    if (freeze.status !== 'DRAFT') throw Object.assign(new Error('只有草稿申请可以上传验证报告'), { code: 'freeze_not_editable' });
    if (!validAttachmentFileName(fileName)) throw new Error('验证报告仅支持 DOCX、PDF、WPS、TXT、MD，文件名不超过 180 字');
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 20 * 1024 * 1024) throw new Error('验证报告必须大于 0 且不超过 20 MiB');
    if (attachmentExtension(fileName) === '.pdf' && (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-')) throw new Error('文件内容不是有效 PDF');
    await mkdir(this.dataDir, { recursive: true });
    const previousPath = this.reportPath(freezeId);
    const destination = join(this.dataDir, `${freezeId}${attachmentExtension(fileName)}`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
    this.db.prepare('UPDATE round_freezes SET report_file_name = ?, report_path = ?, report_sha256 = ?, report_size = ?, updated_at = ? WHERE freeze_id = ? AND status = \'DRAFT\'')
      .run(fileName, destination, hash(bytes), bytes.length, now(), freezeId);
    if (previousPath && previousPath !== destination) await rm(previousPath, { force: true });
    return this.get(freezeId);
  }

  async submit(freezeId, actorId) {
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('freeze request not found'), { code: 'freeze_not_found' });
    if (freeze.submittedBy !== actorId) throw Object.assign(new Error('只有草稿创建人可以提交固化申请'), { code: 'freeze_owner_required' });
    if (freeze.status !== 'DRAFT') throw Object.assign(new Error('该申请不在草稿状态'), { code: 'freeze_not_draft' });
    if (!freeze.reportFileName || !freeze.reportSha256) throw Object.assign(new Error('请先上传验证报告'), { code: 'report_required' });
    if (this.locked(freeze.roundId)) throw Object.assign(new Error('该轮次已有待审批或已固化申请'), { code: 'round_locked' });
    const current = this.snapshot(freeze.roundId);
    const snapshot = JSON.parse(this.db.prepare('SELECT manifest_json FROM round_freezes WHERE freeze_id = ?').get(freezeId).manifest_json);
    const comparable = (value) => { const { createdAt, ...rest } = value; return JSON.stringify(rest); };
    if (comparable(snapshot) !== comparable(current)) throw Object.assign(new Error('候选清单在申请期间发生变化，请重新创建固化申请'), { code: 'manifest_changed' });
    const timestamp = now();
    const envelope = {
      schemaVersion: 1,
      type: 'VERIFICATION_APPROVAL_REQUEST',
      requestId: freeze.freezeId,
      freezeId: freeze.freezeId,
      roundId: freeze.roundId,
      releaseId: freeze.manifest.releaseId,
      manifestSha256: freeze.manifestSha256,
      reportSha256: freeze.reportSha256,
      reportFileName: freeze.reportFileName,
      reportSize: freeze.reportSize,
      conclusion: freeze.conclusion,
      submittedBy: freeze.submittedBy,
      submittedAt: timestamp
    };
    await mkdir(this.exchangeDir, { recursive: true });
    const destination = join(this.exchangeDir, `${freezeId}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
      this.db.prepare("UPDATE round_freezes SET status = 'PENDING_APPROVAL', dispatch_status = 'PENDING', dispatch_attempts = 0, dispatch_last_error = NULL, dispatch_at = NULL, core_approval_id = NULL, core_status = NULL, core_response_json = NULL, submitted_at = ?, updated_at = ? WHERE freeze_id = ? AND status = 'DRAFT'").run(timestamp, timestamp, freezeId);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
    return this.get(freezeId);
  }

  approvalEnvelope(freezeId) {
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('freeze request not found'), { code: 'freeze_not_found' });
    return {
      schemaVersion: 1, type: 'VERIFICATION_APPROVAL_REQUEST', requestId: freeze.freezeId,
      freezeId: freeze.freezeId, roundId: freeze.roundId, releaseId: freeze.manifest.releaseId,
      manifestSha256: freeze.manifestSha256, reportSha256: freeze.reportSha256,
      reportFileName: freeze.reportFileName, reportSize: freeze.reportSize, conclusion: freeze.conclusion,
      submittedBy: freeze.submittedBy, submittedAt: freeze.submittedAt
    };
  }

  listDispatchPending() {
    return this.db.prepare("SELECT * FROM round_freezes WHERE status = 'PENDING_APPROVAL' AND dispatch_status IN ('PENDING','FAILED') ORDER BY submitted_at ASC").all().map((row) => this.parse(row));
  }

  markDispatchAttempt(freezeId) {
    const timestamp = now();
    this.db.prepare("UPDATE round_freezes SET dispatch_status = 'SENDING', dispatch_attempts = dispatch_attempts + 1, dispatch_last_error = NULL, updated_at = ? WHERE freeze_id = ? AND status = 'PENDING_APPROVAL' AND dispatch_status IN ('PENDING','FAILED')").run(timestamp, freezeId);
    return this.get(freezeId);
  }

  markDispatchSuccess(freezeId, response) {
    const item = response?.item ?? response ?? {};
    const timestamp = now();
    this.db.prepare("UPDATE round_freezes SET dispatch_status = 'DELIVERED', dispatch_at = ?, dispatch_last_error = NULL, core_approval_id = ?, core_status = ?, core_response_json = ?, updated_at = ? WHERE freeze_id = ?").run(timestamp, item.cloudApprovalId ?? null, item.status ?? null, JSON.stringify(response ?? {}), timestamp, freezeId);
    return this.get(freezeId);
  }

  markCoreStatus(freezeId, response) {
    const item = response?.item ?? response ?? {};
    const timestamp = now();
    this.db.prepare('UPDATE round_freezes SET core_approval_id = COALESCE(?, core_approval_id), core_status = ?, core_response_json = ?, updated_at = ? WHERE freeze_id = ?').run(item.cloudApprovalId ?? null, item.status ?? null, JSON.stringify(response ?? {}), timestamp, freezeId);
    return this.get(freezeId);
  }

  markDispatchFailure(freezeId, error) {
    const message = String(error?.message ?? error).slice(0, 1000);
    this.db.prepare("UPDATE round_freezes SET dispatch_status = 'FAILED', dispatch_last_error = ?, updated_at = ? WHERE freeze_id = ? AND status = 'PENDING_APPROVAL'").run(message, now(), freezeId);
    return this.get(freezeId);
  }

  decide(freezeId, { decision, reference = null, comment = null }, actorId) {
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('freeze request not found'), { code: 'freeze_not_found' });
    if (freeze.status !== 'PENDING_APPROVAL') throw Object.assign(new Error('该申请当前不在待审批状态'), { code: 'freeze_not_pending' });
    if (freeze.submittedBy === actorId) throw Object.assign(new Error('申请人不能审批自己的固化申请'), { code: 'self_approval_forbidden' });
    if (!['APPROVE', 'REJECT'].includes(decision)) throw new Error('decision 必须是 APPROVE 或 REJECT');
    const note = String(comment ?? '').trim();
    const ref = String(reference ?? '').trim();
    if (decision === 'REJECT' && !note) throw new Error('拒绝申请必须填写意见');
    if (note.length > 2000 || ref.length > 200) throw new Error('审批意见或编号超出长度限制');
    const timestamp = now();
    this.db.prepare('UPDATE round_freezes SET status = ?, decided_by = ?, decided_at = ?, decision_reference = ?, decision_comment = ?, updated_at = ? WHERE freeze_id = ?')
      .run(decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', actorId, timestamp, ref || null, note || null, timestamp, freezeId);
    return this.get(freezeId);
  }

  reportPath(freezeId) {
    const row = this.db.prepare("SELECT report_path FROM round_freezes WHERE freeze_id = ? AND report_path IS NOT NULL").get(freezeId);
    return row?.report_path ?? null;
  }
}
