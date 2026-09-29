import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateChunkCount, getChunkRange } from '../../../libs/cam-transfer/src/transfer.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const CANDIDATE_STATUSES = new Set(['CREATED', 'RECEIVING', 'PARTIAL', 'FAILED', 'COMPLETED']);

function now() {
  return new Date().toISOString();
}

function safeFileName(fileName) {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) throw new Error('fileName must be 1-255 characters');
  if (fileName.includes('\0') || fileName !== fileName.split(/[\\/]/).pop() || fileName === '.' || fileName === '..') throw new Error('fileName must be a plain file name');
  return fileName;
}

function parseCandidate(row) {
  if (!row) return null;
  return {
    ...row,
    targets: JSON.parse(row.targets_json),
    completedParts: row.completed_parts,
    missingParts: row.missing_parts
  };
}

export class CandidateStore {
  constructor({ db, dataDir, defaultChunkSize }) {
    this.db = db;
    this.dataDir = dataDir;
    this.defaultChunkSize = defaultChunkSize;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candidates (
        candidate_id TEXT PRIMARY KEY,
        source_url TEXT NOT NULL,
        file_name TEXT NOT NULL,
        version TEXT NOT NULL,
        architecture TEXT,
        targets_json TEXT NOT NULL,
        expected_size INTEGER NOT NULL,
        expected_sha256 TEXT,
        chunk_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        source_tag TEXT,
        final_sha256 TEXT,
        source_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT
      );
      CREATE TABLE IF NOT EXISTS candidate_parts (
        candidate_id TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        offset INTEGER NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, part_index),
        FOREIGN KEY (candidate_id) REFERENCES candidates(candidate_id)
      );
      CREATE INDEX IF NOT EXISTS candidate_parts_status_idx ON candidate_parts(candidate_id, status);
    `);
    const columns = this.db.prepare('PRAGMA table_info(candidates)').all();
    if (!columns.some((column) => column.name === 'final_sha256')) this.db.exec('ALTER TABLE candidates ADD COLUMN final_sha256 TEXT');
  }

  async create({ sourceUrl, fileName, version, architecture = null, targets = [], size, sha256 = null, chunkSize = this.defaultChunkSize }) {
    if (typeof sourceUrl !== 'string' || sourceUrl.length === 0 || sourceUrl.length > 2048) throw new Error('sourceUrl is required');
    try {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('sourceUrl must use http or https');
    } catch (error) {
      throw new Error(`invalid sourceUrl: ${error.message}`);
    }
    const safeName = safeFileName(fileName);
    if (typeof version !== 'string' || version.length === 0 || version.length > 128) throw new Error('version is required');
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('size must be a non-negative safe integer');
    if (sha256 !== null && (!SHA256_PATTERN.test(sha256))) throw new Error('sha256 must be a 64-character hexadecimal digest');
    if (!Array.isArray(targets) || targets.some((target) => typeof target !== 'string' || target.length > 128)) throw new Error('targets must be an array of strings');
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 512 * 1024 * 1024) throw new Error('chunkSize must be between 1 and 512 MiB');
    const candidateId = `CAND-${Date.now()}-${randomUUID()}`;
    const chunkCount = calculateChunkCount(size, chunkSize);
    const candidateDir = join(this.dataDir, 'candidates', candidateId);
    const sourceDir = join(candidateDir, 'source');
    await mkdir(join(candidateDir, 'parts'), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, safeName);
    const timestamp = now();
    this.db.prepare(`INSERT INTO candidates
      (candidate_id, source_url, file_name, version, architecture, targets_json, expected_size, expected_sha256, chunk_size, chunk_count, status, source_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      candidateId, sourceUrl, safeName, version, architecture, JSON.stringify(targets), size, sha256, chunkSize, chunkCount, 'CREATED', sourcePath, timestamp, timestamp
    );
    return this.get(candidateId);
  }

  get(candidateId) {
    const row = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED')) AS missing_parts
      FROM candidates c WHERE c.candidate_id = ?`).get(candidateId);
    return parseCandidate(row);
  }

  list({ limit = 50, offset = 0 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
    const rows = this.db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED')) AS missing_parts
      FROM candidates c ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(limit, offset);
    return rows.map(parseCandidate);
  }

  getPart(candidateId, partIndex) {
    return this.db.prepare('SELECT * FROM candidate_parts WHERE candidate_id = ? AND part_index = ?').get(candidateId, partIndex) ?? null;
  }

  listParts(candidateId) {
    return this.db.prepare('SELECT * FROM candidate_parts WHERE candidate_id = ? ORDER BY part_index').all(candidateId);
  }

  missingParts(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) return null;
    const completed = new Set(this.listParts(candidateId).filter((part) => part.status === 'COMPLETED').map((part) => part.part_index));
    return Array.from({ length: candidate.chunk_count }, (_, index) => index).filter((index) => !completed.has(index));
  }

  markReceiving(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (candidate.status === 'COMPLETED') throw new Error('candidate is already completed');
    this.db.prepare('UPDATE candidates SET status = ?, error_message = NULL, updated_at = ? WHERE candidate_id = ?').run('RECEIVING', now(), candidateId);
  }

  setSourceTag(candidateId, sourceTag) {
    this.db.prepare('UPDATE candidates SET source_tag = ?, updated_at = ? WHERE candidate_id = ? AND source_tag IS NULL').run(sourceTag, now(), candidateId);
  }

  recordPart({ candidateId, partIndex, size, sha256 }) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (!Number.isInteger(partIndex) || partIndex < 0 || partIndex >= candidate.chunk_count) throw new Error('part index out of range');
    const expected = getChunkRange(partIndex, candidate.expected_size, candidate.chunk_size);
    if (size !== expected.size) throw new Error(`part ${partIndex} has invalid size`);
    if (!SHA256_PATTERN.test(sha256)) throw new Error('part sha256 is invalid');
    const existing = this.getPart(candidateId, partIndex);
    if (existing && (existing.size !== size || existing.sha256 !== sha256)) throw new Error(`part ${partIndex} already exists with different content`);
    const timestamp = now();
    this.db.prepare(`INSERT INTO candidate_parts (candidate_id, part_index, offset, size, sha256, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(candidate_id, part_index) DO UPDATE SET offset=excluded.offset, size=excluded.size, sha256=excluded.sha256, status=excluded.status, updated_at=excluded.updated_at`).run(
      candidateId, partIndex, expected.offset, size, sha256, 'COMPLETED', timestamp
    );
    this.db.prepare('UPDATE candidates SET status = ?, updated_at = ?, error_message = NULL WHERE candidate_id = ?').run('PARTIAL', timestamp, candidateId);
  }

  complete(candidateId, finalSha256) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (candidate.status === 'COMPLETED') return candidate;
    const missing = this.missingParts(candidateId);
    if (missing.length > 0) throw new Error(`candidate has missing parts: ${missing.join(',')}`);
    if (!SHA256_PATTERN.test(finalSha256)) throw new Error('final sha256 is invalid');
    const timestamp = now();
    this.db.prepare('UPDATE candidates SET status = ?, final_sha256 = ?, completed_at = ?, updated_at = ?, error_message = NULL WHERE candidate_id = ?').run('COMPLETED', finalSha256, timestamp, timestamp, candidateId);
    return this.get(candidateId);
  }

  fail(candidateId, error) {
    this.db.prepare('UPDATE candidates SET status = ?, error_message = ?, updated_at = ? WHERE candidate_id = ?').run('FAILED', String(error.message ?? error).slice(0, 1000), now(), candidateId);
  }

  partPath(candidateId, partIndex) {
    return join(this.dataDir, 'candidates', candidateId, 'parts', `part-${String(partIndex).padStart(6, '0')}`);
  }

  candidateDir(candidateId) {
    return join(this.dataDir, 'candidates', candidateId);
  }
}

export { CANDIDATE_STATUSES, safeFileName };
