import { URL } from 'node:url';

const DEFAULTS = Object.freeze({
  mode: 'mapping',
  connectTimeoutMs: 10000,
  transferTimeoutMs: 60000,
  chunkSizeBytes: 268435456,
  retryLimit: 5,
  maxInFlightChunks: 1,
  requestTtlSeconds: 86400,
  tlsCaFile: '',
  tlsServerName: ''
});

const URL_FIELDS = ['coreControlUrl', 'coreTransferUrl', 'edgeControlUrl', 'edgeTransferUrl'];
const STRING_FIELDS = [...URL_FIELDS, 'tlsCaFile', 'tlsServerName'];
const NUMBER_FIELDS = ['connectTimeoutMs', 'transferTimeoutMs', 'chunkSizeBytes', 'retryLimit', 'maxInFlightChunks', 'requestTtlSeconds'];

function clean(value) { return typeof value === 'string' ? value.trim() : value; }
function urlValue(value, field) {
  const text = clean(value);
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw Object.assign(new Error(`${field} 必须是有效的 HTTP/HTTPS 地址`), { code: 'gate_config_invalid' }); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw Object.assign(new Error(`${field} 只允许 HTTP/HTTPS 基地址，不能包含凭据、路径、查询参数或片段`), { code: 'gate_config_invalid' });
  return parsed.toString().replace(/\/$/u, '');
}

export function normalizeGateConfig(input = {}, { requireUrls = false, requiredUrlFields = URL_FIELDS } = {}) {
  const output = { ...DEFAULTS };
  output.mode = clean(input.mode ?? DEFAULTS.mode);
  for (const field of STRING_FIELDS) output[field] = clean(input[field] ?? '') || '';
  for (const field of URL_FIELDS) output[field] = urlValue(output[field], field);
  for (const field of NUMBER_FIELDS) {
    const value = Number(input[field] ?? DEFAULTS[field]);
    if (!Number.isSafeInteger(value) || value <= 0) throw Object.assign(new Error(`${field} 必须是正整数`), { code: 'gate_config_invalid' });
    output[field] = value;
  }
  if (output.chunkSizeBytes < 1024 * 1024 || output.chunkSizeBytes > 1024 * 1024 * 1024) throw Object.assign(new Error('chunkSizeBytes 必须在 1 MiB 到 1 GiB 之间'), { code: 'gate_config_invalid' });
  if (output.maxInFlightChunks > 32 || output.retryLimit > 20 || output.requestTtlSeconds > 7 * 86400) throw Object.assign(new Error('分块并发、重试次数或请求有效期超过安全上限'), { code: 'gate_config_invalid' });
  if (output.mode !== 'mapping') throw Object.assign(new Error('当前只支持 mapping（映射模式）'), { code: 'gate_config_invalid' });
  if (requireUrls && requiredUrlFields.some((field) => !output[field])) throw Object.assign(new Error('请填写本端需要访问的受控映射通道地址'), { code: 'gate_config_invalid' });
  return output;
}

export function gateConfigFromEnv(env = process.env) {
  return normalizeGateConfig({
    mode: env.CAM_GATE_MODE || 'mapping',
    coreControlUrl: env.CAM_GATE_CORE_CONTROL_URL,
    coreTransferUrl: env.CAM_GATE_CORE_TRANSFER_URL,
    edgeControlUrl: env.CAM_GATE_EDGE_CONTROL_URL,
    edgeTransferUrl: env.CAM_GATE_EDGE_TRANSFER_URL,
    connectTimeoutMs: env.CAM_GATE_CONNECT_TIMEOUT_MS,
    transferTimeoutMs: env.CAM_GATE_TRANSFER_TIMEOUT_MS,
    chunkSizeBytes: env.CAM_GATE_CHUNK_SIZE_BYTES,
    retryLimit: env.CAM_GATE_RETRY_LIMIT,
    maxInFlightChunks: env.CAM_GATE_MAX_IN_FLIGHT_CHUNKS,
    requestTtlSeconds: env.CAM_GATE_REQUEST_TTL_SECONDS,
    tlsCaFile: env.CAM_GATE_TLS_CA_FILE,
    tlsServerName: env.CAM_GATE_TLS_SERVER_NAME
  });
}

export class GateConfigStore {
  constructor(db, { table = 'gate_config', eventsTable = 'gate_config_events', env = process.env, requiredUrlFields = URL_FIELDS } = {}) {
    this.db = db; this.table = table; this.eventsTable = eventsTable; this.env = env;
    this.requiredUrlFields = requiredUrlFields;
    db.exec(`CREATE TABLE IF NOT EXISTS ${table} (config_id INTEGER PRIMARY KEY CHECK (config_id = 1), config_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS ${eventsTable} (event_id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, config_json TEXT NOT NULL, created_at TEXT NOT NULL)`);
  }
  get() {
    const row = this.db.prepare(`SELECT * FROM ${this.table} WHERE config_id = 1`).get();
    if (!row) return { ...gateConfigFromEnv(this.env), source: 'environment', updatedBy: null, updatedAt: null };
    return { ...normalizeGateConfig(JSON.parse(row.config_json)), source: 'database', updatedBy: row.updated_by, updatedAt: row.updated_at };
  }
  save(input, actorId) {
    const config = normalizeGateConfig(input, { requireUrls: true, requiredUrlFields: this.requiredUrlFields });
    const timestamp = new Date().toISOString();
    const eventId = `GATECFG-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO ${this.table} (config_id, config_json, updated_by, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(config_id) DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`).run(JSON.stringify(config), actorId ?? null, timestamp);
      this.db.prepare(`INSERT INTO ${this.eventsTable} VALUES (?, ?, ?, ?, ?)`).run(eventId, actorId ?? null, 'UPDATED', JSON.stringify(config), timestamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get();
  }
}

