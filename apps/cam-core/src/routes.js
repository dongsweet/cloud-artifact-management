import { timingSafeEqual } from 'node:crypto';
import { normalizeGateConfig } from '../../../libs/cam-gate/src/config.js';
import { gateHealthCheck as checkGateHealth } from '../../../libs/cam-gate/src/client.js';

function error(reply, status, code, message) { return reply.code(status).send({ error: { code, message } }); }

function gateAuthorized(request, secrets) {
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

export function registerCoreRoutes(app, { store, cloud, gateSecret, previousGateSecret, gateConfig }) {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/gate/') || request.url.startsWith('/api/v1/gate/config')) return;
    if (!gateAuthorized(request, [gateSecret, previousGateSecret])) return error(reply, 401, 'gate_auth_required', '受控交换身份校验失败');
  });

  app.get('/api/v1/gate/config', async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置权限');
    const item = gateConfig.get();
    return reply.send({ item, secretConfigured: Boolean(gateSecret), previousSecretConfigured: Boolean(previousGateSecret) });
  });
  app.put('/api/v1/gate/config', { bodyLimit: 8192 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
    try { return reply.send({ item: gateConfig.save(request.body ?? {}, request.principal.id), secretConfigured: Boolean(gateSecret), previousSecretConfigured: Boolean(previousGateSecret) }); }
    catch (err) { return error(reply, 400, err.code ?? 'gate_config_invalid', err.message); }
  });
  app.post('/api/v1/gate/config/test', { bodyLimit: 8192 }, async (request, reply) => {
    if (!request.principal?.roles?.includes('CORE_ADMIN')) return error(reply, 403, 'admin_required', '需要内网网闸配置管理员权限');
    try {
      const config = normalizeGateConfig(Object.keys(request.body ?? {}).length ? request.body : gateConfig.get(), { requireUrls: true });
      const checks = {};
      for (const [name, url] of Object.entries({ edgeControlUrl: config.edgeControlUrl, edgeTransferUrl: config.edgeTransferUrl })) {
        checks[name] = await checkGateHealth(url, { timeoutMs: config.connectTimeoutMs });
      }
      return reply.send({ ok: true, checks });
    } catch (err) { return error(reply, 502, err.code ?? 'gate_test_failed', err.message); }
  });

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
