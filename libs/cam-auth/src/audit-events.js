const AUDIT_TABLES = new Set(['core_auth_events', 'edge_auth_events']);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function day(value, label) {
  if (!value) return null;
  if (typeof value !== 'string' || !DAY_PATTERN.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw Object.assign(new Error(`${label}日期无效`), { statusCode: 400, code: 'audit_filter_invalid' });
  }
  return value;
}

/** Shared, bounded query for the structurally identical Core and Edge audit tables. */
export function queryAuthEvents(db, table, filters = {}) {
  if (!AUDIT_TABLES.has(table)) throw new TypeError('Unsupported audit event table');
  const limitValue = Number(filters.limit ?? 50);
  const offsetValue = Number(filters.offset ?? 0);
  const limit = Number.isInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 50;
  const offset = Number.isInteger(offsetValue) ? Math.min(1_000_000, Math.max(0, offsetValue)) : 0;
  const eventType = typeof filters.eventType === 'string' ? filters.eventType.trim().slice(0, 128) : '';
  const search = typeof filters.search === 'string' ? filters.search.trim().slice(0, 200) : '';
  const from = day(filters.from, '起始');
  const to = day(filters.to, '结束');
  if (from && to && from > to) throw Object.assign(new Error('起始日期不能晚于结束日期'), { statusCode: 400, code: 'audit_filter_invalid' });

  const conditions = [];
  const values = [];
  if (eventType) { conditions.push('event_type = ?'); values.push(eventType); }
  if (from) { conditions.push('substr(created_at, 1, 10) >= ?'); values.push(from); }
  if (to) { conditions.push('substr(created_at, 1, 10) <= ?'); values.push(to); }
  if (search) {
    const pattern = `%${search}%`;
    conditions.push('(COALESCE(principal_id, \'\') LIKE ? OR event_type LIKE ? OR COALESCE(source_address, \'\') LIKE ? OR details_json LIKE ?)');
    values.push(pattern, pattern, pattern, pattern);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS total FROM ${table} ${where}`).get(...values).total;
  const items = db.prepare(`SELECT event_id, principal_id, event_type, source_address, details_json, created_at FROM ${table} ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`).all(...values, limit, offset);
  return { items, total, limit, offset };
}
