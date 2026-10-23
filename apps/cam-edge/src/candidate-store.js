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
    revision: row.revision ?? 0,
    displayVersion: row.revision > 0 ? `${row.version}-r${row.revision}` : row.version,
    baseReleaseId: row.base_release_id ?? null,
    baseReleaseDisplayVersion: row.base_release_version ? (row.base_release_revision > 0 ? `${row.base_release_version}-r${row.base_release_revision}` : row.base_release_version) : null,
    status: row.status,
    approvalPending: Boolean(row.approval_pending),
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
        revision INTEGER NOT NULL DEFAULT 0,
        base_release_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(product_id, version, revision),
        FOREIGN KEY (product_id) REFERENCES products(product_id),
        FOREIGN KEY (base_release_id) REFERENCES releases(release_id)
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
        change_note TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(release_id, round_no),
        FOREIGN KEY (release_id) REFERENCES releases(release_id),
        FOREIGN KEY (base_round_id) REFERENCES release_rounds(round_id)
      );
      CREATE TABLE IF NOT EXISTS round_attachments (
        attachment_id TEXT PRIMARY KEY,
        round_id TEXT NOT NULL REFERENCES release_rounds(round_id),
        file_name TEXT NOT NULL,
        content_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        file_path TEXT NOT NULL,
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL
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
      CREATE TABLE IF NOT EXISTS round_lifecycle_events (
        event_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        round_id TEXT NOT NULL,
        round_no INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        change_note TEXT NOT NULL,
        actor_id TEXT,
        created_at TEXT NOT NULL
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
    this.migrateReleases();
    this.migrateReleaseRounds();
  }

  migrateReleases() {
    const columns = this.db.prepare('PRAGMA table_info(releases)').all();
    const names = new Set(columns.map((column) => column.name));
    const uniqueVersion = this.db.prepare('PRAGMA index_list(releases)').all().some((index) => {
      if (!index.unique) return false;
      const indexed = this.db.prepare(`PRAGMA index_info("${index.name.replaceAll('"', '""')}")`).all().map((item) => item.name);
      return indexed.join(',') === 'product_id,version';
    });
    if (!names.has('revision') || !names.has('base_release_id') || uniqueVersion) {
      this.db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;');
      try {
        this.db.exec(`CREATE TABLE releases_migrated (
          release_id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          version TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          base_release_id TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(product_id, version, revision),
          FOREIGN KEY (product_id) REFERENCES products(product_id),
          FOREIGN KEY (base_release_id) REFERENCES releases_migrated(release_id)
        );`);
        const revisionSelect = names.has('revision') ? 'revision' : '0';
        const baseSelect = names.has('base_release_id') ? 'base_release_id' : 'NULL';
        this.db.exec(`INSERT INTO releases_migrated (release_id, product_id, version, revision, base_release_id, status, created_at, updated_at)
          SELECT release_id, product_id, version, ${revisionSelect}, ${baseSelect}, status, created_at, updated_at FROM releases; DROP TABLE releases; ALTER TABLE releases_migrated RENAME TO releases; COMMIT;`);
      } catch (error) {
        try { this.db.exec('ROLLBACK;'); } catch {}
        throw error;
      } finally { this.db.exec('PRAGMA foreign_keys = ON;'); }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS releases_product_version_idx ON releases(product_id, version, revision DESC)');
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

  migrateReleaseRounds() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(release_rounds)').all().map((column) => column.name));
    if (!columns.has('change_note')) this.db.exec("ALTER TABLE release_rounds ADD COLUMN change_note TEXT NOT NULL DEFAULT ''");
    if (!columns.has('created_by')) this.db.exec('ALTER TABLE release_rounds ADD COLUMN created_by TEXT');
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

  nextReleaseRevision(productId, version) {
    const previous = this.db.prepare('SELECT release_id, revision, status FROM releases WHERE product_id = ? AND version = ? ORDER BY revision DESC LIMIT 1').get(productId, version);
    if (!previous) return { revision: 0, baseReleaseId: null, baseRoundId: null };
    if (previous.status !== 'SEALED') throw Object.assign(new Error('该研发版本已有未固化的内部版本，请先完成审批或继续在现有版本中创建轮次'), { code: 'release_version_open' });
    const approvedRound = this.db.prepare(`SELECT rr.round_id FROM release_rounds rr JOIN round_freezes rf ON rf.round_id = rr.round_id
      WHERE rr.release_id = ? AND rf.status = 'APPROVED' ORDER BY rr.round_no DESC, rf.decided_at DESC LIMIT 1`).get(previous.release_id);
    if (!approvedRound) throw Object.assign(new Error('上一内部修订版已封存，但未找到审批通过的固化轮次，不能自动继承'), { code: 'release_baseline_missing' });
    return { revision: previous.revision + 1, baseReleaseId: previous.release_id, baseRoundId: approvedRound.round_id };
  }

  createRelease(productId, { version }) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('product not found');
    const releaseVersion = safeText(version, 'version', { max: 128 });
    const { revision, baseReleaseId } = this.nextReleaseRevision(productId, releaseVersion);
    const timestamp = now();
    const releaseId = id('REL');
    try {
      this.db.prepare('INSERT INTO releases (release_id, product_id, version, revision, base_release_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(releaseId, productId, releaseVersion, revision, baseReleaseId, 'OPEN', timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('release version already exists for this product');
      throw error;
    }
    return this.getRelease(releaseId);
  }

  createReleaseWithFirstRound(productId, { version, createdBy = null }) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('product not found');
    const releaseVersion = safeText(version, 'version', { max: 128 });
    const { revision, baseReleaseId, baseRoundId } = this.nextReleaseRevision(productId, releaseVersion);
    const timestamp = now();
    const releaseId = id('REL');
    const roundId = id('ROUND');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO releases (release_id, product_id, version, revision, base_release_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(releaseId, productId, releaseVersion, revision, baseReleaseId, 'OPEN', timestamp, timestamp);
      this.db.prepare('INSERT INTO release_rounds (round_id, release_id, round_no, base_round_id, change_note, created_by, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)')
        .run(roundId, releaseId, baseRoundId, baseRoundId ? `内部修订版创建，继承 ${this.displayVersion(baseReleaseId)} 已审批基线` : '发布版本创建，开始第一轮候选包收集', createdBy, 'OPEN', timestamp, timestamp);
      if (baseRoundId) this.db.prepare(`INSERT INTO round_candidates (round_id, package_key, candidate_id, source, inherited_from_round_id, created_at)
        SELECT ?, package_key, candidate_id, 'INHERITED', ?, ? FROM round_candidates WHERE round_id = ?`).run(roundId, baseRoundId, timestamp, baseRoundId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (String(error.message).includes('UNIQUE')) throw new Error('release version already exists for this product');
      throw error;
    }
    return { ...this.getRelease(releaseId), inheritedPackageCount: baseRoundId ? this.db.prepare('SELECT COUNT(*) AS count FROM round_candidates WHERE round_id = ?').get(roundId).count : 0, initialRound: this.getRound(roundId) };
  }

  createRevisionWithFirstRound(baseReleaseId, { version, createdBy = null } = {}) {
    const base = this.getRelease(baseReleaseId);
    if (!base) throw Object.assign(new Error('release not found'), { code: 'release_not_found' });
    if (version !== undefined && String(version) !== base.version) throw Object.assign(new Error('内部修订版必须沿用原研发版本号，不能修改版本号'), { code: 'revision_version_forbidden' });

    const timestamp = now();
    const releaseId = id('REL');
    const roundId = id('ROUND');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const currentBase = this.db.prepare('SELECT release_id, product_id, version, revision, status FROM releases WHERE release_id = ?').get(baseReleaseId);
      if (!currentBase) throw Object.assign(new Error('release not found'), { code: 'release_not_found' });
      if (currentBase.status !== 'SEALED') throw Object.assign(new Error('只有审批通过并封存的版本才能创建内部修订版'), { code: 'release_not_sealed' });
      const latest = this.db.prepare('SELECT release_id, status FROM releases WHERE product_id = ? AND version = ? ORDER BY revision DESC LIMIT 1').get(currentBase.product_id, currentBase.version);
      if (latest?.release_id !== currentBase.release_id) throw Object.assign(new Error('只能从该研发版本最新的内部修订版创建下一修订版'), { code: 'revision_source_not_latest' });
      const approvedRound = this.db.prepare(`SELECT rr.round_id FROM release_rounds rr JOIN round_freezes rf ON rf.round_id = rr.round_id
        WHERE rr.release_id = ? AND rf.status = 'APPROVED' ORDER BY rr.round_no DESC, rf.decided_at DESC LIMIT 1`).get(baseReleaseId);
      if (!approvedRound) throw Object.assign(new Error('未找到审批通过的固化轮次，不能创建内部修订版'), { code: 'release_baseline_missing' });

      this.db.prepare('INSERT INTO releases (release_id, product_id, version, revision, base_release_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(releaseId, currentBase.product_id, currentBase.version, currentBase.revision + 1, baseReleaseId, 'OPEN', timestamp, timestamp);
      this.db.prepare('INSERT INTO release_rounds (round_id, release_id, round_no, base_round_id, change_note, created_by, status, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?)')
        .run(roundId, releaseId, approvedRound.round_id, `内部修订版创建，继承 ${this.displayVersion(baseReleaseId)} 已审批基线`, createdBy, 'OPEN', timestamp, timestamp);
      this.db.prepare(`INSERT INTO round_candidates (round_id, package_key, candidate_id, source, inherited_from_round_id, created_at)
        SELECT ?, package_key, candidate_id, 'INHERITED', ?, ? FROM round_candidates WHERE round_id = ?`).run(roundId, approvedRound.round_id, timestamp, approvedRound.round_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { ...this.getRelease(releaseId), inheritedPackageCount: this.db.prepare('SELECT COUNT(*) AS count FROM round_candidates WHERE round_id = ?').get(roundId).count, initialRound: this.getRound(roundId) };
  }

  displayVersion(releaseId) {
    const release = this.db.prepare('SELECT version, revision FROM releases WHERE release_id = ?').get(releaseId);
    return release ? (release.revision > 0 ? `${release.version}-r${release.revision}` : release.version) : '';
  }

  getRelease(releaseId) {
    return parseRelease(this.db.prepare(`SELECT r.*, p.name AS product_name, br.version AS base_release_version, br.revision AS base_release_revision,
      (SELECT COUNT(*) FROM round_candidates rc JOIN release_rounds rr ON rr.round_id = rc.round_id WHERE rr.release_id = r.release_id AND rr.round_no = (SELECT MAX(last_round.round_no) FROM release_rounds last_round WHERE last_round.release_id = r.release_id)) AS candidate_count,
      (SELECT COUNT(*) FROM round_candidates rc JOIN release_rounds rr ON rr.round_id = rc.round_id JOIN candidates c ON c.candidate_id = rc.candidate_id WHERE rr.release_id = r.release_id AND rr.round_no = (SELECT MAX(last_round.round_no) FROM release_rounds last_round WHERE last_round.release_id = r.release_id) AND c.status = 'COMPLETED') AS completed_candidate_count,
      EXISTS (SELECT 1 FROM round_freezes rf JOIN release_rounds prr ON prr.round_id = rf.round_id WHERE prr.release_id = r.release_id AND rf.status = 'PENDING_APPROVAL') AS approval_pending
      FROM releases r JOIN products p ON p.product_id = r.product_id LEFT JOIN releases br ON br.release_id = r.base_release_id WHERE r.release_id = ?`).get(releaseId));
  }

  listReleases(productId = null) {
    const sql = `SELECT r.*, p.name AS product_name, br.version AS base_release_version, br.revision AS base_release_revision,
      (SELECT COUNT(*) FROM round_candidates rc JOIN release_rounds rr ON rr.round_id = rc.round_id WHERE rr.release_id = r.release_id AND rr.round_no = (SELECT MAX(last_round.round_no) FROM release_rounds last_round WHERE last_round.release_id = r.release_id)) AS candidate_count,
      (SELECT COUNT(*) FROM round_candidates rc JOIN release_rounds rr ON rr.round_id = rc.round_id JOIN candidates c ON c.candidate_id = rc.candidate_id WHERE rr.release_id = r.release_id AND rr.round_no = (SELECT MAX(last_round.round_no) FROM release_rounds last_round WHERE last_round.release_id = r.release_id) AND c.status = 'COMPLETED') AS completed_candidate_count,
      EXISTS (SELECT 1 FROM round_freezes rf JOIN release_rounds prr ON prr.round_id = rf.round_id WHERE prr.release_id = r.release_id AND rf.status = 'PENDING_APPROVAL') AS approval_pending
      FROM releases r JOIN products p ON p.product_id = r.product_id LEFT JOIN releases br ON br.release_id = r.base_release_id ${productId ? 'WHERE r.product_id = ?' : ''} ORDER BY r.created_at DESC, r.revision DESC`;
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
    if (release.candidateCount > 0 || this.db.prepare('SELECT 1 FROM candidates WHERE release_id = ? LIMIT 1').get(releaseId)) {
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

  createRound(releaseId, { baseRoundId = null, changeNote = '', createdBy = null, requireBaseChanges = false } = {}) {
    const release = this.getRelease(releaseId);
    if (!release) throw new Error('release not found');
    this.assertReleaseOpen(releaseId);
    const note = String(changeNote ?? '').trim();
    if (!note || note.length > 2000) throw new Error('请填写本轮收集/变更说明（1-2000 字）');
    const roundId = id('ROUND');
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.assertReleaseOpen(releaseId);
      const latest = this.db.prepare('SELECT round_id, round_no FROM release_rounds WHERE release_id = ? ORDER BY round_no DESC LIMIT 1').get(releaseId);
      if (baseRoundId && (!latest || latest.round_id !== baseRoundId)) throw Object.assign(new Error('只能基于当前最新轮次创建下一轮'), { code: 'round_not_latest' });
      if (!baseRoundId && latest) throw Object.assign(new Error('后续轮次必须继承当前最新轮次'), { code: 'round_base_required' });
      if (baseRoundId && requireBaseChanges && !this.roundHasChanges(baseRoundId).hasChanges) throw Object.assign(new Error('当前最新轮次相对上一轮没有候选包变更，不能继续创建下一轮；请先修改候选包，或删除这个空轮次'), { code: 'round_no_changes' });
      const roundNo = Number(latest?.round_no ?? 0) + 1;
      this.db.prepare('INSERT INTO release_rounds (round_id, release_id, round_no, base_round_id, change_note, created_by, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(roundId, releaseId, roundNo, baseRoundId, note, createdBy, 'OPEN', timestamp, timestamp);
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
    const row = this.db.prepare(`SELECT rr.*, r.version, r.revision, r.status AS release_status, r.product_id, p.name AS product_name,
      EXISTS (SELECT 1 FROM round_freezes pending WHERE pending.round_id IN (SELECT member.round_id FROM release_rounds member WHERE member.release_id = r.release_id) AND pending.status = 'PENDING_APPROVAL') AS approval_pending,
      base_round.round_no AS base_round_no, base_round.release_id AS base_release_id, base_release.version AS base_release_version, base_release.revision AS base_release_revision,
      (SELECT COUNT(*) FROM round_candidates rc WHERE rc.round_id = rr.round_id) AS candidate_count,
      (SELECT COUNT(*) FROM round_candidates rc JOIN candidates c ON c.candidate_id = rc.candidate_id WHERE rc.round_id = rr.round_id AND c.status = 'COMPLETED') AS completed_candidate_count
      FROM release_rounds rr JOIN releases r ON r.release_id = rr.release_id JOIN products p ON p.product_id = r.product_id
      LEFT JOIN release_rounds base_round ON base_round.round_id = rr.base_round_id LEFT JOIN releases base_release ON base_release.release_id = base_round.release_id
      WHERE rr.round_id = ?`).get(roundId);
    if (!row) return null;
    const item = {
      roundId: row.round_id,
      releaseId: row.release_id,
      productId: row.product_id,
      productName: row.product_name,
      version: row.version,
      revision: row.revision ?? 0,
      displayVersion: row.revision > 0 ? `${row.version}-r${row.revision}` : row.version,
      roundNo: row.round_no,
      baseRoundId: row.base_round_id,
      baseRoundNo: row.base_round_no ?? null,
      baseReleaseId: row.base_release_id ?? null,
      baseReleaseVersion: row.base_release_version ?? null,
      baseReleaseRevision: row.base_release_revision ?? null,
      baseReleaseDisplayVersion: row.base_release_version ? (row.base_release_revision > 0 ? `${row.base_release_version}-r${row.base_release_revision}` : row.base_release_version) : null,
      releaseStatus: row.release_status,
      approvalPending: Boolean(row.approval_pending),
      changeNote: row.change_note ?? '',
      createdBy: row.created_by ?? null,
      status: row.status,
      // A round keeps its own lifecycle status for write guards, while the
      // status shown to users follows the release-level approval lifecycle.
      // Approval seals the release as a whole, so every round in that release
      // must be shown as sealed instead of remaining misleadingly "open".
      effectiveStatus: row.release_status === 'SEALED'
        ? 'SEALED'
        : row.approval_pending
          ? 'PENDING_APPROVAL'
          : row.status,
      candidateCount: row.candidate_count ?? 0,
      completedCandidateCount: row.completed_candidate_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
    const changes = this.roundHasChanges(roundId);
    const latest = this.db.prepare('SELECT round_id FROM release_rounds WHERE release_id = ? ORDER BY round_no DESC LIMIT 1').get(item.releaseId);
    item.changeSummary = changes;
    item.hasChanges = changes.hasChanges;
    item.isLatestRound = latest?.round_id === roundId;
    item.readOnly = !item.isLatestRound;
    item.readOnlyReason = item.readOnly ? '已创建后续轮次，本轮只读；请在最新轮次中变更候选包' : null;
    item.staleEmptyBaseline = item.isLatestRound && this.isStaleEmptyRound(roundId);
    item.canDeleteEmpty = this.canDeleteEmptyRound(roundId);
    return item;
  }

  addRoundAttachment(roundId, { fileName, contentType, fileSize, sha256, filePath, uploadedBy }) {
    this.assertRoundWritable(roundId);
    if (!this.getRound(roundId)) throw new Error('round not found');
    const attachmentId = id('RATT');
    const createdAt = now();
    this.db.prepare('INSERT INTO round_attachments (attachment_id, round_id, file_name, content_type, file_size, sha256, file_path, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(attachmentId, roundId, fileName, contentType, fileSize, sha256, filePath, uploadedBy, createdAt);
    return this.getRoundAttachment(attachmentId);
  }

  getRoundAttachment(attachmentId) {
    const row = this.db.prepare('SELECT * FROM round_attachments WHERE attachment_id = ?').get(attachmentId);
    return row ? { attachmentId: row.attachment_id, roundId: row.round_id, fileName: row.file_name, contentType: row.content_type, fileSize: row.file_size, sha256: row.sha256, uploadedBy: row.uploaded_by, createdAt: row.created_at } : null;
  }

  roundAttachmentPath(attachmentId) { return this.db.prepare('SELECT file_path FROM round_attachments WHERE attachment_id = ?').get(attachmentId)?.file_path ?? null; }

  listRoundAttachments(roundId) {
    if (!this.getRound(roundId)) throw new Error('round not found');
    return this.db.prepare('SELECT attachment_id FROM round_attachments WHERE round_id = ? ORDER BY created_at').all(roundId).map(({ attachment_id }) => this.getRoundAttachment(attachment_id));
  }

  listRounds(releaseId) {
    if (!this.getRelease(releaseId)) throw new Error('release not found');
    return this.db.prepare('SELECT round_id FROM release_rounds WHERE release_id = ? ORDER BY round_no DESC').all(releaseId).map(({ round_id: roundId }) => this.getRound(roundId));
  }

  listRoundsByFilter({ productId = null, releaseId = null } = {}) {
    const conditions = [];
    const args = [];
    if (productId) { conditions.push('r.product_id = ?'); args.push(productId); }
    if (releaseId) { conditions.push('r.release_id = ?'); args.push(releaseId); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT rr.round_id
      FROM release_rounds rr JOIN releases r ON r.release_id = rr.release_id
      ${where} ORDER BY r.created_at DESC, rr.round_no DESC`).all(...args);
    return rows.map(({ round_id: roundId }) => this.getRound(roundId));
  }

  roundCreationPreview(releaseId) {
    const release = this.getRelease(releaseId);
    if (!release) return null;
    const latestRound = this.db.prepare('SELECT round_id, round_no FROM release_rounds WHERE release_id = ? ORDER BY round_no DESC LIMIT 1').get(releaseId);
    const changes = latestRound ? this.roundHasChanges(latestRound.round_id) : { hasChanges: false, added: 0, replaced: 0, removed: 0 };
    return {
      productName: release.productName,
      version: release.version,
      displayVersion: release.displayVersion,
      roundNo: Number(latestRound?.round_no ?? 0) + 1,
      baseRoundId: latestRound?.round_id ?? null,
      canCreate: release.status === 'OPEN' && !this.releaseApprovalPending(releaseId) && Boolean(latestRound && changes.hasChanges),
      blockedReason: release.status !== 'OPEN' ? '该发布版本已有审批通过的固化基线，已封存；如需更新，请创建内部修订版' : this.releaseApprovalPending(releaseId) ? '该发布版本正在审批中，请等待审批通过或驳回后再创建轮次' : latestRound && !changes.hasChanges ? '当前最新轮次没有新增、替换或移除候选包，不能继续创建下一轮' : null,
      latestRoundNo: Number(latestRound?.round_no ?? 0) || null,
      changeSummary: changes
    };
  }

  createNextRound(releaseId, { changeNote = '', createdBy = null } = {}) {
    // Validate the audit note before checking whether the current round has a
    // package delta, so malformed requests retain the normal 400 response.
    const note = String(changeNote ?? '').trim();
    if (!note || note.length > 2000) throw new Error('请填写本轮收集/变更说明（1-2000 字）');
    const preview = this.roundCreationPreview(releaseId);
    if (!preview) throw new Error('release not found');
    if (!preview.canCreate) throw Object.assign(new Error(preview.blockedReason ?? '当前轮次没有候选包变更，不能创建下一轮'), { code: 'round_no_changes' });
    return this.createRound(releaseId, { baseRoundId: preview.baseRoundId, changeNote: note, createdBy, requireBaseChanges: true });
  }

  roundHasChanges(roundId) {
    const round = this.db.prepare('SELECT base_round_id FROM release_rounds WHERE round_id = ?').get(roundId);
    if (!round) return { hasChanges: false, added: 0, replaced: 0, removed: 0 };
    const currentRows = this.db.prepare('SELECT package_key, candidate_id FROM round_candidates WHERE round_id = ?').all(roundId);
    const current = new Map(currentRows.map((row) => [row.package_key, row.candidate_id]));
    if (!round.base_round_id) return { hasChanges: current.size > 0, added: current.size, replaced: 0, removed: 0 };
    const baseRows = this.db.prepare('SELECT package_key, candidate_id FROM round_candidates WHERE round_id = ?').all(round.base_round_id);
    const base = new Map(baseRows.map((row) => [row.package_key, row.candidate_id]));
    let added = 0; let replaced = 0; let removed = 0;
    for (const [key, candidateId] of current) {
      if (!base.has(key)) added += 1;
      else if (base.get(key) !== candidateId) replaced += 1;
    }
    for (const key of base.keys()) if (!current.has(key)) removed += 1;
    return { hasChanges: added + replaced + removed > 0, added, replaced, removed };
  }

  isRoundLatest(roundId) {
    const round = this.db.prepare('SELECT release_id FROM release_rounds WHERE round_id = ?').get(roundId);
    if (!round) return false;
    return this.db.prepare('SELECT 1 FROM release_rounds WHERE release_id = ? AND base_round_id = ? LIMIT 1').get(round.release_id, roundId) === undefined;
  }

  assertRoundWritable(roundId) {
    const round = this.getRound(roundId);
    if (!round) throw Object.assign(new Error('round not found'), { code: 'round_not_found' });
    this.assertReleaseOpen(round.releaseId);
    if (!this.isRoundLatest(roundId)) throw Object.assign(new Error('已创建后续轮次，本轮只读；请在最新轮次中变更候选包'), { code: 'round_locked' });
  }

  assertReleaseOpen(releaseId) {
    const release = this.getRelease(releaseId);
    if (!release) throw Object.assign(new Error('release not found'), { code: 'release_not_found' });
    if (release.status !== 'OPEN') throw Object.assign(new Error('该发布版本已审批通过并封存，不能继续修改；如需更新，请创建内部修订版'), { code: 'release_sealed' });
    if (this.releaseApprovalPending(releaseId)) throw Object.assign(new Error('该发布版本正在审批中，请等待审批通过或驳回后再修改'), { code: 'release_approval_pending' });
  }

  releaseApprovalPending(releaseId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM round_freezes rf JOIN release_rounds rr ON rr.round_id = rf.round_id WHERE rr.release_id = ? AND rf.status = 'PENDING_APPROVAL' LIMIT 1`).get(releaseId));
  }

  canDeleteEmptyRound(roundId) {
    const round = this.db.prepare('SELECT rr.release_id, rr.round_no, rr.base_round_id, rr.status, r.revision FROM release_rounds rr JOIN releases r ON r.release_id = rr.release_id WHERE rr.round_id = ?').get(roundId);
    if (!round || round.status !== 'OPEN' || !round.base_round_id || !this.isRoundLatest(roundId)) return false;
    if (round.revision > 0 && round.round_no === 1) return false;
    const unchangedEmptyRound = !this.roundHasChanges(roundId).hasChanges;
    const staleEmptyRound = this.isStaleEmptyRound(roundId);
    if (!unchangedEmptyRound && !staleEmptyRound) return false;
    if (this.db.prepare('SELECT 1 FROM round_attachments WHERE round_id = ? LIMIT 1').get(roundId)) return false;
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'round_freezes'").get() && this.db.prepare('SELECT 1 FROM round_freezes WHERE round_id = ? LIMIT 1').get(roundId)) return false;
    return true;
  }

  isStaleEmptyRound(roundId) {
    const round = this.db.prepare('SELECT base_round_id, created_at, status FROM release_rounds WHERE round_id = ?').get(roundId);
    if (!round || round.status !== 'OPEN' || !round.base_round_id) return false;
    if (this.db.prepare('SELECT 1 FROM round_candidates WHERE round_id = ? LIMIT 1').get(roundId)) return false;
    // Legacy behavior allowed editing a base round after creating its child.
    // Such edits can make an otherwise empty child look like it intentionally
    // removed every package. Only treat it as stale when the base mapping was
    // actually created after this child, which distinguishes intentional
    // removals from the legacy deadlock.
    return Boolean(this.db.prepare('SELECT 1 FROM round_candidates WHERE round_id = ? AND created_at > ? LIMIT 1').get(round.base_round_id, round.created_at));
  }

  deleteEmptyRound(roundId, actorId = null) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const round = this.db.prepare('SELECT release_id, round_no, change_note FROM release_rounds WHERE round_id = ?').get(roundId);
      if (!round) throw Object.assign(new Error('round not found'), { code: 'round_not_found' });
      if (!this.canDeleteEmptyRound(roundId)) throw Object.assign(new Error('仅可删除没有候选包变更、附件或审批记录的最新草稿轮次'), { code: 'round_not_empty' });
      const timestamp = now();
      const recoveryDelete = this.isStaleEmptyRound(roundId);
      this.db.prepare('INSERT INTO round_lifecycle_events (event_id, release_id, round_id, round_no, event_type, change_note, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id('REVT'), round.release_id, roundId, round.round_no, recoveryDelete ? 'STALE_EMPTY_ROUND_DELETED' : 'EMPTY_ROUND_DELETED', round.change_note, actorId, timestamp);
      this.db.prepare('DELETE FROM round_candidates WHERE round_id = ?').run(roundId);
      this.db.prepare('DELETE FROM release_rounds WHERE round_id = ?').run(roundId);
      this.db.exec('COMMIT');
      return { roundId, roundNo: round.round_no, deleted: true, recoveryDelete };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  listRoundCandidates(roundId) {
    if (!this.getRound(roundId)) throw new Error('round not found');
    return this.db.prepare(`SELECT rc.package_key, rc.source AS mapping_source, rc.inherited_from_round_id,
      inherited_round.round_no AS inherited_from_round_no, inherited_release.version AS inherited_from_release_version, inherited_release.revision AS inherited_from_release_revision, c.*,
      current_release.version AS release_version, current_release.revision AS release_revision, current_product.product_id AS product_id, current_product.name AS product_name,
      (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p WHERE p.candidate_id = c.candidate_id AND p.status = 'COMPLETED')) AS missing_parts
      FROM round_candidates rc JOIN candidates c ON c.candidate_id = rc.candidate_id
      JOIN release_rounds current_round ON current_round.round_id = rc.round_id
      JOIN releases current_release ON current_release.release_id = current_round.release_id
      JOIN products current_product ON current_product.product_id = current_release.product_id
      LEFT JOIN release_rounds inherited_round ON inherited_round.round_id = rc.inherited_from_round_id
      LEFT JOIN releases inherited_release ON inherited_release.release_id = inherited_round.release_id
      WHERE rc.round_id = ? ORDER BY rc.package_key`).all(roundId).map(parseCandidate);
  }

  attachCandidateToRound(roundId, packageKey, candidateId, { source = 'OWNED', inheritedFromRoundId = null } = {}) {
    this.assertRoundWritable(roundId);
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
    this.assertRoundWritable(roundId);
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
    if (effectiveReleaseId) this.assertReleaseOpen(effectiveReleaseId);
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
    if (candidate.release_id) this.assertReleaseOpen(candidate.release_id);
    const linkedRoundIds = this.db.prepare('SELECT round_id FROM round_candidates WHERE candidate_id = ?').all(candidateId).map((row) => row.round_id);
    if (linkedRoundIds.some((roundId) => !this.isRoundLatest(roundId))) throw Object.assign(new Error('该候选包已被历史轮次引用，不能原地编辑；请在最新轮次中替换候选包'), { code: 'round_locked' });
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
    if (candidate.release_id) this.assertReleaseOpen(candidate.release_id);
    const linkedRoundIds = this.db.prepare('SELECT round_id FROM round_candidates WHERE candidate_id = ?').all(candidateId).map((row) => row.round_id);
    if (linkedRoundIds.some((roundId) => !this.isRoundLatest(roundId))) throw Object.assign(new Error('该候选包已被历史轮次引用，不能永久删除；请仅从最新轮次移除'), { code: 'round_locked' });
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
    const row = this.db.prepare(`SELECT c.*, r.version AS release_version, r.revision AS release_revision, r.product_id, p.name AS product_name,
      (SELECT rc.package_key FROM round_candidates rc WHERE rc.candidate_id = c.candidate_id ORDER BY rc.created_at LIMIT 1) AS package_key,
      (SELECT COUNT(*) FROM candidate_parts p2 WHERE p2.candidate_id = c.candidate_id AND p2.status = 'COMPLETED') AS completed_parts,
      (c.chunk_count - (SELECT COUNT(*) FROM candidate_parts p2 WHERE p2.candidate_id = c.candidate_id AND p2.status = 'COMPLETED')) AS missing_parts
      FROM candidates c LEFT JOIN releases r ON r.release_id = c.release_id LEFT JOIN products p ON p.product_id = r.product_id
      WHERE c.candidate_id = ?`).get(candidateId);
    return parseCandidate(row);
  }

  list({ limit = 50, offset = 0, releaseId = null, productId = null, status = null } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('limit must be between 1 and 200');
    if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a non-negative integer');
    if (status && !['CREATED', 'RECEIVING', 'PARTIAL', 'ASSEMBLING', 'FAILED', 'COMPLETED'].includes(status)) throw new Error('invalid candidate status');
    const conditions = [], args = [];
    if (releaseId) { conditions.push('(c.release_id = ? OR EXISTS (SELECT 1 FROM round_candidates rc JOIN release_rounds rr ON rr.round_id = rc.round_id WHERE rc.candidate_id = c.candidate_id AND rr.release_id = ?))'); args.push(releaseId, releaseId); }
    if (productId) { conditions.push('(r.product_id = ? OR EXISTS (SELECT 1 FROM round_candidates rc JOIN release_rounds rr ON rr.round_id = rc.round_id JOIN releases rp ON rp.release_id = rr.release_id WHERE rc.candidate_id = c.candidate_id AND rp.product_id = ?))'); args.push(productId, productId); }
    if (status) { conditions.push('c.status = ?'); args.push(status); }
    const filter = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    args.push(limit, offset);
    const rows = this.db.prepare(`SELECT c.*, r.version AS release_version, r.revision AS release_revision, r.product_id, p.name AS product_name,
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
