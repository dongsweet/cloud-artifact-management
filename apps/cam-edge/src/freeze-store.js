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
      submitted_by_username TEXT,
      submitted_by_display_name TEXT,
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
      report_size: 'INTEGER',
      transfer_task_id: 'TEXT',
      transfer_status: "TEXT NOT NULL DEFAULT 'IDLE'",
      transfer_attempts: 'INTEGER NOT NULL DEFAULT 0',
      transfer_last_error: 'TEXT',
      transfer_error_code: 'TEXT',
      transfer_retry_at: 'TEXT',
      transfer_retry_exhausted: 'INTEGER NOT NULL DEFAULT 0',
      transfer_at: 'TEXT',
      submitted_by_username: 'TEXT',
      submitted_by_display_name: 'TEXT'
    };
    for (const [name, definition] of Object.entries(additions)) if (!columns.has(name)) db.exec(`ALTER TABLE round_freezes ADD COLUMN ${name} ${definition}`);
    db.exec(`CREATE TABLE IF NOT EXISTS edge_core_approval_events (
      event_id TEXT PRIMARY KEY,
      freeze_id TEXT NOT NULL REFERENCES round_freezes(freeze_id),
      payload_sha256 TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('APPROVED','REJECTED','WITHDRAWN')),
      received_at TEXT NOT NULL
    )`);
    const approvalEventSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'edge_core_approval_events'").get()?.sql ?? '';
    if (approvalEventSchema && !approvalEventSchema.includes("'WITHDRAWN'")) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
          ALTER TABLE edge_core_approval_events RENAME TO edge_core_approval_events_legacy;
          CREATE TABLE edge_core_approval_events (
            event_id TEXT PRIMARY KEY,
            freeze_id TEXT NOT NULL REFERENCES round_freezes(freeze_id),
            payload_sha256 TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('APPROVED','REJECTED','WITHDRAWN')),
            received_at TEXT NOT NULL
          );
          INSERT INTO edge_core_approval_events (event_id, freeze_id, payload_sha256, status, received_at)
          SELECT event_id, freeze_id, payload_sha256, status, received_at FROM edge_core_approval_events_legacy;
          DROP TABLE edge_core_approval_events_legacy;
        `);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    db.exec(`CREATE TABLE IF NOT EXISTS edge_core_transfer_events (
      event_id TEXT PRIMARY KEY,
      freeze_id TEXT NOT NULL REFERENCES round_freezes(freeze_id),
      payload_sha256 TEXT NOT NULL,
      transfer_task_id TEXT NOT NULL,
      received_at TEXT NOT NULL
    )`);
    db.prepare(`UPDATE releases SET status = 'SEALED', updated_at = ? WHERE EXISTS (
      SELECT 1 FROM release_rounds rr JOIN round_freezes rf ON rf.round_id = rr.round_id
      WHERE rr.release_id = releases.release_id AND rf.status = 'APPROVED'
    )`).run(now());
    // Cloud work-order identifiers, states and error payloads are internal to Core.
    db.prepare('UPDATE round_freezes SET core_approval_id = NULL, core_status = NULL, core_response_json = NULL').run();
    db.prepare("UPDATE round_freezes SET dispatch_status = 'PENDING' WHERE status = 'PENDING_APPROVAL' AND dispatch_status = 'SENDING'").run();
    db.prepare("UPDATE round_freezes SET transfer_status = 'READY' WHERE status = 'APPROVED' AND transfer_status = 'SENDING'").run();
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
      revision: round.revision ?? 0,
      displayVersion: round.displayVersion ?? round.version,
      roundId: round.roundId,
      roundNo: round.roundNo,
      baseReleaseId: round.baseReleaseId ?? null,
      baseRoundId: round.baseRoundId ?? null,
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
      submittedBy: row.submitted_by, submittedByUsername: row.submitted_by_username ?? null, submittedByDisplayName: row.submitted_by_display_name ?? null, submittedAt: row.submitted_at,
      decidedBy: row.decided_by, decidedAt: row.decided_at,
      decisionReference: row.decision_reference, decisionComment: row.decision_comment,
      dispatchStatus: row.dispatch_status ?? 'PENDING', dispatchAt: row.dispatch_at,
      transferTaskId: row.transfer_task_id ?? null, transferStatus: row.transfer_status ?? 'IDLE',
      transferAttempts: row.transfer_attempts ?? 0, transferLastError: row.transfer_last_error ?? null,
      transferErrorCode: row.transfer_error_code ?? null, transferRetryAt: row.transfer_retry_at ?? null,
      transferRetryExhausted: Boolean(row.transfer_retry_exhausted), transferAt: row.transfer_at ?? null,
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
    const round = this.candidates.getRound(roundId);
    if (!round) throw Object.assign(new Error('round not found'), { code: 'round_not_found' });
    this.candidates.assertReleaseOpen(round.releaseId);
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
    const round = this.candidates.getRound(freeze.roundId);
    if (!round) throw Object.assign(new Error('round not found'), { code: 'round_not_found' });
    this.candidates.assertReleaseOpen(round.releaseId);
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

  async submit(freezeId, actorId, actor = {}) {
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('freeze request not found'), { code: 'freeze_not_found' });
    if (freeze.submittedBy !== actorId) throw Object.assign(new Error('只有草稿创建人可以提交固化申请'), { code: 'freeze_owner_required' });
    if (freeze.status !== 'DRAFT') throw Object.assign(new Error('该申请不在草稿状态'), { code: 'freeze_not_draft' });
    const round = this.candidates.getRound(freeze.roundId);
    if (!round) throw Object.assign(new Error('round not found'), { code: 'round_not_found' });
    this.candidates.assertReleaseOpen(round.releaseId);
    if (!freeze.reportFileName || !freeze.reportSha256) throw Object.assign(new Error('请先上传验证报告'), { code: 'report_required' });
    if (this.locked(freeze.roundId)) throw Object.assign(new Error('该轮次已有待审批或已固化申请'), { code: 'round_locked' });
    const current = this.snapshot(freeze.roundId);
    const snapshot = JSON.parse(this.db.prepare('SELECT manifest_json FROM round_freezes WHERE freeze_id = ?').get(freezeId).manifest_json);
    const comparable = (value) => { const { createdAt, ...rest } = value; return JSON.stringify(rest); };
    if (comparable(snapshot) !== comparable(current)) throw Object.assign(new Error('候选清单在申请期间发生变化，请重新创建固化申请'), { code: 'manifest_changed' });
    const timestamp = now();
    this.db.prepare('UPDATE round_freezes SET submitted_by_username = ?, submitted_by_display_name = ? WHERE freeze_id = ? AND status = \'DRAFT\'')
      .run(actor.username ?? null, actor.displayName ?? null, freezeId);
    const envelope = {
      schemaVersion: 1,
      type: 'VERIFICATION_APPROVAL_REQUEST',
      requestId: freeze.freezeId,
      freezeId: freeze.freezeId,
      roundId: freeze.roundId,
      releaseId: freeze.manifest.releaseId,
      productName: freeze.manifest.product,
      version: freeze.manifest.version,
      revision: freeze.manifest.revision ?? 0,
      displayVersion: freeze.manifest.displayVersion ?? freeze.manifest.version,
      roundNo: freeze.manifest.roundNo,
      reportTitle: freeze.reportTitle,
      environment: freeze.environment,
      manifestSha256: freeze.manifestSha256,
      reportSha256: freeze.reportSha256,
      reportFileName: freeze.reportFileName,
      reportSize: freeze.reportSize,
      conclusion: freeze.conclusion,
      submittedBy: freeze.submittedBy,
      submittedByUsername: actor.username ?? freeze.submittedByUsername ?? null,
      submittedByDisplayName: actor.displayName ?? freeze.submittedByDisplayName ?? null,
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
      productName: freeze.manifest.product, version: freeze.manifest.version,
      revision: freeze.manifest.revision ?? 0, displayVersion: freeze.manifest.displayVersion ?? freeze.manifest.version,
      roundNo: freeze.manifest.roundNo, reportTitle: freeze.reportTitle,
      environment: freeze.environment,
      manifestSha256: freeze.manifestSha256, reportSha256: freeze.reportSha256,
      reportFileName: freeze.reportFileName, reportSize: freeze.reportSize, conclusion: freeze.conclusion,
      manifest: freeze.manifest,
      submittedBy: freeze.submittedBy,
      submittedByUsername: freeze.submittedByUsername ?? null,
      submittedByDisplayName: freeze.submittedByDisplayName ?? null,
      submittedAt: freeze.submittedAt
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
    const timestamp = now();
    this.db.prepare("UPDATE round_freezes SET dispatch_status = 'DELIVERED', dispatch_at = ?, dispatch_last_error = NULL, core_approval_id = NULL, core_status = NULL, core_response_json = NULL, updated_at = ? WHERE freeze_id = ?").run(timestamp, timestamp, freezeId);
    return this.get(freezeId);
  }

  applyCoreDecision(input) {
    const requestId = String(input?.requestId ?? '').trim();
    const freezeId = String(input?.freezeId ?? '').trim();
    const eventId = String(input?.eventId ?? '').trim();
    const status = String(input?.status ?? '').toUpperCase();
    const decidedAt = typeof input?.decidedAt === 'string' && Number.isFinite(Date.parse(input.decidedAt)) ? input.decidedAt : now();
    if (!requestId || requestId !== freezeId || !eventId || eventId.length > 128 || !['APPROVED', 'REJECTED', 'WITHDRAWN'].includes(status)) {
      throw Object.assign(new Error('Core 审批结果格式无效'), { code: 'invalid_approval_result' });
    }
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('固化申请不存在'), { code: 'freeze_not_found' });
    const payloadSha256 = hash(JSON.stringify({ eventId, requestId, freezeId, status, decidedAt }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM edge_core_approval_events WHERE event_id = ?').get(eventId);
      if (prior) {
        if (prior.freeze_id !== freezeId || prior.status !== status || prior.payload_sha256 !== payloadSha256) throw Object.assign(new Error('Core 审批事件编号冲突'), { code: 'approval_event_conflict' });
        this.db.exec('COMMIT');
        return { item: this.get(freezeId), idempotent: true };
      }
      const current = this.get(freezeId);
      if (current.status === status) {
        this.db.prepare('INSERT INTO edge_core_approval_events (event_id, freeze_id, payload_sha256, status, received_at) VALUES (?, ?, ?, ?, ?)').run(eventId, freezeId, payloadSha256, status, now());
        if (status === 'APPROVED') this.db.prepare("UPDATE releases SET status = 'SEALED', updated_at = ? WHERE release_id = (SELECT rr.release_id FROM release_rounds rr WHERE rr.round_id = ?)").run(now(), current.roundId);
        this.db.exec('COMMIT');
        return { item: current, idempotent: true };
      }
      if (current.status !== 'PENDING_APPROVAL') throw Object.assign(new Error('申请已处理，不能覆盖现有结果'), { code: 'approval_result_conflict' });
      this.db.prepare('INSERT INTO edge_core_approval_events (event_id, freeze_id, payload_sha256, status, received_at) VALUES (?, ?, ?, ?, ?)').run(eventId, freezeId, payloadSha256, status, now());
      this.db.prepare('UPDATE round_freezes SET status = ?, decided_by = ?, decided_at = ?, decision_reference = NULL, decision_comment = NULL, updated_at = ? WHERE freeze_id = ? AND status = \'PENDING_APPROVAL\'')
        .run(status, 'CAM_CORE', decidedAt, now(), freezeId);
      if (status === 'APPROVED') this.db.prepare("UPDATE releases SET status = 'SEALED', updated_at = ? WHERE release_id = (SELECT rr.release_id FROM release_rounds rr WHERE rr.round_id = ?)").run(now(), current.roundId);
      this.db.exec('COMMIT');
      return { item: this.get(freezeId), idempotent: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  applyTransferReady(input) {
    const requestId = String(input?.requestId ?? '').trim();
    const freezeId = String(input?.freezeId ?? '').trim();
    const eventId = String(input?.eventId ?? '').trim();
    const taskId = String(input?.transferTaskId ?? '').trim();
    const manifestSha256 = String(input?.manifestSha256 ?? '').toLowerCase();
    if (!requestId || requestId !== freezeId || !eventId || eventId.length > 128 || !taskId || !/^[a-f0-9]{64}$/.test(manifestSha256)) throw Object.assign(new Error('Core 传输任务格式无效'), { code: 'invalid_transfer_request' });
    const freeze = this.get(freezeId);
    if (!freeze) throw Object.assign(new Error('固化申请不存在'), { code: 'freeze_not_found' });
    if (freeze.status !== 'APPROVED' || freeze.manifestSha256.toLowerCase() !== manifestSha256) throw Object.assign(new Error('传输任务未绑定当前已审批清单'), { code: 'transfer_request_conflict' });
    const payloadSha256 = hash(JSON.stringify({ eventId, requestId, freezeId, taskId, manifestSha256 }));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT * FROM edge_core_transfer_events WHERE event_id = ?').get(eventId);
      if (prior) {
        if (prior.freeze_id !== freezeId || prior.transfer_task_id !== taskId || prior.payload_sha256 !== payloadSha256) throw Object.assign(new Error('Core 传输事件编号冲突'), { code: 'transfer_event_conflict' });
        this.db.exec('COMMIT');
        return { item: this.get(freezeId), idempotent: true };
      }
      if (freeze.transferTaskId && freeze.transferTaskId !== taskId) throw Object.assign(new Error('固化申请已绑定其他传输任务'), { code: 'transfer_request_conflict' });
      this.db.prepare('INSERT INTO edge_core_transfer_events (event_id, freeze_id, payload_sha256, transfer_task_id, received_at) VALUES (?, ?, ?, ?, ?)').run(eventId, freezeId, payloadSha256, taskId, now());
      this.db.prepare("UPDATE round_freezes SET transfer_task_id = ?, transfer_status = 'READY', transfer_attempts = 0, transfer_last_error = NULL, transfer_error_code = NULL, transfer_retry_at = NULL, transfer_retry_exhausted = 0, transfer_at = NULL, updated_at = ? WHERE freeze_id = ? AND status = 'APPROVED'").run(taskId, now(), freezeId);
      this.db.exec('COMMIT');
      return { item: this.get(freezeId), idempotent: false };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  listTransferPending() {
    // FAILED transfers wait for a signed recovery command from Core.  Edge
    // must never independently restart them, otherwise the two ends can
    // disagree about retry limits and recovery state.
    return this.db.prepare("SELECT * FROM round_freezes WHERE status = 'APPROVED' AND transfer_task_id IS NOT NULL AND transfer_status IN ('READY','RECEIVED') ORDER BY decided_at ASC").all().map((row) => this.parse(row));
  }
  listTransferFailures() {
    return this.db.prepare("SELECT * FROM round_freezes WHERE status = 'APPROVED' AND transfer_task_id IS NOT NULL AND transfer_status = 'FAILED' AND transfer_attempts > 0 ORDER BY updated_at DESC").all().map((row) => this.parse(row));
  }
  listTransferStates() {
    return this.db.prepare("SELECT * FROM round_freezes WHERE status = 'APPROVED' AND transfer_task_id IS NOT NULL AND transfer_status IN ('READY', 'SENDING', 'FAILED', 'RECEIVED') ORDER BY updated_at DESC").all().map((row) => this.parse(row));
  }
  markTransferAttempt(freezeId) {
    this.db.prepare("UPDATE round_freezes SET transfer_status = 'SENDING', transfer_attempts = transfer_attempts + 1, updated_at = ? WHERE freeze_id = ? AND status = 'APPROVED' AND transfer_status = 'READY'").run(now(), freezeId);
    return this.get(freezeId);
  }
  markTransferSuccess(freezeId) {
    const timestamp = now();
    this.db.prepare("UPDATE round_freezes SET transfer_status = 'RECEIVED', transfer_at = ?, transfer_last_error = NULL, transfer_error_code = NULL, transfer_retry_at = NULL, transfer_retry_exhausted = 0, updated_at = ? WHERE freeze_id = ?").run(timestamp, timestamp, freezeId);
    return this.get(freezeId);
  }
  resetTransfer(freezeId) {
    // Preserve Edge's accumulated attempt number. Core uses it to reject
    // stale control reports after a coordinated recovery.
    this.db.prepare("UPDATE round_freezes SET transfer_status = 'READY', transfer_last_error = NULL, transfer_error_code = NULL, transfer_retry_at = NULL, transfer_retry_exhausted = 0, updated_at = ? WHERE freeze_id = ? AND status = 'APPROVED' AND transfer_status IN ('FAILED','SENDING')").run(now(), freezeId);
    return this.get(freezeId);
  }
  markTransferFailure(freezeId, error, { retryAt = null, exhausted = false } = {}) {
    const timestamp = now();
    this.db.prepare("UPDATE round_freezes SET transfer_status = 'FAILED', transfer_last_error = ?, transfer_error_code = ?, transfer_retry_at = ?, transfer_retry_exhausted = ?, updated_at = ? WHERE freeze_id = ? AND status = 'APPROVED'")
      .run(String(error?.message ?? error).slice(0, 1000), error?.code ? String(error.code).slice(0, 128) : null, retryAt, exhausted ? 1 : 0, timestamp, freezeId);
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
    if (decision === 'APPROVE') this.db.prepare("UPDATE releases SET status = 'SEALED', updated_at = ? WHERE release_id = (SELECT rr.release_id FROM release_rounds rr WHERE rr.round_id = ?)").run(timestamp, freeze.roundId);
    return this.get(freezeId);
  }

  reportPath(freezeId) {
    const row = this.db.prepare("SELECT report_path FROM round_freezes WHERE freeze_id = ? AND report_path IS NOT NULL").get(freezeId);
    return row?.report_path ?? null;
  }
}
