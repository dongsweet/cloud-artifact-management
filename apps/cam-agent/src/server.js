import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, rename, rm, stat, statfs, readdir, readFile, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { buildServer } from '../../../libs/cam-server/src/server.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { AuthStore } from '../../cam-core/src/core-auth-store.js';
import { AGENT_PERMISSION_ROLES, AGENT_ROLE_LABELS, hasAgentPermission } from '../../../libs/cam-auth/src/roles.js';
import { queryAuthEvents } from '../../../libs/cam-auth/src/audit-events.js';
import { AaaConfigStore, DkeyAmAdapter, registerAaaConfigRoutes } from '../../../libs/cam-aaa/src/adapter.js';
import { fingerprint, randomNonce, signRequest, verifyResponse } from '../../../libs/cam-agent-auth/src/protocol.js';
import { createIdentityRotation, loadAgentIdentity } from './identity-rotation.js';
import { agentPage } from './web.js';
import { CoreConnectionStore } from './core-connection.js';
import { AgentDeliveryStore } from './delivery-store.js';
import { bearerToken, parseRange } from '../../../libs/cam-transfer/src/http.js';

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/agent' : join(process.cwd(), 'data', 'agent'));
const CORE_URL = (process.env.CAM_CORE_URL ?? 'http://127.0.0.1:3102').replace(/\/$/u, '');
const LEGACY_AGENT_ID = process.env.CAM_AGENT_ID ?? '';
const CHUNK_SIZE = Math.max(64 * 1024, Math.min(64 * 1024 * 1024, Number(process.env.CAM_AGENT_CHUNK_SIZE ?? 4 * 1024 * 1024)));
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CAM_AGENT_CONCURRENCY ?? 4)));

function fail(reply, status, code, message) { return reply.code(status).send({ error: { code, message } }); }
function cookies(request) { return Object.fromEntries((request.headers.cookie ?? '').split(';').filter(Boolean).map((e) => { const i = e.indexOf('='); return [e.slice(0, i).trim(), e.slice(i + 1).trim()]; })); }
function registerAuth(app, auth) {
  const cookie = (name, value, httpOnly, expired = false) => `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${expired ? 0 : 28800}${httpOnly ? '; HttpOnly' : ''}${process.env.CAM_COOKIE_SECURE === 'false' ? '' : '; Secure'}`;
  const permissionsFor = (roles = []) => Object.fromEntries(Object.keys(AGENT_PERMISSION_ROLES).map((permission) => [permission, hasAgentPermission(roles, permission)]));
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]; if (!path.startsWith('/api/')) return;
    if (path.startsWith('/api/v1/auth/')) { request.principal = auth.resolve(cookies(request).cam_agent_session); return; }
    if (/^\/api\/v1\/delivery-grants\/[^/]+\/(manifest|files\/[^/]+\/(session|content))$/u.test(path)) return;
    request.principal = auth.resolve(cookies(request).cam_agent_session);
    if (!request.principal) return fail(reply, 401, 'login_required', '请先登录');
    if (request.principal.user?.mustChangePassword && !['/api/v1/auth/me', '/api/v1/auth/password', '/api/v1/auth/logout'].includes(path)) return fail(reply, 403, 'password_change_required', '请先修改初始密码');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !auth.csrf(request.principal, request.headers['x-cam-agent-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试');
  });
  app.post('/api/v1/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    try { const result = await auth.login(request.body?.username, request.body?.password, { address: request.ip, userAgent: request.headers['user-agent'] ?? null }); reply.header('Set-Cookie', [cookie('cam_agent_session', result.token, true), cookie('cam_agent_csrf', result.csrfToken, false)]); return { user: result.user, csrfToken: result.csrfToken, roles: AGENT_ROLE_LABELS, permissions: permissionsFor(result.user.roles) }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'login_failed', err.message); }
  });
  app.get('/api/v1/auth/me', async (request) => ({ user: request.principal?.user ?? null, csrfToken: cookies(request).cam_agent_csrf, roles: AGENT_ROLE_LABELS, permissions: permissionsFor(request.principal?.user?.roles) }));
  app.post('/api/v1/auth/logout', async (request, reply) => { if (request.principal && !auth.csrf(request.principal, request.headers['x-cam-agent-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试'); if (request.principal) auth.logout(request.principal); reply.header('Set-Cookie', [cookie('cam_agent_session', '', true, true), cookie('cam_agent_csrf', '', false, true)]); return { ok: true }; });
  app.post('/api/v1/auth/password', { bodyLimit: 4096 }, async (request, reply) => { if (request.principal?.type !== 'LOCAL_USER') return fail(reply, 403, 'local_account_required', '本地账号密码由 Agent 管理'); if (!auth.csrf(request.principal, request.headers['x-cam-agent-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试'); try { await auth.changePassword(request.principal.id, request.body?.password, request.principal.id, request.body?.oldPassword); reply.header('Set-Cookie', [cookie('cam_agent_session', '', true, true), cookie('cam_agent_csrf', '', false, true)]); return { ok: true, loginRequired: true }; } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_failed', err.message); } });
}

export async function buildAgentApp({ dataDir = DEFAULT_DATA_DIR, coreUrl = CORE_URL, agentId: legacyAgentId = LEGACY_AGENT_ID, corePublicKey = process.env.CAM_CORE_PUBLIC_KEY ?? (process.env.CAM_CORE_PUBLIC_KEY_B64 ? Buffer.from(process.env.CAM_CORE_PUBLIC_KEY_B64, 'base64').toString('utf8') : ''), corePreviousPublicKey = process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY ?? (process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY_B64 ? Buffer.from(process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY_B64, 'base64').toString('utf8') : ''), corePreviousPublicKeyExpiresAt = process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY_EXPIRES_AT ?? '', fetchImpl = fetch, aaaAdapter = undefined, startWorker = true } = {}) {
  await mkdir(join(dataDir, 'cache'), { recursive: true });
  const identityPath = join(dataDir, 'identity.json');
  let identity = await loadAgentIdentity(identityPath);
  let agentId = legacyAgentId;
  const db = await openDatabase(join(dataDir, 'agent.sqlite'));
  // AAA authentication is direct from Agent; Core is only the artifact source.
  const aaaConfigStore = new AaaConfigStore(db, { env: process.env, table: 'agent_aaa_config' });
  const agentAaaAdapter = aaaAdapter ?? new DkeyAmAdapter({ config: aaaConfigStore.get().config, fetchImpl });
  const auth = new AuthStore(db, { roleSet: 'AGENT', aaaAdapter: agentAaaAdapter });
  const delivery = new AgentDeliveryStore({ db, dataDir });
  const coreConnection = new CoreConnectionStore(db, { coreUrl, corePublicKey, previousPublicKey: corePreviousPublicKey, previousPublicKeyExpiresAt: corePreviousPublicKeyExpiresAt });
  let running = false;
  let configuring = false;
  let testing = false;
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (task_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, status TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, scheduled_at TEXT, chunk_concurrency INTEGER NOT NULL DEFAULT 4, last_error TEXT, updated_at TEXT NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_task_files (
    task_id TEXT NOT NULL, sha256 TEXT NOT NULL, package_key TEXT, file_name TEXT NOT NULL,
    size_bytes INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', reused INTEGER NOT NULL DEFAULT 0,
    completed_parts INTEGER NOT NULL DEFAULT 0, total_parts INTEGER NOT NULL DEFAULT 0,
    bytes_downloaded INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, sha256)
  ); CREATE INDEX IF NOT EXISTS agent_task_files_task_idx ON agent_task_files(task_id, updated_at);`);
  const taskColumns = new Set(db.prepare('PRAGMA table_info(agent_tasks)').all().map((column) => column.name));
  if (!taskColumns.has('attempts')) db.exec('ALTER TABLE agent_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (!taskColumns.has('retry_at')) db.exec('ALTER TABLE agent_tasks ADD COLUMN retry_at TEXT');
  if (!taskColumns.has('scheduled_at')) db.exec("ALTER TABLE agent_tasks ADD COLUMN scheduled_at TEXT");
  if (!taskColumns.has('chunk_concurrency')) db.exec('ALTER TABLE agent_tasks ADD COLUMN chunk_concurrency INTEGER NOT NULL DEFAULT 4');
  const app = await buildServer({ service: 'cam-agent', configure: async (server) => { registerAuth(server, auth); server.addHook('onClose', async () => db.close()); } });
  const sharedAssetRoot = resolve(process.cwd(), 'web-shared', 'assets');
  app.get('/assets/:file', async (request, reply) => {
    const file = request.params.file;
    if (!/^(bootstrap\.min\.css|bootstrap-icons\.min\.css|adminlte\.min\.css)$/u.test(file)) return reply.code(404).send();
    return reply.type(file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream').send(await readFile(join(sharedAssetRoot, file)));
  });
  app.get('/assets/fonts/:file', async (request, reply) => {
    if (!/^bootstrap-icons\.woff2?$/u.test(request.params.file)) return reply.code(404).send();
    return reply.type('font/woff2').send(await readFile(join(sharedAssetRoot, 'fonts', request.params.file)));
  });
  app.get('/assets/layout.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'layout.css'))));
  app.get('/assets/role-display.css', async (_request, reply) => reply.type('text/css; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'role-display.css'))));
  app.get('/assets/role-display.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'role-display.js'))));
  app.get('/assets/table-pagination.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'table-pagination.js'))));
  app.get('/assets/artifact-catalog.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'artifact-catalog.js'))));
  app.get('/assets/task-table.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'task-table.js'))));
  app.get('/assets/audit-events.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'audit-events.js'))));
  app.get('/assets/aaa-config.js', async (_request, reply) => reply.type('text/javascript; charset=utf-8').send(await readFile(resolve(process.cwd(), 'web-shared', 'aaa-config.js'))));
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(agentPage()));
  const core = async (path, options = {}, signer = identity) => {
    const config = coreConnection.get();
    if (!config.corePublicKey) throw Object.assign(new Error('请先在 Core 身份配对页面配置 Core 公钥'), { code: 'core_public_key_missing', status: 503 });
    const trustedCoreKeys = [{ publicKeyPem: config.corePublicKey, keyId: config.fingerprint }, ...(config.previousPublicKey && Date.parse(config.previousPublicKeyExpiresAt) > Date.now() ? [{ publicKeyPem: config.previousPublicKey, keyId: config.previousFingerprint }] : [])];
    const method = options.method ?? 'GET'; const body = options.body ?? ''; const timestamp = new Date().toISOString(); const nonce = randomNonce();
    const headers = { accept: 'application/json', ...(agentId ? { 'x-cam-agent-id': agentId } : { 'x-cam-agent-key-id': signer.fingerprint ?? fingerprint(signer.publicKeyPem) }), 'x-cam-agent-timestamp': timestamp, 'x-cam-agent-nonce': nonce, 'x-cam-agent-signature': signRequest(signer.privateKeyPem, method, path.split('?')[0], timestamp, nonce, body), ...(options.headers ?? {}) };
    if (options.proofKey) headers['x-cam-agent-new-key-proof'] = signRequest(options.proofKey.privateKeyPem, method, path.split('?')[0], timestamp, nonce, body);
    // An empty string would make fetch send text/plain; Fastify then parses it as
    // a string, changing the signed payload. Send no body for empty requests.
    const requestOptions = { ...options }; delete requestOptions.proofKey; if (body === '') delete requestOptions.body;
    const response = await fetchImpl(`${config.coreUrl}${path}`, { signal: AbortSignal.timeout(Number(process.env.CAM_AGENT_REQUEST_TIMEOUT_MS ?? 60_000)), ...requestOptions, headers });
    const responseTimestamp = response.headers.get('x-cam-core-timestamp');
    const responseSignature = response.headers.get('x-cam-core-signature');
    const responseKeyId = response.headers.get('x-cam-core-key-id');
    const responseBody = Buffer.from(await response.clone().arrayBuffer());
    const key = trustedCoreKeys.find((item) => item.keyId === responseKeyId && (item.keyId === config.fingerprint || Date.parse(config.previousPublicKeyExpiresAt) > Date.now()));
    const validTimestamp = typeof responseTimestamp === 'string' && Number.isFinite(Date.parse(responseTimestamp)) && Math.abs(Date.now() - Date.parse(responseTimestamp)) <= 5 * 60_000;
    if (!key || !validTimestamp || !verifyResponse(key.publicKeyPem, responseSignature, response.status, method, path.split('?')[0], nonce, responseTimestamp, responseBody)) throw Object.assign(new Error('Core 响应签名校验失败'), { code: 'core_response_signature_invalid', status: 502 });
    if (response.headers.get('content-type')?.includes('application/json')) {
      let envelope;
      try { envelope = JSON.parse(responseBody.toString('utf8') || '{}'); } catch { envelope = null; }
      const proposal = envelope?.coreIdentityRotation;
      if (proposal) {
        const accepted = coreConnection.acceptIdentityRotation(proposal);
        if (path.split('?')[0] !== '/api/v1/agent/core-identity/confirm') {
          try {
            const confirmation = JSON.stringify({ rotationId: proposal.rotationId, fingerprint: accepted.fingerprint });
            await core('/api/v1/agent/core-identity/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: confirmation }, signer);
            coreConnection.clearIdentityRotation(proposal.rotationId);
          } catch (error) {
            if (error.code !== 'agent_identity_pending') throw error;
          }
        }
      } else {
        const trustedRotationId = coreConnection.get().coreIdentityRotationId;
        if (trustedRotationId && path.split('?')[0] !== '/api/v1/agent/core-identity/confirm') {
          const confirmation = JSON.stringify({ rotationId: trustedRotationId, fingerprint: coreConnection.get().fingerprint });
          try { await core('/api/v1/agent/core-identity/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: confirmation }, signer); coreConnection.clearIdentityRotation(trustedRotationId); }
          catch (error) { if (error.code !== 'agent_identity_pending') throw error; }
        }
      }
    }
    if (!response.ok) { const body = JSON.parse(responseBody.toString('utf8') || '{}'); throw Object.assign(new Error(body.error?.message ?? `Core 请求失败（HTTP ${response.status}）`), { code: body.error?.code ?? 'core_request_failed', status: response.status }); } return response;
  };
  const rotation = await createIdentityRotation({ identityPath, identity, request: core, onIdentity: (next) => { identity = next; }, onAgentId: (next) => { agentId = next; }, initialAgentId: legacyAgentId });
  const cachePath = (sha256) => join(dataDir, 'cache', sha256);
  const inspectCachedFile = async (file) => {
    try {
      const info = await stat(cachePath(file.sha256));
      if (info.size === Number(file.sizeBytes)) return { ...file, cached: true, cacheState: 'READY', cachedBytes: info.size };
      return { ...file, cached: false, cacheState: 'INVALID', cachedBytes: info.size };
    } catch { return { ...file, cached: false, cacheState: 'MISSING', cachedBytes: 0 }; }
  };
  const taskForArtifact = (artifactId) => db.prepare('SELECT * FROM agent_tasks WHERE artifact_id = ? ORDER BY updated_at DESC LIMIT 1').get(artifactId);
  const displayTaskStatus = (task) => {
    if (!task) return 'NOT_SCHEDULED';
    if (task.status === 'COMPLETED') return 'CACHED';
    if (task.status === 'SCHEDULED') return 'SCHEDULED';
    if ((task.last_error ?? task.lastError) && (task.retry_at ?? task.retryAt) && Date.parse(task.retry_at ?? task.retryAt) > Date.now()) return 'RETRY_WAIT';
    if (task.status === 'RUNNING') return 'RUNNING';
    return 'QUEUED';
  };
  const listAvailableArtifacts = async () => {
    const response = await core('/api/v1/agent/available-artifacts'); const catalog = await response.json();
    return Promise.all((catalog.items ?? []).map(async (item) => {
      const files = await Promise.all((item.files ?? []).map(inspectCachedFile));
      const localTask = taskForArtifact(item.artifactId);
      const task = localTask ?? item.distributionTask;
      const cachedFiles = files.filter((file) => file.cached);
      const allCached = files.length > 0 && cachedFiles.length === files.length;
      const taskState = displayTaskStatus(task);
      const agentStatus = !task ? 'NOT_SCHEDULED' : allCached ? 'CACHED' : taskState === 'RETRY_WAIT' ? 'RETRY_WAIT' : taskState === 'RUNNING' ? 'RUNNING' : taskState === 'SCHEDULED' ? 'SCHEDULED' : taskState === 'QUEUED' ? 'QUEUED' : cachedFiles.length ? 'PARTIAL' : 'NOT_CACHED';
      const agentStatusLabel = { CACHED: '已就绪', PARTIAL: '部分缓存', RETRY_WAIT: '重试等待', RUNNING: '传输中', QUEUED: '排队中', SCHEDULED: '已计划', NOT_SCHEDULED: '未调度', NOT_CACHED: '未缓存' }[agentStatus];
      const agentStatusDetail = task?.last_error ?? task?.lastError ?? (!task && allCached ? '未安排本 Agent 传输，文件已通过 SHA-256 复用' : !task ? '等待 Core 安排传输' : taskState === 'SCHEDULED' ? `计划开始：${task.scheduled_at ?? task.scheduledAt}` : null);
      return { ...item, files, cachedFileCount: cachedFiles.length, cachedBytes: files.reduce((sum, file) => sum + (file.cachedBytes || 0), 0), totalBytes: files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0), agentStatus, agentStatusLabel, agentStatusDetail, lastTransferAt: task?.updated_at ?? task?.updatedAt ?? null, taskId: task?.task_id ?? task?.taskId ?? null, distributionAuthorized: Boolean(item.distributionAuthorized || localTask) };
    }));
  };
  const cacheSummary = async (items) => {
    const catalog = items ?? await listAvailableArtifacts();
    const referenced = new Set(catalog.flatMap((item) => (item.files ?? []).map((file) => file.sha256)));
    let objectCount = 0; let cacheBytes = 0; let orphanObjectCount = 0;
    try {
      const entries = await readdir(join(dataDir, 'cache'), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
        objectCount += 1;
        try { cacheBytes += (await stat(cachePath(entry.name))).size; } catch { /* removed while scanning */ }
        if (!referenced.has(entry.name)) orphanObjectCount += 1;
      }
    } catch { /* cache directory is created during startup */ }
    let disk = { totalBytes: null, freeBytes: null };
    try { const info = await statfs(join(dataDir, 'cache')); const block = Number(info.bsize); disk = { totalBytes: Number(info.blocks) * block, freeBytes: Number(info.bavail) * block }; } catch { /* statfs is platform dependent */ }
    const cachedVersions = catalog.filter((item) => item.agentStatus === 'CACHED').length;
    const taskCounts = catalog.reduce((counts, item) => { if (item.agentStatus === 'QUEUED') counts.queued += 1; else if (item.agentStatus === 'RUNNING') counts.running += 1; else if (item.agentStatus === 'RETRY_WAIT') counts.retry += 1; return counts; }, { queued: 0, running: 0, retry: 0 });
    const invalidFileCount = catalog.reduce((sum, item) => sum + (item.files ?? []).filter((file) => file.cacheState === 'INVALID').length, 0);
    return { objectCount, cacheBytes, cachedFileCount: catalog.reduce((sum, item) => sum + Number(item.cachedFileCount || 0), 0), totalVersionCount: catalog.length, cachedVersionCount: cachedVersions, pendingTaskCount: taskCounts.queued + taskCounts.running + taskCounts.retry, taskCounts, referencedFileCount: referenced.size, orphanObjectCount, invalidFileCount, disk, checkedAt: new Date().toISOString() };
  };
  const requirePermission = (permission, message) => async (request, reply) => {
    if (!hasAgentPermission(request.principal?.user?.roles, permission)) return fail(reply, 403, 'agent_permission_denied', message);
  };
  const admin = requirePermission('configWrite', '需要系统管理员权限');
  const userAdmin = requirePermission('userAdmin', '需要安全管理员权限');
  registerAaaConfigRoutes(app, {
    configStore: aaaConfigStore,
    adapter: agentAaaAdapter,
    readPermission: 'configRead',
    writePermission: 'configWrite',
    requirePermission: (permission) => requirePermission(permission, '需要系统管理员权限'),
    audit: (type, request, details) => auth.event(type, request.principal?.id, details, request.ip)
  });
  app.get('/api/v1/auth-events', { preHandler: requirePermission('auditRead', '需要审计管理员权限') }, async (request, reply) => {
    try { return queryAuthEvents(auth.db, 'core_auth_events', request.query ?? {}, { resolvePrincipal: (id) => auth.getUser(id) }); }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'audit_filter_invalid', err.message); }
  });
  app.get('/api/v1/users', { preHandler: userAdmin }, async () => ({ items: auth.listUsers(), roles: AGENT_ROLE_LABELS }));
  app.post('/api/v1/users', { bodyLimit: 8192, preHandler: userAdmin }, async (request, reply) => {
    try {
      const body = request.body ?? {};
      const user = await auth.createUser({ username: body.username, displayName: body.displayName, password: body.authSource === 'AAA' ? undefined : body.password, authSource: body.authSource ?? 'LOCAL', roles: body.roles ?? [], status: body.status ?? 'ACTIVE' }, request.principal.id);
      return reply.code(201).send({ user });
    } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_create_failed', err.message); }
  });
  app.patch('/api/v1/users/:id', { bodyLimit: 8192, preHandler: userAdmin }, async (request, reply) => {
    try { return { user: auth.updateUser(request.params.id, request.body ?? {}, request.principal.id) }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'user_update_failed', err.message); }
  });
  app.post('/api/v1/users/:id/password', { bodyLimit: 4096, preHandler: userAdmin }, async (request, reply) => {
    if (request.params.id === request.principal.id) return fail(reply, 400, 'self_password_reset', '请使用页面右上角的修改密码功能修改自己的密码');
    try { await auth.changePassword(request.params.id, request.body?.password, request.principal.id); return { ok: true }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_reset_failed', err.message); }
  });
  app.get('/api/v1/core-config', { preHandler: admin }, async () => ({ item: coreConnection.get() }));
  app.put('/api/v1/core-config', { bodyLimit: 16 * 1024, preHandler: admin }, async (request, reply) => {
    if (running || configuring || testing || rotation.status().rotating) return fail(reply, 409, 'core_connection_busy', '正在传输或同步身份，请稍后保存配置');
    configuring = true;
    try {
      const item = coreConnection.save(request.body);
      await rotation.resetConnection();
      auth.event('CORE_CONNECTION_UPDATED', request.principal.id, { coreUrl: item.coreUrl, fingerprint: item.fingerprint, previousFingerprint: item.previousFingerprint }, request.ip);
      return { item };
    } catch (err) { return fail(reply, 400, err.code ?? 'core_config_invalid', err.message); }
    finally { configuring = false; }
  });
  app.post('/api/v1/core-config/test', { bodyLimit: 4096, preHandler: admin }, async (_request, reply) => {
    if (configuring || testing) return fail(reply, 409, 'core_connection_busy', '正在保存或测试，请稍后重试');
    testing = true;
    try {
      await rotation.sync({ ignoreBackoff: true });
      return { ok: true, item: coreConnection.markTest('PASSED') };
    } catch (err) {
      coreConnection.markTest('FAILED');
      return fail(reply, err.status ?? 502, err.code ?? 'core_connection_test_failed', err.message);
    } finally { testing = false; }
  });
  app.post('/api/v1/identity/test', { bodyLimit: 4096, preHandler: admin }, async (_request, reply) => {
    if (configuring) return fail(reply, 409, 'core_connection_busy', '正在保存 Core 对接配置');
    try {
      await rotation.sync({ ignoreBackoff: true });
      return { ok: true, agentId: rotation.status().agentId, fingerprint: identity.fingerprint, rotation: rotation.status() };
    } catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'agent_pairing_failed', err.message); }
  });
  app.post('/api/v1/identity/rotate', { bodyLimit: 4096, preHandler: admin }, async (_request, reply) => {
    if (configuring) return fail(reply, 409, 'core_connection_busy', '正在保存 Core 对接配置');
    try {
      await rotation.sync({ force: true });
      return { ok: true, fingerprint: identity.fingerprint, rotation: rotation.status() };
    } catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'agent_rotation_failed', err.message); }
  });
  const nowIso = () => new Date().toISOString();
  const upsertTaskFiles = (task) => {
    const timestamp = nowIso();
    const statement = db.prepare(`INSERT INTO agent_task_files (task_id, sha256, package_key, file_name, size_bytes, total_parts, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id, sha256) DO UPDATE SET package_key=excluded.package_key, file_name=excluded.file_name, size_bytes=excluded.size_bytes, total_parts=excluded.total_parts, updated_at=excluded.updated_at`);
    for (const file of task.files ?? []) statement.run(task.taskId, file.sha256, file.packageKey ?? null, file.fileName, Number(file.sizeBytes ?? 0), Math.ceil(Number(file.sizeBytes ?? 0) / CHUNK_SIZE), timestamp);
  };
  const localTask = (task) => {
    const timestamp = nowIso();
    const lastError = Object.hasOwn(task, 'lastError') ? task.lastError : null;
    db.prepare(`INSERT INTO agent_tasks (task_id, artifact_id, status, progress_json, attempts, retry_at, scheduled_at, chunk_concurrency, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET artifact_id=excluded.artifact_id, status=excluded.status, progress_json=excluded.progress_json,
      attempts=excluded.attempts, retry_at=excluded.retry_at, scheduled_at=excluded.scheduled_at, chunk_concurrency=excluded.chunk_concurrency, last_error=excluded.last_error, updated_at=excluded.updated_at`)
      .run(task.taskId, task.artifactId, task.status, JSON.stringify(task.progress ?? {}), task.attempts ?? 0, task.retryAt ?? null, task.scheduledAt ?? null, task.chunkConcurrency ?? CONCURRENCY, lastError, timestamp);
    upsertTaskFiles(task);
  };
  const updateTaskFile = (taskId, file, fields = {}) => {
    const timestamp = nowIso();
    db.prepare(`UPDATE agent_task_files SET status = COALESCE(?, status), reused = COALESCE(?, reused), completed_parts = COALESCE(?, completed_parts),
      total_parts = COALESCE(?, total_parts), bytes_downloaded = COALESCE(?, bytes_downloaded), last_error = ?, updated_at = ?
      WHERE task_id = ? AND sha256 = ?`)
      .run(fields.status ?? null, fields.reused ?? null, fields.completedParts ?? null, fields.totalParts ?? null, fields.bytesDownloaded ?? null, fields.lastError ?? null, timestamp, taskId, file.sha256);
  };
  const taskFiles = async (taskId) => Promise.all(db.prepare('SELECT * FROM agent_task_files WHERE task_id = ? ORDER BY file_name').all(taskId).map(async (row) => {
    let cached = false;
    try { const info = await stat(cachePath(row.sha256)); cached = info.size === Number(row.size_bytes); } catch { /* cache miss */ }
    return { taskId: row.task_id, sha256: row.sha256, packageKey: row.package_key, fileName: row.file_name, sizeBytes: row.size_bytes, status: cached ? 'COMPLETED' : row.status, reused: Boolean(row.reused), cached, completedParts: row.completed_parts, totalParts: row.total_parts, bytesDownloaded: cached ? row.size_bytes : row.bytes_downloaded, lastError: row.last_error, updatedAt: row.updated_at };
  }));
  const serializeTask = async (row) => {
    if (!row) return null;
    const files = await taskFiles(row.task_id);
    const progress = JSON.parse(row.progress_json || '{}');
    const completedFiles = files.filter((file) => file.status === 'COMPLETED').length;
    const totalBytes = files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0);
    const completedBytes = files.reduce((sum, file) => sum + Number(file.bytesDownloaded || 0), 0);
    const displayStatus = row.status === 'COMPLETED' ? 'CACHED' : row.last_error && row.retry_at && Date.parse(row.retry_at) > Date.now() ? 'RETRY_WAIT' : row.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
    return { taskId: row.task_id, artifactId: row.artifact_id, status: row.status, displayStatus, progress, files, fileCount: files.length, completedFiles, totalBytes, completedBytes, attempts: row.attempts, retryAt: row.retry_at, scheduledAt: row.scheduled_at, chunkConcurrency: row.chunk_concurrency, lastError: row.last_error, updatedAt: row.updated_at };
  };
  const update = async (taskId, body) => { const response = await core(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return response.json(); };
  async function downloadTask(task) {
    localTask({ ...task, status: 'RUNNING', lastError: null }); await update(task.taskId, { status: 'RUNNING', progress: { state: 'starting' } }).catch(() => {});
    const taskDir = join(dataDir, 'cache', task.taskId); await mkdir(join(taskDir, 'parts'), { recursive: true });
    let currentFile = null;
    try {
      for (const file of task.files) {
        currentFile = file;
        const outputPath = cachePath(file.sha256);
        try {
          const cached = await stat(outputPath);
          if (cached.size === file.sizeBytes && createHash('sha256').update(await readFile(outputPath)).digest('hex') === file.sha256) {
            const count = Math.ceil(file.sizeBytes / CHUNK_SIZE); updateTaskFile(task.taskId, file, { status: 'COMPLETED', reused: 1, completedParts: count, totalParts: count, bytesDownloaded: file.sizeBytes });
            continue;
          }
        } catch { /* cache miss */ }
        const count = Math.ceil(file.sizeBytes / CHUNK_SIZE); const pending = []; let completedBytes = 0;
        for (let index = 0; index < count; index += 1) {
          const partPath = join(taskDir, 'parts', `${file.sha256}.${index}`); const expected = Math.min(CHUNK_SIZE, file.sizeBytes - index * CHUNK_SIZE);
          try { const saved = await stat(partPath); if (saved.size === expected) { completedBytes += saved.size; continue; } } catch { /* missing chunk */ }
          pending.push(index);
        }
        let cursor = 0; let completedParts = count - pending.length;
        updateTaskFile(task.taskId, file, { status: 'RUNNING', reused: 0, completedParts, totalParts: count, bytesDownloaded: completedBytes, lastError: null });
        const worker = async () => { while (cursor < pending.length) { const index = pending[cursor++]; const start = index * CHUNK_SIZE; const end = Math.min(file.sizeBytes - 1, start + CHUNK_SIZE - 1); const response = await core(`/api/v1/agent/tasks/${encodeURIComponent(task.taskId)}/files/${file.sha256}/parts/${index}`, { headers: { 'x-cam-chunk-size': String(CHUNK_SIZE) } }); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length !== end - start + 1) throw new Error(`分块 ${index} 大小不正确`); const partPath = join(taskDir, 'parts', `${file.sha256}.${index}`); await new Promise((resolve, reject) => { const output = createWriteStream(partPath, { flags: 'w', mode: 0o600 }); output.on('error', reject); output.end(bytes, resolve); }); completedParts += 1; completedBytes += bytes.length; updateTaskFile(task.taskId, file, { status: 'RUNNING', completedParts, totalParts: count, bytesDownloaded: completedBytes }); const progress = { state: 'downloading', fileName: file.fileName, sha256: file.sha256, completedParts, totalParts: count, bytesDownloaded: completedBytes, totalBytes: file.sizeBytes }; db.prepare('UPDATE agent_tasks SET progress_json = ?, updated_at = ? WHERE task_id = ?').run(JSON.stringify(progress), nowIso(), task.taskId); await update(task.taskId, { status: 'RUNNING', progress }).catch(() => {}); } };
        const taskConcurrency = Math.max(1, Math.min(CONCURRENCY, Number(task.chunkConcurrency ?? CONCURRENCY)));
        const results = await Promise.allSettled(Array.from({ length: Math.min(taskConcurrency, pending.length) }, worker));
        const failedWorker = results.find((result) => result.status === 'rejected'); if (failedWorker) throw failedWorker.reason;
        const temp = `${outputPath}.tmp`; const output = createWriteStream(temp, { flags: 'w', mode: 0o600 }); const fullHash = createHash('sha256'); let total = 0;
        for (let index = 0; index < count; index += 1) { const bytes = await readFile(join(taskDir, 'parts', `${file.sha256}.${index}`)); fullHash.update(bytes); total += bytes.length; if (!output.write(bytes)) await once(output, 'drain'); }
        output.end(); await once(output, 'close'); if (total !== file.sizeBytes || fullHash.digest('hex') !== file.sha256) { for (let index = 0; index < count; index += 1) await rm(join(taskDir, 'parts', `${file.sha256}.${index}`), { force: true }); throw new Error(`文件 ${file.fileName} 完整性校验失败`); } await rename(temp, outputPath); updateTaskFile(task.taskId, file, { status: 'COMPLETED', completedParts: count, totalParts: count, bytesDownloaded: file.sizeBytes, lastError: null });
      }
      const ready = cachePath(task.artifactId); await writeFile(ready, JSON.stringify({ taskId: task.taskId, artifactId: task.artifactId, files: task.files, readyAt: nowIso() }));
      db.prepare('UPDATE agent_tasks SET status = ?, progress_json = ?, updated_at = ?, last_error = NULL WHERE task_id = ?').run('COMPLETED', JSON.stringify({ state: 'ready', completedFiles: task.files.length, totalFiles: task.files.length }), nowIso(), task.taskId); await update(task.taskId, { status: 'COMPLETED', progress: { state: 'ready' } });
    } catch (err) { if (currentFile) updateTaskFile(task.taskId, currentFile, { status: 'FAILED', lastError: String(err.message).slice(0, 1000) }); db.prepare('UPDATE agent_tasks SET status = ?, last_error = ?, updated_at = ? WHERE task_id = ?').run('QUEUED', String(err.message).slice(0, 1000), nowIso(), task.taskId); await update(task.taskId, { status: 'FAILED', error: err.message }).catch(() => {}); }
  }
  const poll = async () => { if (running || configuring || testing) return; running = true; try { await rotation.sync(); const tasks = (await (await core('/api/v1/agent/tasks/pull', { method: 'POST', body: '' })).json()).items ?? []; for (const task of tasks) { localTask(task); if (db.prepare('SELECT status FROM agent_tasks WHERE task_id = ?')?.get?.(task.taskId)?.status !== 'COMPLETED') await downloadTask(task); } } catch (err) { app.log.warn?.({ message: err.message }, 'Agent 任务轮询失败'); } finally { running = false; } };
  app.get('/api/v1/identity', { preHandler: requirePermission('configRead', '需要配置查看权限') }, async () => ({ agentId: rotation.status().agentId ?? null, centerId: rotation.status().policy?.centerId ?? null, agentName: rotation.status().policy?.name ?? null, publicKey: identity.publicKeyPem, fingerprint: identity.fingerprint, registered: Boolean(rotation.status().agentId), rotation: rotation.status() }));
  app.post('/api/v1/tasks/pull', { preHandler: requirePermission('businessWrite', '需要操作员权限') }, async (_request, reply) => { if (running) return reply.code(202).send({ queued: false, running: true }); queueMicrotask(() => { void poll(); }); return reply.code(202).send({ queued: true }); });
  app.get('/api/v1/available-artifacts', { preHandler: requirePermission('businessRead', '需要 Agent 业务查看权限') }, async (_request, reply) => {
    try { const items = await listAvailableArtifacts(); return reply.send({ items, cacheSummary: await cacheSummary(items) }); }
    catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'artifact_list_failed', err.message); }
  });
  app.get('/api/v1/cache/summary', { preHandler: requirePermission('businessRead', '需要 Agent 业务查看权限') }, async (_request, reply) => {
    try { const items = await listAvailableArtifacts(); return reply.send({ item: await cacheSummary(items) }); }
    catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'cache_summary_failed', err.message); }
  });
  app.get('/api/v1/tasks', { preHandler: requirePermission('businessRead', '需要 Agent 业务查看权限') }, async (_request, reply) => {
    try { const rows = db.prepare('SELECT * FROM agent_tasks ORDER BY updated_at DESC').all(); return reply.send({ items: await Promise.all(rows.map(serializeTask)) }); }
    catch (err) { return fail(reply, 500, 'task_list_failed', err.message); }
  });
  app.get('/api/v1/tasks/:taskId', { preHandler: requirePermission('businessRead', '需要 Agent 业务查看权限') }, async (request, reply) => {
    const row = db.prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(request.params.taskId);
    if (!row) return fail(reply, 404, 'task_not_found', '分发任务不存在');
    return reply.send({ item: await serializeTask(row) });
  });
  app.post('/api/v1/tasks/:taskId/retry', { bodyLimit: 4096, preHandler: requirePermission('businessWrite', '需要操作员权限') }, async (request, reply) => {
    if (running) return fail(reply, 409, 'task_busy', 'Agent 正在传输，请稍后再试');
    const row = db.prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(request.params.taskId);
    if (!row) return fail(reply, 404, 'task_not_found', '分发任务不存在');
    if (row.status === 'COMPLETED') return fail(reply, 409, 'task_completed', '已完成的分发任务不能重试');
    try {
      const response = await core(`/api/v1/agent/tasks/${encodeURIComponent(request.params.taskId)}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const result = await response.json(); localTask(result.item ?? result);
      queueMicrotask(() => { void poll(); });
      return reply.send({ item: await serializeTask(db.prepare('SELECT * FROM agent_tasks WHERE task_id = ?').get(request.params.taskId)) });
    } catch (err) { return fail(reply, err.status ?? 409, err.code ?? 'task_retry_failed', err.message); }
  });

  const deliveryPrincipal = (request, grant) => request.principal?.id ? request.principal.id : `TOKEN:${grant.grantId}`;
  const deliveryTokenGrant = (request, grantId) => {
    const token = bearerToken(request); const grant = token ? delivery.getGrantByToken(token) : null;
    if (!grant || grant.grantId !== grantId || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now()) throw Object.assign(new Error('交付授权无效、已过期或已撤销'), { statusCode: 403, code: 'delivery_grant_invalid' });
    return { token, grant };
  };
  const deliveryItem = (grant, sha256) => grant.items.find((item) => item.fileSha256 === sha256) ?? null;
  const deliveryGrantResponse = (grant, token = null) => ({ ...grant, items: grant.items.map((item) => ({ ...item, downloadUrl: token ? `/api/v1/delivery-grants/${encodeURIComponent(grant.grantId)}/files/${encodeURIComponent(item.fileSha256)}/content?token=${encodeURIComponent(token)}` : undefined })) });
  const deliveryArtifactMetadata = async () => {
    try {
      const response = await core('/api/v1/agent/available-artifacts');
      const body = await response.json();
      return new Map((body.items ?? []).map((item) => [item.artifactId, item]));
    } catch {
      // Delivery history must remain readable when Core is temporarily down.
      return new Map();
    }
  };
  const decorateDeliveryGrant = (grant, artifacts) => {
    const artifact = artifacts.get(grant.artifactId);
    const responsibleId = grant.createdBy || grant.principalId || null;
    const user = responsibleId ? auth.getUser(responsibleId) : null;
    return {
      ...grant,
      roundId: grant.roundId ?? artifact?.roundId ?? null,
      roundNo: grant.roundNo ?? (Number.isSafeInteger(artifact?.roundNo) ? artifact.roundNo : null),
      productName: artifact?.productName ?? null,
      displayVersion: artifact?.displayVersion ?? artifact?.version ?? null,
      responsiblePerson: user
        ? { id: user.id, displayName: user.displayName, username: user.username }
        : { id: responsibleId, displayName: null, username: null }
    };
  };
  const deliveryStatus = (err) => err.statusCode ?? (err.code === 'delivery_grant_invalid' ? 403 : 400);

  app.get('/api/v1/delivery-grants', { preHandler: requirePermission('deliveryRead', '需要部署交付查看权限') }, async (request) => {
    const grants = delivery.listGrants(hasAgentPermission(request.principal.user.roles, 'auditRead') ? null : request.principal.id);
    const artifacts = await deliveryArtifactMetadata();
    return { items: grants.map((grant) => decorateDeliveryGrant(grant, artifacts)) };
  });
  app.post('/api/v1/delivery-grants', { bodyLimit: 32 * 1024, preHandler: requirePermission('deliveryWrite', '需要操作员权限') }, async (request, reply) => {
    try {
      const body = request.body ?? {}; const artifactId = body.artifactId;
      const artifact = (await listAvailableArtifacts()).find((item) => item.artifactId === artifactId);
      const grant = delivery.createGrant({ artifactId, artifact, fileSha256s: body.fileSha256s, principalId: request.principal.id, createdBy: request.principal.id, expiresAt: body.expiresAt, maxTotalSessions: body.maxTotalSessions, maxSessionsPerFile: body.maxSessionsPerFile });
      return reply.code(201).send(deliveryGrantResponse(grant, grant.token));
    } catch (err) { return fail(reply, deliveryStatus(err), err.code ?? 'delivery_grant_failed', err.message); }
  });
  app.get('/api/v1/delivery-grants/:grantId', { preHandler: requirePermission('deliveryRead', '需要部署交付查看权限') }, async (request, reply) => {
    try {
      const grant = delivery.getGrant(request.params.grantId);
      if (!grant || (!hasAgentPermission(request.principal.user.roles, 'auditRead') && grant.createdBy !== request.principal.id && grant.principalId !== request.principal.id)) return fail(reply, 404, 'delivery_grant_not_found', '交付授权不存在');
      const artifacts = await deliveryArtifactMetadata();
      return reply.send({ ...decorateDeliveryGrant(grant, artifacts), sessions: delivery.getSessions(grant.grantId) });
    } catch (err) { return fail(reply, deliveryStatus(err), err.code ?? 'delivery_grant_query_failed', err.message); }
  });
  app.get('/api/v1/delivery-grants/:grantId/manifest', async (request, reply) => {
    try {
      const { token, grant } = deliveryTokenGrant(request, request.params.grantId);
      const manifest = deliveryGrantResponse(grant, token);
      return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').send({ grantId: manifest.grantId, artifactId: manifest.artifactId, expiresAt: manifest.expiresAt, remainingTotalSessions: manifest.remainingTotalSessions, items: manifest.items });
    }
    catch (err) { return fail(reply, deliveryStatus(err), err.code ?? 'delivery_manifest_failed', err.message); }
  });
  app.delete('/api/v1/delivery-grants/:grantId', { preHandler: requirePermission('deliveryWrite', '需要操作员权限') }, async (request, reply) => {
    try {
      const grant = delivery.getGrant(request.params.grantId);
      if (!grant || grant.createdBy !== request.principal.id) return fail(reply, 404, 'delivery_grant_not_found', '交付授权不存在');
      return reply.send(delivery.revokeGrant(grant.grantId, request.principal.id));
    } catch (err) { return fail(reply, deliveryStatus(err), err.code ?? 'delivery_grant_revoke_failed', err.message); }
  });
  app.post('/api/v1/delivery-grants/:grantId/files/:sha256/session', async (request, reply) => {
    let release;
    try {
      const { token, grant } = deliveryTokenGrant(request, request.params.grantId); const item = deliveryItem(grant, request.params.sha256);
      if (!item) return fail(reply, 403, 'delivery_file_forbidden', '文件不在交付授权范围内');
      release = delivery.acquireTransfer(grant.grantId, item.fileSha256);
      const session = delivery.beginSession({ token, fileSha256: item.fileSha256, sessionId: request.body?.sessionId ?? null, downloadedBy: deliveryPrincipal(request, grant), sourceAddress: request.ip, userAgent: request.headers['user-agent'] ?? null, autoResume: true });
      release(); return reply.header('Cache-Control', 'no-store').send(session);
    } catch (err) { release?.(); return fail(reply, deliveryStatus(err), err.code ?? 'delivery_session_failed', err.message); }
  });
  app.get('/api/v1/delivery-grants/:grantId/files/:sha256/content', async (request, reply) => {
    let release; let sessionId = request.headers['x-cam-download-session']; let session; let recorded = false;
    try {
      const { token, grant } = deliveryTokenGrant(request, request.params.grantId); const item = deliveryItem(grant, request.params.sha256);
      if (!item) return fail(reply, 403, 'delivery_file_forbidden', '文件不在交付授权范围内');
      const path = join(dataDir, 'cache', item.fileSha256); const file = await stat(path); if (file.size !== item.size) return fail(reply, 409, 'delivery_cache_invalid', 'Agent 本地缓存文件大小不匹配');
      const range = parseRange(request.headers.range, file.size); if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${file.size}`).send();
      const start = range?.start ?? 0; const end = range?.end ?? file.size - 1; const length = end - start + 1;
      reply.code(range ? 206 : 200).header('Accept-Ranges', 'bytes').header('Content-Length', length).header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`).header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').header('X-CAM-SHA256', item.fileSha256);
      if (range) reply.header('Content-Range', `bytes ${start}-${end}/${file.size}`);
      if (request.method === 'HEAD') return reply.send();
      release = delivery.acquireTransfer(grant.grantId, item.fileSha256);
      session = delivery.beginSession({ token, fileSha256: item.fileSha256, sessionId: typeof sessionId === 'string' ? sessionId : null, downloadedBy: deliveryPrincipal(request, grant), sourceAddress: request.ip, userAgent: request.headers['user-agent'] ?? null, autoResume: true, start });
      sessionId = session.sessionId; const prior = delivery.getSession(sessionId); let responseBytes = 0;
      const originalWrite = reply.raw.write;
      reply.raw.write = function (chunk, encoding, callback) { if (typeof encoding === 'function') { callback = encoding; encoding = undefined; } const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding); return originalWrite.call(this, chunk, encoding, (err) => { if (!err && !recorded) responseBytes += size; callback?.(err); }); };
      const progress = (finished = false) => ({ bytesSent: prior.bytes_sent + (finished ? length : responseBytes), coveredBytes: start <= prior.covered_bytes ? Math.max(prior.covered_bytes, start + (finished ? length : responseBytes)) : prior.covered_bytes });
      const timer = setInterval(() => { if (!recorded) delivery.recordSessionProgress(sessionId, { ...progress(), status: 'ACTIVE' }); }, 1000); timer.unref?.();
      const record = (finished, err = null) => { if (recorded) return; recorded = true; clearInterval(timer); reply.raw.write = originalWrite; release?.(); const current = progress(finished); delivery.recordSessionProgress(sessionId, { ...current, responseBytes: finished ? length : responseBytes, status: err?.message ? 'FAILED' : finished && current.coveredBytes >= file.size ? 'COMPLETED' : 'INTERRUPTED', errorMessage: err?.message ?? null, principalId: deliveryPrincipal(request, grant) }); };
      const stream = createReadStream(path, { start, end }); stream.on('error', (err) => record(false, err)); reply.raw.once('finish', () => record(true)); reply.raw.once('close', () => { record(false); stream.destroy(); });
      return reply.header('X-CAM-Download-Session', sessionId).send(stream);
    } catch (err) {
      release?.(); if (session) { const previous = delivery.getSession(sessionId); if (previous) delivery.recordSessionProgress(sessionId, { bytesSent: previous.bytes_sent, coveredBytes: previous.covered_bytes, status: 'FAILED', errorMessage: err.message }); }
      return fail(reply, deliveryStatus(err), err.code ?? 'delivery_failed', err.message);
    }
  });
  app.post('/api/v1/tasks/request', { bodyLimit: 8192, preHandler: requirePermission('businessWrite', '需要系统管理员或操作员权限') }, async (request, reply) => { try { const response = await core('/api/v1/agent/distribution-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactId: request.body?.artifactId }) }); const result = await response.json(); queueMicrotask(() => { void poll(); }); return reply.code(201).send(result); } catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'distribution_request_failed', err.message); } });
  app.get('/api/v1/cache/:artifactId', { preHandler: requirePermission('businessRead', '需要 Agent 业务查看权限') }, async (request, reply) => { if (typeof request.params.artifactId !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(request.params.artifactId)) return reply.code(400).send({ ready: false }); const path = join(dataDir, 'cache', request.params.artifactId); try { const info = await stat(path); return { artifactId: request.params.artifactId, ready: true, size: info.size }; } catch { return reply.code(404).send({ ready: false }); } });
  if (startWorker) { const timer = setInterval(() => { void poll(); }, Number(process.env.CAM_AGENT_POLL_MS ?? 5000)); timer.unref?.(); app.addHook('onClose', async () => clearInterval(timer)); queueMicrotask(() => { void poll(); }); }
  delivery.setLogger(app.log);
  app.decorate('agentAuthStore', auth); app.decorate('aaaConfigStore', aaaConfigStore); app.decorate('agentDeliveryStore', delivery); app.decorate('agentPoll', poll); app.decorate('agentIdentity', { getter: () => identity }); return app;
}

export async function createAgentServer({ port = Number(process.env.PORT ?? 3103), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) { const app = await buildAgentApp(options); await app.listen({ port, host }); return app; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await createAgentServer();
