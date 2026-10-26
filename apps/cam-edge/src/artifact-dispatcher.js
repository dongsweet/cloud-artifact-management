import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const retryDelay = (attempt) => Math.min(300_000, 5_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));
const errorCode = (error) => error?.name === 'TimeoutError' || error?.code === 23 || error?.code === '23'
  ? 'ETIMEDOUT'
  : error?.code ? String(error.code).slice(0, 128) : 'artifact_transfer_failed';

export function createArtifactDispatcher({ freezes, candidates, gateConfig, keyring, fetchImpl = fetch, logger = console, intervalMs = 5_000 }) {
  let timer = null;
  let busy = false;
  let closed = false;
  const nextAttemptAt = new Map();
  const reconciled = new Set();

  async function request(url, config, options = {}) {
    const method = options.method ?? 'GET';
    const parsed = new URL(url);
    const path = `${parsed.pathname}${parsed.search}`;
    const body = options.body && typeof options.body === 'object' && typeof options.body[Symbol.asyncIterator] === 'function' ? '' : options.body ?? '';
    const headers = await keyring.requestHeaders(method, path, body, options.headers ?? {}, options.headers?.['x-cam-chunk-sha256'] ? { bodyDigest: options.headers['x-cam-chunk-sha256'] } : {});
    return fetchImpl(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(config.transferTimeoutMs)
    });
  }

  async function reportFailure(freeze, error, { attempt, retryAt, terminal, config }) {
    const controlUrl = config?.coreControlUrl;
    if (!controlUrl) return;
    const path = '/api/v1/gate/transfer-failures';
    const payload = {
      requestId: freeze.freezeId,
      freezeId: freeze.freezeId,
      transferTaskId: freeze.transferTaskId,
      manifestSha256: freeze.manifestSha256,
      attempt,
      code: errorCode(error),
      message: String(error?.message ?? error).slice(0, 1000),
      retryAt: retryAt ?? null,
      terminal: Boolean(terminal),
      occurredAt: new Date().toISOString()
    };
    const body = JSON.stringify(payload);
    const response = await fetchImpl(`${controlUrl.replace(/\/$/u, '')}${path}`, {
      method: 'POST',
      headers: await keyring.requestHeaders('POST', path, body, { 'content-type': 'application/json' }),
      body,
      signal: AbortSignal.timeout(config.connectTimeoutMs ?? 10_000)
    });
    if (!response.ok) {
      const responseBody = await response.json().catch(() => ({}));
      throw Object.assign(new Error(responseBody.error?.message ?? `Core 接收传输失败报告失败（HTTP ${response.status}）`), { code: responseBody.error?.code ?? 'transfer_failure_report_failed' });
    }
  }

  async function deliver(freezeId) {
    let freeze = freezes.get(freezeId);
    if (!freeze || freeze.status !== 'APPROVED' || !freeze.transferTaskId) return freeze;
    const attempt = (freeze.transferAttempts ?? 0) + 1;
    const repairingReceipt = freeze.transferStatus === 'RECEIVED';
    if (!repairingReceipt) freezes.markTransferAttempt(freezeId);
    try {
      const config = gateConfig.get();
      if (!config.coreTransferUrl) throw Object.assign(new Error('请先配置 Edge 外侧访问 Core 的制品传输地址'), { code: 'gate_address_missing' });
      const base = config.coreTransferUrl.replace(/\/$/u, '');
      const path = `/api/v1/gate/transfers/${encodeURIComponent(freeze.transferTaskId)}`;
      const readManifest = async () => {
        const response = await request(`${base}${path}/manifest`, config);
        return { response, body: await response.json().catch(() => ({})) };
      };
      let { response: manifestResponse, body: manifestBody } = await readManifest();
      if (!manifestResponse.ok) throw Object.assign(new Error(manifestBody.error?.message ?? `读取 Core 获批清单失败（HTTP ${manifestResponse.status}）`), { code: manifestBody.error?.code ?? 'transfer_manifest_failed' });
      if (manifestBody.requestId !== freeze.freezeId || manifestBody.transferTaskId !== freeze.transferTaskId || manifestBody.manifestSha256 !== freeze.manifestSha256 || !Array.isArray(manifestBody.items)) throw Object.assign(new Error('Core 返回的清单与 Edge 审批记录不一致'), { code: 'transfer_manifest_mismatch' });
      if (manifestBody.items.length === 0 && Array.isArray(freeze.manifest?.items) && freeze.manifest.items.length > 0) {
        const syncResponse = await request(`${base}${path}/manifest`, config, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: freeze.manifest })
        });
        const syncBody = await syncResponse.json().catch(() => ({}));
        if (!syncResponse.ok) throw Object.assign(new Error(syncBody.error?.message ?? `向 Core 同步正式制品清单失败（HTTP ${syncResponse.status}）`), { code: syncBody.error?.code ?? 'transfer_manifest_sync_failed' });
        ({ response: manifestResponse, body: manifestBody } = await readManifest());
        if (!manifestResponse.ok || !Array.isArray(manifestBody.items) || manifestBody.items.length === 0) throw Object.assign(new Error('Core 同步后仍未返回正式制品清单'), { code: 'transfer_manifest_sync_failed' });
      }
      if (manifestBody.items.length === 0) throw Object.assign(new Error('Core 和 Edge 均未携带正式制品清单，不能完成传输'), { code: 'transfer_manifest_missing' });
      if (freeze.transferStatus === 'RECEIVED' && manifestBody.items.length > 0 && manifestBody.items.every((item) => item.stored)) {
        reconciled.add(freezeId);
        nextAttemptAt.set(freezeId, Number.POSITIVE_INFINITY);
        return freeze;
      }
      const chunkSize = Math.min(config.chunkSizeBytes, 32 * 1024 * 1024);
      const sent = new Set();
      for (const item of manifestBody.items) {
        const sha256 = String(item.actualSha256 ?? '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) throw Object.assign(new Error('获批清单包含无效的文件摘要或大小'), { code: 'transfer_manifest_invalid' });
        if (sent.has(sha256) || item.stored) { sent.add(sha256); continue; }
        const candidate = candidates.get(item.candidateId);
        if (!candidate || candidate.status !== 'COMPLETED' || !candidate.source_path || candidate.final_sha256?.toLowerCase() !== sha256 || candidate.expected_size !== item.sizeBytes) throw Object.assign(new Error(`Edge 找不到已校验的源文件：${item.fileName}`), { code: 'transfer_source_missing' });
        const info = await stat(candidate.source_path);
        if (!info.isFile() || info.size !== item.sizeBytes) throw Object.assign(new Error(`源文件大小与获批清单不匹配：${item.fileName}`), { code: 'transfer_source_changed' });
        const fullHash = createHash('sha256');
        for await (const chunk of createReadStream(candidate.source_path)) fullHash.update(chunk);
        if (fullHash.digest('hex') !== sha256) throw Object.assign(new Error(`源文件 SHA-256 与获批清单不匹配：${item.fileName}`), { code: 'transfer_source_changed' });

        if (item.sizeBytes === 0) {
          const url = `${base}${path}/artifacts/${sha256}`;
          const response = await request(url, config, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': '0' }, body: Buffer.alloc(0) });
          if (!response.ok) throw await responseError(response, '空制品上传失败');
        } else {
          const count = Math.ceil(item.sizeBytes / chunkSize);
          const receivedParts = new Set(Array.isArray(item.receivedParts) ? item.receivedParts : []);
          for (let index = 0; index < count; index += 1) {
            if (receivedParts.has(index)) continue;
            const offset = index * chunkSize;
            const size = Math.min(chunkSize, item.sizeBytes - offset);
            const partHash = createHash('sha256');
            const stream = createReadStream(candidate.source_path, { start: offset, end: offset + size - 1 });
            for await (const chunk of stream) partHash.update(chunk);
            const digest = partHash.digest('hex');
            const bodyStream = createReadStream(candidate.source_path, { start: offset, end: offset + size - 1 });
            const response = await request(`${base}${path}/artifacts/${sha256}/parts/${index}`, config, {
              method: 'PUT', duplex: 'half', body: bodyStream,
              headers: {
                'content-type': 'application/octet-stream', 'content-length': String(size),
                'x-cam-chunk-size': String(chunkSize), 'x-cam-chunk-count': String(count),
                'x-cam-chunk-offset': String(offset), 'x-cam-chunk-sha256': digest
              }
            });
            if (!response.ok) throw await responseError(response, `制品 ${item.fileName} 第 ${index + 1}/${count} 块上传失败`);
          }
        }
        sent.add(sha256);
      }
      const receiptResponse = await request(`${base}/api/v1/gate/receipts`, config, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: freeze.freezeId, transferTaskId: freeze.transferTaskId, manifestSha256: freeze.manifestSha256 })
      });
      if (!receiptResponse.ok) throw await responseError(receiptResponse, 'Core 拒绝接收正式制品回执');
      freezes.markTransferSuccess(freezeId);
      reconciled.add(freezeId);
      nextAttemptAt.set(freezeId, Number.POSITIVE_INFINITY);
      nextAttemptAt.delete(freezeId);
      return freezes.get(freezeId);
    } catch (error) {
      const config = (() => { try { return gateConfig.get(); } catch { return {}; } })();
      const retryLimit = Number.isSafeInteger(config.retryLimit) && config.retryLimit > 0 ? config.retryLimit : 5;
      const terminal = attempt >= retryLimit;
      const retryAt = terminal ? null : new Date(Date.now() + retryDelay(attempt)).toISOString();
      freezes.markTransferFailure(freezeId, error, { retryAt, exhausted: terminal });
      nextAttemptAt.set(freezeId, terminal ? Number.POSITIVE_INFINITY : Date.parse(retryAt));
      try {
        await reportFailure(freeze, error, { attempt, retryAt, terminal, config });
      } catch (reportError) {
        logger.warn?.({ freezeId, attempt, code: reportError.code, message: reportError.message }, 'CAM 正式制品传输失败报告 Core 失败');
      }
      logger.warn?.({ freezeId, attempt, retryLimit, terminal, retryAt, code: error.code, message: error.message }, terminal ? 'CAM 正式制品传输失败，已停止自动重试' : 'CAM 正式制品传输失败，将自动重试');
      return freezes.get(freezeId);
    }
  }

  async function responseError(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return Object.assign(new Error(body.error?.message ?? `${fallback}（HTTP ${response.status}）`), { code: body.error?.code ?? 'artifact_transfer_failed', statusCode: response.status });
  }

  async function reconcileFailures() {
    if (typeof freezes.listTransferFailures !== 'function') return;
    let config;
    try { config = gateConfig.get(); } catch { return; }
    if (!config?.coreControlUrl) return;
    for (const freeze of freezes.listTransferFailures()) {
      if (!freeze.transferAttempts || !freeze.transferLastError) continue;
      const error = Object.assign(new Error(freeze.transferLastError), { code: freeze.transferErrorCode ?? 'artifact_transfer_failed' });
      try {
        await reportFailure(freeze, error, {
          attempt: freeze.transferAttempts,
          retryAt: freeze.transferRetryAt,
          terminal: Boolean(freeze.transferRetryExhausted),
          config
        });
      } catch (reportError) {
        logger.warn?.({ freezeId: freeze.freezeId, attempt: freeze.transferAttempts, code: reportError.code, message: reportError.message }, 'CAM Edge 启动时回告传输失败状态失败');
      }
    }
  }

  async function pump() {
    if (busy || closed) return;
    busy = true;
    try {
      for (const freeze of freezes.listTransferPending()) {
        if (closed) break;
        if (reconciled.has(freeze.freezeId)) continue;
        if ((nextAttemptAt.get(freeze.freezeId) ?? 0) > Date.now()) continue;
        await deliver(freeze.freezeId);
      }
    } finally { busy = false; }
  }

  function start() {
    if (timer || closed) return;
    timer = setInterval(() => { void pump(); }, intervalMs);
    timer.unref?.();
    void reconcileFailures();
    void pump();
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { deliver, pump, start, close };
}
