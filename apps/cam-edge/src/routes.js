import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, rename } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { assembleChunks } from '../../../libs/cam-transfer/src/transfer.js';

function error(reply, statusCode, code, message) {
  return reply.code(statusCode).send({ error: { code, message } });
}

async function writeRequestPart(request, destination, expectedSize) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  const output = createWriteStream(temporary, { flags: 'w' });
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of request.raw) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > expectedSize) throw new Error('request body is larger than expected part');
      hash.update(buffer);
      if (!output.write(buffer)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');
    if (bytes !== expectedSize) throw new Error(`request body size ${bytes} does not match expected ${expectedSize}`);
    const digest = hash.digest('hex');
    const declared = request.headers['x-chunk-sha256'];
    if (declared && declared !== digest) throw new Error('x-chunk-sha256 does not match request body');
    return { size: bytes, sha256: digest, temporary };
  } catch (err) {
    output.destroy();
    await rm(temporary, { force: true });
    throw err;
  }
}

function candidateResponse(candidate) {
  return {
    candidateId: candidate.candidate_id,
    sourceUrl: candidate.source_url,
    fileName: candidate.file_name,
    version: candidate.version,
    architecture: candidate.architecture,
    targets: candidate.targets,
    size: candidate.expected_size,
    sha256: candidate.expected_sha256,
    expectedSha256: candidate.expected_sha256,
    finalSha256: candidate.final_sha256,
    sourceTag: candidate.source_tag,
    chunkSize: candidate.chunk_size,
    chunkCount: candidate.chunk_count,
    status: candidate.status,
    completedParts: candidate.completedParts,
    missingParts: candidate.missingParts,
    createdAt: candidate.created_at,
    updatedAt: candidate.updated_at,
    completedAt: candidate.completed_at,
    error: candidate.error_message
  };
}

export function registerCandidateRoutes(app, { store, receiver }) {
  app.post('/api/v1/candidates', async (request, reply) => {
    try {
      const candidate = await store.create(request.body ?? {});
      return reply.code(201).send(candidateResponse(candidate));
    } catch (err) {
      return error(reply, 400, 'invalid_candidate', err.message);
    }
  });

  app.get('/api/v1/candidates/:candidateId', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    return candidate ? reply.send(candidateResponse(candidate)) : error(reply, 404, 'candidate_not_found', 'candidate not found');
  });

  app.get('/api/v1/candidates/:candidateId/parts', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    return reply.send({ candidateId: candidate.candidate_id, status: candidate.status, chunkCount: candidate.chunk_count, completedParts: store.listParts(candidate.candidate_id), missingParts: store.missingParts(candidate.candidate_id) });
  });

  app.put('/api/v1/candidates/:candidateId/parts/:partIndex', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return error(reply, 409, 'candidate_completed', 'candidate is already completed');
    const partIndex = Number(request.params.partIndex);
    const expected = store.getPart(candidate.candidate_id, partIndex);
    const range = (() => {
      try {
        return { offset: partIndex * candidate.chunk_size, size: Math.min(candidate.chunk_size, candidate.expected_size - partIndex * candidate.chunk_size) };
      } catch {
        return null;
      }
    })();
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= candidate.chunk_count || !range || range.size < 0) return error(reply, 400, 'invalid_part', 'part index is out of range');
    if (expected && expected.status === 'COMPLETED') {
      if (request.headers['x-chunk-sha256'] === expected.sha256) return reply.send({ candidateId: candidate.candidate_id, partIndex, status: 'COMPLETED', idempotent: true });
      return error(reply, 409, 'part_conflict', 'part already exists; provide the same x-chunk-sha256 to retry');
    }
    let temporary = null;
    try {
      const destination = store.partPath(candidate.candidate_id, partIndex);
      const result = await writeRequestPart(request, destination, range.size);
      temporary = result.temporary;
      const current = store.getPart(candidate.candidate_id, partIndex);
      if (current && current.status === 'COMPLETED') {
        await rm(result.temporary, { force: true });
        if (current.size === result.size && current.sha256 === result.sha256) return reply.send({ candidateId: candidate.candidate_id, partIndex, status: 'COMPLETED', idempotent: true });
        return error(reply, 409, 'part_conflict', 'part already exists with different content');
      }
      await rename(result.temporary, destination);
      store.recordPart({ candidateId: candidate.candidate_id, partIndex, size: result.size, sha256: result.sha256 });
      const updated = store.get(candidate.candidate_id);
      return reply.send({ candidateId: candidate.candidate_id, partIndex, status: 'COMPLETED', sha256: result.sha256, completedParts: updated.completedParts, missingParts: updated.missingParts });
    } catch (err) {
      if (temporary) await rm(temporary, { force: true });
      return error(reply, 400, 'invalid_part', err.message);
    }
  });

  app.post('/api/v1/candidates/:candidateId/receive', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return reply.send(candidateResponse(candidate));
    if (!receiver.running.has(candidate.candidate_id)) receiver.receive(candidate.candidate_id).catch(() => {});
    return reply.code(202).send({ candidateId: candidate.candidate_id, status: 'RECEIVING' });
  });

  app.post('/api/v1/candidates/:candidateId/complete', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return reply.send(candidateResponse(candidate));
    const missing = store.missingParts(candidate.candidate_id);
    if (missing.length > 0) return error(reply, 409, 'parts_missing', `candidate has missing parts: ${missing.join(',')}`);
    try {
      const manifest = { size: candidate.expected_size, sha256: candidate.expected_sha256 ?? '', transfer: { chunks: store.listParts(candidate.candidate_id).map((part) => ({ index: part.part_index, offset: part.offset, size: part.size, sha256: part.sha256 })) } };
      const assembled = await assembleChunks({ taskDir: store.candidateDir(candidate.candidate_id), manifest, outputPath: candidate.source_path });
      const completed = store.complete(candidate.candidate_id, assembled.sha256);
      return reply.send(candidateResponse(completed));
    } catch (err) {
      store.fail(candidate.candidate_id, err);
      return error(reply, 422, 'candidate_integrity_failed', err.message);
    }
  });
}

export { candidateResponse };
