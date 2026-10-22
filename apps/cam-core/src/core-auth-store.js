import { createHash, randomBytes, randomUUID, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { CORE_ROLES, EDGE_ROLES, AGENT_ROLES, CORE_ROLE_LABELS, EDGE_ROLE_LABELS, AGENT_ROLE_LABELS, hasCorePermission, hasAgentPermission, normalizeCoreRoles, normalizeEdgeRoles } from '../../../libs/cam-auth/src/roles.js';

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
export const ROLES = CORE_ROLES;
export { EDGE_ROLES, AGENT_ROLES, CORE_ROLE_LABELS, EDGE_ROLE_LABELS, AGENT_ROLE_LABELS, hasCorePermission, hasAgentPermission };
export const ROLE_LABELS = CORE_ROLE_LABELS;
function failure(message, statusCode = 400, code = 'invalid_account') {
  return Object.assign(new Error(message), { statusCode, code });
}
function passwordValid(value) {
  if (typeof value !== 'string' || value.length < 12 || Buffer.byteLength(value) > 256) throw failure('密码至少 12 个字符，最多 256 字节');
}
function normalizeAndValidateRoles(roles, roleSet = CORE_ROLES) {
  const normalized = normalizeCoreRoles(roles);
  if (!Array.isArray(normalized) || normalized.some((role) => !roleSet.includes(role)) || new Set(normalized).size !== normalized.length) throw failure(`请选择有效且不重复的${roleSet === AGENT_ROLES ? ' Agent' : ' Core'} 角色`);
  return normalized;
}
function normalizeAndValidateEdgeRoles(roles) {
  const normalized = normalizeEdgeRoles(roles);
  if (!Array.isArray(normalized) || normalized.some((role) => !EDGE_ROLES.includes(role)) || new Set(normalized).size !== normalized.length) throw failure('请选择有效且不重复的 Edge 角色');
  return normalized;
}

export class AuthStore {
  constructor(db, { clock = Date.now, idleMs = 30 * 60_000, absoluteMs = 8 * 60 * 60_000, aaaAdapter = null, roleSet = 'CORE' } = {}) {
    this.db = db;
    this.clock = clock;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.aaaAdapter = aaaAdapter;
    this.roleSet = roleSet === 'AGENT' ? 'AGENT' : 'CORE';
    this.allowedRoles = this.roleSet === 'AGENT' ? AGENT_ROLES : CORE_ROLES;
    this.roleLabels = this.roleSet === 'AGENT' ? AGENT_ROLE_LABELS : CORE_ROLE_LABELS;
    db.exec([
      "CREATE TABLE IF NOT EXISTS core_users (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, password_parameters_json TEXT NOT NULL, roles_json TEXT NOT NULL, status TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 1, failed_attempts INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, password_changed_at TEXT, last_login_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, edge_enabled INTEGER NOT NULL DEFAULT 0, edge_roles_json TEXT NOT NULL DEFAULT '[]', edge_provisioned INTEGER NOT NULL DEFAULT 0)",
      'CREATE TABLE IF NOT EXISTS core_sessions (session_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES core_users(user_id), token_sha256 TEXT NOT NULL UNIQUE, csrf_token_sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, revoked_at INTEGER, source_address TEXT, user_agent TEXT)',
      'CREATE TABLE IF NOT EXISTS core_auth_events (event_id TEXT PRIMARY KEY, principal_id TEXT, event_type TEXT NOT NULL, source_address TEXT, details_json TEXT NOT NULL, created_at TEXT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS core_sessions_user_idx ON core_sessions(user_id)'
    ].join(';'));
    const columns = new Set(db.prepare('PRAGMA table_info(core_users)').all().map((item) => item.name));
    if (!columns.has('edge_enabled')) db.exec('ALTER TABLE core_users ADD COLUMN edge_enabled INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('edge_roles_json')) db.exec("ALTER TABLE core_users ADD COLUMN edge_roles_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('edge_provisioned')) db.exec('ALTER TABLE core_users ADD COLUMN edge_provisioned INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('auth_source')) db.exec("ALTER TABLE core_users ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'LOCAL'");
    db.exec('UPDATE core_users SET edge_provisioned = 1 WHERE edge_enabled = 1');
    // Normalize role arrays so duplicate assignments never affect permission checks.
    for (const row of db.prepare('SELECT user_id, roles_json, edge_roles_json FROM core_users').all()) {
      let roles;
      try { roles = normalizeCoreRoles(JSON.parse(row.roles_json)); } catch { continue; }
      if (this.roleSet === 'AGENT') roles = roles.map((role) => role === 'AGENT_ADMIN' ? 'AGENT_SYSTEM_ADMIN' : role.replace(/^CORE_/, 'AGENT_'));
      let edgeRoles;
      try { edgeRoles = normalizeEdgeRoles(JSON.parse(row.edge_roles_json ?? '[]')); } catch { edgeRoles = []; }
      if (JSON.stringify(roles) !== row.roles_json || JSON.stringify(edgeRoles) !== (row.edge_roles_json ?? '[]')) db.prepare('UPDATE core_users SET roles_json = ?, edge_roles_json = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(roles), JSON.stringify(edgeRoles), now(), row.user_id);
    }
    this.dummySalt = randomBytes(16).toString('hex');
  }
  event(type, actor = null, details = {}, address = null) {
    this.db.prepare('INSERT INTO core_auth_events VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), actor, type, address, JSON.stringify(details), now());
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  getUser(id) {
    const row = this.db.prepare('SELECT * FROM core_users WHERE user_id = ?').get(id);
    if (!row) return null;
    let roles = normalizeCoreRoles(JSON.parse(row.roles_json));
    if (this.roleSet === 'AGENT') roles = roles.map((role) => role === 'AGENT_ADMIN' ? 'AGENT_SYSTEM_ADMIN' : role.replace(/^CORE_/, 'AGENT_'));
    return { id: row.user_id, username: row.username, displayName: row.display_name, authSource: row.auth_source ?? 'LOCAL', roles, coreEnabled: this.roleSet === 'CORE' ? row.status === 'ACTIVE' : undefined, edgeEnabled: Boolean(row.edge_enabled), edgeProvisioned: Boolean(row.edge_provisioned), edgeRoles: normalizeEdgeRoles(JSON.parse(row.edge_roles_json ?? '[]')), status: row.status, mustChangePassword: Boolean(row.must_change_password), lastLoginAt: row.last_login_at, lockedUntil: row.locked_until, createdAt: row.created_at };
  }
  listUsers() { return this.db.prepare('SELECT user_id FROM core_users ORDER BY username').all().map((row) => this.getUser(row.user_id)); }
  async createUser({ username, displayName, password, authSource = 'LOCAL', roles = [], coreEnabled = true, edgeEnabled = false, edgeRoles = [] }, actor = null, { bootstrap = false } = {}) {
    if (typeof username !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(username)) throw failure('用户名需为 3 至 64 位字母、数字、点、下划线或连字符');
    if (typeof displayName !== 'string' || !displayName.trim() || displayName.length > 100) throw failure('姓名不能为空且最多 100 字');
    if (!['LOCAL', 'AAA'].includes(authSource)) throw failure('认证来源无效');
    if (typeof coreEnabled !== 'boolean') throw failure('Core 登录权限无效');
    if (authSource === 'LOCAL') passwordValid(password);
    if (bootstrap && authSource !== 'LOCAL') throw failure('初始管理员必须使用本地认证');
    const suppliedRoles = this.roleSet === 'AGENT' ? (roles ?? []).map((role) => role === 'AGENT_ADMIN' ? 'AGENT_SYSTEM_ADMIN' : role.replace(/^CORE_/, 'AGENT_')) : roles;
    const coreRoles = normalizeAndValidateRoles(suppliedRoles, this.allowedRoles); const normalizedEdgeRoles = this.roleSet === 'AGENT' ? [] : normalizeAndValidateEdgeRoles(edgeRoles);
    if (!coreRoles.length && !normalizedEdgeRoles.length) throw failure('账号至少需要一个 CAM 角色');
    const salt = randomBytes(16).toString('hex');
    // Keep the legacy non-null password hash column populated for AAA users,
    // but never use this random, undisclosed value for AAA-backed logins.
    const passwordMaterial = authSource === 'LOCAL' ? password : randomBytes(32).toString('hex');
    const digest = await scrypt(passwordMaterial, salt, 64, params);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (bootstrap && this.db.prepare('SELECT COUNT(*) AS n FROM core_users').get().n) throw failure('已经初始化，不能再次创建初始管理员');
      const id = 'USR-' + randomUUID();
      this.db.prepare('INSERT INTO core_users (user_id, username, display_name, password_hash, password_salt, password_parameters_json, roles_json, status, edge_enabled, edge_roles_json, edge_provisioned, auth_source, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, username.toLowerCase(), displayName.trim(), digest.toString('hex'), salt, JSON.stringify(params), JSON.stringify(coreRoles), coreEnabled ? 'ACTIVE' : 'DISABLED', edgeEnabled ? 1 : 0, JSON.stringify(normalizedEdgeRoles), edgeEnabled ? 1 : 0, authSource, authSource === 'LOCAL' ? 1 : 0, now(), now());
      this.event(bootstrap ? 'ADMIN_BOOTSTRAPPED' : 'USER_CREATED', actor, { userId: id, authSource, roles: coreRoles, coreEnabled, edgeEnabled, edgeRoles: normalizedEdgeRoles });
      this.db.exec('COMMIT');
      return this.getUser(id);
    } catch (err) { this.db.exec('ROLLBACK'); throw err; }
  }
  async login(username, password, { address = null, userAgent = null, scope = 'CORE' } = {}) {
    if (typeof username !== 'string' || username.length > 64 || typeof password !== 'string' || Buffer.byteLength(password) > 256) throw failure('用户名或密码错误', 401, 'login_failed');
    const row = this.db.prepare('SELECT * FROM core_users WHERE username = ?').get(username.toLowerCase());
    if (row?.auth_source === 'AAA') {
      const current = this.db.prepare('SELECT * FROM core_users WHERE user_id = ?').get(row.user_id);
      if (!current || !this.enabledForScope(current, scope) || current.locked_until > this.clock()) {
        this.event('AAA_LOGIN_FAILED', row.user_id, { reason: 'CAM_ACCOUNT_UNAVAILABLE' }, address);
        throw failure('用户名或密码错误', 401, 'login_failed');
      }
      if (!this.aaaAdapter?.enabled()) {
        this.event('AAA_LOGIN_FAILED', row.user_id, { reason: 'AAA_NOT_CONFIGURED' }, address);
        throw failure('登录暂不可用，请稍后重试', 503, 'login_unavailable');
      }
      try { await this.aaaAdapter.authenticate({ loginName: current.username, password }); }
      catch (error) {
        const latest = this.db.prepare('SELECT * FROM core_users WHERE user_id = ?').get(row.user_id);
        if (error.statusCode === 401 && latest && this.enabledForScope(latest, scope)) {
          const failedAttempts = latest.failed_attempts + 1;
          const lock = failedAttempts >= 5 ? this.clock() + Math.min(60, 2 ** (failedAttempts - 5)) * 60_000 : null;
          this.db.prepare('UPDATE core_users SET failed_attempts = ?, locked_until = ? WHERE user_id = ?').run(failedAttempts, lock, row.user_id);
        }
        this.event('AAA_LOGIN_FAILED', row.user_id, { reason: error.code ?? 'AAA_REJECTED' }, address);
        if (error.statusCode !== 401) throw failure('登录暂不可用，请稍后重试', 503, 'login_unavailable');
        throw failure('用户名或密码错误', 401, 'login_failed');
      }
      const latest = this.db.prepare('SELECT * FROM core_users WHERE user_id = ?').get(row.user_id);
      if (!latest || !this.enabledForScope(latest, scope) || latest.auth_source !== 'AAA') {
        this.event('AAA_LOGIN_FAILED', row.user_id, { reason: 'CAM_ACCOUNT_CHANGED' }, address);
        throw failure('用户名或密码错误', 401, 'login_failed');
      }
      return this.finishLogin(latest, { address, userAgent, scope });
    }
    const digest = await scrypt(password, row?.password_salt ?? this.dummySalt, 64, row ? JSON.parse(row.password_parameters_json) : params);
    const valid = row && timingSafeEqual(digest, Buffer.from(row.password_hash, 'hex'));
    // Re-read after asynchronous password derivation to avoid bypassing concurrent lockout/disable.
    const current = row && this.db.prepare('SELECT * FROM core_users WHERE user_id = ?').get(row.user_id);
    if (!valid || !current || !this.enabledForScope(current, scope) || current.locked_until > this.clock() || current.password_hash !== row.password_hash) {
      if (current && this.enabledForScope(current, scope) && !(current.locked_until > this.clock())) {
        const attempts = current.failed_attempts + 1;
        const lock = attempts >= 5 ? this.clock() + Math.min(60, 2 ** (attempts - 5)) * 60_000 : null;
        this.db.prepare('UPDATE core_users SET failed_attempts = ?, locked_until = ? WHERE user_id = ?').run(attempts, lock, current.user_id);
      }
      this.event('LOGIN_FAILED', row?.user_id, {}, address);
      throw failure('用户名或密码错误', 401, 'login_failed');
    }
    return this.finishLogin(current, { address, userAgent, scope });
  }
  enabledForScope(row, scope) {
    // The legacy status column now controls Core access only; Edge checks its own
    // edgeEnabled flag and role assignment after the shared credential check.
    return scope === 'EDGE' && this.roleSet === 'CORE' ? true : row.status === 'ACTIVE';
  }
  finishLogin(row, { address = null, userAgent = null, scope = 'CORE' } = {}) {
    if (scope === 'EDGE') {
      this.db.prepare('UPDATE core_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE user_id = ?').run(now(), row.user_id);
      this.event('EDGE_CREDENTIALS_VERIFIED', row.user_id, { authSource: row.auth_source ?? 'LOCAL' }, address);
      return { user: this.getUser(row.user_id) };
    }
    if (!row.roles_json || JSON.parse(row.roles_json).length === 0) {
      this.event('CORE_LOGIN_DENIED', row.user_id, { reason: 'CORE_NOT_ASSIGNED' }, address);
      throw failure('此账号未获准登录 CAM Core', 403, 'core_access_denied');
    }
    const token = randomBytes(32).toString('base64url');
    const csrfToken = randomBytes(32).toString('base64url');
    const sessionId = randomUUID();
    const time = this.clock();
    this.db.prepare('INSERT INTO core_sessions (session_id, user_id, token_sha256, csrf_token_sha256, created_at, expires_at, last_seen_at, source_address, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sessionId, row.user_id, hash(token), hash(csrfToken), time, time + this.absoluteMs, time, address, userAgent);
    this.db.prepare('UPDATE core_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE user_id = ?').run(now(), row.user_id);
    this.event('LOGIN_SUCCEEDED', row.user_id, { sessionId }, address);
    return { token, csrfToken, user: this.getUser(row.user_id) };
  }
  async authenticateEdge(username, password, { address = null, userAgent = null } = {}) {
    const result = await this.login(username, password, { address, userAgent, scope: 'EDGE' });
    const user = result.user;
    if (!user.edgeEnabled || user.edgeRoles.length === 0) {
      this.event('EDGE_LOGIN_DENIED', user.id, { reason: 'EDGE_NOT_ASSIGNED' }, address);
      throw failure('此账号尚未获准登录 CAM Edge，请联系管理员分配 Edge 权限', 403, 'edge_access_denied');
    }
    this.event('EDGE_LOGIN_SUCCEEDED', user.id, { edgeRoles: user.edgeRoles }, address);
    return { id: user.id, username: user.username, displayName: user.displayName, roles: user.edgeRoles, mustChangePassword: user.mustChangePassword, edgeEnabled: user.edgeEnabled, status: user.status, lastLoginAt: user.lastLoginAt, lockedUntil: user.lockedUntil, createdAt: user.createdAt };
  }
  resolve(token) {
    if (typeof token !== 'string' || token.length !== 43) return null;
    const session = this.db.prepare('SELECT * FROM core_sessions WHERE token_sha256 = ?').get(hash(token));
    if (!session || session.revoked_at || session.expires_at <= this.clock() || session.last_seen_at + this.idleMs <= this.clock()) return null;
    const user = this.getUser(session.user_id);
    if (!user || user.status !== 'ACTIVE') return null;
    this.db.prepare('UPDATE core_sessions SET last_seen_at = ? WHERE session_id = ?').run(this.clock(), session.session_id);
    return { id: user.id, type: user.authSource === 'AAA' ? 'AAA_USER' : 'LOCAL_USER', domain: user.authSource === 'AAA' ? 'AAA' : 'CORE_LOCAL', roles: user.roles, user, sessionId: session.session_id, csrfHash: session.csrf_token_sha256 };
  }
  csrf(principal, value) { return typeof value === 'string' && value.length === 43 && hash(value) === principal.csrfHash; }
  refreshCsrf(principal) {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE core_sessions SET csrf_token_sha256 = ? WHERE session_id = ?').run(hash(token), principal.sessionId);
    return token;
  }
  revoke(userId) { this.db.prepare('UPDATE core_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(this.clock(), userId); }
  logout(principal) {
    this.db.prepare('UPDATE core_sessions SET revoked_at = ? WHERE session_id = ?').run(this.clock(), principal.sessionId);
    this.event('LOGOUT', principal.id);
  }
  updateUser(id, body, actor) {
    const user = this.getUser(id);
    if (!user) throw failure('账号不存在', 404);
    const roles = body.roles ?? user.roles;
    const edgeEnabled = body.edgeEnabled ?? user.edgeEnabled;
    const edgeRoles = body.edgeRoles ?? user.edgeRoles;
    const coreEnabled = this.roleSet === 'CORE' ? body.coreEnabled ?? (body.status === undefined ? user.status === 'ACTIVE' : body.status === 'ACTIVE') : undefined;
    const status = this.roleSet === 'CORE' ? (coreEnabled ? 'ACTIVE' : 'DISABLED') : body.status ?? user.status;
    const coreRoles = normalizeAndValidateRoles(roles); const normalizedEdgeRoles = normalizeAndValidateEdgeRoles(edgeRoles);
    if (this.roleSet === 'CORE' && typeof coreEnabled !== 'boolean') throw failure('Core 登录权限无效');
    if (this.roleSet === 'CORE' && body.coreEnabled === undefined && body.status !== undefined && !['ACTIVE', 'DISABLED'].includes(body.status)) throw failure('Core 登录权限无效');
    if (this.roleSet !== 'CORE' && !['ACTIVE', 'DISABLED'].includes(status)) throw failure('账号状态无效');
    const display = body.displayName ?? user.displayName;
    if (typeof display !== 'string' || !display.trim() || display.length > 100) throw failure('姓名不能为空且最多 100 字');
    return this.transaction(() => {
    if (id === actor && ((this.roleSet === 'CORE' && !coreEnabled) || (this.roleSet !== 'CORE' && status !== 'ACTIVE') || !coreRoles.length)) throw failure('不能禁用自己或移除自己的 Core 角色');
    const systemAdmins = this.listUsers().filter((u) => u.status === 'ACTIVE' && u.roles.includes('CORE_SYSTEM_ADMIN'));
    if (systemAdmins.length === 1 && systemAdmins[0].id === id && ((this.roleSet === 'CORE' && !coreEnabled) || status !== 'ACTIVE' || !coreRoles.includes('CORE_SYSTEM_ADMIN'))) throw failure('至少保留一个有效系统管理员');
    this.db.prepare('UPDATE core_users SET roles_json = ?, edge_enabled = ?, edge_roles_json = ?, edge_provisioned = MAX(edge_provisioned, ?), status = ?, display_name = ?, locked_until = NULL, failed_attempts = 0, updated_at = ? WHERE user_id = ?')
      .run(JSON.stringify(coreRoles), edgeEnabled ? 1 : 0, JSON.stringify(normalizedEdgeRoles), edgeEnabled ? 1 : 0, status, display.trim(), now(), id);
    this.revoke(id);
    this.event('USER_UPDATED', actor, { userId: id, roles: coreRoles, coreEnabled, edgeEnabled, edgeRoles: normalizedEdgeRoles, status });
    return this.getUser(id);
    });
  }
  async changePassword(id, password, actor, oldPassword = null, { scope = 'CORE' } = {}) {
    passwordValid(password);
    const row = this.db.prepare('SELECT * FROM core_users WHERE user_id = ?').get(id);
    if (!row) throw failure('账号不存在', 404);
    if (row.auth_source === 'AAA') throw failure('AAA 账号密码由身份源管理，请到 AAA 修改', 403, 'external_password_managed');
    if (actor === id) {
      if (typeof oldPassword !== 'string' || Buffer.byteLength(oldPassword) > 256) throw failure('原密码不正确');
      const oldHash = await scrypt(oldPassword, row.password_salt, 64, JSON.parse(row.password_parameters_json));
      if (!timingSafeEqual(oldHash, Buffer.from(row.password_hash, 'hex'))) throw failure('原密码不正确');
      if (oldPassword === password) throw failure('新密码应与原密码不同');
    }
    const salt = randomBytes(16).toString('hex');
    const digest = await scrypt(password, salt, 64, params);
    return this.transaction(() => {
    const current = this.db.prepare('SELECT password_hash, status FROM core_users WHERE user_id = ?').get(id);
    if (current?.password_hash !== row.password_hash || (actor === id && scope !== 'EDGE' && current.status !== 'ACTIVE')) throw failure('账号或密码已被其他操作修改，请重试', 409);
    this.db.prepare('UPDATE core_users SET password_hash = ?, password_salt = ?, password_parameters_json = ?, must_change_password = ?, failed_attempts = 0, locked_until = NULL, password_changed_at = ?, updated_at = ? WHERE user_id = ?')
      .run(digest.toString('hex'), salt, JSON.stringify(params), actor === id ? 0 : 1, now(), now(), id);
    this.revoke(id);
    this.event(actor === id ? 'PASSWORD_CHANGED' : 'PASSWORD_RESET', actor, { userId: id });
    });
  }
}
