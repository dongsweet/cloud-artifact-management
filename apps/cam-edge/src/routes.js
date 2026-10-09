import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { assembleChunks } from '../../../libs/cam-transfer/src/transfer.js';
import { previewCandidateWorkbook } from './candidate-import.js';

function error(reply, statusCode, code, message) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function principal(request) {
  if (request.principal && typeof request.principal.id === 'string') {
    return { principalId: request.principal.id, principalType: request.principal.type ?? 'AUTHENTICATED' };
  }
  throw Object.assign(new Error('authenticated principal is required'), { code: 'principal_required' });
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  if (typeof authorization === 'string' && /^Bearer\s+\S+$/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '');
  const queryToken = request.query?.token;
  return typeof queryToken === 'string' ? queryToken : null;
}

function downloadActor(request, grant) {
  try {
    return principal(request);
  } catch (err) {
    if (err.code === 'principal_required' && grant) return { principalId: `TOKEN:${grant.grantId}`, principalType: 'DOWNLOAD_TOKEN' };
    throw err;
  }
}

function parseRange(value, size) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  let end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return 'invalid';
  end = Math.min(end, size - 1);
  return { start, end };
}

async function md5File(path) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeRequestPart(request, destination, expectedSize) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: 'w' });
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of request.raw) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > expectedSize) throw new Error('request body is larger than expected part');
      hash.update(buffer);
      if (!output.write(buffer)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');
    if (bytes !== expectedSize) throw new Error(`request body size ${bytes} does not match expected ${expectedSize}`);
    const digest = hash.digest('hex');
    const declared = request.headers['x-chunk-sha256'];
    if (declared && declared !== digest) throw new Error('x-chunk-sha256 does not match request body');
    return { size: bytes, sha256: digest, temporary };
  } catch (err) {
    output.destroy();
    await rm(temporary, { force: true });
    throw err;
  }
}

function candidateResponse(candidate) {
  return {
    candidateId: candidate.candidate_id,
    productId: candidate.product_id,
    productName: candidate.product_name,
    releaseId: candidate.release_id,
    releaseVersion: candidate.release_version,
    packageKey: candidate.package_key,
    type: candidate.metadata?.type ?? null,
    mappingSource: candidate.mapping_source,
    inheritedFromRoundId: candidate.inherited_from_round_id,
    sourceUrl: candidate.source_url,
    fileName: candidate.file_name,
    version: candidate.version,
    architecture: candidate.architecture,
    targets: candidate.targets,
    size: candidate.expected_size,
    sha256: candidate.expected_sha256,
    md5: candidate.expected_md5,
    expectedMd5: candidate.expected_md5,
    expectedSha256: candidate.expected_sha256,
    finalMd5: candidate.final_md5,
    finalSha256: candidate.final_sha256,
    sourceTag: candidate.source_tag,
    chunkSize: candidate.chunk_size,
    chunkCount: candidate.chunk_count,
    status: candidate.status,
    completedParts: candidate.completedParts,
    missingParts: candidate.missingParts,
    createdAt: candidate.created_at,
    updatedAt: candidate.updated_at,
    completedAt: candidate.completed_at,
    error: candidate.error_message,
    metadata: candidate.metadata ?? {}
  };
}

export async function finalizeCandidate(store, candidateId) {
  const candidate = store.get(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (candidate.status === 'COMPLETED') return candidate;
  const missing = store.missingParts(candidate.candidate_id);
  if (missing.length > 0) throw new Error(`candidate has missing parts: ${missing.join(',')}`);
  store.markAssembling(candidateId);
  const manifest = { size: candidate.expected_size, sha256: candidate.expected_sha256 ?? '', transfer: { chunks: store.listParts(candidate.candidate_id).map((part) => ({ index: part.part_index, offset: part.offset, size: part.size, sha256: part.sha256 })) } };
  const assembled = await assembleChunks({ taskDir: store.candidateDir(candidate.candidate_id), manifest, outputPath: candidate.source_path });
  return store.complete(candidate.candidate_id, { finalSha256: assembled.sha256, finalMd5: candidate.expected_md5 ? await md5File(assembled.path) : null });
}

export function registerCandidateRoutes(app, { store, receiver, scheduler, downloadGrants, auth }) {
  const usableRecipient = (grant) => {
    if (grant?.principalType !== 'LOCAL_USER') return true;
    const user = auth.getUser(grant.principalId);
    return user?.status === 'ACTIVE' && !user.mustChangePassword && user.roles.includes('VALIDATOR');
  };
  app.get('/api/v1/download-grants', async (request) => {
    const audit = request.principal.roles?.includes('EDGE_AUDITOR');
    const rows = downloadGrants.db.prepare(audit ? 'SELECT grant_id FROM download_grants ORDER BY created_at DESC LIMIT 200' : 'SELECT grant_id FROM download_grants WHERE created_by = ? OR principal_id = ? ORDER BY created_at DESC LIMIT 200');
    return { items: (audit ? rows.all() : rows.all(request.principal.id, request.principal.id)).map((r) => downloadGrants.getGrant(r.grant_id)) };
  });
  app.post('/api/v1/download-grants', async (request, reply) => {
    if (!downloadGrants) return error(reply, 503, 'download_grants_unavailable', 'download grants are not configured');
    try {
      const actor = principal(request);
      const body = request.body ?? {};
      const recipient = request.principal.type === 'LOCAL_USER' ? auth.getUser(body.recipientId ?? actor.principalId) : null;
      if (request.principal.type === 'LOCAL_USER' && (!recipient || recipient.status !== 'ACTIVE' || recipient.mustChangePassword || !recipient.roles.includes('VALIDATOR'))) throw new Error('下载责任人须为已激活并完成初始密码修改的验证人员');
      const grant = downloadGrants.createGrant({
        candidateIds: body.candidateIds,
        principalId: recipient?.id ?? actor.principalId,
        principalType: recipient ? 'LOCAL_USER' : actor.principalType,
        createdBy: actor.principalId,
        expiresAt: body.expiresAt,
        maxTotalSessions: body.maxTotalSessions,
        maxSessionsPerFile: body.maxSessionsPerFile
      });
      return reply.code(201).send({
        ...grant,
        items: grant.items.map((item) => ({ ...item, downloadUrl: `/api/v1/downloads/${encodeURIComponent(item.candidateId)}/content?token=${encodeURIComponent(grant.token)}` }))
      });
    } catch (err) {
      const status = err.code === 'principal_required' ? 401 : 400;
      return error(reply, status, err.code ?? 'download_grant_failed', err.message);
    }
  });

  app.get('/api/v1/download-grants/:grantId', async (request, reply) => {
    try {
      const actor = principal(request);
      const grant = downloadGrants.getGrant(request.params.grantId);
      if (!grant || (grant.createdBy !== actor.principalId && grant.principalId !== actor.principalId && !request.principal.roles?.includes('EDGE_AUDITOR'))) return error(reply, 404, 'download_grant_not_found', 'download grant not found');
      return reply.send({ ...grant, sessions: downloadGrants.db.prepare('SELECT session_id, candidate_id, status, bytes_sent, covered_bytes, source_address, started_at, updated_at FROM download_sessions WHERE grant_id = ? ORDER BY rowid DESC LIMIT 200').all(grant.grantId), events: downloadGrants.db.prepare('SELECT * FROM download_events WHERE grant_id = ? ORDER BY created_at DESC LIMIT 200').all(grant.grantId) });
    } catch (err) {
      return error(reply, err.code === 'principal_required' ? 401 : 400, err.code ?? 'download_grant_query_failed', err.message);
    }
  });

  app.get('/api/v1/download-grants/:grantId/manifest', async (request, reply) => {
    try {
      const token = bearerToken(request);
      const grant = token ? downloadGrants.getGrantByToken(token) : null;
      if (!grant || !usableRecipient(grant) || grant.grantId !== request.params.grantId || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now()) return error(reply, 401, 'download_grant_invalid', 'download grant is invalid, expired or revoked');
      return reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer').send({
        grantId: grant.grantId,
        expiresAt: grant.expiresAt,
        remainingTotalSessions: grant.remainingTotalSessions,
        items: grant.items.map((item) => ({ ...item, downloadUrl: `/api/v1/downloads/${encodeURIComponent(item.candidateId)}/content?token=${encodeURIComponent(token)}` }))
      });
    } catch (err) {
      return error(reply, 400, err.code ?? 'download_manifest_failed', err.message);
    }
  });

  app.delete('/api/v1/download-grants/:grantId', async (request, reply) => {
    try {
      const actor = principal(request);
      const grant = downloadGrants.getGrant(request.params.grantId);
      if (!grant || grant.createdBy !== actor.principalId) return error(reply, 404, 'download_grant_not_found', 'download grant not found');
      return reply.send(downloadGrants.revokeGrant(grant.grantId, actor.principalId));
    } catch (err) {
      return error(reply, err.code === 'principal_required' ? 401 : 400, err.code ?? 'download_grant_revoke_failed', err.message);
    }
  });

  app.post('/api/v1/downloads/:candidateId/session', async (request, reply) => {
    let releaseTransfer;
    try {
      const token = bearerToken(request);
      if (!token) return error(reply, 401, 'download_token_required', 'Bearer download token is required');
      const grant = downloadGrants.getGrantByToken(token);
      if (!usableRecipient(grant)) return error(reply, 403, 'recipient_disabled', '下载责任人账号已停用或权限失效');
      const actor = downloadActor(request, grant);
      if (!grant) return error(reply, 403, 'download_grant_invalid', 'download grant is invalid');
      releaseTransfer = downloadGrants.acquireTransfer(grant.grantId, request.params.candidateId);
      const session = downloadGrants.beginSession({ token, candidateId: request.params.candidateId, sessionId: request.body?.sessionId ?? null, downloadedBy: actor.principalId, sourceAddress: request.ip, userAgent: request.headers['user-agent'] ?? null, autoResume: true });
      releaseTransfer();
      return reply.header('Cache-Control', 'no-store').send(session);
    } catch (err) {
      releaseTransfer?.();
      const status = err.statusCode ?? (err.code === 'principal_required' ? 401 : /invalid, expired|outside|limit reached|already completed/.test(err.message) ? 403 : 400);
      return error(reply, status, err.code ?? 'download_session_failed', err.message);
    }
  });

  app.get('/api/v1/downloads/:candidateId/content', async (request, reply) => {
    let sessionId = request.headers['x-cam-download-session'];
    let session;
    let releaseTransfer;
    try {
      const token = bearerToken(request);
      if (!token) return error(reply, 401, 'download_token_required', 'Bearer download token is required');
      const grant = downloadGrants.getGrantByToken(token);
      if (!usableRecipient(grant)) return error(reply, 403, 'recipient_disabled', '下载责任人账号已停用或权限失效');
      const actor = downloadActor(request, grant);
      const candidate = store.get(request.params.candidateId);
      if (!grant || grant.revokedAt || Date.parse(grant.expiresAt) <= Date.now() || !grant.items.some((i) => i.candidateId === request.params.candidateId)) return error(reply, 403, 'download_grant_invalid', 'download grant is invalid, expired or revoked, or candidate is outside scope');
      if (!candidate || candidate.status !== 'COMPLETED') return error(reply, 404, 'candidate_file_not_found', 'completed candidate file not found');
      const file = await stat(candidate.source_path);
      const range = parseRange(request.headers.range, file.size);
      if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${file.size}`).send();
      const start = range?.start ?? 0;
      const end = range?.end ?? file.size - 1;
      const length = end - start + 1;
      reply.code(range ? 206 : 200)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', length)
        .header('Content-Type', 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(candidate.file_name)}`)
        .header('Cache-Control', 'no-store')
        .header('Referrer-Policy', 'no-referrer')
        .header('X-CAM-SHA256', candidate.final_sha256 ?? '')
        .header('X-CAM-MD5', candidate.final_md5 ?? '');
      if (range) reply.header('Content-Range', `bytes ${start}-${end}/${file.size}`);
      // Download managers probe with HEAD before opening their actual data connection.
      if (request.method === 'HEAD') return reply.send();
      releaseTransfer = downloadGrants.acquireTransfer(grant.grantId, candidate.candidate_id);
      session = downloadGrants.beginSession({ token, candidateId: candidate.candidate_id, sessionId: typeof sessionId === 'string' ? sessionId : null, downloadedBy: actor.principalId, sourceAddress: request.ip, userAgent: request.headers['user-agent'] ?? null, autoResume: true, start });
      sessionId = session.sessionId;
      const stream = createReadStream(candidate.source_path, { start, end });
      const prior = downloadGrants.db.prepare('SELECT bytes_sent, covered_bytes FROM download_sessions WHERE session_id = ?').get(sessionId);
      let recorded = false;
      let responseBytes = 0;
      const originalWrite = reply.raw.write;
      // Count successfully flushed HTTP body writes, including those before an interrupted response.
      reply.raw.write = function (chunk, encoding, callback) {
        if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
        const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
        return originalWrite.call(this, chunk, encoding, (err) => {
          if (!err && !recorded) responseBytes += size;
          callback?.(err);
        });
      };
      const progress = (finished = false) => ({
        bytesSent: prior.bytes_sent + (finished ? length : responseBytes),
        coveredBytes: start <= prior.covered_bytes ? Math.max(prior.covered_bytes, start + (finished ? length : responseBytes)) : prior.covered_bytes
      });
      const timer = setInterval(() => {
        if (!recorded) downloadGrants.recordSessionProgress(sessionId, { ...progress(), status: 'ACTIVE' });
      }, 1000);
      timer.unref();
      const record = (finished, err = null) => {
        if (recorded) return;
        recorded = true;
        clearInterval(timer);
        reply.raw.write = originalWrite;
        releaseTransfer();
        const current = progress(finished);
        downloadGrants.recordSessionProgress(sessionId, { ...current, responseBytes: finished ? length : responseBytes, status: err ? 'FAILED' : finished && current.coveredBytes >= file.size ? 'COMPLETED' : 'INTERRUPTED', errorMessage: err?.message ?? null, principalId: actor.principalId });
      };
      stream.on('error', (err) => record(false, err));
      reply.raw.once('finish', () => record(true));
      reply.raw.once('close', () => { record(false); stream.destroy(); });
      return reply.header('X-CAM-Download-Session', sessionId).send(stream);
    } catch (err) {
      releaseTransfer?.();
      reply.removeHeader('Content-Length').removeHeader('Content-Range').removeHeader('Content-Disposition').type('application/json');
      if (session) {
        const previous = downloadGrants.db.prepare('SELECT bytes_sent, covered_bytes FROM download_sessions WHERE session_id = ?').get(sessionId);
        downloadGrants.recordSessionProgress(sessionId, { bytesSent: previous.bytes_sent, coveredBytes: previous.covered_bytes, status: 'FAILED', errorMessage: err.message });
      }
      const status = err.statusCode ?? (err.code === 'principal_required' ? 401 : /invalid, expired|outside|limit reached|already completed/.test(err.message) ? 403 : 404);
      return error(reply, status, err.code ?? 'download_failed', err.message);
    }
  });

  app.post('/api/v1/products', async (request, reply) => {
    try { return reply.code(201).send(store.createProduct(request.body ?? {})); }
    catch (err) { return error(reply, 400, 'invalid_product', err.message); }
  });

  app.get('/api/v1/products', async (_request, reply) => reply.send({ items: store.listProducts() }));

  app.delete('/api/v1/products/:productId', async (request, reply) => {
    if (!store.getProduct(request.params.productId)) return error(reply, 404, 'product_not_found', 'product not found');
    try {
      store.deleteProduct(request.params.productId);
      return reply.code(204).send();
    } catch (err) {
      if (err.code === 'product_not_empty') return error(reply, 409, err.code, err.message);
      return error(reply, 400, 'invalid_product_delete', err.message);
    }
  });

  app.post('/api/v1/products/:productId/releases', async (request, reply) => {
    try { return reply.code(201).send(store.createRelease(request.params.productId, request.body ?? {})); }
    catch (err) { return error(reply, 400, 'invalid_release', err.message); }
  });

  app.get('/api/v1/releases', async (request, reply) => {
    try { return reply.send({ items: store.listReleases(request.query?.productId ?? null) }); }
    catch (err) { return error(reply, 400, 'invalid_release_query', err.message); }
  });

  app.get('/api/v1/releases/:releaseId', async (request, reply) => {
    const release = store.getRelease(request.params.releaseId);
    return release ? reply.send(release) : error(reply, 404, 'release_not_found', 'release not found');
  });

  app.delete('/api/v1/releases/:releaseId', async (request, reply) => {
    if (!store.getRelease(request.params.releaseId)) return error(reply, 404, 'release_not_found', 'release not found');
    try {
      store.deleteRelease(request.params.releaseId);
      return reply.code(204).send();
    } catch (err) {
      if (err.code === 'release_not_open' || err.code === 'release_not_empty') return error(reply, 409, err.code, err.message);
      return error(reply, 400, 'invalid_release_delete', err.message);
    }
  });

  app.post('/api/v1/releases/:releaseId/rounds', async (request, reply) => {
    try { return reply.code(201).send(store.createRound(request.params.releaseId, request.body ?? {})); }
    catch (err) { return error(reply, 400, 'invalid_round', err.message); }
  });

  app.get('/api/v1/releases/:releaseId/rounds', async (request, reply) => {
    try { return reply.send({ items: store.listRounds(request.params.releaseId) }); }
    catch (err) { return error(reply, 400, 'invalid_round_query', err.message); }
  });

  app.get('/api/v1/rounds/:roundId', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    return round ? reply.send(round) : error(reply, 404, 'round_not_found', 'round not found');
  });

  app.get('/api/v1/rounds/:roundId/candidates', async (request, reply) => {
    try { return reply.send({ items: store.listRoundCandidates(request.params.roundId).map(candidateResponse) }); }
    catch (err) { return error(reply, 400, 'invalid_round_candidates', err.message); }
  });

  app.post('/api/v1/rounds/:roundId/candidates', async (request, reply) => {
    try {
      const candidate = await store.create({ ...(request.body ?? {}), roundId: request.params.roundId });
      return reply.code(201).send(candidateResponse(candidate));
    } catch (err) { return error(reply, 400, 'invalid_candidate', err.message); }
  });

  app.delete('/api/v1/rounds/:roundId/candidates/:candidateId', async (request, reply) => {
    try {
      const removed = store.detachCandidateFromRound(request.params.roundId, request.params.candidateId);
      if (!removed) return error(reply, 404, 'round_candidate_not_found', 'candidate is not attached to this round');
      return reply.code(204).send();
    } catch (err) { return error(reply, 400, 'invalid_round_candidate_delete', err.message); }
  });

  app.post('/api/v1/rounds/:roundId/import-preview', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    try {
      const preview = await previewCandidateWorkbook(request.body, {
        sheetName: request.query?.sheet ?? null,
        mapping: request.query?.mapping ? JSON.parse(request.query.mapping) : {},
        store,
        roundId: request.params.roundId
      });
      return reply.send({ roundId: request.params.roundId, ...preview });
    } catch (err) {
      return error(reply, 400, 'invalid_import_workbook', err.message);
    }
  });

  app.post('/api/v1/rounds/:roundId/import', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    const items = Array.isArray(request.body?.items) ? request.body.items : [];
    if (items.length === 0 || items.length > 1000) return error(reply, 400, 'invalid_import_items', '导入项目数量必须为 1 到 1000');
    const existing = new Set(store.listRoundCandidates(request.params.roundId).map((candidate) => candidate.package_key.toLowerCase()));
    const results = [];
    const errors = [];
    for (const [index, item] of items.entries()) {
      try {
        const packageKey = String(item.packageKey ?? '').trim();
        if (!packageKey) throw new Error('包标识不能为空');
        if (existing.has(packageKey.toLowerCase())) throw new Error(`包标识已存在：${packageKey}`);
        const candidate = await store.create({ ...item, roundId: request.params.roundId });
        existing.add(packageKey.toLowerCase());
        results.push(candidateResponse(candidate));
      } catch (err) {
        errors.push({ index, rowNumber: Number(item.importRowNumber) || index + 1, message: err.message });
      }
    }
    if (results.length === 0) return error(reply, 400, 'import_failed', errors.map((item) => `第 ${item.index + 1} 行：${item.message}`).join('；'));
    return reply.code(201).send({ roundId: request.params.roundId, imported: results.length, skipped: errors.length, items: results, errors });
  });

  app.post('/api/v1/candidates', async (request, reply) => {
    try {
      const candidate = await store.create(request.body ?? {});
      return reply.code(201).send(candidateResponse(candidate));
    } catch (err) {
      return error(reply, 400, 'invalid_candidate', err.message);
    }
  });

  app.get('/api/v1/candidates', async (request, reply) => {
    try {
      const limit = request.query?.limit === undefined ? 50 : Number(request.query.limit);
      const offset = request.query?.offset === undefined ? 0 : Number(request.query.offset);
      const releaseId = request.query?.releaseId ?? null;
      return reply.send({ items: store.list({ limit, offset, releaseId, status: request.query?.status ?? null }).map(candidateResponse), limit, offset });
    } catch (err) {
      return error(reply, 400, 'invalid_query', err.message);
    }
  });

  app.get('/api/v1/receive-queue', async (_request, reply) => reply.send({ concurrency: scheduler.concurrency, items: scheduler.list() }));

  app.post('/api/v1/rounds/:roundId/receive-batch', async (request, reply) => {
    try {
      const roundIds = store.roundCandidateIds(request.params.roundId);
      const requested = request.body?.candidateIds;
      if (requested !== undefined && (!Array.isArray(requested) || requested.some((id) => typeof id !== 'string'))) {
        return error(reply, 400, 'invalid_candidate_ids', 'candidateIds must be an array of candidate IDs');
      }
      const candidateIds = requested ?? roundIds;
      if (candidateIds.some((id) => !roundIds.includes(id))) return error(reply, 400, 'candidate_not_in_round', 'all selected candidates must belong to the specified round');
      const result = scheduler.enqueue(candidateIds);
      return reply.code(202).send({ roundId: request.params.roundId, enqueued: result.enqueued, alreadyActive: result.alreadyActive, completed: result.completed, concurrency: scheduler.concurrency, items: scheduler.list() });
    } catch (err) {
      return error(reply, 400, 'receive_batch_failed', err.message);
    }
  });

  app.get('/api/v1/candidates/:candidateId', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    return candidate ? reply.send(candidateResponse(candidate)) : error(reply, 404, 'candidate_not_found', 'candidate not found');
  });

  app.patch('/api/v1/candidates/:candidateId', async (request, reply) => {
    try { return reply.send(candidateResponse(store.updateCandidate(request.params.candidateId, request.body ?? {}))); }
    catch (err) { return error(reply, err.code === 'candidate_not_editable' || err.code === 'candidate_has_parts' ? 409 : 400, err.code ?? 'invalid_candidate', err.message); }
  });

  app.delete('/api/v1/candidates/:candidateId', async (request, reply) => {
    try {
      if (downloadGrants.db.prepare('SELECT 1 FROM download_grant_items WHERE candidate_id = ? LIMIT 1').get(request.params.candidateId)) return error(reply, 409, 'candidate_in_download_audit', '该候选包已关联下载授权和审计记录，暂不能永久删除；可以移出候选轮次');
      const deleted = store.deleteCandidate(request.params.candidateId);
      if (!deleted) return error(reply, 404, 'candidate_not_found', 'candidate not found');
      await rm(deleted.dataDir, { recursive: true, force: true });
      return reply.code(204).send();
    } catch (err) { return error(reply, err.code === 'candidate_busy' ? 409 : 400, err.code ?? 'candidate_delete_failed', err.message); }
  });

  app.get('/api/v1/candidates/:candidateId/parts', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    const transfer = receiver.progress.get(candidate.candidate_id) ?? null;
    return reply.send({ candidateId: candidate.candidate_id, status: candidate.status, chunkCount: candidate.chunk_count, completedParts: store.listParts(candidate.candidate_id), missingParts: store.missingParts(candidate.candidate_id), transfer });
  });

  app.put('/api/v1/candidates/:candidateId/parts/:partIndex', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return error(reply, 409, 'candidate_completed', 'candidate is already completed');
    const partIndex = Number(request.params.partIndex);
    const expected = store.getPart(candidate.candidate_id, partIndex);
    const range = (() => {
      try {
        return { offset: partIndex * candidate.chunk_size, size: Math.min(candidate.chunk_size, candidate.expected_size - partIndex * candidate.chunk_size) };
      } catch {
        return null;
      }
    })();
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= candidate.chunk_count || !range || range.size < 0) return error(reply, 400, 'invalid_part', 'part index is out of range');
    if (expected && expected.status === 'COMPLETED') {
      if (request.headers['x-chunk-sha256'] === expected.sha256) return reply.send({ candidateId: candidate.candidate_id, partIndex, status: 'COMPLETED', idempotent: true });
      return error(reply, 409, 'part_conflict', 'part already exists; provide the same x-chunk-sha256 to retry');
    }
    let temporary = null;
    try {
      const destination = store.partPath(candidate.candidate_id, partIndex);
      const result = await writeRequestPart(request, destination, range.size);
      temporary = result.temporary;
      const current = store.getPart(candidate.candidate_id, partIndex);
      if (current && current.status === 'COMPLETED') {
        await rm(result.temporary, { force: true });
        if (current.size === result.size && current.sha256 === result.sha256) return reply.send({ candidateId: candidate.candidate_id, partIndex, status: 'COMPLETED', idempotent: true });
        return error(reply, 409, 'part_conflict', 'part already exists with different content');
      }
      await rename(result.temporary, destination);
      store.recordPart({ candidateId: candidate.candidate_id, partIndex, size: result.size, sha256: result.sha256 });
      const updated = store.get(candidate.candidate_id);
      return reply.send({ candidateId: candidate.candidate_id, partIndex, status: 'COMPLETED', sha256: result.sha256, completedParts: updated.completedParts, missingParts: updated.missingParts });
    } catch (err) {
      if (temporary) await rm(temporary, { force: true });
      return error(reply, 400, 'invalid_part', err.message);
    }
  });

  app.post('/api/v1/candidates/:candidateId/receive', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return reply.send(candidateResponse(candidate));
    try {
      const job = scheduler.resume(candidate.candidate_id);
      return reply.code(202).send({ candidateId: candidate.candidate_id, status: job?.status ?? candidate.status, queue: job });
    } catch (err) { return error(reply, 400, 'receive_enqueue_failed', err.message); }
  });

  app.post('/api/v1/candidates/:candidateId/cancel-receive', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return error(reply, 409, 'candidate_completed', 'candidate is already completed');
    const job = scheduler.pause(candidate.candidate_id);
    if (!job) {
      receiver.cancel(candidate.candidate_id);
      store.markPartial(candidate.candidate_id);
    }
    return reply.send({ ...candidateResponse(store.get(candidate.candidate_id)), queue: scheduler.list().find((item) => item.candidate_id === candidate.candidate_id) ?? job });
  });

  app.post('/api/v1/candidates/:candidateId/complete', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return reply.send(candidateResponse(candidate));
    try {
      const completed = await finalizeCandidate(store, candidate.candidate_id);
      return reply.send(candidateResponse(completed));
    } catch (err) {
      if (store.missingParts(candidate.candidate_id)?.length > 0) return error(reply, 409, 'parts_missing', err.message);
      store.fail(candidate.candidate_id, err);
      return error(reply, 422, 'candidate_integrity_failed', err.message);
    }
  });
}

export { candidateResponse };
