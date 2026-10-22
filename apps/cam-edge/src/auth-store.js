import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CORE_ROLE_LABELS, EDGE_ROLE_LABELS, normalizeEdgeRoles } from '../../../libs/cam-auth/src/roles.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

// Edge 只保存 Core 下发的授权缓存和 Edge 会话，不保存密码、本地账号或本地角色。
export const ROLE_LABELS = EDGE_ROLE_LABELS;

export class AuthStore {
  constructor(db, { clock = Date.now, idleMs = 30 * 60_000, absoluteMs = 8 * 60 * 60_000 } = {}) {
    this.db = db;
    this.clock = clock;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    // 清理旧版本的本地账号表。旧表只包含已废弃的 Edge 本地账号，不再被任何代码读取。
    db.exec('DROP TABLE IF EXISTS edge_sessions; DROP TABLE IF EXISTS edge_users;');
    db.exec([
      'CREATE TABLE IF NOT EXISTS edge_auth_events (event_id TEXT PRIMARY KEY, principal_id TEXT, event_type TEXT NOT NULL, source_address TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS edge_core_sessions (session_id TEXT PRIMARY KEY, core_user_id TEXT NOT NULL, username TEXT NOT NULL, display_name TEXT NOT NULL, roles_json TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0, token_sha256 TEXT NOT NULL UNIQUE, csrf_token_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER)',
      'CREATE TABLE IF NOT EXISTS edge_core_users (user_id TEXT PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL, roles_json TEXT NOT NULL, status TEXT NOT NULL, edge_enabled INTEGER NOT NULL DEFAULT 1, must_change_password INTEGER NOT NULL, last_login_at TEXT, locked_until INTEGER, created_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS edge_core_sessions_user_idx ON edge_core_sessions(core_user_id)'
    ].join(';'));
    const columns = new Set(db.prepare('PRAGMA table_info(edge_core_sessions)').all().map((item) => item.name));
    if (!columns.has('must_change_password')) db.exec('ALTER TABLE edge_core_sessions ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
  }

  event(type, actor = null, details = {}, address = null) {
    this.db.prepare('INSERT INTO edge_auth_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), actor, type, address, JSON.stringify(details), now());
  }

  getUser(id) {
    const row = this.db.prepare('SELECT * FROM edge_core_users WHERE user_id = ?').get(id);
    if (!row) return null;
    return { id: row.user_id, username: row.username, displayName: row.display_name, roles: normalizeEdgeRoles(JSON.parse(row.roles_json ?? '[]')), status: row.status, edgeEnabled: Boolean(row.edge_enabled), mustChangePassword: Boolean(row.must_change_password), lastLoginAt: row.last_login_at, lockedUntil: row.locked_until, createdAt: row.created_at, source: 'CORE' };
  }

  listUsers() { return this.db.prepare('SELECT user_id FROM edge_core_users ORDER BY username').all().map(({ user_id }) => this.getUser(user_id)); }

  resolve(token) {
    if (typeof token !== 'string' || token.length !== 43) return null;
    const session = this.db.prepare('SELECT * FROM edge_core_sessions WHERE token_sha256 = ?').get(hash(token));
    if (!session || session.revoked_at || session.expires_at <= this.clock() || session.last_seen_at + this.idleMs <= this.clock()) return null;
    const user = this.getUser(session.core_user_id);
    if (!user || !user.edgeEnabled || user.lockedUntil > this.clock()) return null;
    this.db.prepare('UPDATE edge_core_sessions SET last_seen_at = ? WHERE session_id = ?').run(this.clock(), session.session_id);
    return this.principalFromSession(session, user);
  }

  principalFromSession(session, user) {
    return { id: user.id, type: 'CORE_USER', domain: 'CORE', roles: user.roles, user, sessionId: session.session_id, csrfHash: session.csrf_token_sha256 };
  }

  createCoreSession(principal, { idleMs = 15 * 60_000, absoluteMs = 15 * 60_000 } = {}) {
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const time = this.clock();
    this.db.prepare('INSERT INTO edge_core_sessions (session_id, core_user_id, username, display_name, roles_json, must_change_password, token_sha256, csrf_token_sha256, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, principal.id, principal.username, principal.displayName, JSON.stringify(normalizeEdgeRoles(principal.roles ?? [])), principal.mustChangePassword ? 1 : 0, hash(token), hash(csrfToken), time, time + Math.min(idleMs, absoluteMs), time);
    this.cacheCoreUsers([principal]);
    this.event('CORE_LOGIN_SUCCEEDED', principal.id, { sessionId });
    return { token, csrfToken, user: { id: principal.id, username: principal.username, displayName: principal.displayName, roles: normalizeEdgeRoles(principal.roles ?? []), status: 'ACTIVE', mustChangePassword: Boolean(principal.mustChangePassword) } };
  }

  cacheCoreUsers(users) {
    const upsert = this.db.prepare('INSERT INTO edge_core_users (user_id, username, display_name, roles_json, status, edge_enabled, must_change_password, last_login_at, locked_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, display_name=excluded.display_name, roles_json=excluded.roles_json, status=excluded.status, edge_enabled=excluded.edge_enabled, must_change_password=excluded.must_change_password, last_login_at=excluded.last_login_at, locked_until=excluded.locked_until');
    for (const user of users ?? []) upsert.run(user.id, user.username, user.displayName, JSON.stringify(normalizeEdgeRoles(user.roles ?? [])), user.status ?? 'ACTIVE', user.edgeEnabled ? 1 : 0, user.mustChangePassword ? 1 : 0, user.lastLoginAt ?? null, user.lockedUntil ?? null, user.createdAt ?? new Date().toISOString());
  }

  /** 用 Core 当前下发的授权刷新会话，角色/禁用变更立即生效。 */
  refreshCoreSession(principal, current) {
    if (!principal || principal.type !== 'CORE_USER' || !current || current.id !== principal.id || !current.edgeEnabled || current.lockedUntil > this.clock()) {
      if (principal?.sessionId) this.db.prepare('UPDATE edge_core_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL').run(this.clock(), principal.sessionId);
      return null;
    }
    this.cacheCoreUsers([current]);
    this.db.prepare('UPDATE edge_core_sessions SET username = ?, display_name = ?, roles_json = ?, must_change_password = ?, last_seen_at = ? WHERE session_id = ? AND revoked_at IS NULL')
      .run(current.username, current.displayName, JSON.stringify(normalizeEdgeRoles(current.roles ?? [])), current.mustChangePassword ? 1 : 0, this.clock(), principal.sessionId);
    const session = this.db.prepare('SELECT * FROM edge_core_sessions WHERE session_id = ?').get(principal.sessionId);
    return session ? this.principalFromSession(session, current) : null;
  }

  csrf(principal, value) { return principal?.type === 'CORE_USER' && typeof value === 'string' && value.length === 43 && hash(value) === principal.csrfHash; }

  logout(principal) {
    if (principal?.type !== 'CORE_USER') return;
    this.db.prepare('UPDATE edge_core_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL').run(this.clock(), principal.sessionId);
    this.event('LOGOUT', principal.id);
  }
}

export { CORE_ROLE_LABELS };
