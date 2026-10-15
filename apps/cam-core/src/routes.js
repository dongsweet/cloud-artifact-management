import { timingSafeEqual } from 'node:crypto';
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

export function registerCoreRoutes(app, { store, cloud, gateSecret, previousGateSecret, gateConfig, keyring, enableKeyRotation = false }) {
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
      if (!accepted.idempotent) {
        try { item = store.markCloudSubmitted(item.requestId, await cloud.createApproval(request.body ?? {}, store.getCloudConfig())); }
        catch (err) { store.markError(item.requestId, err); }
      }
      return reply.code(accepted.idempotent ? 200 : 202).send({ item, idempotent: accepted.idempotent, cloudSubmission: item.status !== 'CLOUD_PENDING' });
    } catch (err) { return error(reply, err.code === 'request_conflict' ? 409 : 400, err.code ?? 'approval_request_rejected', err.message); }
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
