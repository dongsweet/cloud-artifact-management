import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveAsync = promisify(derive);
let derivations = 0;
async function scrypt(...args) {
  if (derivations >= 4) throw failure('认证服务繁忙，请稍后重试', 429, 'auth_busy');
  derivations++;
  try { return await deriveAsync(...args); } finally { derivations--; }
}
const params = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
export const ROLES = ['EDGE_ADMIN', 'CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'];
export const ROLE_LABELS = { EDGE_ADMIN: '账号管理员', CANDIDATE_RECEIVER: '候选接收人员', VALIDATOR: '验证人员', RELEASE_APPLICANT: '发布申请人员', EDGE_AUDITOR: '审计人员' };
function failure(message, statusCode = 400, code = 'invalid_account') {
  return Object.assign(new Error(message), { statusCode, code });
}
function passwordValid(value) {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 256) throw failure('密码至少 12 个字符，最多 256 字节');
}
function validateRoles(roles) {
  if (!Array.isArray(roles) || roles.length < 1 || roles.some((role) => !ROLES.includes(role)) || new Set(roles).size !== roles.length) throw failure('请选择有效且不重复的角色');
}

export class AuthStore {
  constructor(db, { clock = Date.now, idleMs = 30 * 60_000, absoluteMs = 8 * 60 * 60_000 } = {}) {
    this.db = db;
    this.clock = clock;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    db.exec([
      'CREATE TABLE IF NOT EXISTS edge_users (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_parameters_json TEXT NOT NULL, roles_json TEXT NOT NULL, status TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, password_changed_at TEXT, last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS edge_sessions (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES edge_users(user_id), token_sha256 TEXT NOT NULL UNIQUE, csrf_token_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER, source_address TEXT, user_agent TEXT)',
      'CREATE TABLE IF NOT EXISTS edge_auth_events (event_id TEXT PRIMARY KEY, principal_id TEXT, event_type TEXT NOT NULL, source_address TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS edge_sessions_user_idx ON edge_sessions(user_id)'
    ].join(';'));
    this.dummySalt = randomBytes(16).toString('hex');
  }
  event(type, actor = null, details = {}, address = null) {
    this.db.prepare('INSERT INTO edge_auth_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), actor, type, address, JSON.stringify(details), now());
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  getUser(id) {
    const row = this.db.prepare('SELECT * FROM edge_users WHERE user_id = ?').get(id);
    if (!row) return null;
    return { id: row.user_id, username: row.username, displayName: row.display_name, roles: JSON.parse(row.roles_json), status: row.status, mustChangePassword: Boolean(row.must_change_password), lastLoginAt: row.last_login_at, lockedUntil: row.locked_until, createdAt: row.created_at };
  }
  listUsers() { return this.db.prepare('SELECT user_id FROM edge_users ORDER BY username').all().map((row) => this.getUser(row.user_id)); }
  async createUser({ username, displayName, password, roles }, actor = null, { bootstrap = false } = {}) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(username)) throw failure('用户名需为 3 至 64 位字母、数字、点、下划线或连字符');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100) throw failure('姓名不能为空且最多 100 字');
    passwordValid(password); validateRoles(roles);
    const salt = randomBytes(16).toString('hex');
    const digest = await scrypt(password, salt, 64, params);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (bootstrap && this.db.prepare('SELECT COUNT(*) AS n FROM edge_users').get().n) throw failure('已经初始化，不能再次创建初始管理员');
      const id = 'USR-' + randomUUID();
      this.db.prepare('INSERT INTO edge_users (user_id, username, display_name, password_hash, password_salt, password_parameters_json, roles_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, username.toLowerCase(), displayName.trim(), digest.toString('hex'), salt, JSON.stringify(params), JSON.stringify(roles), 'ACTIVE', now(), now());
      this.event(bootstrap ? 'ADMIN_BOOTSTRAPPED' : 'USER_CREATED', actor, { userId: id, roles });
      this.db.exec('COMMIT');
      return this.getUser(id);
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  async login(username, password, { address = null, userAgent = null } = {}) {
    if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || Buffer.byteLength(password) > 256) throw failure('用户名或密码错误', 401, 'login_failed');
    const row = this.db.prepare('SELECT * FROM edge_users WHERE username = ?').get(username.toLowerCase());
    const digest = await scrypt(password, row?.password_salt ?? this.dummySalt, 64, row ? JSON.parse(row.password_parameters_json) : params);
    const valid = row && timingSafeEqual(digest, Buffer.from(row.password_hash, 'hex'));
    // Re-read after asynchronous password derivation to avoid bypassing concurrent lockout/disable.
    const current = row && this.db.prepare('SELECT * FROM edge_users WHERE user_id = ?').get(row.user_id);
    if (!valid || !current || current.status !== 'ACTIVE' || current.locked_until > this.clock() || current.password_hash !== row.password_hash) {
      if (current && current.status === 'ACTIVE' && !(current.locked_until > this.clock())) {
        const attempts = current.failed_attempts + 1;
        const lock = attempts >= 5 ? this.clock() + Math.min(60, 2 ** (attempts - 5)) * 60_000 : null;
        this.db.prepare('UPDATE edge_users SET failed_attempts = ?, locked_until = ? WHERE user_id = ?').run(attempts, lock, current.user_id);
      }
      this.event('LOGIN_FAILED', row?.user_id, {}, address);
      throw failure('用户名或密码错误，连续失败后需稍后重试', 401, 'login_failed');
    }
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const time = this.clock();
    this.db.prepare('INSERT INTO edge_sessions (session_id, user_id, token_sha256, csrf_token_sha256, created_at, expires_at, last_seen_at, source_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, row.user_id, hash(token), hash(csrfToken), time, time + this.absoluteMs, time, address, userAgent);
    this.db.prepare('UPDATE edge_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE user_id = ?').run(now(), row.user_id);
    this.event('LOGIN_SUCCEEDED', row.user_id, { sessionId }, address);
    return { token, csrfToken, user: this.getUser(row.user_id) };
  }
  resolve(token) {
    if (typeof token !== 'string' || token.length !== 43) return null;
    const session = this.db.prepare('SELECT * FROM edge_sessions WHERE token_sha256 = ?').get(hash(token));
    if (!session || session.revoked_at || session.expires_at <= this.clock() || session.last_seen_at + this.idleMs <= this.clock()) return null;
    const user = this.getUser(session.user_id);
    if (!user || user.status !== 'ACTIVE') return null;
    this.db.prepare('UPDATE edge_sessions SET last_seen_at = ? WHERE session_id = ?').run(this.clock(), session.session_id);
    return { id: user.id, type: 'LOCAL_USER', domain: 'EDGE_LOCAL', roles: user.roles, user, sessionId: session.session_id, csrfHash: session.csrf_token_sha256 };
  }
  csrf(principal, value) { return typeof value === 'string' && value.length === 43 && hash(value) === principal.csrfHash; }
  refreshCsrf(principal) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE edge_sessions SET csrf_token_sha256 = ? WHERE session_id = ?').run(hash(token), principal.sessionId);
    return token;
  }
  revoke(userId) { this.db.prepare('UPDATE edge_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.clock(), userId); }
  logout(principal) {
    this.db.prepare('UPDATE edge_sessions SET revoked_at = ? WHERE session_id = ?').run(this.clock(), principal.sessionId);
    this.event('LOGOUT', principal.id);
  }
  updateUser(id, body, actor) {
    const user = this.getUser(id);
    if (!user) throw failure('账号不存在', 404);
    const roles = body.roles ?? user.roles;
    const status = body.status ?? user.status;
    validateRoles(roles);
    if (!['ACTIVE', 'DISABLED'].includes(status)) throw failure('账号状态无效');
    const display = body.displayName ?? user.displayName;
    if (typeof display !== 'string' || !display.trim() || display.length > 100) throw failure('姓名不能为空且最多 100 字');
    return this.transaction(() => {
    if (id === actor && (status !== 'ACTIVE' || !roles.includes('EDGE_ADMIN'))) throw failure('不能禁用自己或移除自己的管理员角色');
    const admins = this.listUsers().filter((u) => u.status === 'ACTIVE' && u.roles.includes('EDGE_ADMIN'));
    if (admins.length === 1 && admins[0].id === id && (status !== 'ACTIVE' || !roles.includes('EDGE_ADMIN'))) throw failure('至少保留一个有效管理员');
    this.db.prepare('UPDATE edge_users SET roles_json = ?, status = ?, display_name = ?, locked_until = NULL, failed_attempts = 0, updated_at = ? WHERE user_id = ?')
      .run(JSON.stringify(roles), status, display.trim(), now(), id);
    this.revoke(id);
    this.event('USER_UPDATED', actor, { userId: id, roles, status });
    return this.getUser(id);
    });
  }
  async changePassword(id, password, actor, oldPassword = null) {
    passwordValid(password);
    const row = this.db.prepare('SELECT * FROM edge_users WHERE user_id = ?').get(id);
    if (!row) throw failure('账号不存在', 404);
    if (actor === id) {
      if (typeof oldPassword !== 'string' || Buffer.byteLength(oldPassword) > 256) throw failure('原密码不正确');
      const oldHash = await scrypt(oldPassword, row.password_salt, 64, JSON.parse(row.password_parameters_json));
      if (!timingSafeEqual(oldHash, Buffer.from(row.password_hash, 'hex'))) throw failure('原密码不正确');
      if (oldPassword === password) throw failure('新密码应与原密码不同');
    }
    const salt = randomBytes(16).toString('hex');
    const digest = await scrypt(password, salt, 64, params);
    return this.transaction(() => {
    const current = this.db.prepare('SELECT password_hash, status FROM edge_users WHERE user_id = ?').get(id);
    if (current?.password_hash !== row.password_hash || (actor === id && current.status !== 'ACTIVE')) throw failure('账号或密码已被其他操作修改，请重试', 409);
    this.db.prepare('UPDATE edge_users SET password_hash = ?, password_salt = ?, password_parameters_json = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL, password_changed_at = ?, updated_at = ? WHERE user_id = ?')
      .run(digest.toString('hex'), salt, JSON.stringify(params), actor === id ? 0 : 1, now(), now(), id);
    this.revoke(id);
    this.event(actor === id ? 'PASSWORD_CHANGED' : 'PASSWORD_RESET', actor, { userId: id });
    });
  }
}
