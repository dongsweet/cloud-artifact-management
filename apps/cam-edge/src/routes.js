import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, rename } from 'node:fs/promises';
import { once } from 'node:events';
import { dirname } from 'node:path';
import { assembleChunks } from '../../../libs/cam-transfer/src/transfer.js';
import { previewCandidateWorkbook } from './candidate-import.js';

function error(reply, statusCode, code, message) {
  return reply.code(statusCode).send({ error: { code, message } });
}

async function md5File(path) {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
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
    productId: candidate.product_id,
    productName: candidate.product_name,
    releaseId: candidate.release_id,
    releaseVersion: candidate.release_version,
    packageKey: candidate.package_key,
    mappingSource: candidate.mapping_source,
    inheritedFromRoundId: candidate.inherited_from_round_id,
    sourceUrl: candidate.source_url,
    fileName: candidate.file_name,
    version: candidate.version,
    architecture: candidate.architecture,
    targets: candidate.targets,
    size: candidate.expected_size,
    sha256: candidate.expected_sha256,
    md5: candidate.expected_md5,
    expectedMd5: candidate.expected_md5,
    expectedSha256: candidate.expected_sha256,
    finalMd5: candidate.final_md5,
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
    error: candidate.error_message,
    metadata: candidate.metadata ?? {}
  };
}

export async function finalizeCandidate(store, candidateId) {
  const candidate = store.get(candidateId);
  if (!candidate) throw new Error('candidate not found');
  if (candidate.status === 'COMPLETED') return candidate;
  const missing = store.missingParts(candidate.candidate_id);
  if (missing.length > 0) throw new Error(`candidate has missing parts: ${missing.join(',')}`);
  store.markAssembling(candidateId);
  const manifest = { size: candidate.expected_size, sha256: candidate.expected_sha256 ?? '', transfer: { chunks: store.listParts(candidate.candidate_id).map((part) => ({ index: part.part_index, offset: part.offset, size: part.size, sha256: part.sha256 })) } };
  const assembled = await assembleChunks({ taskDir: store.candidateDir(candidate.candidate_id), manifest, outputPath: candidate.source_path });
  return store.complete(candidate.candidate_id, { finalSha256: assembled.sha256, finalMd5: candidate.expected_md5 ? await md5File(assembled.path) : null });
}

export function registerCandidateRoutes(app, { store, receiver }) {
  app.post('/api/v1/products', async (request, reply) => {
    try { return reply.code(201).send(store.createProduct(request.body ?? {})); }
    catch (err) { return error(reply, 400, 'invalid_product', err.message); }
  });

  app.get('/api/v1/products', async (_request, reply) => reply.send({ items: store.listProducts() }));

  app.delete('/api/v1/products/:productId', async (request, reply) => {
    if (!store.getProduct(request.params.productId)) return error(reply, 404, 'product_not_found', 'product not found');
    try {
      store.deleteProduct(request.params.productId);
      return reply.code(204).send();
    } catch (err) {
      if (err.code === 'product_not_empty') return error(reply, 409, err.code, err.message);
      return error(reply, 400, 'invalid_product_delete', err.message);
    }
  });

  app.post('/api/v1/products/:productId/releases', async (request, reply) => {
    try { return reply.code(201).send(store.createRelease(request.params.productId, request.body ?? {})); }
    catch (err) { return error(reply, 400, 'invalid_release', err.message); }
  });

  app.get('/api/v1/releases', async (request, reply) => {
    try { return reply.send({ items: store.listReleases(request.query?.productId ?? null) }); }
    catch (err) { return error(reply, 400, 'invalid_release_query', err.message); }
  });

  app.get('/api/v1/releases/:releaseId', async (request, reply) => {
    const release = store.getRelease(request.params.releaseId);
    return release ? reply.send(release) : error(reply, 404, 'release_not_found', 'release not found');
  });

  app.delete('/api/v1/releases/:releaseId', async (request, reply) => {
    if (!store.getRelease(request.params.releaseId)) return error(reply, 404, 'release_not_found', 'release not found');
    try {
      store.deleteRelease(request.params.releaseId);
      return reply.code(204).send();
    } catch (err) {
      if (err.code === 'release_not_open' || err.code === 'release_not_empty') return error(reply, 409, err.code, err.message);
      return error(reply, 400, 'invalid_release_delete', err.message);
    }
  });

  app.post('/api/v1/releases/:releaseId/rounds', async (request, reply) => {
    try { return reply.code(201).send(store.createRound(request.params.releaseId, request.body ?? {})); }
    catch (err) { return error(reply, 400, 'invalid_round', err.message); }
  });

  app.get('/api/v1/releases/:releaseId/rounds', async (request, reply) => {
    try { return reply.send({ items: store.listRounds(request.params.releaseId) }); }
    catch (err) { return error(reply, 400, 'invalid_round_query', err.message); }
  });

  app.get('/api/v1/rounds/:roundId', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    return round ? reply.send(round) : error(reply, 404, 'round_not_found', 'round not found');
  });

  app.get('/api/v1/rounds/:roundId/candidates', async (request, reply) => {
    try { return reply.send({ items: store.listRoundCandidates(request.params.roundId).map(candidateResponse) }); }
    catch (err) { return error(reply, 400, 'invalid_round_candidates', err.message); }
  });

  app.post('/api/v1/rounds/:roundId/candidates', async (request, reply) => {
    try {
      const candidate = await store.create({ ...(request.body ?? {}), roundId: request.params.roundId });
      return reply.code(201).send(candidateResponse(candidate));
    } catch (err) { return error(reply, 400, 'invalid_candidate', err.message); }
  });

  app.post('/api/v1/rounds/:roundId/import-preview', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    try {
      const preview = await previewCandidateWorkbook(request.body, {
        sheetName: request.query?.sheet ?? null,
        mapping: request.query?.mapping ? JSON.parse(request.query.mapping) : {},
        store,
        roundId: request.params.roundId
      });
      return reply.send({ roundId: request.params.roundId, ...preview });
    } catch (err) {
      return error(reply, 400, 'invalid_import_workbook', err.message);
    }
  });

  app.post('/api/v1/rounds/:roundId/import', async (request, reply) => {
    const round = store.getRound(request.params.roundId);
    if (!round) return error(reply, 404, 'round_not_found', 'round not found');
    const items = Array.isArray(request.body?.items) ? request.body.items : [];
    if (items.length === 0 || items.length > 1000) return error(reply, 400, 'invalid_import_items', '导入项目数量必须为 1 到 1000');
    const existing = new Set(store.listRoundCandidates(request.params.roundId).map((candidate) => candidate.package_key.toLowerCase()));
    const results = [];
    const errors = [];
    for (const [index, item] of items.entries()) {
      try {
        const packageKey = String(item.packageKey ?? '').trim();
        if (!packageKey) throw new Error('包标识不能为空');
        if (existing.has(packageKey.toLowerCase())) throw new Error(`包标识已存在：${packageKey}`);
        const candidate = await store.create({ ...item, roundId: request.params.roundId });
        existing.add(packageKey.toLowerCase());
        results.push(candidateResponse(candidate));
      } catch (err) {
        errors.push({ index, rowNumber: Number(item.importRowNumber) || index + 1, message: err.message });
      }
    }
    if (results.length === 0) return error(reply, 400, 'import_failed', errors.map((item) => `第 ${item.index + 1} 行：${item.message}`).join('；'));
    return reply.code(201).send({ roundId: request.params.roundId, imported: results.length, skipped: errors.length, items: results, errors });
  });

  app.post('/api/v1/candidates', async (request, reply) => {
    try {
      const candidate = await store.create(request.body ?? {});
      return reply.code(201).send(candidateResponse(candidate));
    } catch (err) {
      return error(reply, 400, 'invalid_candidate', err.message);
    }
  });

  app.get('/api/v1/candidates', async (request, reply) => {
    try {
      const limit = request.query?.limit === undefined ? 50 : Number(request.query.limit);
      const offset = request.query?.offset === undefined ? 0 : Number(request.query.offset);
      const releaseId = request.query?.releaseId ?? null;
      return reply.send({ items: store.list({ limit, offset, releaseId }).map(candidateResponse), limit, offset });
    } catch (err) {
      return error(reply, 400, 'invalid_query', err.message);
    }
  });

  app.get('/api/v1/candidates/:candidateId', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    return candidate ? reply.send(candidateResponse(candidate)) : error(reply, 404, 'candidate_not_found', 'candidate not found');
  });

  app.patch('/api/v1/candidates/:candidateId', async (request, reply) => {
    try { return reply.send(candidateResponse(store.updateCandidate(request.params.candidateId, request.body ?? {}))); }
    catch (err) { return error(reply, err.code === 'candidate_not_editable' || err.code === 'candidate_has_parts' ? 409 : 400, err.code ?? 'invalid_candidate', err.message); }
  });

  app.delete('/api/v1/candidates/:candidateId', async (request, reply) => {
    try {
      const deleted = store.deleteCandidate(request.params.candidateId);
      if (!deleted) return error(reply, 404, 'candidate_not_found', 'candidate not found');
      await rm(deleted.dataDir, { recursive: true, force: true });
      return reply.code(204).send();
    } catch (err) { return error(reply, err.code === 'candidate_busy' ? 409 : 400, err.code ?? 'candidate_delete_failed', err.message); }
  });

  app.get('/api/v1/candidates/:candidateId/parts', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    const transfer = receiver.progress.get(candidate.candidate_id) ?? null;
    return reply.send({ candidateId: candidate.candidate_id, status: candidate.status, chunkCount: candidate.chunk_count, completedParts: store.listParts(candidate.candidate_id), missingParts: store.missingParts(candidate.candidate_id), transfer });
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

  app.post('/api/v1/candidates/:candidateId/cancel-receive', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return error(reply, 409, 'candidate_completed', 'candidate is already completed');
    receiver.cancel(candidate.candidate_id);
    return reply.send(candidateResponse(store.markPartial(candidate.candidate_id)));
  });

  app.post('/api/v1/candidates/:candidateId/complete', async (request, reply) => {
    const candidate = store.get(request.params.candidateId);
    if (!candidate) return error(reply, 404, 'candidate_not_found', 'candidate not found');
    if (candidate.status === 'COMPLETED') return reply.send(candidateResponse(candidate));
    try {
      const completed = await finalizeCandidate(store, candidate.candidate_id);
      return reply.send(candidateResponse(completed));
    } catch (err) {
      if (store.missingParts(candidate.candidate_id)?.length > 0) return error(reply, 409, 'parts_missing', err.message);
      store.fail(candidate.candidate_id, err);
      return error(reply, 422, 'candidate_integrity_failed', err.message);
    }
  });
}

export { candidateResponse };
