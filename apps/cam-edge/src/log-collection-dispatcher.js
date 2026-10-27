import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildLogBundle, categorizeRuntimeLogs, readRuntimeLogs, unpackTarGz } from '../../../libs/cam-server/src/log-bundle.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');

export function createLogCollectionDispatcher({ store, gateConfig, keyring, dataDir, fetchImpl = fetch, logger = console, intervalMs = 5_000 }) {
  let busy = false;
  let timer;
  const create = async ({ fromAt, toAt, categories, retentionDays, requestedBy }) => {
    const config = gateConfig.get();
    if (!config.coreControlUrl) throw Object.assign(new Error('尚未配置 Edge 外侧访问 Core 的控制地址'), { code: 'core_control_unconfigured' });
    const path = '/api/v1/gate/log-collections'; const body = JSON.stringify({ fromAt, toAt, categories, retentionDays });
    const response = await fetchImpl(`${config.coreControlUrl.replace(/\/$/u, '')}${path}`, { method: 'POST', headers: await keyring.requestHeaders('POST', path, body, { 'content-type': 'application/json' }), body, signal: AbortSignal.timeout(config.connectTimeoutMs) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error?.message ?? 'Core 日志收集任务创建失败'), { code: result.error?.code ?? 'log_collection_create_failed', status: response.status });
    return store.create({ coreJobId: result.item.jobId, fromAt: result.item.fromAt, toAt: result.item.toAt, categories: result.item.categories, expiresAt: result.item.expiresAt, requestedBy });
  };
  const fetchCoreStatus = async (job) => {
    const config = gateConfig.get(); const path = `/api/v1/gate/log-collections/${encodeURIComponent(job.coreJobId)}`;
    const response = await fetchImpl(`${config.coreControlUrl.replace(/\/$/u, '')}${path}`, { headers: await keyring.requestHeaders('GET', path, '', { accept: 'application/json' }), signal: AbortSignal.timeout(config.connectTimeoutMs) });
    const result = await response.json().catch(() => ({})); if (!response.ok) throw Object.assign(new Error(result.error?.message ?? 'Core 日志收集状态读取失败'), { code: result.error?.code ?? 'log_collection_status_failed' }); return result.item;
  };
  const downloadCoreBundle = async (job, size) => {
    const config = gateConfig.get(); const base = config.coreTransferUrl?.replace(/\/$/u, ''); if (!base) throw Object.assign(new Error('尚未配置 Edge 外侧访问 Core 的制品传输地址'), { code: 'core_transfer_unconfigured' });
    const path = `/api/v1/gate/log-collections/${encodeURIComponent(job.coreJobId)}/bundle`; const chunkSize = Math.max(64 * 1024, Math.min(config.chunkSizeBytes ?? 4 * 1024 * 1024, 16 * 1024 * 1024)); const chunks = [];
    for (let offset = 0; offset < size; offset += chunkSize) {
      const end = Math.min(size - 1, offset + chunkSize - 1); const headers = await keyring.requestHeaders('GET', path, '', { accept: 'application/gzip', range: `bytes=${offset}-${end}` });
      const response = await fetchImpl(`${base}${path}`, { headers, signal: AbortSignal.timeout(config.transferTimeoutMs) }); if (!response.ok) throw new Error(`Core 日志归档分块读取失败（HTTP ${response.status}）`); const body = Buffer.from(await response.arrayBuffer()); if (body.length !== end - offset + 1) throw new Error('Core 日志归档分块大小不正确'); chunks.push(body);
    }
    return Buffer.concat(chunks);
  };
  const finalize = async (job, status) => {
    const coreBundle = await downloadCoreBundle(job, status.bundleSize); const entries = unpackTarGz(coreBundle).filter((entry) => !['manifest.json', 'checksums.sha256'].includes(entry.name));
    const edgeLogs = readRuntimeLogs(process.env.CAM_LOG_DIR ?? join(dataDir, 'logs'), 'cam-edge', { fromAt: job.fromAt, toAt: job.toAt, maxBytes: Number(process.env.CAM_LOG_COLLECTION_MAX_BYTES ?? 100 * 1024 * 1024) });
    const edgeCategories = categorizeRuntimeLogs(edgeLogs, job.categories);
    entries.push(...Object.entries(edgeCategories).map(([category, data]) => ({ name: `edge/${category}.jsonl`, data })));
    const finalBundle = buildLogBundle({ fromAt: job.fromAt, toAt: job.toAt, categories: job.categories, source: 'edge-aggregate', entries }); const path = store.finalPath(job.jobId); await mkdir(join(dataDir, 'log-collections', job.jobId), { recursive: true, mode: 0o750 }); await writeFile(`${path}.tmp`, finalBundle, { mode: 0o640 }); await rename(`${path}.tmp`, path); return store.setStatus(job.jobId, 'READY', { bundlePath: path, bundleSha256: digest(finalBundle), bundleSize: finalBundle.length });
  };
  const syncOne = async (job) => { try { const status = await fetchCoreStatus(job); if (status.status === 'FAILED') return store.setStatus(job.jobId, 'FAILED', { lastError: status.lastError ?? 'Core 日志收集失败' }); if (status.status !== 'READY') return store.setStatus(job.jobId, 'COLLECTING'); return await finalize(job, status); } catch (error) { logger.warn?.({ jobId: job.jobId, message: error.message }, 'Edge 日志收集同步失败'); return store.setStatus(job.jobId, 'COLLECTING', { lastError: error.message }); } };
  const cleanupExpired = async () => {
    const jobIds = store.expireExpired();
    await Promise.all(jobIds.map((jobId) => rm(join(dataDir, 'log-collections', jobId), { recursive: true, force: true })));
  };
  const pump = async () => { if (busy) return; busy = true; try { await cleanupExpired(); for (const job of store.active()) await syncOne(job); } finally { busy = false; } };
  return { create, list: () => store.list(), get: (jobId) => store.get(jobId), start() { timer = setInterval(() => { void pump(); }, intervalMs); timer.unref?.(); void pump(); return timer; }, close() { if (timer) clearInterval(timer); } };
}
