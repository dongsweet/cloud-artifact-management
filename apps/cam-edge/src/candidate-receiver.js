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

async function writeStreamToFile(stream, destination, expectedSize) {
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

export function createCandidateReceiver({ store, allowlist = parseAllowlist(), fetchImpl = globalThis.fetch }) {
  const running = new Map();

  async function receive(candidateId) {
    if (running.has(candidateId)) return running.get(candidateId);
    const promise = (async () => {
      const candidate = store.get(candidateId);
      if (!candidate) throw new Error('candidate not found');
      if (!allowlisted(candidate.source_url, allowlist)) throw new Error('source host is not allowlisted');
      store.markReceiving(candidateId);
      for (const partIndex of store.missingParts(candidateId)) {
        const current = store.get(candidateId);
        const range = getChunkRange(partIndex, current.expected_size, current.chunk_size);
        const response = await fetchImpl(current.source_url, { headers: { Range: `bytes=${range.offset}-${range.offset + range.size - 1}` } });
        if (response.status !== 206) throw new Error(`source must support HTTP Range, received ${response.status}`);
        const contentRange = response.headers.get('content-range') ?? '';
        const expectedContentRange = `bytes ${range.offset}-${range.offset + range.size - 1}/${current.expected_size}`;
        if (contentRange !== expectedContentRange) throw new Error('source Content-Range does not match requested part');
        const sourceTag = response.headers.get('etag') ?? response.headers.get('last-modified');
        if (current.source_tag && current.source_tag !== sourceTag) throw new Error('source changed during receive');
        if (!current.source_tag && sourceTag) store.setSourceTag(candidateId, sourceTag);
        if (!response.body) throw new Error('source response has no body');
        const result = await writeStreamToFile(response.body, store.partPath(candidateId, partIndex), range.size);
        store.recordPart({ candidateId, partIndex, size: result.size, sha256: result.sha256 });
      }
      return store.get(candidateId);
    })().catch((error) => {
      store.fail(candidateId, error);
      throw error;
    }).finally(() => running.delete(candidateId));
    running.set(candidateId, promise);
    return promise;
  }

  return { receive, running };
}

export { parseAllowlist, writeStreamToFile };
