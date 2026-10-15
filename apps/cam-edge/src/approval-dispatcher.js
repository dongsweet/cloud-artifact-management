const retryDelay = (attempt) => Math.min(300_000, 5_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));

export function createApprovalDispatcher({ freezes, gateConfig, keyring, fetchImpl = fetch, logger = console, intervalMs = 5_000 }) {
  let timer = null;
  let busy = false;
  let closed = false;
  const nextAttemptAt = new Map();
  const nextStatusPollAt = new Map();

  async function coreRequest(path, config, secret, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.connectTimeoutMs);
    try {
      return await fetchImpl(`${config.coreControlUrl.replace(/\/$/u, '')}${path}`, {
        ...options,
        headers: { ...(options.headers ?? {}), 'x-cam-gate-secret': secret.toString('base64url') },
        signal: controller.signal
      });
    } finally { clearTimeout(timeout); }
  }

  async function dispatchOne(freezeId) {
    const freeze = freezes.get(freezeId);
    if (!freeze || freeze.status !== 'PENDING_APPROVAL' || freeze.dispatchStatus === 'DELIVERED') return freeze;
    const attempt = freeze.dispatchAttempts + 1;
    freezes.markDispatchAttempt(freezeId);
    try {
      const config = gateConfig.get();
      if (!config.coreControlUrl) throw Object.assign(new Error('请先配置 Edge 外侧访问 Core 的控制地址'), { code: 'gate_address_missing' });
      const secret = await keyring.currentSecret();
      if (!secret) throw Object.assign(new Error('网闸共享密钥尚未初始化，请先完成 Core/Edge 配对'), { code: 'gate_key_not_configured' });
      const response = await coreRequest('/api/v1/gate/approval-requests', config, secret, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(freezes.approvalEnvelope(freezeId))
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `Core 接收审批请求失败（HTTP ${response.status}）`), { code: body.error?.code ?? 'core_dispatch_rejected', statusCode: response.status });
      const updated = freezes.markDispatchSuccess(freezeId, body);
      nextAttemptAt.delete(freezeId);
      nextStatusPollAt.set(freezeId, Date.now() + 30_000);
      return updated;
    } catch (error) {
      freezes.markDispatchFailure(freezeId, error);
      nextAttemptAt.set(freezeId, Date.now() + retryDelay(attempt));
      logger.warn?.({ freezeId, attempt, code: error.code, message: error.message }, 'CAM 审批请求投递 Core 失败，将自动重试');
      return freezes.get(freezeId);
    }
  }

  async function pollCoreStatus(freeze) {
    const config = gateConfig.get();
    if (!config.coreControlUrl) return;
    const secret = await keyring.currentSecret();
    if (!secret) return;
    const response = await coreRequest(`/api/v1/gate/approval-requests/${encodeURIComponent(freeze.freezeId)}/sync`, config, secret, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `Core 状态查询失败（HTTP ${response.status}）`), { code: body.error?.code ?? 'core_status_sync_failed' });
    freezes.markCoreStatus(freeze.freezeId, body);
    nextStatusPollAt.set(freeze.freezeId, Date.now() + 30_000);
  }

  async function pump() {
    if (busy || closed) return;
    busy = true;
    try {
      for (const item of freezes.listDispatchPending()) {
        if (closed) break;
        if ((nextAttemptAt.get(item.freezeId) ?? 0) > Date.now()) continue;
        await dispatchOne(item.freezeId);
      }
      for (const item of freezes.list()) {
        if (closed) break;
        if (item.status !== 'PENDING_APPROVAL' || item.dispatchStatus !== 'DELIVERED' || !item.coreApprovalId || ['APPROVED', 'REJECTED', 'CLOSED'].includes(item.coreStatus)) continue;
        if ((nextStatusPollAt.get(item.freezeId) ?? 0) > Date.now()) continue;
        try { await pollCoreStatus(item); }
        catch (error) {
          nextStatusPollAt.set(item.freezeId, Date.now() + 60_000);
          logger.warn?.({ freezeId: item.freezeId, code: error.code, message: error.message }, 'CAM 云管审批状态同步失败，将稍后重试');
        }
      }
    } finally { busy = false; }
  }

  function start() {
    if (timer || closed) return;
    timer = setInterval(() => { void pump(); }, intervalMs);
    timer.unref?.();
    void pump();
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { dispatchOne, pump, start, close };
}
