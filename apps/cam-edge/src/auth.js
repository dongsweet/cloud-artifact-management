import { ROLE_LABELS } from './auth-store.js';

const fail = (reply, status, code, message) => reply.code(status).send({ error: { code, message } });
function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((entry) => { const i = entry.indexOf('='); return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()]; }));
}
export function registerAuth(app, { auth, principalProvider, secureCookies = process.env.CAM_COOKIE_SECURE !== 'false' }) {
  const cookie = (name, value, httpOnly, expired = false) => `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${expired ? 0 : 28800}${httpOnly ? '; HttpOnly' : ''}${secureCookies ? '; Secure' : ''}`;
  const clear = (reply) => reply.header('Set-Cookie', [cookie('cam_session', '', true, true), cookie('cam_csrf', '', false, true)]);
  const attempts = new Map();
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const jar = cookies(request);
    request.principal = principalProvider ? await principalProvider(request) : auth.resolve(jar.cam_session);
    const tokenRoute = new RegExp('^/api/v1/downloads/[^/]+/(content|session)$').test(path) || new RegExp('^/api/v1/download-grants/[^/]+/manifest$').test(path);
    if (tokenRoute) return; // These routes validate their own scoped download token.
    const writing = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (writing && request.headers.origin) {
      let origin; try { origin = new URL(request.headers.origin); } catch { return fail(reply, 403, 'origin_invalid', '请求来源无效'); }
      if (origin.host !== request.headers.host) return fail(reply, 403, 'origin_invalid', '不允许跨站操作');
    }
    if (path === '/api/v1/auth/login' && request.method === 'POST') return;
    const actor = request.principal;
    if (!actor) return fail(reply, 401, 'login_required', '请先登录');
    if (writing && actor.type === 'LOCAL_USER' && !auth.csrf(actor, request.headers['x-cam-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试');
    if (actor.user?.mustChangePassword && !['/api/v1/auth/me', '/api/v1/auth/password', '/api/v1/auth/logout'].includes(path)) return fail(reply, 403, 'password_change_required', '请先修改初始密码');
    if (path.startsWith('/api/v1/auth/')) return;
    let required;
    if (path.startsWith('/api/v1/users') || path === '/api/v1/auth-events') required = ['EDGE_ADMIN', ...(writing ? [] : ['EDGE_AUDITOR'])];
    else if (path === '/api/v1/validators') required = ['VALIDATOR'];
    else if (path.startsWith('/api/v1/download-grants')) required = writing ? ['VALIDATOR'] : ['VALIDATOR', 'EDGE_AUDITOR'];
    else required = writing ? ['CANDIDATE_RECEIVER'] : ['CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'];
    if (!required.some((role) => actor.roles?.includes(role))) return fail(reply, 403, 'permission_denied', '当前账号没有此操作权限');
    if (writing) auth.event('API_MUTATION', actor.id, { method: request.method, route: request.routeOptions.url }, request.ip);
  });
  app.post('/api/v1/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    const time = Date.now();
    for (const [key, item] of attempts) if (time >= item.expires) attempts.delete(key);
    const key = request.ip;
    const entry = attempts.get(key) ?? { count: 0, expires: time + 60_000 };
    if (entry.count >= 20 || (!attempts.has(key) && attempts.size >= 1000)) return fail(reply, 429, 'login_rate_limited', '登录尝试过多，请一分钟后重试');
    entry.count++; attempts.set(key, entry);
    try {
      const result = await auth.login(request.body?.username, request.body?.password, { address: request.ip, userAgent: request.headers['user-agent'] ?? null });
      reply.header('Set-Cookie', [cookie('cam_session', result.token, true), cookie('cam_csrf', result.csrfToken, false)]);
      return { user: result.user, csrfToken: result.csrfToken, roles: ROLE_LABELS };
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'login_failed', err.message); }
  });
  app.get('/api/v1/auth/me', async (request) => ({ user: request.principal.user ?? request.principal, csrfToken: cookies(request).cam_csrf, roles: ROLE_LABELS }));
  app.post('/api/v1/auth/logout', async (request, reply) => { if (request.principal.type === 'LOCAL_USER') auth.logout(request.principal); clear(reply); return { ok: true }; });
  app.post('/api/v1/auth/password', { bodyLimit: 4096 }, async (request, reply) => {
    if (request.principal.type !== 'LOCAL_USER') return fail(reply, 403, 'local_account_required', '外部身份的密码由身份源管理');
    try { await auth.changePassword(request.principal.id, request.body?.password, request.principal.id, request.body?.oldPassword); clear(reply); return { ok: true, loginRequired: true }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_failed', err.message); }
  });
  app.get('/api/v1/validators', async () => ({ items: auth.listUsers().filter((u) => u.status === 'ACTIVE' && !u.mustChangePassword && u.roles.includes('VALIDATOR')).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })) }));
  app.get('/api/v1/users', async () => ({ items: auth.listUsers(), roles: ROLE_LABELS }));
  app.post('/api/v1/users', { bodyLimit: 8192 }, async (request, reply) => {
    try { return reply.code(201).send(await auth.createUser(request.body ?? {}, request.principal.id)); }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_create_failed', /UNIQUE constraint/.test(err.message) ? '用户名已存在' : err.message); }
  });
  app.patch('/api/v1/users/:id', { bodyLimit: 8192 }, async (request, reply) => {
    try { return auth.updateUser(request.params.id, request.body ?? {}, request.principal.id); }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_update_failed', err.message); }
  });
  app.post('/api/v1/users/:id/password', { bodyLimit: 4096 }, async (request, reply) => {
    try { await auth.changePassword(request.params.id, request.body?.password, request.principal.id); return { ok: true }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_reset_failed', err.message); }
  });
  app.get('/api/v1/auth-events', async () => ({ items: auth.db.prepare('SELECT event_id, principal_id, event_type, source_address, details_json, created_at FROM edge_auth_events ORDER BY rowid DESC LIMIT 200').all() }));
}
