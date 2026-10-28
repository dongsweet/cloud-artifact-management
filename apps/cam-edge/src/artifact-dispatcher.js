import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const errorCode = (error) => error?.name === 'TimeoutError' || error?.code === 23 || error?.code === '23'
  ? 'ETIMEDOUT'
  : error?.code ? String(error.code).slice(0, 128) : 'artifact_transfer_failed';

export function createArtifactDispatcher({ freezes, candidates, gateConfig, keyring, fetchImpl = fetch, logger = console, intervalMs = 5_000 }) {
  let timer = null;
  let busy = false;
  let closed = false;
  const reconciled = new Set();
  const reportedStates = new Map();
  const heartbeatStops = new Map();

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

  async function reportState(freeze, state, { attempt = freeze.transferAttempts ?? 0, code = null, message = null, retryAt = null, terminal = false, config } = {}) {
    const controlUrl = config?.coreControlUrl;
    if (!controlUrl) return;
    const path = '/api/v1/gate/transfer-status';
    const stateKey = `${freeze.freezeId}:${freeze.transferTaskId}:${state}:${attempt}:${code ?? ''}:${retryAt ?? ''}:${terminal ? '1' : '0'}`;
    // Progress is deliberately not deduplicated: every completed chunk is a
    // liveness signal for Core's idle timeout watchdog.
    if (!['PROGRESS', 'HEARTBEAT'].includes(state) && reportedStates.get(freeze.freezeId) === stateKey) return;
    const payload = {
      requestId: freeze.freezeId,
      freezeId: freeze.freezeId,
      transferTaskId: freeze.transferTaskId,
      manifestSha256: freeze.manifestSha256,
      attempt,
      state,
      code: code ?? undefined,
      message: message ?? undefined,
      retryAt,
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
    if (state !== 'PROGRESS') reportedStates.set(freeze.freezeId, stateKey);
  }

  async function reportFailure(freeze, error, { attempt, config }) {
    return reportState(freeze, 'RETRY_WAIT', {
      attempt, code: errorCode(error), message: String(error?.message ?? error).slice(0, 1000), config
    });
  }

  function reportStateLater(freeze, state, options) {
    void reportState(freeze, state, options).catch((error) => {
      logger.warn?.({ freezeId: freeze.freezeId, state, code: error.code, message: error.message }, 'CAM Edge 传输状态回告 Core 失败');
    });
  }

  function startHeartbeat(freezeId, config) {
    const controlUrl = config?.coreControlUrl;
    const intervalMs = Number(config?.transferHeartbeatMs ?? 15_000);
    if (!controlUrl || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) return () => {};
    heartbeatStops.get(freezeId)?.();
    let stopped = false;
    let sending = false;
    const send = async () => {
      if (stopped || sending) return;
      const current = freezes.get(freezeId);
      if (!current || current.transferStatus !== 'SENDING') return;
      sending = true;
      try {
        await reportState(current, 'HEARTBEAT', { attempt: Number(current.transferAttempts ?? 0), config });
      } catch (error) {
        // A missed heartbeat is tolerated; the next tick retries it. Core's
        // idle watchdog remains the final authority if the control link stays
        // unavailable.
        logger.warn?.({ freezeId, state: 'HEARTBEAT', code: error.code, message: error.message }, 'CAM Edge 传输心跳回告 Core 失败');
      } finally { sending = false; }
    };
    const timer = setInterval(() => { void send(); }, intervalMs);
    timer.unref?.();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (heartbeatStops.get(freezeId) === stop) heartbeatStops.delete(freezeId);
    };
    heartbeatStops.set(freezeId, stop);
    return stop;
  }

  async function deliver(freezeId) {
    let freeze = freezes.get(freezeId);
    if (!freeze || freeze.status !== 'APPROVED' || !freeze.transferTaskId) return freeze;
    let stopHeartbeat = () => {};
    const repairingReceipt = freeze.transferStatus === 'RECEIVED';
    if (!repairingReceipt) {
      // Stores return the persisted row, but keep the dispatcher compatible
      // with callers that only mutate their in-memory state.
      freeze = freezes.markTransferAttempt(freezeId) ?? freezes.get(freezeId) ?? freeze;
    }
    const attempt = Number(freeze.transferAttempts ?? 0);
    try {
      const config = gateConfig.get();
      if (!config.coreTransferUrl) throw Object.assign(new Error('请先配置 Edge 外侧访问 Core 的制品传输地址'), { code: 'gate_address_missing' });
      reportStateLater(freeze, 'STARTED', { attempt, config });
      // Liveness is independent from chunk completion. The heartbeat keeps
      // Core informed while Edge is reading, assembling a request or waiting
      // for a slow local/network write; PROGRESS remains reserved for chunks
      // that the Core data plane has actually accepted.
      stopHeartbeat = startHeartbeat(freezeId, config);
      const base = config.coreTransferUrl.replace(/\/$/u, '');
      const path = `/api/v1/gate/transfers/${encodeURIComponent(freeze.transferTaskId)}`;
      const readManifest = async () => {
        const response = await request(`${base}${path}/manifest`, config);
        return { response, body: await response.json().catch(() => ({})) };
      };
      const waitForCoreAssembly = async (item) => {
        const pollMs = Math.max(250, Number(config.transferAssemblyPollMs ?? 2_000));
        const timeoutMs = Math.max(30_000, Number(config.transferAssemblyTimeoutMs ?? 30 * 60_000));
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          const { response, body } = await readManifest();
          if (!response.ok) throw Object.assign(new Error(body.error?.message ?? `读取 Core 文件校验状态失败（HTTP ${response.status}）`), { code: body.error?.code ?? 'transfer_manifest_failed' });
          if (body.requestId !== freeze.freezeId || body.transferTaskId !== freeze.transferTaskId || body.manifestSha256 !== freeze.manifestSha256 || !Array.isArray(body.items)) throw Object.assign(new Error('Core 返回的文件校验状态与 Edge 审批记录不一致'), { code: 'transfer_manifest_mismatch' });
          const current = body.items.find((entry) => String(entry.actualSha256 ?? '').toLowerCase() === String(item.actualSha256 ?? '').toLowerCase());
          if (!current) throw Object.assign(new Error(`Core 返回的清单缺少文件：${item.fileName}`), { code: 'transfer_manifest_mismatch' });
          if (current.stored === true) return current;
          if (current.assemblyStatus === 'VERIFY_FAILED') throw Object.assign(new Error(current.lastError ?? `Core 文件校验不通过：${item.fileName}`), { code: current.errorCode ?? 'artifact_assembly_failed' });
          await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        throw Object.assign(new Error(`等待 Core 完成文件组装校验超时：${item.fileName}`), { code: 'transfer_assembly_timeout' });
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
      // A prior process may have uploaded every byte but died before the final
      // receipt. Skip re-uploading in that case, but always replay the final
      // control report and receipt so Core can finish the task.
      const alreadyStored = freeze.transferStatus === 'RECEIVED' && manifestBody.items.every((item) => item.stored);
      const chunkSize = Math.min(config.chunkSizeBytes, 32 * 1024 * 1024);
      const sent = new Set();
      if (!alreadyStored) for (const item of manifestBody.items) {
        const sha256 = String(item.actualSha256 ?? '').toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) throw Object.assign(new Error('获批清单包含无效的文件摘要或大小'), { code: 'transfer_manifest_invalid' });
        if (sent.has(sha256) || item.stored) { sent.add(sha256); continue; }
        const count = item.sizeBytes === 0 ? 1 : Math.ceil(item.sizeBytes / chunkSize);
        if (item.sizeBytes > 0 && Array.isArray(item.receivedParts) && item.receivedParts.length >= count) {
          await waitForCoreAssembly(item);
          sent.add(sha256);
          continue;
        }
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
          reportStateLater(freeze, 'PROGRESS', { attempt, config });
        } else {
          const count = Math.ceil(item.sizeBytes / chunkSize);
          const receivedParts = new Set(Array.isArray(item.receivedParts) ? item.receivedParts : []);
          let assemblyPending = false;
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
            const responseBody = await response.json().catch(() => ({}));
            assemblyPending = assemblyPending || responseBody.assemblyPending === true;
            reportStateLater(freeze, 'PROGRESS', { attempt, config });
          }
          if (assemblyPending) await waitForCoreAssembly(item);
        }
        sent.add(sha256);
      }
      // All bytes are on Core now, but Core has not yet accepted the final
      // receipt. Report that boundary before requesting the receipt so both
      // sides can distinguish "waiting for Core confirmation" from transfer.
      try { await reportState(freeze, 'COMPLETED', { attempt, config }); }
      catch (reportError) {
        logger.warn?.({ freezeId, attempt, state: 'COMPLETED', code: reportError.code, message: reportError.message }, 'CAM Edge 完成状态回告 Core 失败，将继续提交回执');
      }
      // The artifact bytes use Core's transfer channel; the small final
      // receipt belongs to the signed control channel.
      if (!config.coreControlUrl) throw Object.assign(new Error('请先配置 Edge 外侧访问 Core 的控制地址'), { code: 'gate_address_missing' });
      const receiptPath = '/api/v1/gate/receipts';
      const receiptBody = JSON.stringify({ requestId: freeze.freezeId, transferTaskId: freeze.transferTaskId, manifestSha256: freeze.manifestSha256 });
      const receiptResponse = await fetchImpl(`${config.coreControlUrl.replace(/\/$/u, '')}${receiptPath}`, {
        method: 'POST',
        headers: await keyring.requestHeaders('POST', receiptPath, receiptBody, { 'content-type': 'application/json' }),
        body: receiptBody,
        signal: AbortSignal.timeout(config.connectTimeoutMs ?? 10_000)
      });
      if (!receiptResponse.ok) throw await responseError(receiptResponse, 'Core 拒绝接收正式制品回执');
      freezes.markTransferSuccess(freezeId);
      reconciled.add(freezeId);
      return freezes.get(freezeId);
    } catch (error) {
      const config = (() => { try { return gateConfig.get(); } catch { return {}; } })();
      // Core owns retry budgets and retry timing for Edge -> Core transfers.
      // Edge persists the failure so it survives a restart, reports it over the
      // signed control link, and waits for an explicit Core recovery command.
      freezes.markTransferFailure(freezeId, error);
      try {
        await reportFailure(freeze, error, { attempt, config });
      } catch (reportError) {
        logger.warn?.({ freezeId, attempt, code: reportError.code, message: reportError.message }, 'CAM 正式制品传输失败报告 Core 失败');
      }
      logger.warn?.({ freezeId, attempt, code: error.code, message: error.message }, 'CAM 正式制品传输失败，已回告 Core，等待协调恢复');
      return freezes.get(freezeId);
    } finally { stopHeartbeat(); }
  }

  async function responseError(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return Object.assign(new Error(body.error?.message ?? `${fallback}（HTTP ${response.status}）`), { code: body.error?.code ?? 'artifact_transfer_failed', statusCode: response.status });
  }

  async function reconcileTransferStates() {
    if (typeof freezes.listTransferStates !== 'function') return;
    let config;
    try { config = gateConfig.get(); } catch { return; }
    if (!config?.coreControlUrl) return;
    for (const freeze of freezes.listTransferStates()) {
      const attempt = Number(freeze.transferAttempts ?? 0);
      const state = freeze.transferStatus === 'READY' ? 'ACCEPTED'
        : freeze.transferStatus === 'SENDING' ? 'STARTED'
          : freeze.transferStatus === 'RECEIVED' ? 'COMPLETED'
            : 'RETRY_WAIT';
      const error = freeze.transferLastError ? Object.assign(new Error(freeze.transferLastError), { code: freeze.transferErrorCode ?? 'artifact_transfer_failed' }) : null;
      try {
        await reportState(freeze, state, {
          attempt, config,
          code: error ? errorCode(error) : null, message: error?.message ?? null,
          terminal: false
        });
      } catch (reportError) {
        logger.warn?.({ freezeId: freeze.freezeId, state, code: reportError.code, message: reportError.message }, 'CAM Edge 启动时回告传输状态失败');
      }
    }
  }

  async function accepted(freezeId) {
    const freeze = freezes.get(freezeId);
    if (!freeze?.transferTaskId) return;
    let config;
    try { config = gateConfig.get(); } catch { return; }
    try { await reportState(freeze, 'ACCEPTED', { attempt: Number(freeze.transferAttempts ?? 0), config }); }
    catch (error) { logger.warn?.({ freezeId, state: 'ACCEPTED', code: error.code, message: error.message }, 'CAM Edge 接单状态回告 Core 失败'); }
  }

  async function pump() {
    if (busy || closed) return;
    busy = true;
    try {
      for (const freeze of freezes.listTransferPending()) {
        if (closed) break;
        if (reconciled.has(freeze.freezeId)) continue;
        await deliver(freeze.freezeId);
      }
    } finally { busy = false; }
  }

  function start() {
    if (timer || closed) return;
    timer = setInterval(() => { void pump(); }, intervalMs);
    timer.unref?.();
    void reconcileTransferStates();
    void pump();
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    while (busy) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  return { accepted, deliver, pump, start, close };
}
