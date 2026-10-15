import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { normalizeGateConfig } from '../../../libs/cam-gate/src/config.js';
import { gateHealthCheck as checkGateHealth } from '../../../libs/cam-gate/src/client.js';

function error(reply, status, code, message) { return reply.code(status).send({ error: { code, message } }); }

async function gateAuthorized(request, secrets, keyring) {
  if (keyring && await keyring.verifySecret(request.headers['x-cam-gate-secret'])) return true;
  const accepted = Array.isArray(secrets) ? secrets.filter(Boolean) : [secrets].filter(Boolean);
  if (!accepted.length) return process.env.NODE_ENV !== 'production';
  const received = request.headers['x-cam-gate-secret'];
  if (typeof received !== 'string') return false;
  const actual = Buffer.from(received);
  return accepted.some((secret) => {
    const expected = Buffer.from(secret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

async function rotateEdgeKey({ keyring, gateConfig }) {
  const config = gateConfig.get();
  if (!config.edgeControlUrl) throw Object.assign(new Error('请先配置 Edge 控制地址（内侧）'), { code: 'gate_address_missing' });
  let pending = await keyring.prepareProposal();
  const baseUrl = config.edgeControlUrl.replace(/\/$/u, '');
  if (pending.status === 'PROPOSAL_PENDING') {
    const secret = await keyring.currentSecret();
    if (!secret) throw Object.assign(new Error('尚未建立初始网闸密钥，不能发起轮换'), { code: 'gate_key_not_configured' });
    const proposed = await fetch(`${baseUrl}/api/v1/gate/key-rotation/proposals`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cam-gate-secret': secret.toString('base64url') }, body: JSON.stringify(pending.proposal), signal: AbortSignal.timeout(config.connectTimeoutMs)
    });
    const response = await proposed.json().catch(() => ({}));
    if (!proposed.ok) throw Object.assign(new Error(response.error?.message ?? `Edge 密钥提案失败（HTTP ${proposed.status}）`), { code: 'gate_rotation_proposal_failed' });
    pending = await keyring.verifyProof(response);
  }
  if (pending.status !== 'CONFIRM_PENDING') throw Object.assign(new Error('密钥轮换状态无效'), { code: 'gate_rotation_state_invalid' });
  const secret = await keyring.currentSecret();
  const confirmed = await fetch(`${baseUrl}/api/v1/gate/key-rotation/proposals/${encodeURIComponent(pending.id)}/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cam-gate-secret': secret.toString('base64url') }, body: JSON.stringify({ keyId: pending.id }), signal: AbortSignal.timeout(config.connectTimeoutMs)
  });
  const response = await confirmed.json().catch(() => ({}));
  if (!confirmed.ok) throw Object.assign(new Error(response.error?.message ?? `Edge 密钥确认失败（HTTP ${confirmed.status}）`), { code: 'gate_rotation_confirm_failed' });
  return keyring.markEdgeConfirmed(pending.id);
}

export function registerCoreRoutes(app, { store, cloud, gateSecret, previousGateSecret, gateConfig, keyring, enableKeyRotation = false, cloudRetryDelayMs = 30_000, fetchImpl = fetch }) {
  const cloudNextAttempt = new Map();
  const cloudInFlight = new Set();
  const ensureCloudReport = async (requestId, envelope) => {
    // Older control envelopes may contain only a report name/digest. New Edge
    // envelopes include reportSize and therefore require the binary transfer.
    if (!envelope?.reportFileName || !Number.isSafeInteger(envelope.reportSize)) return envelope;
    let path = store.reportPath(requestId);
    if (!path) {
      const config = gateConfig.get();
      if (!config.edgeTransferUrl) throw Object.assign(new Error('请先配置 Core 内侧访问 Edge 报告/回执映射地址'), { code: 'gate_address_missing' });
      const secret = await keyring.currentSecret();
      if (!secret) throw Object.assign(new Error('网闸共享密钥尚未初始化'), { code: 'gate_key_not_configured' });
      const reportUrl = `${config.edgeTransferUrl.replace(/\/$/u, '')}/api/v1/gate/transfer/reports/${encodeURIComponent(requestId)}`;
      const chunks = []; let offset = 0; const expected = envelope.reportSize; let reportResponseSha = null;
      while (offset < expected) {
        let received = false; let lastError = null;
        for (let attempt = 1; attempt <= 4 && !received; attempt++) try {
        const end = Math.min(expected - 1, offset + Math.max(1024 * 1024, Math.min(config.chunkSizeBytes, 4 * 1024 * 1024)) - 1);
        const response = await fetchImpl(reportUrl, { headers: { 'x-cam-gate-secret': secret.toString('base64url'), accept: 'application/pdf', range: `bytes=${offset}-${end}` }, signal: AbortSignal.timeout(config.transferTimeoutMs) });
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
    if (typeof cloud.uploadApprovalReport !== 'function') throw Object.assign(new Error('云管文件上传协议尚未接入：缺少上传接口路径、请求格式和附件标识解析规则'), { code: 'cloud_attachment_upload_unavailable' });
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
      const envelope = await ensureCloudReport(requestId, store.envelope(requestId));
      store.markCloudSubmitted(requestId, await cloud.createApproval(envelope, store.getCloudConfig()));
      cloudNextAttempt.delete(requestId);
    } catch (err) {
      store.markError(requestId, err);
      cloudNextAttempt.set(requestId, Date.now() + cloudRetryDelayMs);
      app.log.warn?.({ requestId, code: err.code, message: err.message }, '云管工单创建失败，将自动重试');
    } finally { cloudInFlight.delete(requestId); }
  };
  const cloudTimer = setInterval(() => {
    for (const requestId of store.listCloudPending()) if ((cloudNextAttempt.get(requestId) ?? 0) <= Date.now()) void submitCloud(requestId);
  }, 5_000);
  cloudTimer.unref?.();
  app.addHook('onClose', async () => clearInterval(cloudTimer));
  app.addHook('onRequest', async (request, reply) => {
    const exchangePath = request.url.startsWith('/api/v1/gate/approval-requests') || request.url.startsWith('/api/v1/gate/receipts');
    if (!exchangePath) return;
    if (!await gateAuthorized(request, [gateSecret, previousGateSecret], keyring)) return error(reply, 401, 'gate_auth_required', '受控交换身份校验失败');
  });

  app.get('/api/v1/gate/config', async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置权限');
    const item = gateConfig.get();
    const keys = await keyring.status();
    return reply.send({ item, secretConfigured: keys.keyConfigured, previousSecretConfigured: Boolean(keys.previousKeyExpiresAt) });
  });
  app.put('/api/v1/gate/config', { bodyLimit: 8192 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
    try { const item = gateConfig.save(request.body ?? {}, request.principal.id); const keys = await keyring.status(); return reply.send({ item, secretConfigured: keys.keyConfigured, previousSecretConfigured: Boolean(keys.previousKeyExpiresAt) }); }
    catch (err) { return error(reply, 400, err.code ?? 'gate_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/config/test', { bodyLimit: 8192 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
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
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置权限');
    return { item: await keyring.status(), identityBundle: await keyring.identity() };
  });
  app.put('/api/v1/gate/keys/trusted-peer', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
    try { return { item: await keyring.trustPeer(request.body?.identityBundle) }; }
    catch (err) { return error(reply, 400, err.code ?? 'gate_peer_invalid', err.message); }
  });
  app.put('/api/v1/gate/keys/schedule', { bodyLimit: 4096 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
    try { return { item: await keyring.configure(request.body ?? {}) }; }
    catch (err) { return error(reply, 400, err.code ?? 'gate_rotation_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/keys/rotate', async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
    try { return { item: await rotateEdgeKey({ keyring, gateConfig }) }; }
    catch (err) { return error(reply, 502, err.code ?? 'gate_rotation_failed', err.message); }
  });
  if (enableKeyRotation) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      try {
        if (!await keyring.needsRotation()) return;
        busy = true;
        await rotateEdgeKey({ keyring, gateConfig });
        app.log.info({ keyId: (await keyring.status()).activeKeyId }, 'CAM 网闸共享密钥已自动轮换');
      } catch (err) { app.log.warn({ code: err.code, message: err.message }, 'CAM 网闸共享密钥轮换失败，将在下个周期重试'); }
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
      return reply.code(accepted.idempotent ? 200 : 202).send({ item, idempotent: accepted.idempotent, cloudSubmission: false });
    } catch (err) { return error(reply, err.code === 'request_conflict' ? 409 : 400, err.code ?? 'approval_request_rejected', err.message); }
  });

  app.get('/api/v1/gate/approval-requests/:requestId', async (request, reply) => {
    const item = store.get(request.params.requestId);
    return item ? reply.send({ item }) : error(reply, 404, 'request_not_found', 'approval request not found');
  });

  app.post('/api/v1/gate/approval-requests/:requestId/sync', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      let item = store.get(request.params.requestId);
      if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
      if (!item.cloudApprovalId) {
        cloudNextAttempt.delete(item.requestId);
        queueMicrotask(() => { void submitCloud(item.requestId); });
        return reply.send({ item });
      }
      return reply.send({ item: store.applyCloudStatus(item.requestId, await cloud.getApproval(item.cloudApprovalId, item)) });
    } catch (err) { store.markError(request.params.requestId, err); return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_sync_failed', err.message); }
  });

  app.get('/api/v1/cloud/config', async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网发布审批管理员权限');
    const item = store.getCloudConfig();
    return reply.send({ item: item ?? cloud.businessConfig(), source: item ? 'database' : 'environment', secretConfigured: cloud.enabled() });
  });

  app.put('/api/v1/cloud/config', { bodyLimit: 8192 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网发布审批管理员权限');
    try {
      const config = request.body ?? {};
      const mappings = await cloud.resolveMappings(config);
      return reply.send({ item: store.saveCloudConfig(config, request.principal?.id, mappings) });
    } catch (err) { return error(reply, err.code === 'cloud_not_configured' ? 503 : ['cloud_config_invalid', 'cloud_mapping_not_configured'].includes(err.code) ? 400 : 502, err.code ?? 'cloud_config_invalid', err.message); }
  });

  app.post('/api/v1/cloud/test', { bodyLimit: 8192 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网发布审批管理员权限');
    try { return reply.send({ mappings: await cloud.resolveMappings(request.body && Object.keys(request.body).length ? request.body : store.getCloudConfig()) }); }
    catch (err) { return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_test_failed', err.message); }
  });

  app.get('/api/v1/approval-requests', async (_request, reply) => reply.send({ items: store.list() }));

  app.get('/api/v1/approval-requests/:requestId', async (request, reply) => {
    const item = store.get(request.params.requestId);
    return item ? reply.send({ item }) : error(reply, 404, 'request_not_found', 'approval request not found');
  });

  app.get('/api/v1/approval-requests/:requestId/report-file', async (request, reply) => {
    const item = store.get(request.params.requestId);
    const path = store.reportPath(request.params.requestId);
    if (!item || !path || !item.reportReceived) return error(reply, 404, 'report_not_found', 'verification report not found');
    return reply.type('application/pdf').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.reportFileName ?? 'verification-report.pdf')}`).send(createReadStream(path));
  });

  app.post('/api/v1/approval-requests/:requestId/sync', async (request, reply) => {
    try {
      const item = store.get(request.params.requestId);
      if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
      if (!item.cloudApprovalId) return error(reply, 409, 'cloud_submission_pending', 'cloud approval has not been created');
      if (item.closeStatus === 'CLOSED') return reply.send({ item });
      return reply.send({ item: store.applyCloudStatus(item.requestId, await cloud.getApproval(item.cloudApprovalId, item)) });
    } catch (err) { store.markError(request.params.requestId, err); return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_sync_failed', err.message); }
  });

  app.post('/api/v1/approval-requests/:requestId/transfer-authorize', { bodyLimit: 8192 }, async (request, reply) => {
    try { return reply.send({ item: store.authorizeTransfer(request.params.requestId, request.body ?? {}) }); }
    catch (err) { return error(reply, ['approval_required', 'approval_expired', 'manifest_mismatch', 'transfer_task_mismatch'].includes(err.code) ? 409 : err.code === 'request_not_found' ? 404 : 400, err.code ?? 'transfer_not_authorized', err.message); }
  });

  app.post('/api/v1/gate/receipts', { bodyLimit: 8192 }, async (request, reply) => {
    try { return reply.send({ item: store.receiveReceipt(request.body ?? {}) }); }
    catch (err) { return error(reply, ['approval_required', 'manifest_mismatch', 'transfer_task_mismatch'].includes(err.code) ? 409 : err.code === 'request_not_found' ? 404 : 400, err.code ?? 'receipt_rejected', err.message); }
  });

  app.post('/api/v1/approval-requests/:requestId/close', { bodyLimit: 8192 }, async (request, reply) => {
    try {
      const item = store.get(request.params.requestId);
      if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
      if (item.status !== 'APPROVED' || item.transferStatus !== 'RECEIVED') return error(reply, 409, 'transfer_not_received', '制品接收回执未到达，暂不能关单');
      if (item.cloudApprovalId) await cloud.closeApproval(item.cloudApprovalId, request.body ?? {});
      return reply.send({ item: store.close(item.requestId, { status: 'CLOSED' }) });
    } catch (err) { if (err.code === 'transfer_not_received') return error(reply, 409, err.code, err.message); store.markError(request.params.requestId, err); return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_close_failed', err.message); }
  });
}
