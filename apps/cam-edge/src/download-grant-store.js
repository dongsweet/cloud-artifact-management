import { createHash, randomBytes, randomUUID } from 'node:crypto';

function timestamp() { return new Date().toISOString(); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function boundedInteger(value, name, { min = 1, max = 10000 } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export class DownloadGrantStore {
  constructor({ db, candidateStore }) {
    this.db = db;
    this.candidateStore = candidateStore;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS download_grants (
        grant_id TEXT PRIMARY KEY,
        token_sha256 TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,
        principal_type TEXT NOT NULL,
        created_by TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        max_total_sessions INTEGER NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS download_grant_items (
        grant_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        max_sessions INTEGER NOT NULL,
        PRIMARY KEY (grant_id, candidate_id),
        FOREIGN KEY (grant_id) REFERENCES download_grants(grant_id) ON DELETE CASCADE,
        FOREIGN KEY (candidate_id) REFERENCES candidates(candidate_id)
      );
      CREATE TABLE IF NOT EXISTS download_sessions (
        session_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        downloaded_by TEXT NOT NULL,
        source_address TEXT,
        user_agent TEXT,
        status TEXT NOT NULL,
        bytes_sent INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT,
        FOREIGN KEY (grant_id, candidate_id) REFERENCES download_grant_items(grant_id, candidate_id)
      );
      CREATE INDEX IF NOT EXISTS download_sessions_grant_idx ON download_sessions(grant_id, status);
      CREATE TABLE IF NOT EXISTS download_events (
        event_id TEXT PRIMARY KEY,
        grant_id TEXT NOT NULL,
        candidate_id TEXT,
        session_id TEXT,
        principal_id TEXT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (grant_id) REFERENCES download_grants(grant_id)
      );
      CREATE INDEX IF NOT EXISTS download_events_grant_idx ON download_events(grant_id, created_at);
    `);
    if (!db.prepare('PRAGMA table_info(download_sessions)').all().some((column) => column.name === 'covered_bytes')) {
      db.exec('ALTER TABLE download_sessions ADD COLUMN covered_bytes INTEGER NOT NULL DEFAULT 0; UPDATE download_sessions SET covered_bytes = bytes_sent');
    }
    // An ACTIVE row left by a process restart has no live response to resume.
    db.prepare("UPDATE download_sessions SET status = 'INTERRUPTED' WHERE status = 'ACTIVE'").run();
    this.activeTransfers = new Set();
  }

  recordEvent({ grantId, candidateId = null, sessionId = null, principalId = null, type, details = {} }) {
    this.db.prepare(`INSERT INTO download_events
      (event_id, grant_id, candidate_id, session_id, principal_id, event_type, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), grantId, candidateId, sessionId, principalId, type, JSON.stringify(details), timestamp());
  }

  createGrant({ candidateIds, principalId, principalType, createdBy = principalId, expiresAt, maxTotalSessions, maxSessionsPerFile }) {
    if (typeof principalId !== 'string' || !principalId.trim()) throw new Error('principalId is required');
    if (typeof principalType !== 'string' || !principalType.trim()) throw new Error('principalType is required');
    if (typeof createdBy !== 'string' || !createdBy.trim()) throw new Error('createdBy is required');
    if (!Array.isArray(candidateIds) || candidateIds.length === 0 || candidateIds.length > 500 || new Set(candidateIds).size !== candidateIds.length) throw new Error('candidateIds must contain 1-500 unique IDs');
    const totalLimit = boundedInteger(maxTotalSessions, 'maxTotalSessions');
    const fileLimit = boundedInteger(maxSessionsPerFile, 'maxSessionsPerFile');
    const expiry = new Date(expiresAt);
    const now = Date.now();
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now || expiry.getTime() > now + 30 * 24 * 60 * 60 * 1000) throw new Error('expiresAt must be within the next 30 days');
    const candidates = candidateIds.map((candidateId) => {
      const candidate = this.candidateStore.get(candidateId);
      if (!candidate) throw new Error(`candidate not found: ${candidateId}`);
      if (candidate.status !== 'COMPLETED' || !candidate.final_sha256 || !candidate.source_path) throw new Error(`candidate is not a verified completed file: ${candidateId}`);
      return candidate;
    });
    const grantId = `DGR-${Date.now()}-${randomUUID()}`;
    const token = randomBytes(32).toString('base64url');
    const createdAt = timestamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO download_grants
        (grant_id, token_sha256, principal_id, principal_type, created_by, expires_at, max_total_sessions, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(grantId, tokenHash(token), principalId, principalType, createdBy, expiry.toISOString(), totalLimit, createdAt);
      const insertItem = this.db.prepare('INSERT INTO download_grant_items (grant_id, candidate_id, max_sessions) VALUES (?, ?, ?)');
      for (const candidate of candidates) insertItem.run(grantId, candidate.candidate_id ?? candidate.candidateId, fileLimit);
      this.recordEvent({ grantId, principalId: createdBy, type: 'GRANT_CREATED', details: { itemCount: candidates.length, expiresAt: expiry.toISOString(), maxTotalSessions: totalLimit, maxSessionsPerFile: fileLimit } });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { grantId, token, expiresAt: expiry.toISOString(), maxTotalSessions: totalLimit, maxSessionsPerFile: fileLimit, items: candidates.map((candidate) => ({ candidateId: candidate.candidate_id ?? candidate.candidateId, fileName: candidate.file_name ?? candidate.fileName, size: candidate.expected_size ?? candidate.size, sha256: candidate.final_sha256 ?? candidate.finalSha256, md5: candidate.final_md5 ?? candidate.finalMd5 ?? null })) };
  }

  getGrantByToken(token) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 256) return null;
    const row = this.db.prepare('SELECT * FROM download_grants WHERE token_sha256 = ?').get(tokenHash(token));
    if (!row) return null;
    return this._parseGrant(row);
  }

  getGrant(grantId) {
    const row = this.db.prepare('SELECT * FROM download_grants WHERE grant_id = ?').get(grantId);
    return row ? this._parseGrant(row) : null;
  }

  _parseGrant(row) {
    const usedTotal = this.db.prepare("SELECT COUNT(*) AS count FROM download_sessions WHERE grant_id = ? AND (bytes_sent > 0 OR status = 'COMPLETED')").get(row.grant_id).count;
    const items = this.db.prepare(`SELECT i.candidate_id, i.max_sessions, c.file_name, c.expected_size, c.final_md5, c.final_sha256,
      (SELECT COUNT(*) FROM download_sessions s WHERE s.grant_id = i.grant_id AND s.candidate_id = i.candidate_id AND (s.bytes_sent > 0 OR s.status = 'COMPLETED')) AS used_sessions
      FROM download_grant_items i JOIN candidates c ON c.candidate_id = i.candidate_id WHERE i.grant_id = ?`).all(row.grant_id);
    return { grantId: row.grant_id, principalId: row.principal_id, principalType: row.principal_type, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at, maxTotalSessions: row.max_total_sessions, usedTotalSessions: usedTotal, remainingTotalSessions: Math.max(0, row.max_total_sessions - usedTotal), revokedAt: row.revoked_at, items: items.map((item) => ({ candidateId: item.candidate_id, fileName: item.file_name, size: item.expected_size, sha256: item.final_sha256, md5: item.final_md5, maxSessions: item.max_sessions, usedSessions: item.used_sessions, remainingSessions: Math.max(0, item.max_sessions - item.used_sessions) })) };
  }

  revokeGrant(grantId, principalId) {
    const grant = this.getGrant(grantId);
    if (!grant) return null;
    if (grant.revokedAt) return grant;
    const revokedAt = timestamp();
    this.db.prepare('UPDATE download_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL').run(revokedAt, grantId);
    this.recordEvent({ grantId, principalId, type: 'GRANT_REVOKED' });
    return this.getGrant(grantId);
  }

  beginSession({ token, candidateId, sessionId = null, downloadedBy, sourceAddress = null, userAgent = null, autoResume = false, start = null }) {
    if (typeof downloadedBy !== 'string' || !downloadedBy.trim()) throw new Error('downloadedBy is required');
    const grant = this.getGrantByToken(token);
    if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now()) throw new Error('download grant is invalid, expired or revoked');
    const item = grant.items.find((entry) => entry.candidateId === candidateId);
    if (!item) throw new Error('candidate is outside the download grant');
    let session = sessionId ? this.db.prepare('SELECT * FROM download_sessions WHERE session_id = ?').get(sessionId) : null;
    if (sessionId && !session) throw new Error('download session not found');
    if (!sessionId && autoResume) session = this.db.prepare("SELECT * FROM download_sessions WHERE grant_id = ? AND candidate_id = ? AND source_address IS ? AND status != 'COMPLETED' ORDER BY rowid DESC LIMIT 1").get(grant.grantId, candidateId, sourceAddress);
    if (start !== null && start > (session?.covered_bytes ?? 0)) throw Object.assign(new Error('仅支持单连接顺序下载，请关闭多线程并从已下载位置续传'), { statusCode: 409, code: 'download_noncontiguous' });
    if (session) {
      if (session.grant_id !== grant.grantId || session.candidate_id !== candidateId) throw new Error('download session does not match grant and candidate');
      if (session.status === 'COMPLETED') throw new Error('download session is already completed');
      sessionId = session.session_id;
      this.reserveSlot(grant.grantId, candidateId, sessionId);
      this.db.prepare(`UPDATE download_sessions SET status = 'ACTIVE', downloaded_by = ?, updated_at = ?, source_address = ?, user_agent = ? WHERE session_id = ?`).run(downloadedBy, timestamp(), sourceAddress, userAgent, sessionId);
      this.recordEvent({ grantId: grant.grantId, candidateId, sessionId, principalId: downloadedBy, type: 'DOWNLOAD_RESUMED' });
      return { sessionId, resumed: true };
    }
    const newSessionId = `DLS-${randomUUID()}`;
    const startedAt = timestamp();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getGrant(grant.grantId);
      if (current.revokedAt || Date.parse(current.expiresAt) <= Date.now()) throw new Error('download grant is invalid, expired or revoked');
      this.reserveSlot(grant.grantId, candidateId);
      this.db.prepare(`INSERT INTO download_sessions
        (session_id, grant_id, candidate_id, downloaded_by, source_address, user_agent, status, started_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(newSessionId, grant.grantId, candidateId, downloadedBy, sourceAddress, userAgent, startedAt, startedAt);
      this.recordEvent({ grantId: grant.grantId, candidateId, sessionId: newSessionId, principalId: downloadedBy, type: 'DOWNLOAD_STARTED' });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { sessionId: newSessionId, resumed: false };
  }

  reserveSlot(grantId, candidateId, sessionId = null) {
    // Zero-byte active sessions reserve capacity until the response closes, but are not charged.
    const rows = this.db.prepare("SELECT session_id, candidate_id FROM download_sessions WHERE grant_id = ? AND (bytes_sent > 0 OR status IN ('ACTIVE', 'COMPLETED')) AND session_id != ?").all(grantId, sessionId ?? '');
    const grant = this.getGrant(grantId);
    if (rows.length >= grant.maxTotalSessions || rows.filter((row) => row.candidate_id === candidateId).length >= grant.items.find((item) => item.candidateId === candidateId).maxSessions) throw new Error('download session limit reached');
  }

  acquireTransfer(grantId, candidateId) {
    const key = `${grantId}/${candidateId}`;
    if (this.activeTransfers.has(key)) throw Object.assign(new Error('该文件正在下载，仅支持一个连接；请关闭多线程后续传'), { statusCode: 409, code: 'download_in_progress' });
    this.activeTransfers.add(key);
    return () => this.activeTransfers.delete(key);
  }

  recordSessionProgress(sessionId, { bytesSent, coveredBytes, status, errorMessage = null, principalId = null, responseBytes = null }) {
    if (!Number.isSafeInteger(bytesSent) || bytesSent < 0) throw new Error('bytesSent must be a non-negative safe integer');
    if (!['ACTIVE', 'INTERRUPTED', 'COMPLETED', 'FAILED'].includes(status)) throw new Error('invalid download session status');
    const session = this.db.prepare('SELECT * FROM download_sessions WHERE session_id = ?').get(sessionId);
    if (!session) return null;
    const ended = ['COMPLETED', 'FAILED'].includes(status) ? timestamp() : null;
    this.db.prepare('UPDATE download_sessions SET bytes_sent = ?, covered_bytes = ?, status = ?, updated_at = ?, completed_at = ?, error_message = ? WHERE session_id = ?').run(bytesSent, coveredBytes ?? bytesSent, status, timestamp(), ended, errorMessage, sessionId);
    if (status !== 'ACTIVE') this.recordEvent({ grantId: session.grant_id, candidateId: session.candidate_id, sessionId, principalId, type: `DOWNLOAD_${status}`, details: { bytesSent, coveredBytes: coveredBytes ?? bytesSent, responseBytes, errorMessage } });
    return this.db.prepare('SELECT * FROM download_sessions WHERE session_id = ?').get(sessionId);
  }
}
