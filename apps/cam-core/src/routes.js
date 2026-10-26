import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { once } from 'node:events';
import { attachmentContentType } from '../../../libs/cam-server/src/attachment-types.js';
import { normalizeGateConfig } from '../../../libs/cam-gate/src/config.js';
import { gateHealthCheck as checkGateHealth } from '../../../libs/cam-gate/src/client.js';
import { verifyRequest } from '../../../libs/cam-agent-auth/src/protocol.js';
import { hasCorePermission } from '../../../libs/cam-auth/src/roles.js';
import { buildCoreLogCollection, expireCoreLogCollections } from './log-collection.js';

function error(reply, status, code, message) { return reply.code(status).send({ error: { code, message } }); }
function requireCorePermission(request, reply, permission, message) {
  // Auth-disabled application instances are used by internal protocol tests;
  // production requests always have a principal from Core auth middleware.
  if (!request.principal) return null;
  if (!hasCorePermission(request.principal?.roles, permission)) return error(reply, 403, 'core_permission_denied', message);
  return null;
}

async function gateAuthorized(request, keyring) {
  const status = await keyring.status();
  if (!status.peerTrusted || (!status.businessReady && request.url.split('?')[0] !== '/api/v1/gate/pairing-probe')) return 'pairing_required';
  const body = request.body === undefined ? '' : Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body);
  const verified = await keyring.verifyRequest({ method: request.method, path: request.url, headers: request.headers, body, bodyDigest: request.body === undefined ? request.headers['x-cam-gate-content-sha256'] : request.headers['x-cam-chunk-sha256'] });
  if (!verified) return false;
  if (request.url.split('?')[0] === '/api/v1/gate/pairing-probe') await keyring.markPeerConfirmed();
  return true;
}

async function rotateEdgeKey({ keyring, gateConfig, fetchImpl = fetch }) {
  const config = gateConfig.get();
  if (!config.edgeControlUrl) throw Object.assign(new Error('请先配置 Edge 控制地址（内侧）'), { code: 'gate_address_missing' });
  const pending = await keyring.proposeIdentityRotation();
  const baseUrl = config.edgeControlUrl.replace(/\/$/u, '');
  const path = '/api/v1/gate/identity-rotation/proposals';
  const body = JSON.stringify(pending);
  const response = await fetchImpl(`${baseUrl}${path}`, {
    method: 'POST', headers: await keyring.requestHeaders('POST', path, body, { 'content-type': 'application/json' }), body, signal: AbortSignal.timeout(config.connectTimeoutMs)
  });
  const receipt = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(receipt.error?.message ?? `Edge 身份轮换失败（HTTP ${response.status}）`), { code: receipt.error?.code ?? 'gate_identity_rotation_failed' });
  return keyring.activateIdentityRotation(receipt);
}

export function registerCoreRoutes(app, { store, cloud, gateConfig, keyring, agentServiceIdentity, agentServiceIdentityPath = null, rotateAgentServiceIdentity, stageAgentServiceIdentityRotation, activateStagedAgentServiceIdentity, enableKeyRotation = false, cloudRetryDelayMs = 30_000, cloudStatusPollMs = 30_000, approvalResultRetryBaseMs = 5_000, workerIntervalMs = 5_000, fetchImpl = fetch }) {
  let rotationInFlight;
  const rotateKey = () => {
    if (rotationInFlight) return rotationInFlight;
    rotationInFlight = rotateEdgeKey({ keyring, gateConfig, fetchImpl })
      .catch(async (err) => { await keyring.recordRotationFailure(err); throw err; })
      .finally(() => { rotationInFlight = null; });
    return rotationInFlight;
  };
  const cloudInFlight = new Set();
  const cloudStatusNextAttempt = new Map();
  const cloudStatusInFlight = new Set();
  let workerBusy = false;
  const ensureCloudReport = async (requestId, envelope) => {
    // Older control envelopes may contain only a report name/digest. New Edge
    // envelopes include reportSize and therefore require the binary transfer.
    if (!envelope?.reportFileName || !Number.isSafeInteger(envelope.reportSize)) return envelope;
    let path = store.reportPath(requestId);
    if (!path) {
      const config = gateConfig.get();
      if (!config.edgeTransferUrl) throw Object.assign(new Error('请先配置 Core 内侧访问 Edge 报告/回执映射地址'), { code: 'gate_address_missing' });
      const reportUrl = `${config.edgeTransferUrl.replace(/\/$/u, '')}/api/v1/gate/transfer/reports/${encodeURIComponent(requestId)}`;
      const chunks = []; let offset = 0; const expected = envelope.reportSize; let reportResponseSha = null;
      while (offset < expected) {
        let received = false; let lastError = null;
        for (let attempt = 1; attempt <= 4 && !received; attempt++) try {
        const end = Math.min(expected - 1, offset + Math.max(1024 * 1024, Math.min(config.chunkSizeBytes, 4 * 1024 * 1024)) - 1);
        const reportPath = `/api/v1/gate/transfer/reports/${encodeURIComponent(requestId)}`;
        const headers = await keyring.requestHeaders('GET', reportPath, '', { accept: '*/*', range: `bytes=${offset}-${end}` });
        const response = await fetchImpl(reportUrl, { headers, signal: AbortSignal.timeout(config.transferTimeoutMs) });
        if (!response.ok) throw Object.assign(new Error(`从 Edge 获取验证报告失败（HTTP ${response.status}）`), { code: 'report_transfer_failed' });
        const body = Buffer.from(await response.arrayBuffer());
        reportResponseSha = response.headers.get('x-report-sha256') ?? reportResponseSha;
        if (!body.length || body.length > expected - offset) throw Object.assign(new Error('Edge 返回的报告分块大小无效'), { code: 'report_transfer_failed' });
        chunks.push(body); offset += body.length;
        if (response.status !== 206 && offset < expected) throw Object.assign(new Error('Edge 未按 Range 返回完整报告'), { code: 'report_transfer_failed' });
        received = true;
        } catch (error) { lastError = error; if (attempt < 4) await new Promise((resolve) => setTimeout(resolve, 250 * attempt)); }
        if (!received) throw lastError ?? Object.assign(new Error('报告传输失败'), { code: 'report_transfer_failed' });
      }
      if (offset !== expected) throw Object.assign(new Error(`验证报告传输未完成（已接收 ${offset}/${expected} 字节）`), { code: 'report_transfer_failed' });
      const bytes = Buffer.concat(chunks);
      const saved = await store.saveReport(requestId, bytes);
      if (reportResponseSha && reportResponseSha.toLowerCase() !== saved.reportReceivedSha256) throw Object.assign(new Error('Edge 报告摘要响应头与实际内容不一致'), { code: 'report_integrity_failed' });
      path = store.reportPath(requestId);
    }
    const item = store.get(requestId);
    if (!item.reportReceived || item.reportReceivedSha256 !== item.reportSha256) throw Object.assign(new Error('Core 尚未持有经校验的验证报告'), { code: 'report_not_received' });
    if (item.cloudAttachmentId) return { ...envelope, cloudAttachmentId: item.cloudAttachmentId };
    if (typeof cloud.uploadApprovalReport !== 'function') throw Object.assign(new Error('当前云管适配器未实现验证报告附件上传'), { code: 'cloud_attachment_upload_unavailable' });
    const attachmentId = await cloud.uploadApprovalReport({ path, fileName: item.reportFileName, sha256: item.reportSha256, size: item.reportSize }, store.getCloudConfig());
    if (typeof attachmentId !== 'string' || !attachmentId.trim()) throw Object.assign(new Error('云管报告上传未返回有效附件标识'), { code: 'cloud_attachment_upload_invalid' });
    store.markReportAttachment(requestId, attachmentId.trim());
    return { ...envelope, cloudAttachmentId: attachmentId.trim() };
  };
  const submitCloud = async (requestId) => {
    if (cloudInFlight.has(requestId)) return;
    cloudInFlight.add(requestId);
    try {
      const item = store.get(requestId);
      if (!item || item.status !== 'CLOUD_PENDING' || item.cloudApprovalId) return;
      store.markCloudSubmissionAttempt(requestId);
      const envelope = await ensureCloudReport(requestId, store.envelope(requestId));
      const latest = store.get(requestId);
      if (!latest || latest.status !== 'CLOUD_PENDING' || latest.cloudApprovalId) return;
      store.markCloudSubmitted(requestId, await cloud.createApproval(envelope, store.getCloudConfig()));
      cloudStatusNextAttempt.set(requestId, Date.now() + cloudStatusPollMs);
    } catch (err) {
      const retryAt = new Date(Date.now() + cloudRetryDelayMs).toISOString();
      const item = store.markCloudSubmissionFailure(requestId, err, retryAt);
      app.log.warn?.({ requestId, attempt: item?.cloudSubmissionAttempts, retryAt, code: err.code, message: err.message }, '云管工单创建失败，将自动重试');
    } finally { cloudInFlight.delete(requestId); }
  };
  const closeRejectedCloudApproval = async (item) => {
    if (item.status !== 'REJECTED' || !item.cloudApprovalId || item.closeStatus === 'CLOSED') return item;
    if (typeof cloud.closeApproval !== 'function') throw Object.assign(new Error('当前云管适配器未实现自动关单'), { code: 'cloud_close_unavailable' });
    await cloud.closeApproval(item.cloudApprovalId, { reason: '审批未通过，Core 已自动关闭云管工单。' });
    return store.markCloudClosed(item.requestId);
  };
  const syncCloudStatus = async (requestId) => {
    if (cloudStatusInFlight.has(requestId)) return store.get(requestId);
    const current = store.get(requestId);
    if (!current) throw Object.assign(new Error('approval request not found'), { code: 'request_not_found' });
    if (current.status === 'REJECTED') {
      const refreshed = current.cloudApprovalId && typeof cloud.getApproval === 'function'
        ? store.refreshCloudDetail(requestId, await cloud.getApproval(current.cloudApprovalId, { ...current, approvalCode: store.approvalCode(requestId) }))
        : current;
      const closed = await closeRejectedCloudApproval(refreshed);
      cloudStatusNextAttempt.delete(requestId);
      store.enqueueApprovalResult(requestId);
      return closed;
    }
    if (['APPROVED', 'WITHDRAWN'].includes(current.status)) {
      store.enqueueApprovalResult(requestId);
      return current;
    }
    if (!current.cloudApprovalId || !['CLOUD_SUBMITTED', 'CLOUD_STATUS_UNCONFIRMED'].includes(current.status)) return current;
    cloudStatusInFlight.add(requestId);
    try {
      let updated = store.applyCloudStatus(requestId, await cloud.getApproval(current.cloudApprovalId, { ...current, approvalCode: store.approvalCode(requestId) }));
      if (updated.status === 'REJECTED') updated = await closeRejectedCloudApproval(updated);
      if (['APPROVED', 'REJECTED'].includes(updated.status)) {
        store.enqueueApprovalResult(requestId);
        cloudStatusNextAttempt.delete(requestId);
        queueMicrotask(() => { void pumpWorkers(); });
      } else cloudStatusNextAttempt.set(requestId, Date.now() + cloudStatusPollMs);
      return updated;
    } catch (err) {
      store.markError(requestId, err);
      cloudStatusNextAttempt.set(requestId, Date.now() + Math.min(300_000, cloudStatusPollMs * 2));
      throw err;
    } finally { cloudStatusInFlight.delete(requestId); }
  };
  const sendApprovalResult = async (entry) => {
    store.markApprovalResultAttempt(entry.event_id);
    try {
      const config = gateConfig.get();
      if (!config.edgeControlUrl) throw Object.assign(new Error('Edge 审批结果回告地址尚未配置'), { code: 'gate_address_missing' });
      const response = await fetchImpl(`${config.edgeControlUrl.replace(/\/$/u, '')}/api/v1/gate/approval-results`, {
        method: 'POST',
        headers: await keyring.requestHeaders('POST', '/api/v1/gate/approval-results', JSON.stringify(entry.payload), { 'content-type': 'application/json' }),
        body: JSON.stringify(entry.payload),
        signal: AbortSignal.timeout(config.connectTimeoutMs)
      });
      if (!response.ok) throw Object.assign(new Error(`Edge 审批结果回告失败（HTTP ${response.status}）`), { code: 'approval_result_delivery_failed' });
      const acknowledgement = await response.json().catch(() => ({}));
      if (acknowledgement.accepted !== true || acknowledgement.requestId !== entry.payload.requestId || acknowledgement.eventId !== entry.event_id) {
        throw Object.assign(new Error('Edge 未确认接收该审批结果'), { code: 'approval_result_ack_invalid' });
      }
      store.markApprovalResultDelivered(entry.event_id);
    } catch (err) {
      const attempts = entry.attempts + 1;
      const retryAt = new Date(Date.now() + Math.min(300_000, approvalResultRetryBaseMs * (2 ** Math.min(attempts - 1, 6)))).toISOString();
      store.markApprovalResultFailure(entry.event_id, err, retryAt);
      app.log.warn?.({ requestId: entry.request_id, eventId: entry.event_id, code: err.code, message: err.message }, 'CAM 审批结果回告 Edge 失败，将自动重试');
    }
  };
  const sendTransferReady = async (entry) => {
    store.markTransferAttempt(entry.event_id);
    try {
      const config = gateConfig.get();
      if (!config.edgeControlUrl) throw Object.assign(new Error('Edge 传输控制地址尚未配置'), { code: 'gate_address_missing' });
      const response = await fetchImpl(`${config.edgeControlUrl.replace(/\/$/u, '')}/api/v1/gate/transfer-requests`, {
        method: 'POST', headers: await keyring.requestHeaders('POST', '/api/v1/gate/transfer-requests', JSON.stringify(entry.payload), { 'content-type': 'application/json' }),
        body: JSON.stringify(entry.payload), signal: AbortSignal.timeout(config.connectTimeoutMs)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `Edge 接收传输任务失败（HTTP ${response.status}）`), { code: body.error?.code ?? 'transfer_ready_delivery_failed' });
      if (body.accepted !== true || body.requestId !== entry.payload.requestId || body.transferTaskId !== entry.payload.transferTaskId || body.eventId !== entry.event_id) throw Object.assign(new Error('Edge 未确认接收该传输任务'), { code: 'transfer_ready_ack_invalid' });
      store.markTransferDelivered(entry.event_id);
    } catch (err) {
      const attempts = entry.attempts + 1;
      const retryAt = new Date(Date.now() + Math.min(300_000, 5_000 * (2 ** Math.min(attempts - 1, 6)))).toISOString();
      store.markTransferFailure(entry.event_id, err, retryAt);
      app.log.warn?.({ requestId: entry.request_id, eventId: entry.event_id, code: err.code, message: err.message }, 'CAM 传输任务通知 Edge 失败，将自动重试');
    }
  };
  async function pumpWorkers() {
    if (workerBusy) return;
    workerBusy = true;
    try {
      await expireCoreLogCollections(store);
      const timestamp = Date.now();
      for (const requestId of store.listCloudPending()) void submitCloud(requestId);
      for (const requestId of store.listCloudApprovalPending()) {
        if ((cloudStatusNextAttempt.get(requestId) ?? 0) > timestamp) continue;
        try { await syncCloudStatus(requestId); }
        catch (err) { app.log.warn?.({ requestId, code: err.code, message: err.message }, '云管审批状态查询失败，将自动重试'); }
      }
      for (const entry of store.listPendingApprovalResults()) await sendApprovalResult(entry);
      for (const entry of store.listPendingTransferReady()) await sendTransferReady(entry);
    } finally { workerBusy = false; }
  }
  const cloudTimer = setInterval(() => { void pumpWorkers(); }, workerIntervalMs);
  cloudTimer.unref?.();
  queueMicrotask(() => { void pumpWorkers(); });
  app.addHook('onClose', async () => clearInterval(cloudTimer));
  app.addHook('preHandler', async (request, reply) => {
    const exchangePath = request.url.startsWith('/api/v1/gate/approval-requests') || request.url.startsWith('/api/v1/gate/receipts') || request.url.startsWith('/api/v1/gate/transfers/') || request.url.startsWith('/api/v1/gate/log-collections') || request.url === '/api/v1/gate/transfer-failures' || request.url.startsWith('/api/v1/gate/pairing-probe') || request.url.startsWith('/api/v1/gate/identity-rotation/') || ['/api/v1/gate/authenticate', '/api/v1/gate/users', '/api/v1/gate/change-password'].includes(request.url.split('?')[0]);
    if (!exchangePath) return;
    const authorization = await gateAuthorized(request, keyring);
    if (authorization === 'pairing_required') return error(reply, 503, 'gate_pairing_required', 'Core 尚未完成 Edge 身份配对，暂不能接收跨区业务消息');
    if (!authorization) return error(reply, 401, 'gate_auth_required', '受控交换身份校验失败');
  });

  const agentPrincipal = (request) => store.authenticateAgent({
    agentId: request.headers['x-cam-agent-id'], keyId: request.headers['x-cam-agent-key-id'], timestamp: request.headers['x-cam-agent-timestamp'],
    nonce: request.headers['x-cam-agent-nonce'], signature: request.headers['x-cam-agent-signature'],
    method: request.method, path: request.url.split('?')[0], body: request.body === undefined ? '' : Buffer.isBuffer(request.body) ? request.body : JSON.stringify(request.body), allowPendingIdentity: true
  });
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/agent/')) return;
    const principal = agentPrincipal(request);
    if (!principal) return error(reply, 401, 'agent_auth_required', 'Agent 身份凭证无效或已禁用');
    if (principal.status === 'PENDING' && !((request.method === 'GET' && request.url.split('?')[0] === '/api/v1/agent/identity') || (request.method === 'POST' && ['/api/v1/agent/identity/confirm', '/api/v1/agent/core-identity/confirm'].includes(request.url.split('?')[0])))) return error(reply, 403, 'agent_identity_pending', 'Agent 尚未通过重新启用后的身份验证');
    request.agentPrincipal = principal;
  });

  app.get('/api/v1/agents', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    return { items: store.listAgents() };
  });
  app.get('/api/v1/distribution-agents', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    return { items: store.listDistributionAgents() };
  });
  app.get('/api/v1/agent-service-identity', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    const pendingIdentity = agentServiceIdentity?.pendingIdentity;
    let fileStatus = 'unknown';
    if (agentServiceIdentityPath) { try { await stat(agentServiceIdentityPath); fileStatus = 'available'; } catch (error) { if (error.code === 'ENOENT') fileStatus = 'missing'; else fileStatus = 'unreadable'; } }
    return { publicKey: agentServiceIdentity?.publicKeyPem ?? null, fingerprint: agentServiceIdentity?.fingerprint ?? null, previousPublicKey: agentServiceIdentity?.previousPublicKeyPem ?? null, previousFingerprint: agentServiceIdentity?.previousFingerprint ?? null, lastRotationSkippedAgentCount: agentServiceIdentity?.lastRotationSkippedAgentCount ?? 0, agentRotationPolicy: store.getAgentRotationPolicy(), identityFile: { status: fileStatus, path: agentServiceIdentityPath ? '[Core 数据目录]/core-agent-identity.json' : null }, pendingRotation: pendingIdentity ? { rotationId: pendingIdentity.rotationId, publicKey: pendingIdentity.publicKeyPem, fingerprint: pendingIdentity.fingerprint, activationDeadlineAt: pendingIdentity.activationDeadlineAt ?? null, graceHours: pendingIdentity.graceHours ?? store.getAgentRotationPolicy().graceHours, ...store.getCoreIdentityRotationStatus(pendingIdentity.rotationId) } : null };
  });
  app.put('/api/v1/agent-rotation-policy', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try { return { item: store.setAgentRotationPolicy(request.body ?? {}) }; }
    catch (err) { return error(reply, 400, err.code ?? 'agent_policy_invalid', err.message); }
  });
  app.post('/api/v1/agent-service-identity/rotate', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    if (typeof stageAgentServiceIdentityRotation !== 'function') return error(reply, 503, 'service_identity_unavailable', 'Core 服务身份轮换不可用');
    try { return reply.code(202).send(await stageAgentServiceIdentityRotation()); }
    catch (err) { return error(reply, 500, 'service_identity_rotation_failed', err.message); }
  });
  app.post('/api/v1/agents', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try { return reply.code(201).send({ item: store.registerAgent(request.body ?? {}) }); }
    catch (err) { return error(reply, 400, err.code ?? 'agent_invalid', err.message); }
  });
  app.post('/api/v1/agents/:agentId/rotate', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try { return reply.code(202).send({ item: store.requestAgentRotation(request.params.agentId) }); }
    catch (err) { return error(reply, 400, err.code ?? 'agent_rotation_failed', err.message); }
  });
  app.patch('/api/v1/agents/:agentId', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try {
      if (!store.setAgentStatus(request.params.agentId, request.body?.status)) return error(reply, 404, 'agent_not_found', 'Agent 不存在');
      return { ok: true, item: store.getAgentIdentity(request.params.agentId) };
    }
    catch (err) { return error(reply, 400, err.code ?? 'agent_invalid', err.message); }
  });
  app.post('/api/v1/agent/key-rotation', { bodyLimit: 8192 }, async (request, reply) => {
    const proof = request.headers['x-cam-agent-new-key-proof'];
    if (!verifyRequest(request.body?.publicKey, proof, request.method, request.url.split('?')[0], request.headers['x-cam-agent-timestamp'], request.headers['x-cam-agent-nonce'], JSON.stringify(request.body))) return error(reply, 400, 'agent_new_key_proof_invalid', '新身份签名校验失败');
    if (typeof request.body?.expectedKeyId !== 'string') return error(reply, 400, 'agent_expected_key_required', '缺少原身份指纹');
    try { return { item: store.rotateAgentKey(request.agentPrincipal.agentId, request.body.publicKey, undefined, { signingKeyId: request.agentPrincipal.signingKeyId, expectedKeyId: request.body.expectedKeyId }) }; }
    catch (err) { return error(reply, 400, err.code ?? 'agent_rotation_failed', err.message); }
  });
  app.get('/api/v1/agent/identity', async (request) => ({ item: store.getAgentIdentity(request.agentPrincipal.agentId) }));
  app.post('/api/v1/agent/log-collections/pull', { bodyLimit: 4096 }, async (request) => ({ items: store.listPendingLogCollections(request.agentPrincipal.agentId) }));
  app.put('/api/v1/agent/log-collections/:jobId', { bodyLimit: Number(process.env.CAM_LOG_COLLECTION_MAX_BYTES ?? 100 * 1024 * 1024) + 1024 * 1024 }, async (request, reply) => {
    const body = Buffer.isBuffer(request.body) ? request.body : null;
    if (!body || !body.length) return error(reply, 400, 'log_collection_empty', '日志归档为空');
    const declared = String(request.headers['x-log-sha256'] ?? '').toLowerCase();
    const received = createHash('sha256').update(body).digest('hex');
    if (!/^[a-f0-9]{64}$/u.test(declared) || declared !== received) return error(reply, 400, 'log_collection_digest_invalid', '日志归档摘要校验失败');
    const dir = join(store.dataDir, 'log-collections', request.params.jobId, 'agents');
    await mkdir(dir, { recursive: true, mode: 0o750 });
    const path = join(dir, `${request.agentPrincipal.agentId}.tar.gz`);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, body, { mode: 0o640 });
    await rename(temporary, path);
    const item = store.saveAgentLogCollection(request.params.jobId, request.agentPrincipal.agentId, path, received, body.length);
    if (item?.status === 'PACKAGING') queueMicrotask(() => { void buildCoreLogCollection(store, request.params.jobId).catch((err) => { app.log.error?.({ jobId: request.params.jobId, message: err.message }, 'Core 日志归档失败'); }); });
    return reply.send({ accepted: true, item: { jobId: request.params.jobId, status: item.status } });
  });
  app.post('/api/v1/agent/identity/confirm', { bodyLimit: 4096 }, async (request, reply) => {
    try { return { item: store.confirmAgentIdentity(request.agentPrincipal) }; }
    catch (err) { return error(reply, 409, err.code ?? 'agent_confirmation_failed', err.message); }
  });
  app.post('/api/v1/agent/core-identity/confirm', { bodyLimit: 4096 }, async (request, reply) => {
    const pending = agentServiceIdentity?.pendingIdentity;
    const { rotationId, fingerprint } = request.body ?? {};
    if (!pending) {
      if (rotationId === agentServiceIdentity?.rotationId && fingerprint === agentServiceIdentity?.fingerprint) return { ok: true, item: { rotationId, fingerprint, confirmed: true } };
      return error(reply, 409, 'core_identity_rotation_mismatch', 'Core 身份轮换提案已变化或不匹配');
    }
    if (rotationId !== pending.rotationId || fingerprint !== pending.fingerprint) return error(reply, 409, 'core_identity_rotation_mismatch', 'Core 身份轮换提案已变化或不匹配');
    try {
      const status = store.confirmCoreIdentity(request.agentPrincipal.agentId, { rotationId, fingerprint });
      if (!status.pending && typeof activateStagedAgentServiceIdentity === 'function') await activateStagedAgentServiceIdentity();
      return { ok: true, item: { rotationId, fingerprint, confirmed: true } };
    } catch (err) { return error(reply, 409, err.code ?? 'core_identity_confirmation_failed', err.message); }
  });
  app.post('/api/v1/agent/identity/failure', { bodyLimit: 4096 }, async (request, reply) => {
    try { return { item: store.reportAgentRotationFailure(request.agentPrincipal.agentId, request.body ?? {}) }; }
    catch (err) { return error(reply, 400, err.code ?? 'agent_rotation_report_invalid', err.message); }
  });
  app.post('/api/v1/gate/log-collections', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const item = store.createLogCollection({ fromAt: request.body?.fromAt, toAt: request.body?.toAt, categories: request.body?.categories, retentionDays: request.body?.retentionDays });
      if (item.status === 'PACKAGING') queueMicrotask(() => { void buildCoreLogCollection(store, item.jobId).catch((err) => { app.log.error?.({ jobId: item.jobId, message: err.message }, 'Core 日志归档失败'); }); });
      return reply.code(202).send({ item: { jobId: item.jobId, fromAt: item.fromAt, toAt: item.toAt, categories: item.categories, status: item.status, expiresAt: item.expiresAt } });
    } catch (err) { return error(reply, 400, err.code ?? 'log_collection_create_failed', err.message); }
  });
  app.get('/api/v1/gate/log-collections/:jobId', async (request, reply) => {
    const item = store.getLogCollection(request.params.jobId);
    if (!item) return error(reply, 404, 'log_collection_not_found', '日志收集任务不存在');
    if (item.status === 'PACKAGING' && item.agentCompleted === item.agentTotal) queueMicrotask(() => { void buildCoreLogCollection(store, item.jobId).catch((err) => { app.log.error?.({ jobId: item.jobId, message: err.message }, 'Core 日志归档失败'); }); });
    return reply.send({ item: { jobId: item.jobId, fromAt: item.fromAt, toAt: item.toAt, categories: item.categories, status: item.status, bundleSha256: item.bundleSha256, bundleSize: item.bundleSize, lastError: item.lastError, createdAt: item.createdAt, updatedAt: item.updatedAt, expiresAt: item.expiresAt } });
  });
  app.get('/api/v1/gate/log-collections/:jobId/bundle', async (request, reply) => {
    const item = store.getLogCollection(request.params.jobId); const bundle = store.getLogCollectionBundle(request.params.jobId);
    if (!item || !bundle) return error(reply, 404, 'log_collection_not_ready', '日志归档尚未准备完成');
    if (Date.parse(bundle.expiresAt) <= Date.now()) return error(reply, 410, 'log_collection_expired', '日志归档已过期');
    try {
      const info = await stat(bundle.path);
      const rangeHeader = request.headers.range;
      const match = typeof rangeHeader === 'string' && /^bytes=(\d+)-(\d*)$/u.exec(rangeHeader);
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(info.size - 1, Number(match[2])) : info.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= info.size) return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
      const length = end - start + 1;
      reply.code(match ? 206 : 200).type('application/gzip').header('Accept-Ranges', 'bytes').header('Content-Length', String(length)).header('X-Log-Bundle-Sha256', bundle.sha256);
      if (match) reply.header('Content-Range', `bytes ${start}-${end}/${info.size}`);
      return reply.send(createReadStream(bundle.path, { start, end }));
    } catch { return error(reply, 404, 'log_collection_bundle_missing', '日志归档文件不存在'); }
  });
  app.get('/api/v1/distribution-tasks', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    return { items: store.listDistributionTasks() };
  });
  app.get('/api/v1/transfer-monitor', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    return store.listTransferMonitor();
  });
  app.get('/api/v1/distribution-tasks/:taskId', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    const item = store.getDistributionTask(request.params.taskId);
    if (!item) return error(reply, 404, 'distribution_task_not_found', '分发任务不存在');
    return { item };
  });
  app.post('/api/v1/distribution-tasks', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try { return reply.code(201).send({ item: store.createDistributionTask(request.body ?? {}) }); }
    catch (err) { return error(reply, err.code === 'artifact_not_found' ? 404 : 409, err.code ?? 'distribution_task_invalid', err.message); }
  });
  app.post('/api/v1/distribution-tasks/:taskId/start', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try { return { item: store.startDistributionTask(request.params.taskId) }; }
    catch (err) { return error(reply, 409, err.code ?? 'distribution_start_rejected', err.message); }
  });
  app.post('/api/v1/distribution-tasks/:taskId/retry', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try { return { item: store.retryDistributionTaskFromCore(request.params.taskId) }; }
    catch (err) { return error(reply, 409, err.code ?? 'distribution_retry_rejected', err.message); }
  });
  app.post('/api/v1/distribution-tasks/:taskId/control', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try { return { item: store.controlDistributionTask(request.params.taskId, request.body?.action) }; }
    catch (err) { return error(reply, 409, err.code ?? 'distribution_control_rejected', err.message); }
  });
  app.get('/api/v1/agent/available-artifacts', async (request, reply) => {
    const taskByArtifact = store.listLatestAgentDistributionTasks(request.agentPrincipal.agentId);
    return reply.send({ items: store.listArtifacts({ includeRoundMetadata: true }).map(({ artifactId, productName, displayVersion, version, revision, releaseId, roundId, roundNo, manifestSha256, cloudApprovalId, transferTaskId, files, receivedAt }) => {
      const task = taskByArtifact.get(artifactId);
      return { artifactId, productName, displayVersion, version, revision, releaseId, roundId, roundNo, manifestSha256, cloudApprovalId, transferTaskId, distributionAuthorized: Boolean(task), distributionTask: task ? { taskId: task.taskId, status: task.status, scheduledAt: task.scheduledAt, chunkConcurrency: task.chunkConcurrency, attempts: task.attempts, retryAt: task.retryAt, lastError: task.lastError, updatedAt: task.updatedAt, completedAt: task.completedAt } : null, files: files.map(({ packageKey, fileName, sizeBytes, sha256, source, stored }) => ({ packageKey, fileName, sizeBytes, sha256, source, stored })), receivedAt };
    }) });
  });
  app.post('/api/v1/agent/distribution-tasks', { bodyLimit: 8192 }, async (request, reply) => {
    try { return reply.code(201).send({ item: store.createDistributionTask({ agentId: request.agentPrincipal.agentId, artifactId: request.body?.artifactId }) }); }
    catch (err) { return error(reply, err.code === 'artifact_not_found' ? 404 : 409, err.code ?? 'distribution_task_invalid', err.message); }
  });
  app.post('/api/v1/agent/tasks/pull', async (request, reply) => {
    const agent = request.agentPrincipal;
    const tasks = store.listAgentTasks(agent.agentId);
    return { items: tasks };
  });
  app.get('/api/v1/agent/tasks/:taskId/manifest', async (request, reply) => {
    const task = store.getDistributionTask(request.params.taskId);
    if (!task || task.agentId !== request.agentPrincipal.agentId) return error(reply, 404, 'distribution_task_not_found', '分发任务不存在');
    return { item: task };
  });
  app.post('/api/v1/agent/tasks/:taskId/progress', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    try { return { item: store.updateDistributionTask(request.agentPrincipal.agentId, request.params.taskId, request.body ?? {}) }; }
    catch (err) { return error(reply, 409, err.code ?? 'distribution_progress_rejected', err.message); }
  });
  app.post('/api/v1/agent/tasks/:taskId/retry', { bodyLimit: 4096 }, async (request, reply) => {
    try { return { item: store.retryDistributionTask(request.agentPrincipal.agentId, request.params.taskId) }; }
    catch (err) { return error(reply, 409, err.code ?? 'distribution_retry_rejected', err.message); }
  });
  app.get('/api/v1/agent/tasks/:taskId/files/:sha256/parts/:index', async (request, reply) => {
    const file = store.getAuthorizedDistributionFile(request.agentPrincipal.agentId, request.params.taskId, request.params.sha256);
    if (!file) return error(reply, 404, 'distribution_file_not_found', '分发文件不存在或未授权');
    const chunkSize = Number(request.headers['x-cam-chunk-size'] ?? 4 * 1024 * 1024);
    const index = Number(request.params.index);
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || !Number.isSafeInteger(index) || index < 0) return error(reply, 400, 'distribution_chunk_invalid', '分块参数无效');
    const count = Math.ceil(file.sizeBytes / chunkSize);
    if (index >= count) return error(reply, 416, 'distribution_chunk_invalid', '分块序号超出范围');
    const start = index * chunkSize; const end = Math.min(file.sizeBytes - 1, start + chunkSize - 1);
    const stream = createReadStream(file.path, { start, end });
    return reply.code(206).header('Accept-Ranges', 'bytes').header('Content-Length', String(end - start + 1)).header('Content-Range', `bytes ${start}-${end}/${file.sizeBytes}`).header('X-CAM-SHA256', file.sha256).type('application/octet-stream').send(stream);
  });
  app.get('/api/v1/agent/cache/:artifactId', async (request, reply) => {
    const task = store.listAgentTasks(request.agentPrincipal.agentId).find((entry) => entry.artifactId === request.params.artifactId);
    return { ready: false, task: task ?? null };
  });

  app.get('/api/v1/gate/config', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    const item = gateConfig.get();
    const keys = await keyring.status();
    return reply.send({ item, identityConfigured: keys.keyConfigured, previousIdentityConfigured: Boolean(keys.previousKeyExpiresAt) });
  });
  app.put('/api/v1/gate/config', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try { const item = gateConfig.save(request.body ?? {}, request.principal.id); const keys = await keyring.status(); return reply.send({ item, identityConfigured: keys.keyConfigured, previousIdentityConfigured: Boolean(keys.previousKeyExpiresAt) }); }
    catch (err) { return error(reply, 400, err.code ?? 'gate_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/config/test', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    try {
      const config = normalizeGateConfig(Object.keys(request.body ?? {}).length ? request.body : gateConfig.get(), { requireUrls: true, requiredUrlFields: ['edgeControlUrl', 'edgeTransferUrl'] });
      const checks = {};
      for (const [name, url] of Object.entries({ edgeControlUrl: config.edgeControlUrl, edgeTransferUrl: config.edgeTransferUrl })) {
        checks[name] = await checkGateHealth(url, { timeoutMs: config.connectTimeoutMs });
      }
      return reply.send({ ok: true, checks });
    } catch (err) { return error(reply, 502, err.code ?? 'gate_test_failed', err.message); }
  });

  app.get('/api/v1/gate/keys', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    return { item: await keyring.status(), identityBundle: await keyring.identity() };
  });
  app.post('/api/v1/gate/keys/test', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    const status = await keyring.status();
    if (!status.peerTrusted) return error(reply, 409, 'gate_pairing_required', '请先导入 Edge 身份包');
    const config = gateConfig.get();
    if (!config.edgeControlUrl) return error(reply, 400, 'gate_address_missing', '请先配置 Edge 控制地址（内侧）');
    try {
      const path = '/api/v1/gate/pairing-probe';
      const response = await fetchImpl(`${config.edgeControlUrl.replace(/\/$/u, '')}${path}`, { headers: await keyring.requestHeaders('GET', path, '', { accept: 'application/json' }), signal: AbortSignal.timeout(config.connectTimeoutMs) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.role !== 'edge' || body.businessReady !== true || body.peerFingerprint !== status.identity.signingFingerprint) return error(reply, 502, body.error?.code ?? 'gate_pairing_probe_failed', body.error?.message ?? 'Edge 未确认身份配对状态');
      await keyring.markPeerConfirmed();
      return { ok: true, checks: { local: { role: 'core', peerTrusted: true, identityConfigured: true }, remote: { role: body.role, peerTrusted: body.peerTrusted, identityConfigured: body.keyConfigured }, authenticated: true } };
    } catch (err) { return error(reply, 502, err.code ?? 'gate_pairing_probe_failed', err.message ?? '无法连接 Edge 配对测试接口'); }
  });
  app.get('/api/v1/gate/pairing-probe', async (request, reply) => {
    const status = await keyring.status();
    if (!status.peerTrusted) return error(reply, 503, 'gate_pairing_required', 'Core 尚未保存 Edge 身份');
    return { role: 'core', peerTrusted: true, keyConfigured: true, businessReady: status.businessReady, activeKeyId: status.identity.signingFingerprint, peerFingerprint: status.peerFingerprint };
  });
  app.post('/api/v1/gate/identity-rotation/proposals', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try { return await keyring.acceptIdentityRotation(request.body ?? {}); }
    catch (err) { return error(reply, 409, err.code ?? 'gate_identity_rotation_rejected', err.message); }
  });
  app.put('/api/v1/gate/keys/trusted-peer', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    if (rotationInFlight) return error(reply, 409, 'gate_rotation_in_progress', '密钥正在协商，请完成后再更换对端身份');
    try {
      await keyring.trustPeer(request.body?.identityBundle);
      return { item: await keyring.status() };
    }
    catch (err) { return error(reply, 400, err.code ?? 'gate_peer_invalid', err.message); }
  });
  app.put('/api/v1/gate/keys/schedule', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    if (rotationInFlight) return error(reply, 409, 'gate_rotation_in_progress', '密钥正在协商，请完成后再修改轮换策略');
    try { return { item: await keyring.configure(request.body ?? {}) }; }
    catch (err) { return error(reply, 400, err.code ?? 'gate_rotation_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/keys/rotate', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try { return { item: await rotateKey() }; }
    catch (err) { return error(reply, 502, err.code ?? 'gate_rotation_failed', err.message); }
  });
  if (enableKeyRotation) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      try {
        if (!await keyring.needsRotation()) return;
        busy = true;
        await rotateKey();
        app.log.info({ fingerprint: (await keyring.status()).identity.signingFingerprint }, 'CAM Core 身份密钥已自动轮换');
      } catch (err) { app.log.warn({ code: err.code, message: err.message }, 'CAM Core 身份密钥轮换失败，将在下个周期重试'); }
      finally { busy = false; }
    }, 60_000);
    timer.unref();
    app.addHook('onClose', async () => clearInterval(timer));
  }

  app.post('/api/v1/gate/approval-requests', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    try {
      const accepted = store.receiveApproval(request.body ?? {});
      let item = accepted.item;
      if (!accepted.idempotent || (item.status === 'CLOUD_PENDING' && !item.cloudApprovalId)) queueMicrotask(() => { void submitCloud(item.requestId); });
      return reply.code(accepted.idempotent ? 200 : 202).send({ accepted: true, requestId: item.requestId, idempotent: accepted.idempotent });
    } catch (err) { return error(reply, err.code === 'request_conflict' ? 409 : 400, err.code ?? 'approval_request_rejected', err.message); }
  });

  app.get('/api/v1/cloud/config', async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    const item = store.getCloudConfig();
    return reply.send({ item: item ?? cloud.businessConfig(), source: item ? 'database' : 'environment', secretConfigured: cloud.enabled() });
  });

  app.put('/api/v1/cloud/config', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configWrite', '需要平台配置管理权限')) return;
    try {
      const config = request.body ?? {};
      const mappings = await cloud.resolveMappings(config);
      return reply.send({ item: store.saveCloudConfig(config, request.principal?.id, mappings) });
    } catch (err) { return error(reply, err.code === 'cloud_not_configured' ? 503 : ['cloud_config_invalid', 'cloud_mapping_not_configured'].includes(err.code) ? 400 : 502, err.code ?? 'cloud_config_invalid', err.message); }
  });

  app.post('/api/v1/cloud/test', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'configRead', '需要平台配置查看权限')) return;
    try { return reply.send({ mappings: await cloud.resolveMappings(request.body && Object.keys(request.body).length ? request.body : store.getCloudConfig()) }); }
    catch (err) { return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_test_failed', err.message); }
  });

  app.get('/api/v1/approval-requests', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    return reply.send({ items: store.list() });
  });

  app.get('/api/v1/artifacts', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    return reply.send({ items: store.listArtifacts() });
  });
  app.get('/api/v1/artifacts/:artifactId', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    const item = store.getArtifact(request.params.artifactId);
    return item ? reply.send({ item }) : error(reply, 404, 'artifact_baseline_not_found', '正式发布基线不存在');
  });

  app.post('/api/v1/gate/transfers/:transferTaskId/manifest', { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => {
    try { return reply.send({ item: store.setTransferManifest(request.params.transferTaskId, request.body?.manifest ?? request.body) }); }
    catch (err) { return error(reply, err.code === 'approval_required' ? 409 : 400, err.code ?? 'artifact_manifest_invalid', err.message); }
  });
  app.get('/api/v1/gate/transfers/:transferTaskId/manifest', async (request, reply) => {
    try {
      const transfer = store.expectedTransferArtifacts(request.params.transferTaskId);
      const partsByDigest = new Map();
      for (const digest of new Set(transfer.items.map((item) => String(item.actualSha256 ?? '').toLowerCase()))) partsByDigest.set(digest, store.listTransferParts(request.params.transferTaskId, digest).map((part) => part.partIndex));
      return reply.send({ transferTaskId: request.params.transferTaskId, requestId: transfer.requestId, manifestSha256: transfer.manifestSha256, items: transfer.items.map((item) => ({ ...item, stored: Boolean(store.artifactPath(String(item.actualSha256 ?? '').toLowerCase())), receivedParts: partsByDigest.get(String(item.actualSha256 ?? '').toLowerCase()) ?? [] })) });
    } catch (err) { return error(reply, err.code === 'approval_required' ? 409 : 400, err.code ?? 'artifact_manifest_invalid', err.message); }
  });

  app.put('/api/v1/gate/transfers/:transferTaskId/artifacts/:sha256', { bodyLimit: 1024 * 1024 * 1024 }, async (request, reply) => {
    const sha256 = String(request.params.sha256 ?? '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) return error(reply, 400, 'artifact_digest_invalid', '制品 SHA-256 格式无效');
    let temporary = null;
    let output = null;
    try {
      const transfer = store.expectedTransferArtifacts(request.params.transferTaskId);
      const entries = transfer.items.filter((item) => String(item.actualSha256).toLowerCase() === sha256);
      if (!entries.length) return error(reply, 409, 'artifact_not_approved', '该摘要不属于审批通过的制品清单');
      const expectedSize = Number(entries[0].sizeBytes);
      if (!Number.isSafeInteger(expectedSize) || entries.some((item) => Number(item.sizeBytes) !== expectedSize)) return error(reply, 409, 'artifact_manifest_invalid', '审批清单中的同一摘要大小不一致');
      temporary = join(store.dataDir, 'tmp', `artifact-${randomUUID()}.part`);
      await mkdir(dirname(temporary), { recursive: true });
      output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of request.raw) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > expectedSize) throw Object.assign(new Error('制品内容超过审批清单声明大小'), { code: 'artifact_size_mismatch' });
        hash.update(bytes);
        if (!output.write(bytes)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'close');
      if (size !== expectedSize) throw Object.assign(new Error('制品内容大小与审批清单不一致'), { code: 'artifact_size_mismatch' });
      const received = await store.receiveArtifact(request.params.transferTaskId, sha256, temporary, size, hash.digest('hex'));
      temporary = null;
      return reply.send({ transferTaskId: request.params.transferTaskId, ...received });
    } catch (err) {
      output?.destroy();
      if (temporary) await rm(temporary, { force: true });
      const status = ['approval_required', 'artifact_not_approved', 'artifact_manifest_missing', 'artifacts_incomplete'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'artifact_receive_failed', err.message);
    }
  });

  app.put('/api/v1/gate/transfers/:transferTaskId/artifacts/:sha256/parts/:index', { bodyLimit: 1024 * 1024 * 1024 }, async (request, reply) => {
    const sha256 = String(request.params.sha256 ?? '').toLowerCase();
    const index = Number(request.params.index);
    const chunkSize = Number(request.headers['x-cam-chunk-size']);
    const chunkCount = Number(request.headers['x-cam-chunk-count']);
    const offset = Number(request.headers['x-cam-chunk-offset']);
    const size = Number(request.headers['content-length']);
    if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(chunkSize) || !Number.isSafeInteger(chunkCount) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || size < 0) return error(reply, 400, 'artifact_chunk_invalid', '制品分块请求头无效');
    let temporary = null;
    let output = null;
    try {
      const transfer = store.expectedTransferArtifacts(request.params.transferTaskId);
      const expected = transfer.items.find((item) => String(item.actualSha256 ?? '').toLowerCase() === sha256);
      if (!expected) return error(reply, 409, 'artifact_not_approved', '该摘要不属于审批通过的制品清单');
      temporary = join(store.dataDir, 'tmp', `artifact-${randomUUID()}.chunk`);
      await mkdir(dirname(temporary), { recursive: true });
      output = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of request.raw) {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > size) throw Object.assign(new Error('分块内容超过声明大小'), { code: 'artifact_chunk_invalid' });
        hash.update(buffer);
        if (!output.write(buffer)) await once(output, 'drain');
      }
      output.end();
      await once(output, 'close');
      if (bytes !== size) throw Object.assign(new Error('分块内容大小与声明不一致'), { code: 'artifact_chunk_invalid' });
      const saved = await store.saveTransferPart(request.params.transferTaskId, sha256, {
        index, chunkSize, chunkCount, offset, size, sha256: hash.digest('hex'), temporaryPath: temporary
      });
      temporary = null;
      const assembled = saved.complete ? await store.assembleTransferParts(request.params.transferTaskId, sha256) : null;
      return reply.send({ transferTaskId: request.params.transferTaskId, sha256, ...saved, assembled });
    } catch (err) {
      output?.destroy();
      if (temporary) await rm(temporary, { force: true });
      const status = ['approval_required', 'artifact_not_approved', 'artifact_integrity_failed', 'artifact_chunk_invalid', 'artifact_chunk_conflict', 'artifact_chunk_incomplete'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'artifact_chunk_receive_failed', err.message);
    }
  });

  app.get('/api/v1/artifacts/:sha256/content', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    const path = store.artifactPath(String(request.params.sha256 ?? '').toLowerCase());
    if (!path) return error(reply, 404, 'artifact_not_found', '正式制品文件不存在');
    return reply.type('application/octet-stream').header('Content-Disposition', `attachment; filename="${request.params.sha256}"`).send(createReadStream(path));
  });

  app.post('/api/v1/gate/transfer-failures', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    try {
      const result = store.recordEdgeTransferFailure(request.body ?? {});
      return reply.send({ accepted: true, requestId: request.body?.requestId, transferTaskId: request.body?.transferTaskId, idempotent: result.idempotent });
    } catch (err) {
      const status = err.code === 'request_not_found' || err.code === 'transfer_task_not_found' ? 404 : ['transfer_failure_conflict', 'invalid_transfer_failure'].includes(err.code) ? 409 : 400;
      return error(reply, status, err.code ?? 'transfer_failure_rejected', err.message);
    }
  });

  app.get('/api/v1/approval-requests/:requestId', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    const item = store.get(request.params.requestId);
    return item ? reply.send({ item }) : error(reply, 404, 'request_not_found', 'approval request not found');
  });

  app.get('/api/v1/approval-requests/:requestId/transfer-progress', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    const item = store.getTransferProgress(request.params.requestId);
    return item ? reply.send({ item }) : error(reply, 404, 'request_not_found', 'approval request not found');
  });

  app.post('/api/v1/approval-requests/:requestId/transfer/retry', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    const item = store.get(request.params.requestId);
    if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
    if (item.status !== 'APPROVED' || !item.transferTaskId || !['FAILED', 'RETRY_WAIT'].includes(item.transferEdgeStatus)) return error(reply, 409, 'transfer_retry_unavailable', '当前 Edge → Core 传输状态不支持重试');
    const config = gateConfig.get();
    if (!config.edgeControlUrl) return error(reply, 503, 'gate_address_missing', 'Edge 传输控制地址尚未配置');
    const path = '/api/v1/gate/transfer-retry';
    const payload = { requestId: item.requestId, freezeId: item.freezeId, transferTaskId: item.transferTaskId, manifestSha256: item.manifestSha256 };
    const body = JSON.stringify(payload);
    try {
      const response = await fetchImpl(`${config.edgeControlUrl.replace(/\/$/u, '')}${path}`, {
        method: 'POST',
        headers: await keyring.requestHeaders('POST', path, body, { 'content-type': 'application/json' }),
        body,
        signal: AbortSignal.timeout(config.connectTimeoutMs)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return error(reply, response.status >= 500 ? 502 : response.status, result.error?.code ?? 'transfer_retry_failed', result.error?.message ?? `Edge 接收重试指令失败（HTTP ${response.status}）`);
      if (result.accepted !== true || result.requestId !== item.requestId || result.transferTaskId !== item.transferTaskId) return error(reply, 502, 'transfer_retry_ack_invalid', 'Edge 未确认接收传输重试指令');
      const idempotentState = ['RECEIVED', 'SENDING'].includes(result.status);
      const updated = idempotentState ? { item, idempotent: true } : store.markEdgeTransferRetryRequested(item.requestId);
      return reply.code(idempotentState && result.status === 'RECEIVED' ? 200 : 202).send({ item: updated.item, idempotent: Boolean(result.idempotent || updated.idempotent), edgeStatus: result.status });
    } catch (err) { return error(reply, 502, err.code ?? 'transfer_retry_failed', err.message); }
  });

  app.post('/api/v1/approval-requests/:requestId/retry', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    const item = store.get(request.params.requestId);
    if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
    if (item.status !== 'CLOUD_PENDING' || item.cloudApprovalId) return error(reply, 409, 'cloud_retry_not_available', '只有尚未创建云管工单的请求可以重试提交');
    if (cloudInFlight.has(item.requestId)) return reply.code(202).send({ item, inProgress: true });
    const queued = store.queueCloudRetry(item.requestId);
    queueMicrotask(() => { void submitCloud(item.requestId); });
    return reply.code(202).send({ item: queued, queued: true });
  });

  app.post('/api/v1/approval-requests/:requestId/withdraw', { bodyLimit: 4096 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try {
      const item = store.withdraw(request.params.requestId, request.principal?.id);
      cloudStatusNextAttempt.delete(request.params.requestId);
      store.enqueueApprovalResult(item.requestId);
      queueMicrotask(() => { void pumpWorkers(); });
      return reply.send({ item });
    } catch (err) {
      return error(reply, err.code === 'request_not_found' ? 404 : err.code === 'approval_withdraw_not_available' ? 409 : 400, err.code ?? 'approval_withdraw_failed', err.message);
    }
  });

  app.get('/api/v1/approval-requests/:requestId/report-file', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessRead', '需要正式制品业务查看权限')) return;
    const item = store.get(request.params.requestId);
    const path = store.reportPath(request.params.requestId);
    if (!item || !path || !item.reportReceived) return error(reply, 404, 'report_not_found', 'verification report not found');
    return reply.type(attachmentContentType(item.reportFileName)).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.reportFileName ?? 'verification-report.pdf')}`).send(createReadStream(path));
  });

  app.post('/api/v1/approval-requests/:requestId/sync', async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try {
      const item = store.get(request.params.requestId);
      if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
      if (item.status === 'WITHDRAWN') return reply.send({ item });
      if (!item.cloudApprovalId) return error(reply, 409, 'cloud_submission_pending', 'cloud approval has not been created');
      if (item.closeStatus === 'CLOSED') return reply.send({ item });
      const updated = await syncCloudStatus(item.requestId);
      return reply.send({ item: updated });
    } catch (err) { store.markError(request.params.requestId, err); return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_sync_failed', err.message); }
  });

  app.post('/api/v1/approval-requests/:requestId/transfer-authorize', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try {
      const item = store.authorizeTransfer(request.params.requestId, request.body ?? {});
      store.enqueueTransferReady(request.params.requestId);
      queueMicrotask(() => { void pumpWorkers(); });
      return reply.send({ item });
    }
    catch (err) { return error(reply, ['approval_required', 'approval_expired', 'manifest_mismatch', 'transfer_task_mismatch'].includes(err.code) ? 409 : err.code === 'request_not_found' ? 404 : 400, err.code ?? 'transfer_not_authorized', err.message); }
  });

  app.post('/api/v1/gate/receipts', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      const body = request.body ?? {};
      const transfer = store.expectedTransferArtifacts(body.transferTaskId);
      if (transfer.items.length) store.assertTransferComplete(body.transferTaskId);
      return reply.send({ item: store.receiveReceipt(body) });
    }
    catch (err) { return error(reply, ['approval_required', 'manifest_mismatch', 'transfer_task_mismatch'].includes(err.code) ? 409 : err.code === 'request_not_found' ? 404 : 400, err.code ?? 'receipt_rejected', err.message); }
  });

  app.post('/api/v1/approval-requests/:requestId/close', { bodyLimit: 8192 }, async (request, reply) => {
    if (requireCorePermission(request, reply, 'businessWrite', '需要正式制品业务操作权限')) return;
    try {
      const item = store.get(request.params.requestId);
      if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
      if (item.closeStatus === 'CLOSED') return reply.send({ item });
      if (item.status !== 'APPROVED' || item.transferStatus !== 'RECEIVED') return error(reply, 409, 'transfer_not_received', '制品接收回执未到达，暂不能关单');
      if (item.cloudApprovalId) await cloud.closeApproval(item.cloudApprovalId, request.body ?? {});
      return reply.send({ item: store.close(item.requestId, { status: 'CLOSED' }) });
    } catch (err) { if (err.code === 'transfer_not_received') return error(reply, 409, err.code, err.message); store.markError(request.params.requestId, err); return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_close_failed', err.message); }
  });
}
