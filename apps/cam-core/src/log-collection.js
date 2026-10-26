import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildLogBundle, readRuntimeLogs, sanitizeRuntimeLog, sha256, unpackTarGz } from '../../../libs/cam-server/src/log-bundle.js';

const inFlight = new Set();

function safeAgentDirectoryName(item, used) {
  const source = String(item.agentName ?? '').trim() || item.agentId;
  const base = source.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^\.+|\.+$/gu, '').slice(0, 80) || 'agent';
  let name = base;
  if (used.has(name)) name = `${base}-${String(item.agentId).slice(-8)}`;
  let suffix = 2;
  while (used.has(name)) name = `${base}-${suffix++}`;
  used.add(name);
  return name;
}

async function buildCoreLogCollectionOnce(store, jobId) {
  const job = store.getLogCollection(jobId);
  if (!job) throw Object.assign(new Error('日志收集任务不存在'), { code: 'log_collection_not_found' });
  if (job.status === 'READY') return job;
  const baseDir = join(store.dataDir, 'log-collections', jobId);
  await mkdir(baseDir, { recursive: true, mode: 0o750 });
  const agentEntries = [];
  const usedAgentNames = new Set();
  for (const item of store.listAgentLogCollectionFiles(jobId)) {
    try {
      const entries = unpackTarGz(await readFile(item.bundlePath));
      const logs = entries.filter((entry) => entry.name.endsWith('.jsonl') && !entry.name.includes('manifest') && !entry.name.includes('checksums')).map((entry) => entry.data);
      const agentName = safeAgentDirectoryName(item, usedAgentNames);
      agentEntries.push({ name: `agents/${agentName}/runtime.jsonl`, data: Buffer.concat(logs), agentId: item.agentId, centerId: item.centerId, agentName: item.agentName ?? item.agentId });
    } catch (error) {
      store.setLogCollectionBundle(jobId, { status: 'FAILED', error: `Agent 日志归档解析失败：${error.message}` });
      return store.getLogCollection(jobId);
    }
  }
  const coreLogs = sanitizeRuntimeLog(readRuntimeLogs(process.env.CAM_LOG_DIR ?? join(store.dataDir, 'logs'), 'cam-core', { fromAt: job.fromAt, toAt: job.toAt, maxBytes: Number(process.env.CAM_LOG_COLLECTION_MAX_BYTES ?? 100 * 1024 * 1024) }), { stripIdentifiers: true });
  const bundle = buildLogBundle({
    fromAt: job.fromAt,
    toAt: job.toAt,
    categories: job.categories,
    source: 'core-aggregate',
    entries: [{ name: 'core/runtime.jsonl', data: coreLogs }, ...agentEntries]
  });
  const path = join(baseDir, 'core-aggregate.tar.gz');
  await writeFile(`${path}.tmp`, bundle, { mode: 0o640 });
  await rename(`${path}.tmp`, path);
  const result = store.setLogCollectionBundle(jobId, { status: 'READY', path, sha256: sha256(bundle), size: bundle.length });
  return result;
}

export async function buildCoreLogCollection(store, jobId) {
  if (inFlight.has(jobId)) return store.getLogCollection(jobId);
  inFlight.add(jobId);
  try { return await buildCoreLogCollectionOnce(store, jobId); }
  finally { inFlight.delete(jobId); }
}

export async function expireCoreLogCollections(store) {
  const jobIds = store.expireLogCollections();
  await Promise.all(jobIds.map((jobId) => rm(join(store.dataDir, 'log-collections', jobId), { recursive: true, force: true })));
  return jobIds;
}

export function logBundleDigest(bundle) { return createHash('sha256').update(bundle).digest('hex'); }
