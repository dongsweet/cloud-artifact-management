import { createHash, randomBytes, randomUUID } from 'node:crypto';

function now() { return new Date().toISOString(); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function integer(value, name, min = 1, max = 10000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  return value;
}

const AUDIT_EVENTS = new Set(['GRANT_CREATED', 'GRANT_REVOKED', 'DOWNLOAD_STARTED', 'DOWNLOAD_RESUMED', 'DOWNLOAD_INTERRUPTED', 'DOWNLOAD_COMPLETED', 'DOWNLOAD_FAILED']);

/**
 * Human-facing delivery grants for files already cached by one Agent.
 *
 * The Edge download grant store intentionally remains Edge-specific because
 * its items are candidate records. This store uses immutable SHA-256 cache
 * objects and shares the same grant/session/audit contract at the API layer.
 */
export class AgentDeliveryStore {
  constructor({ db, dataDir, logger = null }) {
    this.db = db;
    this.dataDir = dataDir;
    this.logger = logger ?? { info() {} };
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_delivery_grants (
        grant_id TEXT PRIMARY KEY,
        token_sha256 TEXT NOT NULL UNIQUE,
        artifact_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_total_sessions INTEGER NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_delivery_items (
        grant_id TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        package_key TEXT NOT NULL,
        file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        max_sessions INTEGER NOT NULL,
        PRIMARY KEY (grant_id, file_sha256),
        FOREIGN KEY (grant_id) REFERENCES agent_delivery_grants(grant_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS agent_delivery_sessions (
        session_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        file_sha256 TEXT NOT NULL,
        downloaded_by TEXT NOT NULL,
        source_address TEXT,
        user_agent TEXT,
        status TEXT NOT NULL,
        bytes_sent INTEGER NOT NULL DEFAULT 0,
        covered_bytes INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (grant_id, file_sha256) REFERENCES agent_delivery_items(grant_id, file_sha256)
      );
      CREATE INDEX IF NOT EXISTS agent_delivery_sessions_grant_idx ON agent_delivery_sessions(grant_id, status);
      CREATE TABLE IF NOT EXISTS agent_delivery_events (
        event_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        file_sha256 TEXT,
        session_id TEXT,
        principal_id TEXT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (grant_id) REFERENCES agent_delivery_grants(grant_id)
      );
      CREATE INDEX IF NOT EXISTS agent_delivery_events_grant_idx ON agent_delivery_events(grant_id, created_at);
    `);
    this.db.prepare("UPDATE agent_delivery_sessions SET status = 'INTERRUPTED' WHERE status = 'ACTIVE'").run();
    this.activeTransfers = new Set();
  }

  setLogger(logger) { this.logger = logger ?? { info() {} }; }

  recordEvent({ grantId, fileSha256 = null, sessionId = null, principalId = null, type, details = {} }) {
    const eventId = randomUUID(); const createdAt = now();
    if (AUDIT_EVENTS.has(type)) this.db.prepare(`INSERT INTO agent_delivery_events
      (event_id, grant_id, file_sha256, session_id, principal_id, event_type, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(eventId, grantId, fileSha256, sessionId, principalId, type, JSON.stringify(details), createdAt);
    this.logger.info({ deliveryEvent: { eventId, grantId, fileSha256, sessionId, principalId, eventType: type, details, createdAt } }, 'agent delivery event');
  }

  createGrant({ artifactId, artifact, fileSha256s, principalId, createdBy = principalId, expiresAt, maxTotalSessions, maxSessionsPerFile = 2 }) {
    if (typeof artifactId !== 'string' || !artifactId.trim()) throw new Error('artifactId 必填');
    if (!artifact || artifact.artifactId !== artifactId) throw new Error('正式版本不存在');
    if (typeof principalId !== 'string' || !principalId.trim()) throw new Error('principalId 必填');
    const totalLimit = integer(maxTotalSessions, '累计会话次数');
    const fileLimit = integer(maxSessionsPerFile, '每文件会话次数');
    const expiry = new Date(expiresAt); const current = Date.now();
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= current || expiry.getTime() > current + 30 * 24 * 60 * 60 * 1000) throw new Error('有效期必须在未来 30 天以内');
    const requested = Array.isArray(fileSha256s) && fileSha256s.length ? new Set(fileSha256s) : new Set((artifact.files ?? []).map((file) => file.sha256));
    if (!requested.size || requested.size > 500) throw new Error('至少选择一个文件，最多 500 个文件');
    const files = (artifact.files ?? []).filter((file) => requested.has(file.sha256));
    if (files.length !== requested.size) throw new Error('选择的文件不属于该正式版本');
    if (files.some((file) => !file.cached || !/^[a-f0-9]{64}$/u.test(file.sha256))) throw new Error('只能交付 Agent 已缓存并校验完成的文件');
    const grantId = `ADG-${Date.now()}-${randomUUID()}`; const token = randomBytes(32).toString('base64url'); const createdAt = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO agent_delivery_grants
        (grant_id, token_sha256, artifact_id, principal_id, created_by, expires_at, max_total_sessions, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(grantId, tokenHash(token), artifactId, principalId, createdBy, expiry.toISOString(), totalLimit, createdAt);
      const insert = this.db.prepare(`INSERT INTO agent_delivery_items
        (grant_id, file_sha256, package_key, file_name, size_bytes, max_sessions) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const file of files) insert.run(grantId, file.sha256, file.packageKey ?? '-', file.fileName ?? file.sha256, file.sizeBytes, fileLimit);
      this.recordEvent({ grantId, principalId: createdBy, type: 'GRANT_CREATED', details: { artifactId, itemCount: files.length, expiresAt: expiry.toISOString(), maxTotalSessions: totalLimit, maxSessionsPerFile: fileLimit } });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { ...this.getGrant(grantId), token, artifactId };
  }

  getGrantByToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const row = this.db.prepare('SELECT * FROM agent_delivery_grants WHERE token_sha256 = ?').get(tokenHash(token));
    return row ? this._parseGrant(row) : null;
  }

  getGrant(grantId) {
    const row = this.db.prepare('SELECT * FROM agent_delivery_grants WHERE grant_id = ?').get(grantId);
    return row ? this._parseGrant(row) : null;
  }

  listGrants(principalId = null) {
    const rows = principalId
      ? this.db.prepare('SELECT grant_id FROM agent_delivery_grants WHERE created_by = ? OR principal_id = ? ORDER BY created_at DESC LIMIT 200').all(principalId, principalId)
      : this.db.prepare('SELECT grant_id FROM agent_delivery_grants ORDER BY created_at DESC LIMIT 200').all();
    return rows.map((row) => this.getGrant(row.grant_id));
  }

  _parseGrant(row) {
    const usedTotal = this.db.prepare("SELECT COUNT(*) AS count FROM agent_delivery_sessions WHERE grant_id = ? AND (bytes_sent > 0 OR status = 'COMPLETED')").get(row.grant_id).count;
    const sessionSummary = this.db.prepare("SELECT SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed, SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed FROM agent_delivery_sessions WHERE grant_id = ?").get(row.grant_id);
    const items = this.db.prepare(`SELECT i.*, (SELECT COUNT(*) FROM agent_delivery_sessions s
      WHERE s.grant_id = i.grant_id AND s.file_sha256 = i.file_sha256 AND (s.bytes_sent > 0 OR s.status = 'COMPLETED')) AS used_sessions
      FROM agent_delivery_items i WHERE i.grant_id = ? ORDER BY rowid`).all(row.grant_id);
    return {
      grantId: row.grant_id, artifactId: row.artifact_id, principalId: row.principal_id, createdBy: row.created_by,
      createdAt: row.created_at, expiresAt: row.expires_at, maxTotalSessions: row.max_total_sessions,
      usedTotalSessions: usedTotal, remainingTotalSessions: Math.max(0, row.max_total_sessions - usedTotal), revokedAt: row.revoked_at,
      activeSessions: Number(sessionSummary.active ?? 0), failedSessions: Number(sessionSummary.failed ?? 0), completedSessions: Number(sessionSummary.completed ?? 0),
      items: items.map((item) => ({ fileSha256: item.file_sha256, packageKey: item.package_key, fileName: item.file_name, size: item.size_bytes,
        maxSessions: item.max_sessions, usedSessions: item.used_sessions, remainingSessions: Math.max(0, item.max_sessions - item.used_sessions) }))
    };
  }

  getSessions(grantId) {
    return this.db.prepare(`SELECT session_id, file_sha256, downloaded_by, status, bytes_sent, covered_bytes,
      source_address, user_agent, started_at, updated_at, completed_at, error_message
      FROM agent_delivery_sessions WHERE grant_id = ? ORDER BY rowid DESC LIMIT 500`).all(grantId);
  }

  revokeGrant(grantId, principalId) {
    const grant = this.getGrant(grantId); if (!grant) return null; if (grant.revokedAt) return grant;
    const revokedAt = now(); this.db.prepare('UPDATE agent_delivery_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(revokedAt, grantId);
    this.recordEvent({ grantId, principalId, type: 'GRANT_REVOKED' }); return this.getGrant(grantId);
  }

  beginSession({ token, fileSha256, sessionId = null, downloadedBy, sourceAddress = null, userAgent = null, autoResume = false, start = null }) {
    if (typeof downloadedBy !== 'string' || !downloadedBy.trim()) throw new Error('downloadedBy 必填');
    const grant = this.getGrantByToken(token); if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('交付授权无效、已过期或已撤销');
    const item = grant.items.find((entry) => entry.fileSha256 === fileSha256); if (!item) throw new Error('文件不在交付授权范围内');
    let session = sessionId ? this.db.prepare('SELECT * FROM agent_delivery_sessions WHERE session_id = ?').get(sessionId) : null;
    if (sessionId && !session) throw new Error('交付会话不存在');
    if (!sessionId && autoResume) session = this.db.prepare("SELECT * FROM agent_delivery_sessions WHERE grant_id = ? AND file_sha256 = ? AND source_address IS ? AND status != 'COMPLETED' ORDER BY rowid DESC LIMIT 1").get(grant.grantId, fileSha256, sourceAddress);
    if (start !== null && start > (session?.covered_bytes ?? 0)) throw Object.assign(new Error('只支持从已下载位置顺序续传'), { statusCode: 409, code: 'delivery_noncontiguous' });
    if (session) {
      if (session.grant_id !== grant.grantId || session.file_sha256 !== fileSha256) throw new Error('交付会话与授权文件不匹配');
      if (session.status === 'COMPLETED') throw new Error('交付会话已完成');
      sessionId = session.session_id; this.reserveSlot(grant.grantId, fileSha256, sessionId);
      this.db.prepare(`UPDATE agent_delivery_sessions SET status = 'ACTIVE', downloaded_by = ?, updated_at = ?, source_address = ?, user_agent = ? WHERE session_id = ?`).run(downloadedBy, now(), sourceAddress, userAgent, sessionId);
      this.recordEvent({ grantId: grant.grantId, fileSha256, sessionId, principalId: downloadedBy, type: 'DOWNLOAD_RESUMED', details: { resumed: true } });
      return { sessionId, resumed: true };
    }
    const newSessionId = `ADS-${randomUUID()}`; const startedAt = now(); this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGrant(grant.grantId); if (current.revokedAt || Date.parse(current.expiresAt) <= Date.now()) throw new Error('交付授权无效、已过期或已撤销');
      this.reserveSlot(grant.grantId, fileSha256);
      this.db.prepare(`INSERT INTO agent_delivery_sessions
        (session_id, grant_id, file_sha256, downloaded_by, source_address, user_agent, status, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(newSessionId, grant.grantId, fileSha256, downloadedBy, sourceAddress, userAgent, startedAt, startedAt);
      this.recordEvent({ grantId: grant.grantId, fileSha256, sessionId: newSessionId, principalId: downloadedBy, type: 'DOWNLOAD_STARTED', details: { resumed: false } });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { sessionId: newSessionId, resumed: false };
  }

  reserveSlot(grantId, fileSha256, sessionId = null) {
    const rows = this.db.prepare("SELECT session_id, file_sha256 FROM agent_delivery_sessions WHERE grant_id = ? AND (bytes_sent > 0 OR status IN ('ACTIVE', 'COMPLETED')) AND session_id != ?").all(grantId, sessionId ?? '');
    const grant = this.getGrant(grantId); const item = grant?.items.find((entry) => entry.fileSha256 === fileSha256);
    if (!grant || !item || rows.length >= grant.maxTotalSessions || rows.filter((row) => row.file_sha256 === fileSha256).length >= item.maxSessions) throw new Error('交付会话次数已达到授权上限');
  }

  acquireTransfer(grantId, fileSha256) {
    const key = `${grantId}/${fileSha256}`; if (this.activeTransfers.has(key)) throw Object.assign(new Error('该文件正在下载，请稍后续传'), { statusCode: 409, code: 'delivery_in_progress' });
    this.activeTransfers.add(key); return () => this.activeTransfers.delete(key);
  }

  getSession(sessionId) { return this.db.prepare('SELECT * FROM agent_delivery_sessions WHERE session_id = ?').get(sessionId); }

  recordSessionProgress(sessionId, { bytesSent, coveredBytes = bytesSent, status, errorMessage = null, principalId = null, responseBytes = null }) {
    if (!Number.isSafeInteger(bytesSent) || bytesSent < 0 || !Number.isSafeInteger(coveredBytes) || coveredBytes < 0) throw new Error('传输进度无效');
    if (!['ACTIVE', 'INTERRUPTED', 'COMPLETED', 'FAILED'].includes(status)) throw new Error('传输状态无效');
    const session = this.getSession(sessionId); if (!session) return null;
    const ended = ['COMPLETED', 'FAILED'].includes(status) ? now() : null;
    this.db.prepare('UPDATE agent_delivery_sessions SET bytes_sent = ?, covered_bytes = ?, status = ?, updated_at = ?, completed_at = ?, error_message = ? WHERE session_id = ?').run(bytesSent, coveredBytes, status, now(), ended, errorMessage, sessionId);
    if (status !== 'ACTIVE') {
      const eventType = status === 'COMPLETED' ? 'DOWNLOAD_COMPLETED' : status === 'INTERRUPTED' ? 'DOWNLOAD_INTERRUPTED' : 'DOWNLOAD_FAILED';
      this.recordEvent({ grantId: session.grant_id, fileSha256: session.file_sha256, sessionId, principalId, type: eventType, details: { bytesSent, coveredBytes, responseBytes, errorMessage } });
    }
    return this.getSession(sessionId);
  }
}
