import { fingerprint } from '../../../libs/cam-agent-auth/src/protocol.js';
import { createPublicKey } from 'node:crypto';

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('请填写 Core 地址'), { code: 'core_url_invalid' });
  let url;
  try { url = new URL(value.trim()); } catch { throw Object.assign(new Error('Core 地址格式无效'), { code: 'core_url_invalid' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('Core 地址只允许 HTTP(S) 基地址，不可包含账号、查询参数或片段'), { code: 'core_url_invalid' });
  return url.toString().replace(/\/$/u, '');
}
function normalizeKey(value, label, optional = false) {
  if (optional && !value) return '';
  if (typeof value !== 'string' || !value.includes('PUBLIC KEY')) throw Object.assign(new Error(`${label}无效`), { code: 'core_public_key_invalid' });
  try { fingerprint(value); } catch { throw Object.assign(new Error(`${label}必须是有效的 Ed25519 公钥`), { code: 'core_public_key_invalid' }); }
  return createPublicKey(value).export({ type: 'spki', format: 'pem' }).toString().trim();
}

export class CoreConnectionStore {
  constructor(db, defaults = {}) {
    this.db = db;
    db.exec('CREATE TABLE IF NOT EXISTS agent_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    this.defaults = {
      coreUrl: normalizeUrl(defaults.coreUrl ?? 'http://127.0.0.1:3102'),
      corePublicKey: defaults.corePublicKey ? normalizeKey(defaults.corePublicKey, 'Core 当前公钥') : '',
      previousPublicKey: defaults.previousPublicKey ? normalizeKey(defaults.previousPublicKey, 'Core 过渡公钥') : '',
      previousPublicKeyExpiresAt: defaults.previousPublicKeyExpiresAt ?? '',
      lastTestAt: null, lastTestState: 'NOT_TESTED'
    };
  }
  get() {
    const stored = Object.fromEntries(this.db.prepare('SELECT setting_key, setting_value FROM agent_settings').all().map((row) => [row.setting_key, JSON.parse(row.setting_value)]));
    const item = { ...this.defaults, ...stored };
    const fingerprintValue = item.corePublicKey ? fingerprint(item.corePublicKey) : null;
    const previousFingerprint = item.previousPublicKey ? fingerprint(item.previousPublicKey) : null;
    return { ...item, fingerprint: fingerprintValue, previousFingerprint, configured: Boolean(item.corePublicKey), source: Object.hasOwn(stored, 'coreUrl') ? 'database' : 'environment' };
  }
  save(input = {}) {
    const before = this.get();
    const coreUrl = normalizeUrl(input.coreUrl ?? before.coreUrl);
    const corePublicKey = normalizeKey(input.corePublicKey ?? before.corePublicKey, 'Core 当前公钥');
    let previousPublicKey = normalizeKey(input.previousPublicKey ?? before.previousPublicKey, 'Core 过渡公钥', true);
    let previousPublicKeyExpiresAt = input.previousPublicKeyExpiresAt ?? before.previousPublicKeyExpiresAt ?? '';
    if (before.corePublicKey && corePublicKey !== before.corePublicKey) {
      if (input.confirmTrustChange !== true) throw Object.assign(new Error('替换 Core 公钥需明确确认身份变更'), { code: 'core_trust_change_confirmation_required' });
      if (input.previousPublicKey === undefined || !previousPublicKey) previousPublicKey = before.corePublicKey;
      if (previousPublicKey !== before.corePublicKey) throw Object.assign(new Error('Core 密钥轮换过渡公钥必须是当前已信任的旧公钥'), { code: 'core_previous_key_mismatch' });
      const expiresAt = Date.parse(previousPublicKeyExpiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 30 * 86400_000) throw Object.assign(new Error('旧公钥过渡期必须设置为未来 30 天以内'), { code: 'core_previous_key_expiry_invalid' });
    } else if (previousPublicKey !== before.previousPublicKey || previousPublicKeyExpiresAt !== before.previousPublicKeyExpiresAt) {
      if (previousPublicKey) throw Object.assign(new Error('过渡公钥只能在明确更换 Core 身份时设置'), { code: 'core_previous_key_mismatch' });
    }
    if (!previousPublicKey) previousPublicKeyExpiresAt = '';
    if (previousPublicKey && !previousPublicKeyExpiresAt) throw Object.assign(new Error('配置旧 Core 公钥时必须设置过期时间'), { code: 'core_previous_key_expiry_required' });
    if (previousPublicKeyExpiresAt && !Number.isFinite(Date.parse(previousPublicKeyExpiresAt))) throw Object.assign(new Error('Core 旧公钥过期时间无效'), { code: 'core_previous_key_expiry_invalid' });
    const next = { coreUrl, corePublicKey, previousPublicKey, previousPublicKeyExpiresAt, lastTestAt: null, lastTestState: 'NOT_TESTED' };
    const timestamp = new Date().toISOString();
    const upsert = this.db.prepare('INSERT INTO agent_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of Object.entries(next)) upsert.run(key, JSON.stringify(value), timestamp);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get();
  }
  markTest(state) {
    const timestamp = new Date().toISOString();
    for (const [key, value] of Object.entries({ lastTestAt: timestamp, lastTestState: state })) this.db.prepare('INSERT INTO agent_settings (setting_key, setting_value, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = excluded.updated_at').run(key, JSON.stringify(value), timestamp);
    return this.get();
  }
}
