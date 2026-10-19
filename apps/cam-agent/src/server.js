import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, rename, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { buildServer } from '../../../libs/cam-server/src/server.js';
import { openDatabase } from '../../../libs/cam-sqlite/src/database.js';
import { AuthStore } from '../../cam-core/src/core-auth-store.js';
import { fingerprint, randomNonce, signRequest, verifyResponse } from '../../../libs/cam-agent-auth/src/protocol.js';
import { createIdentityRotation, loadAgentIdentity } from './identity-rotation.js';
import { agentPage } from './web.js';

const DEFAULT_DATA_DIR = process.env.DATA_DIR ?? (process.env.NODE_ENV === 'production' ? '/data/agent' : join(process.cwd(), 'data', 'agent'));
const CORE_URL = (process.env.CAM_CORE_URL ?? 'http://127.0.0.1:3102').replace(/\/$/u, '');
const AGENT_ID = process.env.CAM_AGENT_ID ?? '';
const CHUNK_SIZE = Math.max(64 * 1024, Math.min(64 * 1024 * 1024, Number(process.env.CAM_AGENT_CHUNK_SIZE ?? 4 * 1024 * 1024)));
const CONCURRENCY = Math.max(1, Math.min(16, Number(process.env.CAM_AGENT_CONCURRENCY ?? 4)));

function fail(reply, status, code, message) { return reply.code(status).send({ error: { code, message } }); }
function cookies(request) { return Object.fromEntries((request.headers.cookie ?? '').split(';').filter(Boolean).map((e) => { const i = e.indexOf('='); return [e.slice(0, i).trim(), e.slice(i + 1).trim()]; })); }
function registerAuth(app, auth) {
  const cookie = (name, value, httpOnly, expired = false) => `${name}=${value}; Path=/; SameSite=Strict; Max-Age=${expired ? 0 : 28800}${httpOnly ? '; HttpOnly' : ''}${process.env.CAM_COOKIE_SECURE === 'false' ? '' : '; Secure'}`;
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]; if (!path.startsWith('/api/')) return;
    if (path.startsWith('/api/v1/auth/')) { request.principal = auth.resolve(cookies(request).cam_agent_session); return; }
    request.principal = auth.resolve(cookies(request).cam_agent_session);
    if (!request.principal) return fail(reply, 401, 'login_required', '请先登录');
    if (request.principal.user?.mustChangePassword && !['/api/v1/auth/me', '/api/v1/auth/password', '/api/v1/auth/logout'].includes(path)) return fail(reply, 403, 'password_change_required', '请先修改初始密码');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !auth.csrf(request.principal, request.headers['x-cam-agent-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试');
  });
  app.post('/api/v1/auth/login', { bodyLimit: 4096 }, async (request, reply) => {
    try { const result = await auth.login(request.body?.username, request.body?.password, { address: request.ip, userAgent: request.headers['user-agent'] ?? null }); reply.header('Set-Cookie', [cookie('cam_agent_session', result.token, true), cookie('cam_agent_csrf', result.csrfToken, false)]); return { user: result.user, csrfToken: result.csrfToken }; }
    catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'login_failed', err.message); }
  });
  app.get('/api/v1/auth/me', async (request) => ({ user: request.principal?.user ?? null, csrfToken: cookies(request).cam_agent_csrf }));
  app.post('/api/v1/auth/logout', async (request, reply) => { if (request.principal && !auth.csrf(request.principal, request.headers['x-cam-agent-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试'); if (request.principal) auth.logout(request.principal); reply.header('Set-Cookie', [cookie('cam_agent_session', '', true, true), cookie('cam_agent_csrf', '', false, true)]); return { ok: true }; });
  app.post('/api/v1/auth/password', { bodyLimit: 4096 }, async (request, reply) => { if (request.principal?.type !== 'LOCAL_USER') return fail(reply, 403, 'local_account_required', '本地账号密码由 Agent 管理'); if (!auth.csrf(request.principal, request.headers['x-cam-agent-csrf'])) return fail(reply, 403, 'csrf_invalid', '会话校验失败，请刷新页面后重试'); try { await auth.changePassword(request.principal.id, request.body?.password, request.principal.id, request.body?.oldPassword); reply.header('Set-Cookie', [cookie('cam_agent_session', '', true, true), cookie('cam_agent_csrf', '', false, true)]); return { ok: true, loginRequired: true }; } catch (err) { return fail(reply, err.statusCode ?? 400, err.code ?? 'password_failed', err.message); } });
}

export async function buildAgentApp({ dataDir = DEFAULT_DATA_DIR, coreUrl = CORE_URL, agentId = AGENT_ID, corePublicKey = process.env.CAM_CORE_PUBLIC_KEY ?? (process.env.CAM_CORE_PUBLIC_KEY_B64 ? Buffer.from(process.env.CAM_CORE_PUBLIC_KEY_B64, 'base64').toString('utf8') : ''), corePreviousPublicKey = process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY ?? (process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY_B64 ? Buffer.from(process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY_B64, 'base64').toString('utf8') : ''), corePreviousPublicKeyExpiresAt = process.env.CAM_CORE_PREVIOUS_PUBLIC_KEY_EXPIRES_AT ?? '', fetchImpl = fetch, startWorker = true } = {}) {
  await mkdir(join(dataDir, 'cache'), { recursive: true });
  const identityPath = join(dataDir, 'identity.json');
  let identity = await loadAgentIdentity(identityPath);
  const db = await openDatabase(join(dataDir, 'agent.sqlite'));
  const auth = new AuthStore(db);
  db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (task_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, status TEXT NOT NULL, progress_json TEXT NOT NULL DEFAULT '{}', attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, last_error TEXT, updated_at TEXT NOT NULL);`);
  const taskColumns = new Set(db.prepare('PRAGMA table_info(agent_tasks)').all().map((column) => column.name));
  if (!taskColumns.has('attempts')) db.exec('ALTER TABLE agent_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');
  if (!taskColumns.has('retry_at')) db.exec('ALTER TABLE agent_tasks ADD COLUMN retry_at TEXT');
  const trustedCoreKeys = [corePublicKey, corePreviousPublicKey].filter((value, index, values) => typeof value === 'string' && value.includes('PUBLIC KEY') && values.indexOf(value) === index).map((publicKeyPem) => ({ publicKeyPem, keyId: fingerprint(publicKeyPem) }));
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
  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(agentPage()));  const core = async (path, options = {}, signer = identity) => {
    if (!agentId) throw Object.assign(new Error('Agent 尚未完成 Core 注册'), { code: 'agent_not_registered' });
    const method = options.method ?? 'GET'; const body = options.body ?? ''; const timestamp = new Date().toISOString(); const nonce = randomNonce();
    const headers = { accept: 'application/json', 'x-cam-agent-id': agentId, 'x-cam-agent-timestamp': timestamp, 'x-cam-agent-nonce': nonce, 'x-cam-agent-signature': signRequest(signer.privateKeyPem, method, path.split('?')[0], timestamp, nonce, body), ...(options.headers ?? {}) };
    if (options.proofKey) headers['x-cam-agent-new-key-proof'] = signRequest(options.proofKey.privateKeyPem, method, path.split('?')[0], timestamp, nonce, body);
    // An empty string would make fetch send text/plain; Fastify then parses it as
    // a string, changing the signed payload. Send no body for empty requests.
    const requestOptions = { ...options }; delete requestOptions.proofKey; if (body === '') delete requestOptions.body;
    const response = await fetchImpl(`${coreUrl}${path}`, { signal: AbortSignal.timeout(Number(process.env.CAM_AGENT_REQUEST_TIMEOUT_MS ?? 60_000)), ...requestOptions, headers });
    if (!trustedCoreKeys.length) throw Object.assign(new Error('Core 公钥未配置，拒绝处理 Core 响应'), { code: 'core_public_key_missing', status: 503 });
    const responseTimestamp = response.headers.get('x-cam-core-timestamp');
    const responseSignature = response.headers.get('x-cam-core-signature');
    const responseKeyId = response.headers.get('x-cam-core-key-id');
    const responseBody = Buffer.from(await response.clone().arrayBuffer());
    const key = trustedCoreKeys.find((item) => item.keyId === responseKeyId && (item.publicKeyPem !== corePreviousPublicKey || (Date.parse(corePreviousPublicKeyExpiresAt) > Date.now())));
    const validTimestamp = typeof responseTimestamp === 'string' && Number.isFinite(Date.parse(responseTimestamp)) && Math.abs(Date.now() - Date.parse(responseTimestamp)) <= 5 * 60_000;
    if (!key || !validTimestamp || !verifyResponse(key.publicKeyPem, responseSignature, response.status, method, path.split('?')[0], nonce, responseTimestamp, responseBody)) throw Object.assign(new Error('Core 响应签名校验失败'), { code: 'core_response_signature_invalid', status: 502 });
    if (!response.ok) { const body = JSON.parse(responseBody.toString('utf8') || '{}'); throw Object.assign(new Error(body.error?.message ?? `Core 请求失败（HTTP ${response.status}）`), { code: body.error?.code ?? 'core_request_failed', status: response.status }); } return response;
  };
  const rotation = await createIdentityRotation({ identityPath, identity, request: core, onIdentity: (next) => { identity = next; } });
  app.post('/api/v1/identity/test', { bodyLimit: 4096 }, async (_request, reply) => {
    try {
      await rotation.sync({ ignoreBackoff: true });
      return { ok: true, agentId, fingerprint: identity.fingerprint, rotation: rotation.status() };
    } catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'agent_pairing_failed', err.message); }
  });
  app.post('/api/v1/identity/rotate', { bodyLimit: 4096 }, async (_request, reply) => {
    try {
      await rotation.sync({ force: true });
      return { ok: true, fingerprint: identity.fingerprint, rotation: rotation.status() };
    } catch (err) { return fail(reply, err.status ?? 502, err.code ?? 'agent_rotation_failed', err.message); }
  });
  const localTask = (task) => { db.prepare(`INSERT INTO agent_tasks (task_id, artifact_id, status, progress_json, attempts, retry_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET artifact_id=excluded.artifact_id, status=excluded.status, attempts=excluded.attempts, retry_at=excluded.retry_at, updated_at=excluded.updated_at`).run(task.taskId, task.artifactId, task.status, JSON.stringify(task.progress ?? {}), task.attempts ?? 0, task.retryAt ?? null, new Date().toISOString()); };
  const update = async (taskId, body) => { const response = await core(`/api/v1/agent/tasks/${encodeURIComponent(taskId)}/progress`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return response.json(); };
  async function downloadTask(task) {
    localTask({ ...task, status: 'RUNNING' }); await update(task.taskId, { status: 'RUNNING', progress: { state: 'starting' } }).catch(() => {});
    const taskDir = join(dataDir, 'cache', task.taskId); await mkdir(join(taskDir, 'parts'), { recursive: true });
    try {
      for (const file of task.files) {
        const outputPath = join(dataDir, 'cache', file.sha256);
        try { const cached = await stat(outputPath); if (cached.size === file.sizeBytes && createHash('sha256').update(await readFile(outputPath)).digest('hex') === file.sha256) continue; } catch { /* cache miss */ }
        const count = Math.ceil(file.sizeBytes / CHUNK_SIZE); const pending = [];
        for (let index = 0; index < count; index += 1) { const partPath = join(taskDir, 'parts', `${file.sha256}.${index}`); try { const saved = await stat(partPath); const expected = Math.min(CHUNK_SIZE, file.sizeBytes - index * CHUNK_SIZE); if (saved.size === expected) continue; } catch { /* missing chunk */ } pending.push(index); }
        let cursor = 0; let completedParts = count - pending.length;
        const worker = async () => { while (cursor < pending.length) { const index = pending[cursor++]; const start = index * CHUNK_SIZE; const end = Math.min(file.sizeBytes - 1, start + CHUNK_SIZE - 1); const response = await core(`/api/v1/agent/tasks/${encodeURIComponent(task.taskId)}/files/${file.sha256}/parts/${index}`, { headers: { 'x-cam-chunk-size': String(CHUNK_SIZE) } }); const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length !== end - start + 1) throw new Error(`分块 ${index} 大小不正确`); const partPath = join(taskDir, 'parts', `${file.sha256}.${index}`); await new Promise((resolve, reject) => { const output = createWriteStream(partPath, { flags: 'w', mode: 0o600 }); output.on('error', reject); output.end(bytes, resolve); }); completedParts += 1; const progress = { state: 'downloading', fileName: file.fileName, sha256: file.sha256, completedParts, totalParts: count }; db.prepare('UPDATE agent_tasks SET progress_json = ?, updated_at = ? WHERE task_id = ?').run(JSON.stringify(progress), new Date().toISOString(), task.taskId); await update(task.taskId, { status: 'RUNNING', progress }).catch(() => {}); } };
        const results = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
        const failedWorker = results.find((result) => result.status === 'rejected'); if (failedWorker) throw failedWorker.reason;
        const temp = `${outputPath}.tmp`; const output = createWriteStream(temp, { flags: 'w', mode: 0o600 }); const fullHash = createHash('sha256'); let total = 0;
        for (let index = 0; index < count; index += 1) { const bytes = await readFile(join(taskDir, 'parts', `${file.sha256}.${index}`)); fullHash.update(bytes); total += bytes.length; if (!output.write(bytes)) await once(output, 'drain'); }
        output.end(); await once(output, 'close'); if (total !== file.sizeBytes || fullHash.digest('hex') !== file.sha256) { for (let index = 0; index < count; index += 1) await rm(join(taskDir, 'parts', `${file.sha256}.${index}`), { force: true }); throw new Error(`文件 ${file.fileName} 完整性校验失败`); } await rename(temp, outputPath);
      }
      const ready = join(dataDir, 'cache', task.artifactId); await writeFile(ready, JSON.stringify({ taskId: task.taskId, artifactId: task.artifactId, files: task.files, readyAt: new Date().toISOString() }));
      db.prepare('UPDATE agent_tasks SET status = ?, progress_json = ?, updated_at = ?, last_error = NULL WHERE task_id = ?').run('COMPLETED', JSON.stringify({ state: 'ready' }), new Date().toISOString(), task.taskId); await update(task.taskId, { status: 'COMPLETED', progress: { state: 'ready' } });
    } catch (err) { db.prepare('UPDATE agent_tasks SET status = ?, last_error = ?, updated_at = ? WHERE task_id = ?').run('QUEUED', String(err.message).slice(0, 1000), new Date().toISOString(), task.taskId); await update(task.taskId, { status: 'FAILED', error: err.message }).catch(() => {}); }
  }
  let running = false;
  const poll = async () => { if (running || !agentId) return; running = true; try { await rotation.sync(); const tasks = (await (await core('/api/v1/agent/tasks/pull', { method: 'POST', body: '' })).json()).items ?? []; for (const task of tasks) if (db.prepare('SELECT status FROM agent_tasks WHERE task_id = ?')?.get?.(task.taskId)?.status !== 'COMPLETED') await downloadTask(task); } catch (err) { app.log.warn?.({ message: err.message }, 'Agent 任务轮询失败'); } finally { running = false; } };
  app.get('/api/v1/identity', async () => ({ agentId: agentId || null, publicKey: identity.publicKeyPem, fingerprint: identity.fingerprint, registered: Boolean(agentId), rotation: rotation.status() }));
  app.get('/api/v1/tasks', async () => ({ items: db.prepare('SELECT * FROM agent_tasks ORDER BY updated_at DESC').all().map((row) => ({ taskId: row.task_id, artifactId: row.artifact_id, status: row.status, progress: JSON.parse(row.progress_json), attempts: row.attempts, retryAt: row.retry_at, lastError: row.last_error, updatedAt: row.updated_at })) }));
  app.get('/api/v1/cache/:artifactId', async (request, reply) => { if (typeof request.params.artifactId !== 'string' || !/^[A-Za-z0-9._-]{1,255}$/.test(request.params.artifactId)) return reply.code(400).send({ ready: false }); const path = join(dataDir, 'cache', request.params.artifactId); try { const info = await stat(path); return { artifactId: request.params.artifactId, ready: true, size: info.size }; } catch { return reply.code(404).send({ ready: false }); } });
  if (startWorker) { const timer = setInterval(() => { void poll(); }, Number(process.env.CAM_AGENT_POLL_MS ?? 5000)); timer.unref?.(); app.addHook('onClose', async () => clearInterval(timer)); queueMicrotask(() => { void poll(); }); }
  app.decorate('agentAuthStore', auth); app.decorate('agentPoll', poll); app.decorate('agentIdentity', { getter: () => identity }); return app;
}

export async function createAgentServer({ port = Number(process.env.PORT ?? 3103), host = process.env.HOST ?? '127.0.0.1', ...options } = {}) { const app = await buildAgentApp(options); await app.listen({ port, host }); return app; }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await createAgentServer();
