import { timingSafeEqual } from 'node:crypto';

function error(reply, status, code, message) { return reply.code(status).send({ error: { code, message } }); }

function gateAuthorized(request, sharedSecret) {
  if (!sharedSecret) return process.env.NODE_ENV !== 'production';
  const received = request.headers['x-cam-gate-secret'];
  if (typeof received !== 'string') return false;
  const actual = Buffer.from(received);
  const expected = Buffer.from(sharedSecret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function registerCoreRoutes(app, { store, cloud, gateSecret }) {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/v1/gate/')) return;
    if (!gateAuthorized(request, gateSecret)) return error(reply, 401, 'gate_auth_required', '受控交换身份校验失败');
  });

  app.post('/api/v1/gate/approval-requests', { bodyLimit: 1024 * 1024 }, async (request, reply) => {
    try {
      const accepted = store.receiveApproval(request.body ?? {});
      let item = accepted.item;
      if (!accepted.idempotent) {
        try { item = store.markCloudSubmitted(item.requestId, await cloud.createApproval(request.body ?? {})); }
        catch (err) { store.markError(item.requestId, err); }
      }
      return reply.code(accepted.idempotent ? 200 : 202).send({ item, idempotent: accepted.idempotent, cloudSubmission: item.status !== 'CLOUD_PENDING' });
    } catch (err) { return error(reply, err.code === 'request_conflict' ? 409 : 400, err.code ?? 'approval_request_rejected', err.message); }
  });

  app.get('/api/v1/approval-requests/:requestId', async (request, reply) => {
    const item = store.get(request.params.requestId);
    return item ? reply.send({ item }) : error(reply, 404, 'request_not_found', 'approval request not found');
  });

  app.post('/api/v1/approval-requests/:requestId/sync', async (request, reply) => {
    try {
      const item = store.get(request.params.requestId);
      if (!item) return error(reply, 404, 'request_not_found', 'approval request not found');
      if (!item.cloudApprovalId) return error(reply, 409, 'cloud_submission_pending', 'cloud approval has not been created');
      return reply.send({ item: store.applyCloudStatus(item.requestId, await cloud.getApproval(item.cloudApprovalId)) });
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
      if (item.cloudApprovalId) await cloud.closeApproval(item.cloudApprovalId, request.body ?? {});
      return reply.send({ item: store.close(item.requestId, { status: 'CLOSED' }) });
    } catch (err) { store.markError(request.params.requestId, err); return error(reply, err.code === 'cloud_not_configured' ? 503 : 502, err.code ?? 'cloud_close_failed', err.message); }
  });
}
