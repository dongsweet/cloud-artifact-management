import { ROLE_LABELS, AuthStore } from './core-auth-store.js';

const fail = (reply, status, code, message) => reply.code(status).send({ error: { code, message } });
function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').filter(Boolean).map((entry) => { const i = entry.indexOf('='); return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()]; }));
}

export function registerCoreAuth(app, { auth, secureCookies = process.env.CAM_COOKIE_SECURE !== 'false' }) {
  const cookie = (name, value, httpOnly, expired = false) => `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${expired ? 0 : 28800}${httpOnly ? '; HttpOnly' : ''}${secureCookies ? '; Secure' : ''}`;
  const clear = (reply) => reply.header('Set-Cookie', [cookie('cam_core_session', '', true, true), cookie('cam_core_csrf', '', false, true)]);
  const attempts = new Map();
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (path.startsWith('/api/v1/gate/')) return;
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
}

export { AuthStore };
