import { EDGE_ROLE_LABELS, ROLE_LABELS, AuthStore, hasCorePermission } from './core-auth-store.js';
import { queryAuthEvents } from '../../../libs/cam-auth/src/audit-events.js';

const fail = (reply, status, code, message) => reply.code(status).send({ error: { code, message } });
function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').filter(Boolean).map((entry) => { const i = entry.indexOf('='); return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()]; }));
}

export function registerCoreAuth(app, { auth, keyring, aaaConfigStore = null, aaaAdapter = null, secureCookies = process.env.CAM_COOKIE_SECURE !== 'false' }) {
  const cookie = (name, value, httpOnly, expired = false) => `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${expired ? 0 : 28800}${httpOnly ? '; HttpOnly' : ''}${secureCookies ? '; Secure' : ''}`;
  const clear = (reply) => reply.header('Set-Cookie', [cookie('cam_core_session', '', true, true), cookie('cam_core_csrf', '', false, true)]);
  const attempts = new Map();
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    if (path.startsWith('/api/v1/agent/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (path.startsWith('/api/v1/gate/approval-requests') || path.startsWith('/api/v1/gate/receipts') || path.startsWith('/api/v1/gate/transfers/') || path === '/api/v1/gate/pairing-probe' || path === '/api/v1/gate/identity-rotation/proposals' || ['/api/v1/gate/authenticate', '/api/v1/gate/users', '/api/v1/gate/change-password'].includes(path)) return;
    const jar = cookies(request);
    request.principal = auth.resolve(jar.cam_core_session);
    if (path === '/api/v1/auth/login' && request.method === 'POST') return;
    if (!request.principal) return fail(reply, 401, 'login_required', '请先登录');
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (writing && request.headers.origin) {
      let origin; try { origin = new URL(request.headers.origin); } catch { return fail(reply, 403, 'origin_invalid', '请求来源无效'); }
      if (origin.host !== request.headers.host) return fail(reply, 403, 'origin_invalid', '不允许跨站操作');
    }
    if (writing && !auth.csrf(request.principal, request.headers['x-cam-core-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试');
    if (request.principal.user?.mustChangePassword && !['/api/v1/auth/me', '/api/v1/auth/password', '/api/v1/auth/logout'].includes(path)) return fail(reply, 403, 'password_change_required', '请先修改初始密码');
    if (writing && !path.startsWith('/api/v1/auth/')) auth.event('API_MUTATION', request.principal.id, { method: request.method, route: request.routeOptions.url }, request.ip);
  });
  app.post('/api/v1/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const now = Date.now(); for (const [key, item] of attempts) if (now >= item.expires) attempts.delete(key);
    const entry = attempts.get(request.ip) ?? { count: 0, expires: now + 60_000 }; if (entry.count >= 20) return fail(reply, 429, 'login_rate_limited', '登录尝试过多，请稍后重试'); entry.count++; attempts.set(request.ip, entry);
    try {
      const result = await auth.login(request.body?.username, request.body?.password, { address: request.ip, userAgent: request.headers['user-agent'] ?? null });
      reply.header('Set-Cookie', [cookie('cam_core_session', result.token, true), cookie('cam_core_csrf', result.csrfToken, false)]);
      return { user: result.user, csrfToken: result.csrfToken, roles: ROLE_LABELS };
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'login_failed', err.message); }
  });
  app.get('/api/v1/auth/me', async (request) => ({ user: request.principal?.user ?? request.principal, csrfToken: cookies(request).cam_core_csrf, roles: ROLE_LABELS }));
  app.post('/api/v1/auth/logout', async (request, reply) => { if (request.principal) auth.logout(request.principal); clear(reply); return { ok: true }; });
  app.post('/api/v1/auth/password', { bodyLimit: 4096 }, async (request, reply) => {
    if (request.principal?.type !== 'LOCAL_USER') return fail(reply, 403, 'local_account_required', '外部身份的密码由身份源管理');
    try { await auth.changePassword(request.principal.id, request.body?.password, request.principal.id, request.body?.oldPassword); clear(reply); return { ok: true, loginRequired: true }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_failed', err.message); }
  });
  const requirePermission = (request, reply, permission, message) => {
    if (!hasCorePermission(request.principal?.roles, permission)) return fail(reply, 403, 'core_permission_denied', message);
  };
  app.post('/api/v1/gate/authenticate', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      const credentials = await keyring.openFromPeer(request.body);
      const principal = await auth.authenticateEdge(credentials.username, credentials.password, { address: request.ip, userAgent: credentials.userAgent ?? null });
      const issuedAt = Date.now();
      const assertion = await keyring.signAssertion({ schemaVersion: 1, audience: 'cam-edge', issuedAt, expiresAt: issuedAt + 60_000, nonce: credentials.nonce, principal });
      return { assertion };
    } catch (err) {
      const status = err.statusCode ?? 401;
      return fail(reply, status, err.code ?? 'edge_auth_failed', err.message);
    }
  });
  app.get('/api/v1/gate/users', async (request) => {
    const issuedAt = Date.now();
    const users = auth.listUsers().filter((user) => user.edgeProvisioned).map((user) => ({ id: user.id, username: user.username, displayName: user.displayName, roles: user.edgeRoles, edgeEnabled: user.edgeEnabled, status: user.status, mustChangePassword: user.mustChangePassword, lastLoginAt: user.lastLoginAt, lockedUntil: user.lockedUntil, createdAt: user.createdAt }));
    const payload = { schemaVersion: 1, audience: 'cam-edge', issuedAt, expiresAt: issuedAt + 60_000, nonce: request.headers['x-cam-gate-nonce'], users, roles: EDGE_ROLE_LABELS };
    return { assertion: await keyring.signAssertion(payload) };
  });
  app.post('/api/v1/gate/change-password', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      const credentials = await keyring.openFromPeer(request.body);
      const checked = await auth.login(credentials.username, credentials.oldPassword, { address: request.ip, scope: 'EDGE' });
      if (!checked.user.edgeEnabled || !checked.user.edgeRoles.length) throw Object.assign(new Error('此账号当前未获准登录 CAM Edge'), { statusCode: 403, code: 'edge_access_denied' });
      await auth.changePassword(checked.user.id, credentials.password, checked.user.id, credentials.oldPassword, { scope: 'EDGE' });
      const issuedAt = Date.now();
      const assertion = await keyring.signAssertion({ schemaVersion: 1, audience: 'cam-edge', issuedAt, expiresAt: issuedAt + 60_000, nonce: credentials.nonce, changed: true });
      return { assertion };
    } catch (err) {
      return fail(reply, err.statusCode ?? 400, err.code ?? 'password_change_failed', err.message);
    }
  });
  app.get('/api/v1/users', async (request, reply) => {
    if (requirePermission(request, reply, 'userAdmin', '需要账号与角色管理权限')) return;
    return { items: auth.listUsers(), roles: ROLE_LABELS, edgeRoles: EDGE_ROLE_LABELS };
  });
  app.get('/api/v1/aaa/config', async (request, reply) => {
    if (requirePermission(request, reply, 'aaaRead', '需要系统管理员权限')) return;
    return { item: aaaConfigStore?.publicValue() ?? { configured: false, secretConfigured: false } };
  });
  app.put('/api/v1/aaa/config', { bodyLimit: 4096 }, async (request, reply) => {
    if (requirePermission(request, reply, 'aaaWrite', '需要系统管理员权限')) return;
    try {
      const saved = aaaConfigStore.save(request.body ?? {}, request.principal.id);
      aaaAdapter?.updateConfig?.(saved.config);
      return { item: aaaConfigStore.publicValue() };
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'aaa_config_invalid', err.message); }
  });
  app.post('/api/v1/aaa/test', { bodyLimit: 4096 }, async (request, reply) => {
    if (requirePermission(request, reply, 'aaaRead', '需要系统管理员权限')) return;
    try {
      const current = aaaConfigStore.get().config;
      const { testLoginName, ...input } = request.body ?? {};
      const loginName = typeof testLoginName === 'string' ? testLoginName.trim() : '';
      const candidate = { ...current, ...input, sharedSecret: String(input.sharedSecret ?? '').trim() || current.sharedSecret };
      if (!loginName || loginName.length > 128) return fail(reply, 400, 'aaa_test_user_required', '请输入一个已存在的 AAA 测试用户名（最多 128 个字符）');
      if (typeof aaaAdapter?.testConfiguration !== 'function') return { ok: true, item: aaaConfigStore.publicValue(), check: { valid: true, loginName, mode: 'injected' } };
      if (!aaaAdapter?.fetch || !candidate.baseUrl || !candidate.tenantName || !candidate.accessServerName || !candidate.sharedSecret) return fail(reply, 503, 'aaa_not_configured', 'AAA 参数尚未完整配置，请先填写 API 共享密钥');
      const result = await aaaAdapter.testConfiguration(candidate, loginName);
      return { ok: true, item: aaaConfigStore.publicValue(), check: result };
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'aaa_test_failed', err.message); }
  });
  app.post('/api/v1/users', { bodyLimit: 8192 }, async (request, reply) => {
    if (requirePermission(request, reply, 'userAdmin', '需要账号与角色管理权限')) return;
    try {
      const user = await auth.createUser(request.body ?? {}, request.principal.id);
      return reply.code(201).send({ user });
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_create_failed', err.message); }
  });
  app.patch('/api/v1/users/:id', { bodyLimit: 8192 }, async (request, reply) => {
    if (requirePermission(request, reply, 'userAdmin', '需要账号与角色管理权限')) return;
    try { return { user: auth.updateUser(request.params.id, request.body ?? {}, request.principal.id) }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_update_failed', err.message); }
  });
  app.post('/api/v1/users/:id/password', { bodyLimit: 4096 }, async (request, reply) => {
    if (requirePermission(request, reply, 'userAdmin', '需要账号与角色管理权限')) return;
    try {
      await auth.changePassword(request.params.id, request.body?.password, request.principal.id);
      return { ok: true, mustChangePassword: true };
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_reset_failed', err.message); }
  });
  app.get('/api/v1/auth-events', async (request, reply) => {
    if (requirePermission(request, reply, 'auditRead', '需要审计管理员权限')) return;
    try { return queryAuthEvents(auth.db, 'core_auth_events', request.query ?? {}); }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'audit_filter_invalid', err.message); }
  });
}

export { AuthStore };
