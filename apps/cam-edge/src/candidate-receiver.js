import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { getChunkRange } from '../../../libs/cam-transfer/src/transfer.js';

function allowlisted(url, allowlist) {
  if (!allowlist || allowlist.length === 0) return false;
  const host = new URL(url).hostname.toLowerCase();
  return allowlist.includes('*') || allowlist.some((entry) => entry === host || (entry.startsWith('*.') && host.endsWith(entry.slice(1))));
}

async function writeStreamToFile(stream, destination, expectedSize, onProgress = () => {}) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp`;
  const output = createWriteStream(temporary, { flags: 'w' });
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > expectedSize) throw new Error('source returned more bytes than expected');
      hash.update(buffer);
      onProgress(bytes);
      if (!output.write(buffer)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');
    if (bytes !== expectedSize) throw new Error(`source returned ${bytes} bytes, expected ${expectedSize}`);
    await rename(temporary, destination);
    return { size: bytes, sha256: hash.digest('hex') };
  } catch (error) {
    output.destroy();
    await rm(temporary, { force: true });
    throw error;
  }
}

function parseAllowlist(value = process.env.CAM_SOURCE_ALLOWLIST ?? '') {
  return value.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

async function resolveRemoteSize(url, fetchImpl) {
  const head = await fetchImpl(url, { method: 'HEAD' });
  const headLength = Number(head.headers.get('content-length'));
  if (head.ok && Number.isSafeInteger(headLength) && headLength >= 0) return headLength;
  const probe = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
  const contentRange = probe.headers.get('content-range') ?? '';
  const match = /^bytes\s+0-0\/(\d+)$/.exec(contentRange);
  if (probe.body?.cancel) await probe.body.cancel();
  if (probe.status !== 206 || !match) throw new Error('source content length is unavailable; provide the file size');
  return Number(match[1]);
}

export function createCandidateReceiver({ store, allowlist = parseAllowlist(), fetchImpl = globalThis.fetch, finalize = null }) {
  const running = new Map();
  const cancelled = new Set();
  const controllers = new Map();
  const progress = new Map();

  async function receive(candidateId) {
    if (running.has(candidateId)) return running.get(candidateId);
    const controller = new AbortController();
    controllers.set(candidateId, controller);
    const promise = (async () => {
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error('candidate not found');
      if (!allowlisted(candidate.source_url, allowlist)) throw new Error('source host is not allowlisted');
      if (candidate.expected_size === 0 && candidate.chunk_count === 0) {
        store.setExpectedSize(candidateId, await resolveRemoteSize(candidate.source_url, fetchImpl));
      }
      store.markReceiving(candidateId);
      for (const partIndex of store.missingParts(candidateId)) {
        if (cancelled.has(candidateId)) { cancelled.delete(candidateId); store.markPartial(candidateId); return store.get(candidateId); }
        const current = store.get(candidateId);
        const range = getChunkRange(partIndex, current.expected_size, current.chunk_size);
        const response = await fetchImpl(current.source_url, { signal: controller.signal, headers: { Range: `bytes=${range.offset}-${range.offset + range.size - 1}` } });
        if (response.status !== 206) throw new Error(`source must support HTTP Range, received ${response.status}`);
        const contentRange = response.headers.get('content-range') ?? '';
        const expectedContentRange = `bytes ${range.offset}-${range.offset + range.size - 1}/${current.expected_size}`;
        if (contentRange !== expectedContentRange) throw new Error('source Content-Range does not match requested part');
        const sourceTag = response.headers.get('etag') ?? response.headers.get('last-modified');
        if (current.source_tag && current.source_tag !== sourceTag) throw new Error('source changed during receive');
        if (!current.source_tag && sourceTag) store.setSourceTag(candidateId, sourceTag);
        if (!response.body) throw new Error('source response has no body');
        progress.set(candidateId, { partIndex, bytes: 0 });
        const result = await writeStreamToFile(response.body, store.partPath(candidateId, partIndex), range.size, (bytes) => progress.set(candidateId, { partIndex, bytes }));
        progress.delete(candidateId);
        store.recordPart({ candidateId, partIndex, size: result.size, sha256: result.sha256 });
      }
      return finalize ? await finalize(candidateId) : store.get(candidateId);
    })().catch((error) => {
      if (cancelled.has(candidateId)) {
        cancelled.delete(candidateId);
        return store.markPartial(candidateId);
      }
      store.fail(candidateId, error);
      throw error;
    }).finally(() => { running.delete(candidateId); controllers.delete(candidateId); progress.delete(candidateId); });
    running.set(candidateId, promise);
    return promise;
  }

  async function resumePending() {
    const pending = store.list({ limit: 200 }).filter((candidate) => ['RECEIVING', 'PARTIAL', 'ASSEMBLING'].includes(candidate.status));
    await Promise.allSettled(pending.map((candidate) => receive(candidate.candidate_id)));
  }

  function cancel(candidateId) {
    if (!running.has(candidateId)) return false;
    cancelled.add(candidateId);
    controllers.get(candidateId)?.abort(new Error('receive paused'));
    return true;
  }

  return { receive, resumePending, cancel, running, progress };
}

export { parseAllowlist, resolveRemoteSize, writeStreamToFile };
