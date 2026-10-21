import { ROLE_LABELS } from './auth-store.js';
import { randomBytes } from 'node:crypto';

const fail = (reply, status, code, message) => reply.code(status).send({ error: { code, message } });
function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? '').split(';').map((entry) => { const i = entry.indexOf('='); return [entry.slice(0, i).trim(), entry.slice(i + 1).trim()]; }));
}
export function registerAuth(app, { auth, principalProvider, allowLocalAuth = false, keyring, gateConfig, fetchImpl = fetch, secureCookies = process.env.CAM_COOKIE_SECURE !== 'false' }) {
  const coreExchange = async (method, path, payload) => {
    const config = gateConfig.get();
    if (!config.coreControlUrl) throw Object.assign(new Error('尚未配置 Edge 外侧访问 Core 的控制地址'), { statusCode: 503, code: 'core_control_unconfigured' });
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const headers = await keyring.requestHeaders(method, path, body, { ...(body ? { 'content-type': 'application/json' } : {}), ...(method === 'GET' ? { accept: 'application/json' } : {}) });
    const response = await fetchImpl(config.coreControlUrl.replace(/\/$/u, '') + path, { method, headers, ...(body ? { body } : {}), signal: AbortSignal.timeout(config.connectTimeoutMs) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error?.message ?? 'Core 请求失败'), { statusCode: response.status, code: result.error?.code ?? 'core_request_failed' });
    if (path === '/api/v1/gate/users') {
      const assertion = result.assertion;
      if (!await keyring.verifyPeerAssertion(assertion) || assertion.payload?.audience !== 'cam-edge' || assertion.payload?.nonce !== headers['x-cam-gate-nonce'] || assertion.payload?.expiresAt <= Date.now() || assertion.payload?.issuedAt > Date.now() + 30_000 || !Array.isArray(assertion.payload?.users)) throw Object.assign(new Error('Core 返回的 Edge 用户清单签名无效或已过期'), { statusCode: 502, code: 'core_user_list_assertion_invalid' });
      result.items = assertion.payload.users;
      result.roles = assertion.payload.roles;
      auth.cacheCoreUsers(result.items);
    }
    return result;
  };
  const cookie = (name, value, httpOnly, expired = false) => `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${expired ? 0 : 28800}${httpOnly ? '; HttpOnly' : ''}${secureCookies ? '; Secure' : ''}`;
  const clear = (reply) => reply.header('Set-Cookie', [cookie('cam_session', '', true, true), cookie('cam_csrf', '', false, true)]);
  const attempts = new Map();
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (/^\/api\/v1\/gate\/(?:approval-results|transfer-requests|pairing-probe|identity-rotation\/proposals|key-rotation\/proposals(?:\/[^/]+\/confirm)?|transfer\/reports\/[^/]+)$/.test(path)) return;
    const jar = cookies(request);
    request.principal = principalProvider ? await principalProvider(request) : auth.resolve(jar.cam_session, { allowLocal: allowLocalAuth });
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
    if (writing && ['LOCAL_USER', 'CORE_USER'].includes(actor.type) && !auth.csrf(actor, request.headers['x-cam-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试');
    if (actor.user?.mustChangePassword && !['/api/v1/auth/me', '/api/v1/auth/password', '/api/v1/auth/logout'].includes(path)) return fail(reply, 403, 'password_change_required', '请先修改初始密码');
    if (path.startsWith('/api/v1/auth/')) return;
    let required;
    if (path.startsWith('/api/v1/users') || path === '/api/v1/auth-events') required = ['EDGE_ADMIN', ...(writing ? [] : ['EDGE_AUDITOR'])];
    else if (path === '/api/v1/gate/config' || path === '/api/v1/gate/config/test' || path === '/api/v1/gate/keys' || path === '/api/v1/gate/keys/test' || path === '/api/v1/gate/keys/trusted-peer' || path === '/api/v1/gate/keys/schedule' || path === '/api/v1/gate/keys/rotate') required = writing ? ['EDGE_ADMIN'] : ['EDGE_ADMIN', 'EDGE_AUDITOR'];
    else if (path === '/api/v1/validators') required = ['VALIDATOR'];
    else if (path.startsWith('/api/v1/download-grants')) required = writing ? ['VALIDATOR'] : ['VALIDATOR', 'EDGE_AUDITOR'];
    else if (/^\/api\/v1\/rounds\/[^/]+\/freezes$/.test(path)) required = writing ? ['VALIDATOR'] : ['VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'];
    else if (/^\/api\/v1\/freezes\/[^/]+\/(report|submit|dispatch|transfer\/retry)$/.test(path)) required = ['VALIDATOR'];
    else if (/^\/api\/v1\/freezes\/[^/]+\/decision$/.test(path)) required = ['RELEASE_APPLICANT'];
    else if (/^\/api\/v1\/freezes\/[^/]+\/report-file$/.test(path)) required = ['VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'];
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
      let result;
      if (principalProvider || allowLocalAuth) result = await auth.login(request.body?.username, request.body?.password, { address: request.ip, userAgent: request.headers['user-agent'] ?? null });
      else {
        const config = gateConfig.get();
        if (!config.coreControlUrl) return fail(reply, 503, 'core_control_unconfigured', '尚未配置 Edge 外侧访问 Core 的控制地址');
        const nonce = randomBytes(24).toString('base64url');
        const sealed = await keyring.sealForPeer({ username: request.body?.username, password: request.body?.password, userAgent: request.headers['user-agent'] ?? null, nonce });
        const body = JSON.stringify(sealed);
        const path = '/api/v1/gate/authenticate';
        const response = await fetchImpl(config.coreControlUrl.replace(/\/$/u, '') + path, { method: 'POST', headers: await keyring.requestHeaders('POST', path, body, { 'content-type': 'application/json' }), body, signal: AbortSignal.timeout(config.connectTimeoutMs) });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) return fail(reply, response.status, payload.error?.code ?? 'core_auth_failed', payload.error?.message ?? 'Core 认证失败');
        const assertion = payload.assertion;
        if (!await keyring.verifyPeerAssertion(assertion) || assertion.payload?.audience !== 'cam-edge' || assertion.payload?.nonce !== nonce || assertion.payload?.expiresAt <= Date.now() || assertion.payload?.issuedAt > Date.now() + 30_000) return fail(reply, 502, 'core_assertion_invalid', 'Core 返回的认证结果无效或已过期');
        result = auth.createCoreSession(assertion.payload.principal);
      }
      reply.header('Set-Cookie', [cookie('cam_session', result.token, true), cookie('cam_csrf', result.csrfToken, false)]);
      return { user: result.user, csrfToken: result.csrfToken, roles: ROLE_LABELS };
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'login_failed', err.message); }
  });
  app.get('/api/v1/auth/me', async (request) => ({ user: request.principal.user ?? request.principal, csrfToken: cookies(request).cam_csrf, roles: ROLE_LABELS }));
  app.post('/api/v1/auth/logout', async (request, reply) => { if (['LOCAL_USER', 'CORE_USER'].includes(request.principal.type)) auth.logout(request.principal); clear(reply); return { ok: true }; });
  app.post('/api/v1/auth/password', { bodyLimit: 4096 }, async (request, reply) => {
    if (request.principal.type !== 'LOCAL_USER') return fail(reply, 403, 'local_account_required', '账号密码由 CAM Core 管理，请登录 Core 修改或联系管理员重置');
    try { await auth.changePassword(request.principal.id, request.body?.password, request.principal.id, request.body?.oldPassword); clear(reply); return { ok: true, loginRequired: true }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_failed', err.message); }
  });
  app.get('/api/v1/validators', async (_request, reply) => {
    if (allowLocalAuth) return { items: auth.listUsers().filter((u) => u.status === 'ACTIVE' && !u.mustChangePassword && u.roles.includes('VALIDATOR')).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })) };
    try { return { items: (await coreExchange('GET', '/api/v1/gate/users')).items.filter((user) => user.edgeEnabled && user.status === 'ACTIVE' && !user.mustChangePassword && !(user.lockedUntil > Date.now()) && user.roles.includes('VALIDATOR')) }; }
    catch (err) { return fail(reply, err.statusCode ?? 502, err.code ?? 'core_request_failed', err.message); }
  });
  app.get('/api/v1/users', async (_request, reply) => {
    if (allowLocalAuth) return { items: auth.listUsers(), roles: ROLE_LABELS };
    try { const result = await coreExchange('GET', '/api/v1/gate/users'); return { items: result.items.filter((user) => user.edgeEnabled), roles: result.roles }; }
    catch (err) { return fail(reply, err.statusCode ?? 502, err.code ?? 'core_request_failed', err.message); }
  });
  app.post('/api/v1/users', { bodyLimit: 8192 }, async (request, reply) => {
    if (allowLocalAuth) { try { return reply.code(201).send(await auth.createUser(request.body ?? {}, request.principal.id)); } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_create_failed', err.message); } }
    return fail(reply, 403, 'users_managed_by_core', 'CAM 账号和角色统一由 Core 管理');
  });
  app.patch('/api/v1/users/:id', { bodyLimit: 8192 }, async (request, reply) => {
    if (allowLocalAuth) { try { return auth.updateUser(request.params.id, request.body ?? {}, request.principal.id); } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_update_failed', err.message); } }
    return fail(reply, 403, 'users_managed_by_core', 'CAM 账号和角色统一由 Core 管理');
  });
  app.post('/api/v1/users/:id/password', { bodyLimit: 4096 }, async (request, reply) => {
    if (allowLocalAuth) { try { await auth.changePassword(request.params.id, request.body?.password, request.principal.id); return { ok: true }; } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_reset_failed', err.message); } }
    return fail(reply, 403, 'users_managed_by_core', 'CAM 账号密码统一由 Core 管理');
  });
  app.get('/api/v1/auth-events', async () => ({ items: auth.db.prepare('SELECT event_id, principal_id, event_type, source_address, details_json, created_at FROM edge_auth_events ORDER BY rowid DESC LIMIT 200').all() }));
}
