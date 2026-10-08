import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { calculateChunkCount, getChunkRange } from '../../../libs/cam-transfer/src/transfer.js';

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const MD5_PATTERN = /^[a-f0-9]{32}$/i;
const CANDIDATE_STATUSES = new Set(['CREATED', 'RECEIVING', 'PARTIAL', 'FAILED', 'COMPLETED']);

function now() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}-${Date.now()}-${randomUUID()}`; }

function safeText(value, name, { required = true, max = 255 } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`${name} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.length > max) throw new Error(`${name} must be 1-${max} characters`);
  return value.trim();
}

function safeFileName(fileName) {
  const value = safeText(fileName, 'fileName', { max: 255 });
  if (value.includes('\0') || value !== value.split(/[\\/]/).pop() || value === '.' || value === '..') throw new Error('fileName must be a plain file name');
  return value;
}

function fileNameFromUrl(sourceUrl) {
  const pathname = new URL(sourceUrl).pathname;
  const name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() ?? '');
  if (!name) throw new Error('fileName is required when source URL has no file name');
  return safeFileName(name);
}

function parseProduct(row) {
  if (!row) return null;
  return { productId: row.product_id, name: row.name, releaseCount: row.release_count ?? 0, createdAt: row.created_at, updatedAt: row.updated_at };
}

function parseRelease(row) {
  if (!row) return null;
  return {
    releaseId: row.release_id,
    productId: row.product_id,
    productName: row.product_name,
    version: row.version,
    status: row.status,
    candidateCount: row.candidate_count ?? 0,
    completedCandidateCount: row.completed_candidate_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseCandidate(row) {
  if (!row) return null;
  return { ...row, targets: JSON.parse(row.targets_json), metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {}, completedParts: row.completed_parts, missingParts: row.missing_parts };
}

export class CandidateStore {
  constructor({ db, dataDir, defaultChunkSize }) {
    this.db = db;
    this.dataDir = dataDir;
    this.defaultChunkSize = defaultChunkSize;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        product_id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (
        release_id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(product_id, version),
        FOREIGN KEY (product_id) REFERENCES products(product_id)
      );
      CREATE TABLE IF NOT EXISTS candidates (
        candidate_id TEXT PRIMARY KEY,
        release_id TEXT,
        source_url TEXT NOT NULL,
        file_name TEXT NOT NULL,
        version TEXT NOT NULL,
        architecture TEXT,
        targets_json TEXT NOT NULL,
        expected_size INTEGER NOT NULL DEFAULT 0,
        expected_md5 TEXT,
        expected_sha256 TEXT,
        chunk_size INTEGER NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        source_tag TEXT,
        final_md5 TEXT,
        final_sha256 TEXT,
        source_path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        error_message TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (release_id) REFERENCES releases(release_id)
      );
      CREATE TABLE IF NOT EXISTS release_rounds (
        round_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        base_round_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(release_id, round_no),
        FOREIGN KEY (release_id) REFERENCES releases(release_id),
        FOREIGN KEY (base_round_id) REFERENCES release_rounds(round_id)
      );
      CREATE TABLE IF NOT EXISTS round_candidates (
        round_id TEXT NOT NULL,
        package_key TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        source TEXT NOT NULL,
        inherited_from_round_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (round_id, package_key),
        FOREIGN KEY (round_id) REFERENCES release_rounds(round_id),
        FOREIGN KEY (candidate_id) REFERENCES candidates(candidate_id),
        FOREIGN KEY (inherited_from_round_id) REFERENCES release_rounds(round_id)
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
      CREATE TABLE IF NOT EXISTS receive_queue (
        candidate_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        queued_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (candidate_id) REFERENCES candidates(candidate_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS receive_queue_order_idx ON receive_queue(status, queued_at);
    `);
    this.migrateCandidates();
  }

  migrateCandidates() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(candidates)').all().map((column) => column.name));
    const migrations = [
      ['release_id', 'ALTER TABLE candidates ADD COLUMN release_id TEXT'],
      ['expected_md5', 'ALTER TABLE candidates ADD COLUMN expected_md5 TEXT'],
      ['final_md5', 'ALTER TABLE candidates ADD COLUMN final_md5 TEXT'],
      ['final_sha256', 'ALTER TABLE candidates ADD COLUMN final_sha256 TEXT'],
      ['metadata_json', "ALTER TABLE candidates ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'"]
    ];
    for (const [column, statement] of migrations) if (!columns.has(column)) this.db.exec(statement);
    this.db.exec('CREATE INDEX IF NOT EXISTS candidates_release_idx ON candidates(release_id, created_at DESC)');
  }

  createProduct({ name }) {
    const productName = safeText(name, 'name', { max: 128 });
    const timestamp = now();
    const productId = id('PROD');
    try {
      this.db.prepare('INSERT INTO products (product_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(productId, productName, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('product name already exists');
      throw error;
    }
    return this.getProduct(productId);
  }

  getProduct(productId) {
    return parseProduct(this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM releases r WHERE r.product_id = p.product_id) AS release_count
      FROM products p WHERE p.product_id = ?`).get(productId));
  }

  listProducts() {
    return this.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM releases r WHERE r.product_id = p.product_id) AS release_count
      FROM products p ORDER BY p.name`).all().map(parseProduct);
  }

  deleteProduct(productId) {
    const product = this.getProduct(productId);
    if (!product) return null;
    if (product.releaseCount > 0) {
      const error = new Error('product has releases and cannot be deleted');
      error.code = 'product_not_empty';
      throw error;
    }
    this.db.prepare('DELETE FROM products WHERE product_id = ?').run(productId);
    return { productId, deleted: true };
  }

  createRelease(productId, { version }) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('product not found');
    const releaseVersion = safeText(version, 'version', { max: 128 });
    const timestamp = now();
    const releaseId = id('REL');
    try {
      this.db.prepare('INSERT INTO releases (release_id, product_id, version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(releaseId, productId, releaseVersion, 'OPEN', timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('release version already exists for this product');
      throw error;
    }
    return this.getRelease(releaseId);
  }

  getRelease(releaseId) {
    return parseRelease(this.db.prepare(`SELECT r.*, p.name AS product_name,
      (SELECT COUNT(*) FROM candidates c WHERE c.release_id = r.release_id) AS candidate_count,
      (SELECT COUNT(*) FROM candidates c WHERE c.release_id = r.release_id AND c.status = 'COMPLETED') AS completed_candidate_count
      FROM releases r JOIN products p ON p.product_id = r.product_id WHERE r.release_id = ?`).get(releaseId));
  }

  listReleases(productId = null) {
    const sql = `SELECT r.*, p.name AS product_name,
      (SELECT COUNT(*) FROM candidates c WHERE c.release_id = r.release_id) AS candidate_count,
      (SELECT COUNT(*) FROM candidates c WHERE c.release_id = r.release_id AND c.status = 'COMPLETED') AS completed_candidate_count
      FROM releases r JOIN products p ON p.product_id = r.product_id ${productId ? 'WHERE r.product_id = ?' : ''} ORDER BY r.created_at DESC`;
    return (productId ? this.db.prepare(sql).all(productId) : this.db.prepare(sql).all()).map(parseRelease);
  }

  deleteRelease(releaseId) {
    const release = this.getRelease(releaseId);
    if (!release) return null;
    if (release.status !== 'OPEN') {
      const error = new Error('only open releases can be deleted');
      error.code = 'release_not_open';
      throw error;
    }
    if (release.candidateCount > 0) {
      const error = new Error('release has candidate packages and cannot be deleted');
      error.code = 'release_not_empty';
      throw error;
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE release_rounds SET base_round_id = NULL WHERE release_id = ?').run(releaseId);
      this.db.prepare('DELETE FROM round_candidates WHERE round_id IN (SELECT round_id FROM release_rounds WHERE release_id = ?)').run(releaseId);
      this.db.prepare('DELETE FROM release_rounds WHERE release_id = ?').run(releaseId);
      this.db.prepare('DELETE FROM releases WHERE release_id = ?').run(releaseId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { releaseId, deleted: true };
  }

  createRound(releaseId, { baseRoundId = null } = {}) {
    const release = this.getRelease(releaseId);
    if (!release) throw new Error('release not found');
    const base = baseRoundId ? this.getRound(baseRoundId) : null;
    if (baseRoundId && (!base || base.releaseId !== releaseId)) throw new Error('base round does not belong to release');
    const latest = this.db.prepare('SELECT MAX(round_no) AS round_no FROM release_rounds WHERE release_id = ?').get(releaseId);
    const roundNo = Number(latest?.round_no ?? 0) + 1;
    const roundId = id('ROUND');
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO release_rounds (round_id, release_id, round_no, base_round_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(roundId, releaseId, roundNo, baseRoundId, 'OPEN', timestamp, timestamp);
      if (baseRoundId) {
        this.db.prepare(`INSERT INTO round_candidates (round_id, package_key, candidate_id, source, inherited_from_round_id, created_at)
          SELECT ?, package_key, candidate_id, 'INHERITED', ?, ? FROM round_candidates WHERE round_id = ?`).run(roundId, baseRoundId, timestamp, baseRoundId);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getRound(roundId);
  }

  getRound(roundId) {
    const row = this.db.prepare(`SELECT rr.*, r.version, r.product_id, p.name AS product_name,
      (SELECT COUNT(*) FROM round_candidates rc WHERE rc.round_id = rr.round_id) AS candidate_count,
      (SELECT COUNT(*) FROM round_candidates rc JOIN candidates c ON c.candidate_id = rc.candidate_id WHERE rc.round_id = rr.round_id AND c.status = 'COMPLETED') AS completed_candidate_count
      FROM release_rounds rr JOIN releases r ON r.release_id = rr.release_id JOIN products p ON p.product_id = r.product_id
      WHERE rr.round_id = ?`).get(roundId);
    if (!row) return null;
    return {
      roundId: row.round_id,
      releaseId: row.release_id,
      productId: row.product_id,
      productName: row.product_name,
      version: row.version,
      roundNo: row.round_no,
      baseRoundId: row.base_round_id,
      status: row.status,
      candidateCount: row.candidate_count ?? 0,
      completedCandidateCount: row.completed_candidate_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listRounds(releaseId) {
    if (!this.getRelease(releaseId)) throw new Error('release not found');
    return this.db.prepare('SELECT round_id FROM release_rounds WHERE release_id = ? ORDER BY round_no DESC').all(releaseId).map(({ round_id: roundId }) => this.getRound(roundId));
  }

  listRoundCandidates(roundId) {
    if (!this.getRound(roundId)) throw new Error('round not found');
    return this.db.prepare(`SELECT rc.package_key, rc.source AS mapping_source, rc.inherited_from_round_id, c.*,
      (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED')) AS missing_parts
      FROM round_candidates rc JOIN candidates c ON c.candidate_id = rc.candidate_id
      WHERE rc.round_id = ? ORDER BY rc.package_key`).all(roundId).map(parseCandidate);
  }

  attachCandidateToRound(roundId, packageKey, candidateId, { source = 'OWNED', inheritedFromRoundId = null } = {}) {
    const round = this.getRound(roundId);
    const candidate = this.get(candidateId);
    const key = safeText(packageKey, 'packageKey', { max: 255 });
    if (!round) throw new Error('round not found');
    if (!candidate) throw new Error('candidate not found');
    if (candidate.release_id !== round.releaseId) throw new Error('candidate and round belong to different releases');
    if (inheritedFromRoundId && !this.getRound(inheritedFromRoundId)) throw new Error('inherited source round not found');
    this.db.prepare(`INSERT INTO round_candidates (round_id, package_key, candidate_id, source, inherited_from_round_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(round_id, package_key) DO UPDATE SET candidate_id=excluded.candidate_id, source=excluded.source, inherited_from_round_id=excluded.inherited_from_round_id, created_at=excluded.created_at`).run(roundId, key, candidateId, source, inheritedFromRoundId, now());
    return this.getRound(roundId);
  }

  detachCandidateFromRound(roundId, candidateId) {
    const round = this.getRound(roundId);
    if (!round) throw new Error('round not found');
    const mapping = this.db.prepare(`SELECT package_key, candidate_id, source, inherited_from_round_id
      FROM round_candidates WHERE round_id = ? AND candidate_id = ?`).get(roundId, candidateId);
    if (!mapping) return null;
    this.db.prepare('DELETE FROM round_candidates WHERE round_id = ? AND candidate_id = ?').run(roundId, candidateId);
    return { roundId, candidateId, packageKey: mapping.package_key, source: mapping.source, inheritedFromRoundId: mapping.inherited_from_round_id };
  }

  resolveSourceUrl(sourceUrl) {
    if (typeof sourceUrl !== 'string' || sourceUrl.length === 0 || sourceUrl.length > 2048) throw new Error('sourceUrl is required');
    try {
      const parsed = new URL(sourceUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('sourceUrl must use http or https');
      return parsed.toString();
    } catch (error) { throw new Error(`invalid sourceUrl: ${error.message}`); }
  }

  async create({ releaseId = null, roundId = null, packageKey = null, sourceUrl, fileName = null, version = null, architecture = null, targets = [], size = null, md5 = null, sha256 = null, expectedMd5 = null, expectedSha256 = null, chunkSize = this.defaultChunkSize, sourceMetadata = null, metadata = null }) {
    const normalizedUrl = this.resolveSourceUrl(sourceUrl);
    const round = roundId ? this.getRound(roundId) : null;
    if (roundId && !round) throw new Error('round not found');
    if (round && releaseId && round.releaseId !== releaseId) throw new Error('round and release do not match');
    const effectiveReleaseId = round?.releaseId ?? releaseId;
    const release = effectiveReleaseId ? this.getRelease(effectiveReleaseId) : null;
    if (effectiveReleaseId && !release) throw new Error('release not found');
    const safeName = fileName ? safeFileName(fileName) : fileNameFromUrl(normalizedUrl);
    const packageVersion = version ? safeText(version, 'version', { max: 128 }) : (release?.version ?? 'UNSPECIFIED');
    const effectivePackageKey = packageKey ? safeText(packageKey, 'packageKey', { max: 255 }) : safeName;
    const safeArchitecture = architecture ? safeText(architecture, 'architecture', { max: 64 }) : null;
    const normalizedTargets = targets ?? [];
    if (!Array.isArray(normalizedTargets) || normalizedTargets.some((target) => typeof target !== 'string' || target.length > 128)) throw new Error('targets must be an array of strings');
    const expectedMd5Value = md5 ?? expectedMd5;
    const expectedSha256Value = sha256 ?? expectedSha256;
    if (expectedMd5Value !== null && (!MD5_PATTERN.test(expectedMd5Value))) throw new Error('md5 must be a 32-character hexadecimal digest');
    if (expectedSha256Value !== null && (!SHA256_PATTERN.test(expectedSha256Value))) throw new Error('sha256 must be a 64-character hexadecimal digest');
    const expectedSize = size === null || size === undefined || size === '' ? 0 : size;
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error('size must be a non-negative safe integer');
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > 512 * 1024 * 1024) throw new Error('chunkSize must be between 1 and 512 MiB');
    const candidateMetadata = metadata ?? sourceMetadata ?? {};
    if (!candidateMetadata || typeof candidateMetadata !== 'object' || Array.isArray(candidateMetadata)) throw new Error('metadata must be an object');
    if (Buffer.byteLength(JSON.stringify(candidateMetadata)) > 16 * 1024) throw new Error('metadata must be 16 KiB or smaller');
    const candidateId = id('CAND');
    const chunkCount = calculateChunkCount(expectedSize, chunkSize);
    const candidateDir = join(this.dataDir, 'candidates', candidateId);
    const sourceDir = join(candidateDir, 'source');
    await mkdir(join(candidateDir, 'parts'), { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, safeName);
    const timestamp = now();
    this.db.prepare(`INSERT INTO candidates
      (candidate_id, release_id, source_url, file_name, version, architecture, targets_json, expected_size, expected_md5, expected_sha256, chunk_size, chunk_count, status, source_path, created_at, updated_at, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(candidateId, effectiveReleaseId, normalizedUrl, safeName, packageVersion, safeArchitecture, JSON.stringify(normalizedTargets), expectedSize, expectedMd5Value, expectedSha256Value, chunkSize, chunkCount, 'CREATED', sourcePath, timestamp, timestamp, JSON.stringify(candidateMetadata));
    if (roundId) this.attachCandidateToRound(roundId, effectivePackageKey, candidateId);
    return this.get(candidateId);
  }

  updateCandidate(candidateId, { sourceUrl, fileName, packageKey, version, architecture, targets, size, md5, sha256, expectedMd5, expectedSha256, metadata, sourceMetadata } = {}) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (['RECEIVING', 'ASSEMBLING', 'COMPLETED'].includes(candidate.status)) { const error = new Error('candidate cannot be edited in its current status'); error.code = 'candidate_not_editable'; throw error; }
    const parts = this.listParts(candidateId);
    const nextUrl = sourceUrl === undefined ? candidate.source_url : this.resolveSourceUrl(sourceUrl);
    const nextName = fileName === undefined || fileName === null || fileName === '' ? candidate.file_name : safeFileName(fileName);
    const nextSize = size === undefined || size === null || size === '' ? candidate.expected_size : size;
    if (!Number.isSafeInteger(nextSize) || nextSize < 0) throw new Error('size must be a non-negative safe integer');
    if (parts.length > 0 && (nextUrl !== candidate.source_url || nextName !== candidate.file_name || nextSize !== candidate.expected_size)) { const error = new Error('cannot change source, file name or size after receiving parts'); error.code = 'candidate_has_parts'; throw error; }
    const nextMd5 = md5 !== undefined ? md5 : expectedMd5 !== undefined ? expectedMd5 : candidate.expected_md5;
    const nextSha256 = sha256 !== undefined ? sha256 : expectedSha256 !== undefined ? expectedSha256 : candidate.expected_sha256;
    if (nextMd5 !== null && !MD5_PATTERN.test(nextMd5)) throw new Error('md5 must be a 32-character hexadecimal digest');
    if (nextSha256 !== null && !SHA256_PATTERN.test(nextSha256)) throw new Error('sha256 must be a 64-character hexadecimal digest');
    const nextVersion = version === undefined || version === null || version === '' ? candidate.version : safeText(version, 'version', { max: 128 });
    const nextPackageKey = packageKey ? safeText(packageKey, 'packageKey', { max: 255 }) : candidate.package_key;
    const nextArchitecture = architecture === undefined ? candidate.architecture : (architecture ? safeText(architecture, 'architecture', { max: 64 }) : null);
    const nextTargets = targets === undefined ? candidate.targets : targets;
    if (!Array.isArray(nextTargets) || nextTargets.some((target) => typeof target !== 'string' || target.length > 128)) throw new Error('targets must be an array of strings');
    const nextChunkCount = nextSize === candidate.expected_size ? candidate.chunk_count : calculateChunkCount(nextSize, candidate.chunk_size);
    const nextMetadata = metadata ?? sourceMetadata ?? candidate.metadata ?? {};
    if (!nextMetadata || typeof nextMetadata !== 'object' || Array.isArray(nextMetadata)) throw new Error('metadata must be an object');
    if (Buffer.byteLength(JSON.stringify(nextMetadata)) > 16 * 1024) throw new Error('metadata must be 16 KiB or smaller');
    const nextStatus = parts.length > 0 ? 'PARTIAL' : 'CREATED';
    const sourcePath = join(this.candidateDir(candidateId), 'source', nextName);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE candidates SET source_url = ?, file_name = ?, version = ?, architecture = ?, targets_json = ?, expected_size = ?, expected_md5 = ?, expected_sha256 = ?, chunk_count = ?, source_path = ?, status = ?, metadata_json = ?, error_message = NULL, updated_at = ? WHERE candidate_id = ?`).run(nextUrl, nextName, nextVersion, nextArchitecture, JSON.stringify(nextTargets), nextSize, nextMd5, nextSha256, nextChunkCount, sourcePath, nextStatus, JSON.stringify(nextMetadata), now(), candidateId);
      if (nextPackageKey && nextPackageKey !== candidate.package_key) this.db.prepare('UPDATE round_candidates SET package_key = ? WHERE candidate_id = ?').run(nextPackageKey, candidateId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(candidateId);
  }

  deleteCandidate(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) return null;
    if (['RECEIVING', 'ASSEMBLING'].includes(candidate.status)) { const error = new Error('candidate is receiving and cannot be deleted'); error.code = 'candidate_busy'; throw error; }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM round_candidates WHERE candidate_id = ?').run(candidateId);
      this.db.prepare('DELETE FROM candidate_parts WHERE candidate_id = ?').run(candidateId);
      this.db.prepare('DELETE FROM candidates WHERE candidate_id = ?').run(candidateId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { candidateId, deleted: true, dataDir: this.candidateDir(candidateId) };
  }

  get(candidateId) {
    const row = this.db.prepare(`SELECT c.*, r.version AS release_version, r.product_id, p.name AS product_name,
      (SELECT rc.package_key FROM round_candidates rc WHERE rc.candidate_id = c.candidate_id ORDER BY rc.created_at LIMIT 1) AS package_key,
      (SELECT COUNT(*) FROM candidate_parts p2 WHERE p2.candidate_id = c.candidate_id AND p2.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p2 WHERE p2.candidate_id = c.candidate_id AND p2.status = 'COMPLETED')) AS missing_parts
      FROM candidates c LEFT JOIN releases r ON r.release_id = c.release_id LEFT JOIN products p ON p.product_id = r.product_id
      WHERE c.candidate_id = ?`).get(candidateId);
    return parseCandidate(row);
  }

  list({ limit = 50, offset = 0, releaseId = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
    const filter = releaseId ? 'WHERE c.release_id = ?' : '';
    const args = releaseId ? [releaseId, limit, offset] : [limit, offset];
    const rows = this.db.prepare(`SELECT c.*, r.version AS release_version, r.product_id, p.name AS product_name,
      (SELECT rc.package_key FROM round_candidates rc WHERE rc.candidate_id = c.candidate_id ORDER BY rc.created_at LIMIT 1) AS package_key,
      (SELECT COUNT(*) FROM candidate_parts p2 WHERE p2.candidate_id = c.candidate_id AND p2.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p2 WHERE p2.candidate_id = c.candidate_id AND p2.status = 'COMPLETED')) AS missing_parts
      FROM candidates c LEFT JOIN releases r ON r.release_id = c.release_id LEFT JOIN products p ON p.product_id = r.product_id
      ${filter} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`).all(...args);
    return rows.map(parseCandidate);
  }

  enqueueReceive(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (candidate.status === 'COMPLETED') return this.getReceiveJob(candidateId);
    const timestamp = now();
    this.db.prepare(`INSERT INTO receive_queue (candidate_id, status, attempts, error_message, queued_at, updated_at)
      VALUES (?, 'QUEUED', 0, NULL, ?, ?)
      ON CONFLICT(candidate_id) DO UPDATE SET status = 'QUEUED', error_message = NULL, queued_at = excluded.queued_at, updated_at = excluded.updated_at
      WHERE receive_queue.status IN ('PAUSED', 'FAILED', 'CANCELLED')`).run(candidateId, timestamp, timestamp);
    return this.getReceiveJob(candidateId);
  }

  getReceiveJob(candidateId) {
    return this.db.prepare('SELECT * FROM receive_queue WHERE candidate_id = ?').get(candidateId) ?? null;
  }

  listReceiveQueue() {
    return this.db.prepare(`SELECT q.*, c.file_name, c.version, c.expected_size, c.status AS candidate_status,
      (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED') AS completed_parts,
      c.chunk_count AS total_parts
      FROM receive_queue q JOIN candidates c ON c.candidate_id = q.candidate_id
      ORDER BY CASE q.status WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 ELSE 2 END, q.queued_at`).all();
  }

  claimReceiveJob(candidateId) {
    const timestamp = now();
    const result = this.db.prepare(`UPDATE receive_queue SET status = 'RUNNING', attempts = attempts + 1, error_message = NULL, updated_at = ?
      WHERE candidate_id = ? AND status = 'QUEUED'`).run(timestamp, candidateId);
    return result.changes === 1;
  }

  nextReceiveJobs(limit) {
    return this.db.prepare("SELECT candidate_id FROM receive_queue WHERE status = 'QUEUED' ORDER BY queued_at, candidate_id LIMIT ?").all(limit).map((row) => row.candidate_id);
  }

  updateReceiveJob(candidateId, status, errorMessage = null) {
    this.db.prepare('UPDATE receive_queue SET status = ?, error_message = ?, updated_at = ? WHERE candidate_id = ?')
      .run(status, errorMessage ? String(errorMessage).slice(0, 1000) : null, now(), candidateId);
    return this.getReceiveJob(candidateId);
  }

  recoverReceiveQueue() {
    this.db.prepare("UPDATE receive_queue SET status = 'QUEUED', updated_at = ? WHERE status = 'RUNNING'").run(now());
    this.db.prepare(`INSERT INTO receive_queue (candidate_id, status, attempts, queued_at, updated_at)
      SELECT candidate_id, 'QUEUED', 0, ?, ? FROM candidates c
      WHERE c.status IN ('RECEIVING', 'PARTIAL', 'ASSEMBLING')
        AND NOT EXISTS (SELECT 1 FROM receive_queue q WHERE q.candidate_id = c.candidate_id)`).run(now(), now());
  }

  roundCandidateIds(roundId) {
    if (!this.getRound(roundId)) throw new Error('round not found');
    return this.db.prepare('SELECT candidate_id FROM round_candidates WHERE round_id = ? ORDER BY package_key').all(roundId).map((row) => row.candidate_id);
  }

  setExpectedSize(candidateId, size) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('remote file size is invalid');
    if (candidate.expected_size !== 0 && candidate.expected_size !== size) throw new Error('source size changed during receive');
    const chunkCount = calculateChunkCount(size, candidate.chunk_size);
    this.db.prepare('UPDATE candidates SET expected_size = ?, chunk_count = ?, updated_at = ? WHERE candidate_id = ?').run(size, chunkCount, now(), candidateId);
    return this.get(candidateId);
  }

  getPart(candidateId, partIndex) { return this.db.prepare('SELECT * FROM candidate_parts WHERE candidate_id = ? AND part_index = ?').get(candidateId, partIndex) ?? null; }
  listParts(candidateId) { return this.db.prepare('SELECT * FROM candidate_parts WHERE candidate_id = ? ORDER BY part_index').all(candidateId); }

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

  markPartial(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (candidate.status === 'COMPLETED') return candidate;
    this.db.prepare('UPDATE candidates SET status = ?, updated_at = ? WHERE candidate_id = ?').run('PARTIAL', now(), candidateId);
    return this.get(candidateId);
  }

  markAssembling(candidateId) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (candidate.status === 'COMPLETED') return candidate;
    this.db.prepare('UPDATE candidates SET status = ?, updated_at = ?, error_message = NULL WHERE candidate_id = ?').run('ASSEMBLING', now(), candidateId);
    return this.get(candidateId);
  }

  setSourceTag(candidateId, sourceTag) { this.db.prepare('UPDATE candidates SET source_tag = ?, updated_at = ? WHERE candidate_id = ? AND source_tag IS NULL').run(sourceTag, now(), candidateId); }

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
      ON CONFLICT(candidate_id, part_index) DO UPDATE SET offset=excluded.offset, size=excluded.size, sha256=excluded.sha256, status=excluded.status, updated_at=excluded.updated_at`).run(candidateId, partIndex, expected.offset, size, sha256, 'COMPLETED', timestamp);
    this.db.prepare('UPDATE candidates SET status = ?, updated_at = ?, error_message = NULL WHERE candidate_id = ?').run(candidate.status === 'RECEIVING' ? 'RECEIVING' : 'PARTIAL', timestamp, candidateId);
  }

  complete(candidateId, { finalSha256, finalMd5 = null } = {}) {
    const candidate = this.get(candidateId);
    if (!candidate) throw new Error('candidate not found');
    if (candidate.status === 'COMPLETED') return candidate;
    const missing = this.missingParts(candidateId);
    if (missing.length > 0) throw new Error(`candidate has missing parts: ${missing.join(',')}`);
    if (!SHA256_PATTERN.test(finalSha256)) throw new Error('final sha256 is invalid');
    if (finalMd5 !== null && !MD5_PATTERN.test(finalMd5)) throw new Error('final md5 is invalid');
    if (candidate.expected_sha256 && candidate.expected_sha256.toLowerCase() !== finalSha256.toLowerCase()) throw new Error(`assembled file SHA-256 does not match expected digest (expected: ${candidate.expected_sha256}; actual: ${finalSha256})`);
    if (candidate.expected_md5 && (!finalMd5 || candidate.expected_md5.toLowerCase() !== finalMd5.toLowerCase())) throw new Error(`assembled file MD5 does not match expected digest (expected: ${candidate.expected_md5}; actual: ${finalMd5 ?? 'unavailable'})`);
    const timestamp = now();
    this.db.prepare('UPDATE candidates SET status = ?, final_md5 = ?, final_sha256 = ?, completed_at = ?, updated_at = ?, error_message = NULL WHERE candidate_id = ?').run('COMPLETED', finalMd5, finalSha256, timestamp, timestamp, candidateId);
    return this.get(candidateId);
  }

  fail(candidateId, error) { this.db.prepare('UPDATE candidates SET status = ?, error_message = ?, updated_at = ? WHERE candidate_id = ?').run('FAILED', String(error.message ?? error).slice(0, 1000), now(), candidateId); }
  partPath(candidateId, partIndex) { return join(this.dataDir, 'candidates', candidateId, 'parts', `part-${String(partIndex).padStart(6, '0')}`); }
  candidateDir(candidateId) { return join(this.dataDir, 'candidates', candidateId); }
}

export { CANDIDATE_STATUSES, MD5_PATTERN, SHA256_PATTERN, fileNameFromUrl, safeFileName };
