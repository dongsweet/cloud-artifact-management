import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const retryDelay = (attempt) => Math.min(300_000, 5_000 * (2 ** Math.min(Math.max(attempt - 1, 0), 6)));

export function createArtifactDispatcher({ freezes, candidates, gateConfig, keyring, fetchImpl = fetch, logger = console, intervalMs = 5_000 }) {
  let timer = null;
  let busy = false;
  let closed = false;
  const nextAttemptAt = new Map();

  async function request(url, config, secret, options = {}) {
    return fetchImpl(url, {
      ...options,
      headers: { ...(options.headers ?? {}), 'x-cam-gate-secret': secret.toString('base64url') },
      signal: AbortSignal.timeout(config.transferTimeoutMs)
    });
  }

  async function deliver(freezeId) {
    let freeze = freezes.get(freezeId);
    if (!freeze || freeze.status !== 'APPROVED' || !freeze.transferTaskId || freeze.transferStatus === 'RECEIVED') return freeze;
    const attempt = (freeze.transferAttempts ?? 0) + 1;
    freezes.markTransferAttempt(freezeId);
    try {
      const config = gateConfig.get();
      if (!config.coreTransferUrl) throw Object.assign(new Error('请先配置 Edge 外侧访问 Core 的制品传输地址'), { code: 'gate_address_missing' });
      const secret = await keyring.currentSecret();
      if (!secret) throw Object.assign(new Error('网闸共享密钥尚未初始化，请先完成 Core/Edge 配对'), { code: 'gate_key_not_configured' });
      const base = config.coreTransferUrl.replace(/\/$/u, '');
      const path = `/api/v1/gate/transfers/${encodeURIComponent(freeze.transferTaskId)}`;
      const manifestResponse = await request(`${base}${path}/manifest`, config, secret);
      const manifestBody = await manifestResponse.json().catch(() => ({}));
      if (!manifestResponse.ok) throw Object.assign(new Error(manifestBody.error?.message ?? `读取 Core 获批清单失败（HTTP ${manifestResponse.status}）`), { code: manifestBody.error?.code ?? 'transfer_manifest_failed' });
      if (manifestBody.requestId !== freeze.freezeId || manifestBody.transferTaskId !== freeze.transferTaskId || manifestBody.manifestSha256 !== freeze.manifestSha256 || !Array.isArray(manifestBody.items)) throw Object.assign(new Error('Core 返回的清单与 Edge 审批记录不一致'), { code: 'transfer_manifest_mismatch' });

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
          const response = await request(url, config, secret, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': '0' }, body: Buffer.alloc(0) });
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
            const response = await request(`${base}${path}/artifacts/${sha256}/parts/${index}`, config, secret, {
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
      const receiptResponse = await request(`${base}/api/v1/gate/receipts`, config, secret, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: freeze.freezeId, transferTaskId: freeze.transferTaskId, manifestSha256: freeze.manifestSha256 })
      });
      if (!receiptResponse.ok) throw await responseError(receiptResponse, 'Core 拒绝接收正式制品回执');
      freezes.markTransferSuccess(freezeId);
      nextAttemptAt.delete(freezeId);
      return freezes.get(freezeId);
    } catch (error) {
      freezes.markTransferFailure(freezeId, error);
      nextAttemptAt.set(freezeId, Date.now() + retryDelay(attempt));
      logger.warn?.({ freezeId, attempt, code: error.code, message: error.message }, 'CAM 正式制品传输失败，将自动重试');
      return freezes.get(freezeId);
    }
  }

  async function responseError(response, fallback) {
    const body = await response.json().catch(() => ({}));
    return Object.assign(new Error(body.error?.message ?? `${fallback}（HTTP ${response.status}）`), { code: body.error?.code ?? 'artifact_transfer_failed', statusCode: response.status });
  }

  async function pump() {
    if (busy || closed) return;
    busy = true;
    try {
      for (const freeze of freezes.listTransferPending()) {
        if (closed) break;
        if ((nextAttemptAt.get(freeze.freezeId) ?? 0) > Date.now()) continue;
        await deliver(freeze.freezeId);
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

  return { deliver, pump, start, close };
}
