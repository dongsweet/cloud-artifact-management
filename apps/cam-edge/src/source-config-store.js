const now = () => new Date().toISOString();

function values(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\s,;\r\n]+/u);
  return [...new Set(raw.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean))];
}

function normalize(input) {
  const list = values(input);
  for (const entry of list) {
    if (entry === '*') continue;
    if (entry.startsWith('*.')) {
      if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(entry.slice(2))) throw Object.assign(new Error('可信下载来源必须是主机名、IP 地址或有效的通配域名'), { code: 'source_allowlist_invalid' });
      continue;
    }
    if (entry.includes('/') || entry.includes(':') || !/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu.test(entry)) {
      throw Object.assign(new Error(`可信下载来源“${entry}”格式无效，请填写主机名或 IP 地址，不要填写 URL、端口或路径`), { code: 'source_allowlist_invalid' });
    }
  }
  return list;
}

export class SourceConfigStore {
  constructor(db, { env = process.env, initialAllowlist } = {}) {
    this.db = db;
    this.env = env;
    this.initialAllowlist = initialAllowlist === undefined ? null : normalize(initialAllowlist);
    db.exec(`CREATE TABLE IF NOT EXISTS edge_source_allowlist_config (
      config_id INTEGER PRIMARY KEY CHECK (config_id = 1),
      allowlist_json TEXT NOT NULL,
      updated_by TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS edge_source_allowlist_events (
      event_id TEXT PRIMARY KEY,
      actor_id TEXT,
      action TEXT NOT NULL,
      allowlist_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
  }

  get() {
    const row = this.db.prepare('SELECT * FROM edge_source_allowlist_config WHERE config_id = 1').get();
    if (!row) {
      const fallback = this.initialAllowlist ?? normalize(this.env.CAM_SOURCE_ALLOWLIST ?? '');
      return { allowlist: fallback, source: this.initialAllowlist !== null ? 'provided' : 'environment', updatedBy: null, updatedAt: null };
    }
    return { allowlist: normalize(JSON.parse(row.allowlist_json)), source: 'database', updatedBy: row.updated_by, updatedAt: row.updated_at };
  }

  save(input, actorId) {
    const allowlist = normalize(input);
    const timestamp = now();
    const eventId = `SRCFG-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO edge_source_allowlist_config (config_id, allowlist_json, updated_by, updated_at)
        VALUES (1, ?, ?, ?) ON CONFLICT(config_id) DO UPDATE SET allowlist_json = excluded.allowlist_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(JSON.stringify(allowlist), actorId ?? null, timestamp);
      this.db.prepare('INSERT INTO edge_source_allowlist_events VALUES (?, ?, ?, ?, ?)').run(eventId, actorId ?? null, 'UPDATED', JSON.stringify(allowlist), timestamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get();
  }
}

export { normalize as normalizeSourceAllowlist };
