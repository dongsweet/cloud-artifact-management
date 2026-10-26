import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const now = () => new Date().toISOString();

export class LogCollectionStore {
  constructor({ db, dataDir }) {
    this.db = db;
    this.dataDir = dataDir;
    db.exec(`CREATE TABLE IF NOT EXISTS edge_log_collection_jobs (
      job_id TEXT PRIMARY KEY, core_job_id TEXT NOT NULL UNIQUE, from_at TEXT NOT NULL, to_at TEXT NOT NULL,
      categories_json TEXT NOT NULL, status TEXT NOT NULL, bundle_path TEXT, bundle_sha256 TEXT, bundle_size INTEGER,
      last_error TEXT, requested_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS edge_log_collection_jobs_status_idx ON edge_log_collection_jobs(status, updated_at);`);
  }
  create({ coreJobId, fromAt, toAt, categories, expiresAt, requestedBy }) {
    const jobId = `LOG-${randomUUID()}`; const timestamp = now();
    this.db.prepare('INSERT INTO edge_log_collection_jobs (job_id, core_job_id, from_at, to_at, categories_json, status, requested_by, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, coreJobId, fromAt, toAt, JSON.stringify(categories), 'COLLECTING', requestedBy ?? null, timestamp, timestamp, expiresAt);
    return this.get(jobId);
  }
  list() { return this.db.prepare('SELECT * FROM edge_log_collection_jobs ORDER BY created_at DESC').all().map((row) => this.#map(row)); }
  get(jobId) { const row = this.db.prepare('SELECT * FROM edge_log_collection_jobs WHERE job_id = ?').get(jobId); return row ? this.#map(row) : null; }
  active() { return this.db.prepare("SELECT * FROM edge_log_collection_jobs WHERE status IN ('COLLECTING','PACKAGING') ORDER BY created_at").all().map((row) => this.#map(row)); }
  expireExpired(at = now()) {
    const rows = this.db.prepare("SELECT job_id AS jobId FROM edge_log_collection_jobs WHERE expires_at <= ? AND status <> 'EXPIRED'").all(at);
    if (!rows.length) return [];
    this.db.prepare("UPDATE edge_log_collection_jobs SET status = 'EXPIRED', bundle_path = NULL, bundle_sha256 = NULL, bundle_size = NULL, updated_at = ? WHERE expires_at <= ? AND status <> 'EXPIRED'").run(now(), at);
    return rows.map((row) => row.jobId);
  }
  setStatus(jobId, status, fields = {}) { this.db.prepare('UPDATE edge_log_collection_jobs SET status = ?, bundle_path = COALESCE(?, bundle_path), bundle_sha256 = COALESCE(?, bundle_sha256), bundle_size = COALESCE(?, bundle_size), last_error = ?, updated_at = ? WHERE job_id = ?').run(status, fields.bundlePath ?? null, fields.bundleSha256 ?? null, fields.bundleSize ?? null, fields.lastError ?? null, now(), jobId); return this.get(jobId); }
  finalPath(jobId) { return join(this.dataDir, 'log-collections', jobId, 'final.tar.gz'); }
  #map(row) { return { jobId: row.job_id, coreJobId: row.core_job_id, fromAt: row.from_at, toAt: row.to_at, categories: JSON.parse(row.categories_json), status: row.status, bundlePath: row.bundle_path, bundleSha256: row.bundle_sha256, bundleSize: row.bundle_size, lastError: row.last_error, requestedBy: row.requested_by, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at }; }
}
