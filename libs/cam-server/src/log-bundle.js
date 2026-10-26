import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const BLOCK = 512;

function field(buffer, offset, length, value = '') {
  const bytes = Buffer.from(String(value), 'utf8');
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
}

function tarHeader(name, size, mode = '0000640') {
  const header = Buffer.alloc(BLOCK);
  field(header, 0, 100, name);
  field(header, 100, 8, `${mode}\0`);
  field(header, 108, 8, '0000000\0');
  field(header, 116, 8, '0000000\0');
  field(header, 124, 12, `${size.toString(8).padStart(11, '0')}\0`);
  field(header, 136, 12, `${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  field(header, 257, 6, 'ustar\0');
  field(header, 263, 2, '00');
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  field(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function normalizeName(name) {
  const normalized = String(name).replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) throw new Error('日志归档条目名称无效');
  return normalized;
}

export function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

export function packTarGz(entries) {
  const chunks = [];
  for (const item of entries) {
    const name = normalizeName(item.name);
    const data = Buffer.isBuffer(item.data) ? item.data : Buffer.from(item.data ?? '');
    chunks.push(tarHeader(name, data.length), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks), { level: 6 });
}

export function unpackTarGz(bundle) {
  const tar = gunzipSync(bundle);
  const entries = [];
  for (let offset = 0; offset + BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + BLOCK + size > tar.length) throw new Error('日志归档格式无效');
    entries.push({ name: normalizeName(name), data: Buffer.from(tar.subarray(offset + BLOCK, offset + BLOCK + size)) });
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return entries;
}

function lineTimestamp(line) {
  try {
    const item = JSON.parse(line);
    const value = item.time ?? item.timestamp ?? item.createdAt;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Date.parse(value);
  } catch {}
  return NaN;
}

const INTERNAL_ID_KEY = /^(agentId|centerId|name|hostname|host|remoteAddress|coreUrl|agentUrl|publicKey|fingerprint)$/u;
function stripInternal(value) {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !INTERNAL_ID_KEY.test(key)).map(([key, item]) => [key, stripInternal(item)]));
  if (typeof value === 'string') return value.replace(/AG-[A-Za-z0-9-]+/gu, '[AGENT]');
  return value;
}

export function sanitizeRuntimeLog(buffer, { stripIdentifiers = false } = {}) {
  if (!stripIdentifiers) return buffer;
  const lines = [];
  for (const line of Buffer.from(buffer).toString('utf8').split(/\r?\n/u)) {
    if (!line) continue;
    try { lines.push(`${JSON.stringify(stripInternal(JSON.parse(line)))}\n`); } catch { lines.push(`${line.replace(/AG-[A-Za-z0-9-]+/gu, '[AGENT]')}\n`); }
  }
  return Buffer.from(lines.join(''), 'utf8');
}

export function readRuntimeLogs(dir, service, { fromAt, toAt, maxBytes = 50 * 1024 * 1024 } = {}) {
  if (!dir) return Buffer.alloc(0);
  const prefix = `${service}.jsonl`;
  let files = [];
  try { files = readdirSync(dir).filter((name) => name === prefix || name.startsWith(`${prefix}.`)).sort().map((name) => join(dir, name)); } catch { return Buffer.alloc(0); }
  const from = Number.isFinite(Date.parse(fromAt)) ? Date.parse(fromAt) : -Infinity;
  const to = Number.isFinite(Date.parse(toAt)) ? Date.parse(toAt) : Infinity;
  const lines = [];
  let total = 0;
  for (const file of files) {
    let content;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of content.split(/\r?\n/u)) {
      if (!line) continue;
      const timestamp = lineTimestamp(line);
      if (Number.isFinite(timestamp) && (timestamp < from || timestamp > to)) continue;
      const bytes = Buffer.byteLength(`${line}\n`);
      if (total + bytes > maxBytes) return Buffer.from(lines.join(''), 'utf8');
      lines.push(`${line}\n`); total += bytes;
    }
  }
  return Buffer.from(lines.join(''), 'utf8');
}

export function buildLogBundle({ entries = [], fromAt, toAt, categories = ['runtime'], source = 'cam' } = {}) {
  const payloadEntries = entries.map(({ name, data }) => ({ name: normalizeName(name), data: Buffer.isBuffer(data) ? data : Buffer.from(data ?? '') }));
  const manifest = {
    schemaVersion: 1,
    source,
    generatedAt: new Date().toISOString(),
    fromAt: fromAt ?? null,
    toAt: toAt ?? null,
    categories,
    entries: payloadEntries.map(({ name, data }) => ({ name, size: data.length, sha256: sha256(data) }))
  };
  const manifestData = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = Buffer.from(`${payloadEntries.map(({ name, data }) => `${sha256(data)}  ${name}`).join('\n')}${payloadEntries.length ? '\n' : ''}`);
  return packTarGz([{ name: 'manifest.json', data: manifestData }, { name: 'checksums.sha256', data: checksums }, ...payloadEntries]);
}
