import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rm, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assembleChunks } from '../../../libs/cam-transfer/src/transfer.js';
import { writeBufferAtomic, writeStreamAtomic } from '../../../libs/cam-transfer/src/secure-file.js';
import { bearerToken, parseRange } from '../../../libs/cam-transfer/src/http.js';
import { previewCandidateWorkbook } from './candidate-import.js';
import { normalizeGateConfig } from '../../../libs/cam-gate/src/config.js';
import { gateHealthCheck as checkGateHealth } from '../../../libs/cam-gate/src/client.js';
import { attachmentContentType, validAttachmentFileName } from '../../../libs/cam-server/src/attachment-types.js';
import { normalizeSourceAllowlist } from './source-config-store.js';

function error(reply, statusCode, code, message) {
  return reply.code(statusCode).send({ error: { code, message } });
}

function principal(request) {
  if (request.principal && typeof request.principal.id === 'string') {
    const user = request.principal.user ?? request.principal;
    return {
      principalId: request.principal.id,
      principalType: request.principal.type ?? 'AUTHENTICATED',
      username: typeof user?.username === 'string' ? user.username : null,
      displayName: typeof user?.displayName === 'string' ? user.displayName : null
    };
  }
  throw Object.assign(new Error('authenticated principal is required'), { code: 'principal_required' });
}

function downloadActor(request, grant) {
  try {
    return principal(request);
  } catch (err) {
    if (err.code === 'principal_required' && grant) return { principalId: `TOKEN:${grant.grantId}`, principalType: 'DOWNLOAD_TOKEN' };
    throw err;
  }
}

async function md5File(path) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function writeRequestPart(request, destination, expectedSize) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const result = await writeStreamAtomic({ stream: request.raw, destination: temporary, expectedSize });
    const declared = request.headers['x-chunk-sha256'];
    if (declared && declared !== result.sha256) throw new Error('x-chunk-sha256 does not match request body');
    return { ...result, temporary };
  } catch (err) {
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
    releaseRevision: candidate.release_revision ?? 0,
    releaseDisplayVersion: candidate.release_display_version ?? (candidate.release_revision > 0 ? `${candidate.release_version}-r${candidate.release_revision}` : candidate.release_version),
    packageKey: candidate.package_key,
    type: candidate.metadata?.type ?? null,
    mappingSource: candidate.mapping_source,
    inheritedFromRoundId: candidate.inherited_from_round_id,
    inheritedFromRoundNo: candidate.inherited_from_round_no,
    inheritedFromReleaseVersion: candidate.inherited_from_release_version ?? null,
    inheritedFromReleaseRevision: candidate.inherited_from_release_revision ?? null,
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
    metadata: candidate.metadata ?? {},
    rounds: (candidate.rounds ?? []).map((round) => ({
      roundId: round.roundId,
      roundNo: round.roundNo,
      releaseId: round.releaseId,
      version: round.version,
      revision: round.revision ?? 0,
      displayVersion: round.displayVersion ?? (round.revision > 0 ? `${round.version}-r${round.revision}` : round.version),
      productId: round.productId,
      productName: round.productName,
      packageKey: round.packageKey
    }))
  };
}

export async function finalizeCandidate(store, candidateId) {
  const candidate = store.get(candidateId);
  if (!candidate) throw new Error('candidate not found');
  const partsDir = join(store.candidateDir(candidate.candidate_id), 'parts');
  if (candidate.status === 'COMPLETED') {
    await rm(partsDir, { recursive: true, force: true });
    const promoted = store.deduplicateCompleted ? await store.deduplicateCompleted(candidateId) : candidate;
    if (promoted?.source_path && promoted.source_path !== candidate.source_path) await rm(store.candidateDir(candidate.candidate_id), { recursive: true, force: true });
    return promoted;
  }
  const missing = store.missingParts(candidate.candidate_id);
  if (missing.length > 0) throw new Error(`candidate has missing parts: ${missing.join(',')}`);
  store.markAssembling(candidateId);
  const manifest = { size: candidate.expected_size, sha256: candidate.expected_sha256 ?? '', transfer: { chunks: store.listParts(candidate.candidate_id).map((part) => ({ index: part.part_index, offset: part.offset, size: part.size, sha256: part.sha256 })) } };
  const assembled = await assembleChunks({ taskDir: store.candidateDir(candidate.candidate_id), manifest, outputPath: candidate.source_path });
  const completed = store.complete(candidate.candidate_id, { finalSha256: assembled.sha256, finalMd5: candidate.expected_md5 ? await md5File(assembled.path) : null });
  await rm(partsDir, { recursive: true, force: true });
  const promoted = store.deduplicateCompleted ? await store.deduplicateCompleted(candidateId) : completed;
  if (promoted?.source_path && promoted.source_path !== candidate.source_path) await rm(store.candidateDir(candidate.candidate_id), { recursive: true, force: true });
  return promoted;
}

export function registerCandidateRoutes(app, { store, receiver, scheduler, downloadGrants, auth, freezes, gateConfig, sourceConfig, keyring, approvalDispatcher, artifactDispatcher, logCollections }) {
  app.addHook('preHandler', async (request, reply) => {
    const url = request.url.split('?')[0];
    const exchangePath = url === '/api/v1/gate/pairing-probe' || url === '/api/v1/gate/approval-results' || url === '/api/v1/gate/transfer-requests' || url === '/api/v1/gate/transfer-retry' || url === '/api/v1/gate/identity-rotation/proposals' || url.startsWith('/api/v1/gate/transfer/reports/');
    if (!exchangePath) return;
    const status = await keyring.status();
    const pairingProbe = url === '/api/v1/gate/pairing-probe';
    if (!status.peerTrusted || (!status.businessReady && !pairingProbe)) return error(reply, 503, 'gate_pairing_required', 'Edge 尚未完成 Core 身份配對，暂不能接收跨区业务消息');
    const body = request.body === undefined ? '' : Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
    const verified = await keyring.verifyRequest({ method: request.method, path: request.url, headers: request.headers, body, bodyDigest: request.body === undefined ? request.headers['x-cam-gate-content-sha256'] : request.headers['x-cam-chunk-sha256'] });
    if (!verified) return error(reply, 401, 'gate_auth_required', 'Core 请求签名校验失败');
    if (pairingProbe) await keyring.markPeerConfirmed();
  });
  let identityRotationInFlight;
  const rotateIdentity = () => {
    if (identityRotationInFlight) return identityRotationInFlight;
    identityRotationInFlight = (async () => {
      const config = gateConfig.get();
      if (!config.coreControlUrl) throw Object.assign(new Error('请先配置 Core 控制地址（外侧）'), { code: 'gate_address_missing' });
      const proposal = await keyring.proposeIdentityRotation();
      const path = '/api/v1/gate/identity-rotation/proposals';
      const body = JSON.stringify(proposal);
      const response = await fetch(`${config.coreControlUrl.replace(/\/$/u, '')}${path}`, {
        method: 'POST', headers: await keyring.requestHeaders('POST', path, body, { 'content-type': 'application/json' }), body,
        signal: AbortSignal.timeout(config.connectTimeoutMs)
      });
      const receipt = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(receipt.error?.message ?? `Core 身份轮换失败（HTTP ${response.status}）`), { code: receipt.error?.code ?? 'gate_identity_rotation_failed' });
      return keyring.activateIdentityRotation(receipt);
    })().catch(async (err) => { await keyring.recordRotationFailure(err); throw err; }).finally(() => { identityRotationInFlight = null; });
    return identityRotationInFlight;
  };
  // 专用于 Core 通过网闸映射拉取验证报告。该地址只接受当前轮换密钥，
  // 不经过浏览器会话和外部区账号权限，且申请编号绑定报告路径。
  app.get('/api/v1/gate/transfer/reports/:requestId', async (request, reply) => {
    const freeze = freezes.get(request.params.requestId);
    const path = freezes.reportPath(request.params.requestId);
    if (!freeze || !path || freeze.status === 'DRAFT') return error(reply, 404, 'report_not_found', 'verification report not found');
    try {
      const info = await stat(path);
      const range = parseRange(request.headers.range, info.size);
      if (range === 'invalid') return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      reply.type(attachmentContentType(freeze.reportFileName)).header('Accept-Ranges', 'bytes').header('Content-Length', String(range ? range.end - range.start + 1 : info.size)).header('X-Report-Sha256', freeze.reportSha256);
      if (!range) return reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(freeze.reportFileName)}"`).send(createReadStream(path));
      return reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`).send(createReadStream(path, { start: range.start, end: range.end }));
    } catch { return error(reply, 404, 'report_not_found', 'verification report not found'); }
  });
  app.get('/api/v1/gate/config', async (request, reply) => {
    const item = gateConfig.get();
    const source = sourceConfig.get();
    const keys = await keyring.status();
    return reply.send({ item: { ...item, sourceAllowlist: source.allowlist, sourceAllowlistSource: source.source }, identityConfigured: keys.keyConfigured, previousIdentityConfigured: Boolean(keys.previousKeyExpiresAt) });
  });
  app.put('/api/v1/gate/config', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      const input = request.body ?? {};
      const sourceAllowlist = Object.prototype.hasOwnProperty.call(input, 'sourceAllowlist') ? normalizeSourceAllowlist(input.sourceAllowlist) : null;
      const item = gateConfig.save(input, request.principal?.id);
      const source = sourceAllowlist === null ? sourceConfig.get() : sourceConfig.save(sourceAllowlist, request.principal?.id);
      const keys = await keyring.status();
      return reply.send({ item: { ...item, sourceAllowlist: source.allowlist, sourceAllowlistSource: source.source }, identityConfigured: keys.keyConfigured, previousIdentityConfigured: Boolean(keys.previousKeyExpiresAt) });
    }
    catch (err) { return error(reply, 400, err.code ?? 'gate_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/config/test', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      // The Core control endpoint is deployment-owned.  Ignore any value sent
      // by the browser/API caller and always test the effective configured URL.
      const config = normalizeGateConfig({ ...request.body, coreControlUrl: gateConfig.get().coreControlUrl }, { requireUrls: true, requiredUrlFields: ['coreControlUrl', 'coreTransferUrl'] });
      const checks = {};
      for (const [name, url] of Object.entries({ coreControlUrl: config.coreControlUrl, coreTransferUrl: config.coreTransferUrl })) checks[name] = await checkGateHealth(url, { timeoutMs: config.connectTimeoutMs });
      return reply.send({ ok: true, checks });
    } catch (err) { return error(reply, 502, err.code ?? 'gate_test_failed', err.message); }
  });
  app.get('/api/v1/gate/keys', async (request, reply) => {
    if (!request.principal?.roles?.some((role) => ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN'].includes(role))) return error(reply, 403, 'admin_required', '需要外部交换区网闸配置权限');
    return { item: await keyring.status(), identityBundle: await keyring.identity() };
  });
  app.post('/api/v1/gate/keys/test', async (request, reply) => {
    if (!request.principal?.roles?.some((role) => ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN'].includes(role))) return error(reply, 403, 'admin_required', '需要外部交换区网闸配置管理员权限');
    const status = await keyring.status();
    if (!status.peerTrusted) return error(reply, 409, 'gate_pairing_required', '请先导入 Core 身份包');
    const config = gateConfig.get();
    if (!config.coreControlUrl) return error(reply, 400, 'gate_address_missing', '请先配置 Core 控制地址（外侧）');
    try {
      const path = '/api/v1/gate/pairing-probe';
      const response = await fetch(`${config.coreControlUrl.replace(/\/$/u, '')}${path}`, { headers: await keyring.requestHeaders('GET', path, '', { accept: 'application/json' }), signal: AbortSignal.timeout(config.connectTimeoutMs) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.role !== 'core' || body.businessReady !== true || body.peerFingerprint !== status.identity.signingFingerprint) return error(reply, 502, body.error?.code ?? 'gate_pairing_probe_failed', body.error?.message ?? 'Core 未确认身份配对状态');
      await keyring.markPeerConfirmed();
      return { ok: true, checks: { local: { role: 'edge', peerTrusted: true, keyConfigured: true }, remote: { role: body.role, peerTrusted: body.peerTrusted, keyConfigured: body.keyConfigured }, authenticated: true } };
    } catch (err) { return error(reply, 502, err.code ?? 'gate_pairing_probe_failed', err.message ?? '无法连接 Core 配对测试接口'); }
  });
  app.get('/api/v1/gate/pairing-probe', async (request, reply) => {
    const status = await keyring.status();
    return { role: 'edge', peerTrusted: true, keyConfigured: true, businessReady: status.businessReady, activeKeyId: status.identity.signingFingerprint, peerFingerprint: status.peerFingerprint };
  });
  app.put('/api/v1/gate/keys/trusted-peer', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!request.principal?.roles?.some((role) => ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN'].includes(role))) return error(reply, 403, 'admin_required', '需要外部交换区网闸配置管理员权限');
    try { return { item: await keyring.trustPeer(request.body?.identityBundle) }; }
    catch (err) { return error(reply, 400, err.code ?? 'gate_peer_invalid', err.message); }
  });
  app.put('/api/v1/gate/keys/schedule', { bodyLimit: 4096 }, async (request, reply) => {
    if (!request.principal?.roles?.some((role) => ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN'].includes(role))) return error(reply, 403, 'admin_required', '需要外部交换区网闸配置管理员权限');
    try { return { item: await keyring.configure(request.body ?? {}) }; }
    catch (err) { return error(reply, 400, err.code ?? 'gate_rotation_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/keys/rotate', async (request, reply) => {
    if (!request.principal?.roles?.some((role) => ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN'].includes(role))) return error(reply, 403, 'admin_required', '需要外部交换区网闸配置管理员权限');
    try { return { item: await rotateIdentity() }; }
    catch (err) { return error(reply, 502, err.code ?? 'gate_identity_rotation_failed', err.message); }
  });
  app.get('/api/v1/log-collections', async () => ({ items: logCollections.list() }));
  app.post('/api/v1/log-collections', { bodyLimit: 8 * 1024 }, async (request, reply) => {
    try { return reply.code(202).send({ item: await logCollections.create({ ...request.body, requestedBy: request.principal?.id }) }); }
    catch (err) { return error(reply, err.status ?? 400, err.code ?? 'log_collection_create_failed', err.message); }
  });
  app.get('/api/v1/log-collections/:jobId', async (request, reply) => {
    const item = logCollections.get(request.params.jobId); if (!item) return error(reply, 404, 'log_collection_not_found', '日志收集任务不存在'); return reply.send({ item });
  });
  app.get('/api/v1/log-collections/:jobId/download', async (request, reply) => {
    const item = logCollections.get(request.params.jobId); if (!item || item.status !== 'READY' || !item.bundlePath) return error(reply, 404, 'log_collection_not_ready', '日志归档尚未准备完成');
    if (Date.parse(item.expiresAt) <= Date.now()) return error(reply, 410, 'log_collection_expired', '日志归档已过期');
    try { const info = await stat(item.bundlePath); return reply.type('application/gzip').header('Content-Length', String(info.size)).header('Content-Disposition', `attachment; filename="cam-log-collection-${encodeURIComponent(item.jobId)}.tar.gz"`).header('Cache-Control', 'no-store').header('X-Log-Bundle-Sha256', item.bundleSha256).send(createReadStream(item.bundlePath)); }
    catch { return error(reply, 404, 'log_collection_bundle_missing', '日志归档文件不存在'); }
  });
  app.post('/api/v1/gate/identity-rotation/proposals', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try { return await keyring.acceptIdentityRotation(request.body ?? {}); }
    catch (err) { return error(reply, 409, err.code ?? 'gate_identity_rotation_rejected', err.message); }
  });
  if (process.env.NODE_ENV === 'production') {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      try { if (!await keyring.needsRotation()) return; busy = true; await rotateIdentity(); }
      catch (err) { app.log.warn?.({ code: err.code, message: err.message }, 'CAM Edge 身份轮换失败，将自动重试'); }
      finally { busy = false; }
    }, 60_000);
    timer.unref?.();
    app.addHook('onClose', async () => clearInterval(timer));
  }
  app.post('/api/v1/gate/approval-results', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const result = freezes.applyCoreDecision(request.body ?? {});
      return reply.send({ accepted: true, requestId: result.item.freezeId, eventId: request.body.eventId, idempotent: result.idempotent });
    } catch (err) {
      const status = err.code === 'freeze_not_found' ? 404 : ['approval_result_conflict', 'approval_event_conflict'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'approval_result_rejected', err.message);
    }
  });
  app.post('/api/v1/gate/transfer-requests', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const result = freezes.applyTransferReady(request.body ?? {});
      const item = result.item;
      // Acknowledge synchronously so Core can durably mark the dispatch as
      // delivered. The dispatcher then reports ACCEPTED before it starts the
      // data plane, so a missing first byte has an explicit deadline.
      queueMicrotask(() => { void (async () => {
        await artifactDispatcher.accepted(item.freezeId);
        await artifactDispatcher.deliver(item.freezeId);
      })(); });
      return reply.send({ accepted: true, requestId: item.freezeId, transferTaskId: item.transferTaskId, eventId: request.body?.eventId, idempotent: result.idempotent });
    } catch (err) {
      const status = err.code === 'freeze_not_found' ? 404 : ['transfer_request_conflict', 'transfer_event_conflict'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'transfer_request_rejected', err.message);
    }
  });
  // Edge → Core 的传输由 Core 统一调度。此受控网闸接口只接受 Core
  // 的签名指令，浏览器用户不能在 Edge 侧直接启动重试。
  app.post('/api/v1/gate/transfer-retry', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    const body = request.body ?? {};
    const requestId = String(body.requestId ?? '').trim();
    const freezeId = String(body.freezeId ?? '').trim();
    const transferTaskId = String(body.transferTaskId ?? '').trim();
    const manifestSha256 = String(body.manifestSha256 ?? '').trim().toLowerCase();
    if (!requestId || requestId !== freezeId || !transferTaskId || !/^[a-f0-9]{64}$/.test(manifestSha256)) return error(reply, 400, 'invalid_transfer_retry', 'Core 传输重试指令格式无效');
    const freeze = freezes.get(freezeId);
    if (!freeze) return error(reply, 404, 'freeze_not_found', '固化申请不存在');
    if (freeze.status !== 'APPROVED' || freeze.transferTaskId !== transferTaskId || freeze.manifestSha256.toLowerCase() !== manifestSha256) return error(reply, 409, 'transfer_retry_conflict', '传输重试指令与 Edge 审批记录不匹配');
    if (freeze.transferStatus === 'RECEIVED') {
      // Core may have persisted all data but missed Edge's final receipt. Ask
      // the dispatcher to repair that idempotently instead of leaving Core in
      // a permanent "waiting for receipt" state.
      queueMicrotask(() => { void artifactDispatcher.deliver(freezeId); });
      return reply.send({ accepted: true, requestId, transferTaskId, status: 'RECEIVED', idempotent: true });
    }
    if (freeze.transferStatus === 'SENDING') return reply.code(202).send({ accepted: true, requestId, transferTaskId, status: 'SENDING', idempotent: true });
    if (freeze.transferStatus === 'READY') {
      queueMicrotask(() => { void (async () => { await artifactDispatcher.accepted(freezeId); await artifactDispatcher.deliver(freezeId); })(); });
      return reply.code(202).send({ accepted: true, requestId, transferTaskId, status: 'QUEUED', idempotent: true });
    }
    if (freeze.transferStatus !== 'FAILED') return error(reply, 409, 'transfer_retry_unavailable', '当前传输状态不支持重试');
    freezes.resetTransfer(freezeId);
    queueMicrotask(() => { void (async () => { await artifactDispatcher.accepted(freezeId); await artifactDispatcher.deliver(freezeId); })(); });
    return reply.code(202).send({ accepted: true, requestId, transferTaskId, status: 'QUEUED', idempotent: false });
  });
  app.get('/api/v1/rounds/:roundId/freezes', async (request, reply) => {
    if (!store.getRound(request.params.roundId)) return error(reply, 404, 'round_not_found', 'round not found');
    return reply.send({ item: freezes.latest(request.params.roundId) });
  });

  app.post('/api/v1/rounds/:roundId/freezes', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      store.assertRoundWritable(request.params.roundId);
      const actor = principal(request);
      return reply.code(201).send(freezes.createDraft(request.params.roundId, request.body ?? {}, actor.principalId));
    } catch (err) {
      const status = err.code === 'round_not_found' ? 404 : ['round_locked', 'release_sealed', 'release_approval_pending'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'freeze_create_failed', err.message);
    }
  });

  app.put('/api/v1/freezes/:freezeId/report', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    try {
      const chunks = [];
      let size = 0;
      const parsedBody = Buffer.isBuffer(request.body) ? request.body : typeof request.body === 'string' ? Buffer.from(request.body) : null;
      if (parsedBody) {
        size = parsedBody.length;
        if (size > 20 * 1024 * 1024) return error(reply, 413, 'report_too_large', '附件不能超过 20 MiB');
        chunks.push(parsedBody);
      } else {
        for await (const chunk of request.raw) {
          size += chunk.length;
          if (size > 20 * 1024 * 1024) return error(reply, 413, 'report_too_large', '附件不能超过 20 MiB');
          chunks.push(Buffer.from(chunk));
        }
      }
      let fileName;
      try { fileName = decodeURIComponent(request.headers['x-report-filename'] ?? ''); } catch { throw new Error('报告文件名编码无效'); }
      const updated = await freezes.saveReport(request.params.freezeId, fileName, Buffer.concat(chunks), principal(request).principalId);
      return reply.send(updated);
    } catch (err) {
      const status = err.code === 'freeze_not_found' ? 404 : err.code === 'freeze_not_editable' ? 409 : err.code === 'freeze_owner_required' ? 403 : 400;
      return error(reply, status, err.code ?? 'report_upload_failed', err.message);
    }
  });

  app.post('/api/v1/freezes/:freezeId/submit', async (request, reply) => {
    try {
      const actor = principal(request);
      const submitted = await freezes.submit(request.params.freezeId, actor.principalId, actor);
      // Submission only commits the durable outbox record. Delivery across the
      // mapped channel is deliberately asynchronous and retried by the worker.
      queueMicrotask(() => { void approvalDispatcher.dispatchOne(submitted.freezeId); });
      return reply.send(submitted);
    }
    catch (err) { return error(reply, err.code === 'freeze_not_found' ? 404 : err.code === 'freeze_owner_required' ? 403 : ['freeze_not_draft', 'round_locked', 'manifest_changed', 'release_sealed', 'release_approval_pending'].includes(err.code) ? 409 : 400, err.code ?? 'freeze_submit_failed', err.message); }
  });

  app.post('/api/v1/freezes/:freezeId/dispatch', async (request, reply) => {
    try {
      const freeze = freezes.get(request.params.freezeId);
      if (!freeze) return error(reply, 404, 'freeze_not_found', 'freeze request not found');
      if (!['PENDING_APPROVAL'].includes(freeze.status)) return error(reply, 409, 'freeze_not_pending', '该申请当前不在待发送或待审批状态');
      return reply.send(await approvalDispatcher.dispatchOne(freeze.freezeId));
    } catch (err) { return error(reply, 502, err.code ?? 'freeze_dispatch_failed', err.message); }
  });

  app.post('/api/v1/freezes/:freezeId/decision', { bodyLimit: 8192 }, async (request, reply) => {
    return error(reply, 409, 'cloud_workflow_required', '审批结果由 CAM Core 从统一云管获取并回告，不能在外部交换区直接处理');
  });

  app.get('/api/v1/freezes/:freezeId/report-file', async (request, reply) => {
    const freeze = freezes.get(request.params.freezeId);
    const path = freezes.reportPath(request.params.freezeId);
    if (!freeze || !path) return error(reply, 404, 'report_not_found', 'verification report not found');
    const { createReadStream } = await import('node:fs');
    return reply.type(attachmentContentType(freeze.reportFileName)).header('Content-Disposition', `attachment; filename="${encodeURIComponent(freeze.reportFileName)}"`).send(createReadStream(path));
  });

  const usableRecipient = (grant) => {
    if (grant?.principalType !== 'CORE_USER') return true;
    const user = auth.getUser(grant.principalId);
    return user?.source === 'CORE' ? user.edgeEnabled && !user.mustChangePassword && !(user.lockedUntil > Date.now()) && user.roles.includes('EDGE_OPERATOR') : user?.status === 'ACTIVE' && !user.mustChangePassword && user.roles.includes('EDGE_OPERATOR');
  };
  const grantResponse = (grant) => {
    if (!grant) return grant;
    const person = auth.getUser(grant.principalId) ?? auth.getUser(grant.createdBy);
    return {
      ...grant,
      responsiblePerson: person ? { id: person.id, displayName: person.displayName, username: person.username } : { id: grant.principalId, displayName: null, username: null }
    };
  };
  app.get('/api/v1/download-grants', async (request) => {
    const audit = request.principal.roles?.includes('EDGE_AUDITOR');
    const rows = downloadGrants.db.prepare(audit ? 'SELECT grant_id FROM download_grants ORDER BY created_at DESC LIMIT 200' : 'SELECT grant_id FROM download_grants WHERE created_by = ? OR principal_id = ? ORDER BY created_at DESC LIMIT 200');
    return { items: (audit ? rows.all() : rows.all(request.principal.id, request.principal.id)).map((r) => grantResponse(downloadGrants.getGrant(r.grant_id))) };
  });
  app.post('/api/v1/download-grants', async (request, reply) => {
    if (!downloadGrants) return error(reply, 503, 'download_grants_unavailable', 'download grants are not configured');
    try {
      const actor = principal(request);
      const body = request.body ?? {};
      if (!request.principal.roles?.includes('EDGE_OPERATOR')) throw Object.assign(new Error('只有当前登录的操作员可以创建下载授权'), { code: 'permission_denied' });
      const managedUser = request.principal.type === 'CORE_USER';
      const recipient = managedUser ? auth.getUser(actor.principalId) : null;
      if (managedUser && (!recipient || recipient.edgeEnabled === false || recipient.mustChangePassword || recipient.lockedUntil > Date.now() || !recipient.roles.includes('EDGE_OPERATOR'))) throw new Error('当前登录账号未获准操作 Edge，不能创建下载授权');
      if (body.roundId) {
        const roundCandidateIds = new Set(store.listRoundCandidates(body.roundId).map((candidate) => candidate.candidate_id));
        if (!Array.isArray(body.candidateIds) || body.candidateIds.some((candidateId) => !roundCandidateIds.has(candidateId))) throw new Error('候选包必须属于所选候选轮次');
      } else if (Array.isArray(body.candidateIds) && body.candidateIds.length > 1) {
        throw new Error('批量创建下载授权时必须指定候选轮次');
      }
      const grant = downloadGrants.createGrant({
        candidateIds: body.candidateIds,
        principalId: actor.principalId,
        principalType: actor.principalType,
        createdBy: actor.principalId,
        roundId: body.roundId || null,
        expiresAt: body.expiresAt,
        maxTotalSessions: body.maxTotalSessions,
        maxSessionsPerFile: body.maxSessionsPerFile
      });
      return reply.code(201).send({
        ...grantResponse(grant),
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
      const sessions = downloadGrants.db.prepare('SELECT session_id, candidate_id, downloaded_by, status, bytes_sent, covered_bytes, source_address, user_agent, started_at, updated_at, completed_at, error_message FROM download_sessions WHERE grant_id = ? ORDER BY rowid DESC LIMIT 200').all(grant.grantId).map((session) => {
        const downloadedBy = String(session.downloaded_by ?? '');
        if (downloadedBy.startsWith('TOKEN:')) return { ...session, downloadedBy: { type: 'TOKEN', label: 'Token 持有者（未登录）' } };
        const user = auth.getUser(downloadedBy);
        return { ...session, downloadedBy: user ? { type: 'ACCOUNT', id: user.id, displayName: user.displayName, username: user.username, label: `${user.displayName}（${user.username}）` } : { type: 'ACCOUNT', label: '已认证账号' } };
      });
      return reply.send({ ...grantResponse(grant), sessions });
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
    try { return reply.code(201).send(store.createReleaseWithFirstRound(request.params.productId, { ...(request.body ?? {}), createdBy: principal(request).principalId })); }
    catch (err) { return error(reply, ['release_version_open', 'release_baseline_missing'].includes(err.code) ? 409 : 400, err.code ?? 'invalid_release', err.message); }
  });

  app.post('/api/v1/releases/:releaseId/revisions', async (request, reply) => {
    try { return reply.code(201).send(store.createRevisionWithFirstRound(request.params.releaseId, { ...(request.body ?? {}), createdBy: principal(request).principalId })); }
    catch (err) {
      const status = err.code === 'release_not_found' ? 404 : ['release_not_sealed', 'revision_source_not_latest', 'release_baseline_missing'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'invalid_release_revision', err.message);
    }
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
    try { return reply.code(201).send(store.createNextRound(request.params.releaseId, { changeNote: request.body?.changeNote, createdBy: principal(request).principalId })); }
    catch (err) { return error(reply, ['round_no_changes', 'round_not_latest', 'round_base_required', 'release_sealed', 'release_approval_pending'].includes(err.code) ? 409 : 400, err.code ?? 'invalid_round', err.message); }
  });

  app.delete('/api/v1/rounds/:roundId', async (request, reply) => {
    try {
      const deleted = store.deleteEmptyRound(request.params.roundId, principal(request).principalId);
      return reply.send(deleted);
    } catch (err) {
      return error(reply, err.code === 'round_not_found' ? 404 : err.code === 'round_not_empty' ? 409 : 400, err.code ?? 'round_delete_failed', err.message);
    }
  });

  app.get('/api/v1/releases/:releaseId/rounds', async (request, reply) => {
    try { return reply.send({ items: store.listRounds(request.params.releaseId), nextRound: store.roundCreationPreview(request.params.releaseId) }); }
    catch (err) { return error(reply, 400, 'invalid_round_query', err.message); }
  });

  app.get('/api/v1/rounds', async (request, reply) => {
    try {
      const productId = request.query?.productId ?? null;
      const releaseId = request.query?.releaseId ?? null;
      return reply.send({ items: store.listRoundsByFilter({ productId, releaseId }) });
    } catch (err) { return error(reply, 400, 'invalid_round_query', err.message); }
  });

  app.get('/api/v1/rounds/:roundId', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    return reply.send({ ...round, attachments: store.listRoundAttachments(request.params.roundId) });
  });

  app.post('/api/v1/rounds/:roundId/attachments', { bodyLimit: 20 * 1024 * 1024 }, async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    try { store.assertRoundWritable(round.roundId); }
    catch (err) { return error(reply, 409, err.code ?? 'round_locked', err.message); }
    if (freezes.locked(round.roundId)) return error(reply, 409, 'round_locked', '轮次审批或固化期间不能变更留痕附件');
    const chunks = []; let size = 0;
    const parsedBody = Buffer.isBuffer(request.body) ? request.body : typeof request.body === 'string' ? Buffer.from(request.body) : null;
    if (parsedBody) {
      size = parsedBody.length;
      if (size > 20 * 1024 * 1024) return error(reply, 413, 'attachment_too_large', '单个轮次附件不能超过 20 MiB');
      chunks.push(parsedBody);
    } else {
      for await (const chunk of request.raw) { size += chunk.length; if (size > 20 * 1024 * 1024) return error(reply, 413, 'attachment_too_large', '单个轮次附件不能超过 20 MiB'); chunks.push(Buffer.from(chunk)); }
    }
    const bytes = Buffer.concat(chunks);
    let fileName; try { fileName = decodeURIComponent(request.headers['x-attachment-filename'] ?? ''); } catch { return error(reply, 400, 'attachment_invalid', '附件文件名编码无效'); }
    if (!validAttachmentFileName(fileName)) return error(reply, 400, 'attachment_invalid', '附件仅支持 DOCX、PDF、WPS、TXT、MD，文件名不超过 180 字');
    if (!bytes.length) return error(reply, 400, 'attachment_invalid', '附件不能为空');
    const contentType = attachmentContentType(fileName).split(';')[0];
    const attachmentId = `RATT-${Date.now()}-${randomUUID()}`;
    const dir = join(store.dataDir, 'round-attachments', round.roundId);
    const path = join(dir, `${attachmentId}-${fileName}`);
    try {
      await mkdir(dir, { recursive: true });
      await writeBufferAtomic({ data: bytes, destination: path, expectedSize: bytes.length });
      const item = store.addRoundAttachment(round.roundId, { fileName, contentType, fileSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), filePath: path, uploadedBy: principal(request).principalId });
      return reply.code(201).send({ item });
    } catch (err) { await rm(path, { force: true }); return error(reply, 400, 'attachment_save_failed', err.message); }
  });

  app.get('/api/v1/round-attachments/:attachmentId/file', async (request, reply) => {
    const item = store.getRoundAttachment(request.params.attachmentId);
    if (!item) return error(reply, 404, 'attachment_not_found', 'round attachment not found');
    const path = store.roundAttachmentPath(item.attachmentId);
    if (!path) return error(reply, 404, 'attachment_not_found', 'round attachment file not found');
    return reply.type(item.contentType).header('Content-Length', String(item.fileSize)).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`).send(createReadStream(path));
  });

  app.get('/api/v1/rounds/:roundId/candidates', async (request, reply) => {
    try { return reply.send({ items: store.listRoundCandidates(request.params.roundId).map(candidateResponse) }); }
    catch (err) { return error(reply, 400, 'invalid_round_candidates', err.message); }
  });

  app.post('/api/v1/rounds/:roundId/candidates', async (request, reply) => {
    try {
      store.assertRoundWritable(request.params.roundId);
      if (freezes.locked(request.params.roundId)) return error(reply, 409, 'round_locked', '该轮次正在审批或已固化，不能修改候选包');
      const candidate = await store.create({ ...(request.body ?? {}), roundId: request.params.roundId });
      return reply.code(201).send(candidateResponse(candidate));
    } catch (err) { return error(reply, ['round_locked', 'round_not_found', 'release_sealed', 'release_approval_pending'].includes(err.code) ? (err.code === 'round_not_found' ? 404 : 409) : 400, err.code ?? 'invalid_candidate', err.message); }
  });

  app.delete('/api/v1/rounds/:roundId/candidates/:candidateId', async (request, reply) => {
    try {
      store.assertRoundWritable(request.params.roundId);
      if (freezes.locked(request.params.roundId)) return error(reply, 409, 'round_locked', '该轮次正在审批或已固化，不能修改候选包');
      const removed = store.detachCandidateFromRound(request.params.roundId, request.params.candidateId);
      if (!removed) return error(reply, 404, 'round_candidate_not_found', 'candidate is not attached to this round');
      return reply.code(204).send();
    } catch (err) { return error(reply, err.code === 'round_not_found' ? 404 : ['round_locked', 'release_sealed', 'release_approval_pending'].includes(err.code) ? 409 : 400, err.code ?? 'invalid_round_candidate_delete', err.message); }
  });

  app.post('/api/v1/rounds/:roundId/import-preview', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    try { store.assertRoundWritable(round.roundId); }
    catch (err) { return error(reply, 409, err.code ?? 'round_locked', err.message); }
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
    try { store.assertRoundWritable(request.params.roundId); }
    catch (err) { return error(reply, err.code === 'round_not_found' ? 404 : 409, err.code ?? 'round_locked', err.message); }
    if (freezes.locked(request.params.roundId)) return error(reply, 409, 'round_locked', '该轮次正在审批或已固化，不能导入候选包');
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
      const productId = request.query?.productId ?? null;
      return reply.send({ items: store.list({ limit, offset, releaseId, productId, status: request.query?.status ?? null }).map(candidateResponse), limit, offset });
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
    catch (err) { return error(reply, ['candidate_not_editable', 'candidate_has_parts', 'round_locked', 'release_sealed', 'release_approval_pending'].includes(err.code) ? 409 : 400, err.code ?? 'invalid_candidate', err.message); }
  });

  app.delete('/api/v1/candidates/:candidateId', async (request, reply) => {
    try {
      const linkedRounds = downloadGrants.db.prepare('SELECT round_id FROM round_candidates WHERE candidate_id = ?').all(request.params.candidateId);
      if (linkedRounds.some(({ round_id: roundId }) => freezes.locked(roundId) || !store.isRoundLatest(roundId))) return error(reply, 409, 'round_locked', '候选包已属于历史、审批或固化轮次，不能永久删除');
      if (downloadGrants.db.prepare('SELECT 1 FROM download_grant_items WHERE candidate_id = ? LIMIT 1').get(request.params.candidateId)) return error(reply, 409, 'candidate_in_download_audit', '该候选包已关联下载授权和审计记录，暂不能永久删除；可以移出候选轮次');
      const deleted = store.deleteCandidate(request.params.candidateId);
      if (!deleted) return error(reply, 404, 'candidate_not_found', 'candidate not found');
      if (deleted.removeSourcePath && deleted.sourcePath) await rm(deleted.sourcePath, { force: true });
      await rm(deleted.dataDir, { recursive: true, force: true });
      return reply.code(204).send();
    } catch (err) { return error(reply, ['candidate_busy', 'round_locked', 'release_sealed', 'release_approval_pending'].includes(err.code) ? 409 : 400, err.code ?? 'candidate_delete_failed', err.message); }
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
    try {
      const completed = await finalizeCandidate(store, candidate.candidate_id);
      return reply.send(candidateResponse(completed));
    } catch (err) {
      if (store.missingParts(candidate.candidate_id)?.length > 0) return error(reply, 409, 'parts_missing', err.message);
      if (store.get(candidate.candidate_id)?.status !== 'COMPLETED') store.fail(candidate.candidate_id, err);
      return error(reply, 422, 'candidate_integrity_failed', err.message);
    }
  });
}

export { candidateResponse };
