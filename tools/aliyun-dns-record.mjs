#!/usr/bin/env node

/**
 * Idempotently create/update/delete an Alibaba Cloud DNS record.
 *
 * This tool uses only Node.js built-ins and the Alibaba Cloud RPC API. It does
 * not install a CLI, store credentials, or request certificates. Certificate
 * issuance will be a separate ACME step after DNS is configured.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'node:https';

const API_VERSION = '2015-01-09';
const DEFAULT_ENDPOINT = 'https://alidns.aliyuncs.com/';
const ALLOWED_TYPES = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA']);

function fail(message) {
  throw new Error(message);
}

function percentEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
    .replace(/%7E/g, '~');
}

function canonicalQuery(parameters) {
  return Object.keys(parameters)
    .sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(parameters[key])}`)
    .join('&');
}

function signedUrl(endpoint, accessKeyId, accessKeySecret, action, parameters = {}) {
  const common = {
    AccessKeyId: accessKeyId,
    Action: action,
    Format: 'JSON',
    SignatureMethod: 'HMAC-SHA1',
    SignatureNonce: randomUUID(),
    SignatureVersion: '1.0',
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    Version: API_VERSION,
    ...parameters
  };
  const query = canonicalQuery(common);
  const stringToSign = `GET&%2F&${percentEncode(query)}`;
  common.Signature = createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}${canonicalQuery(common)}`;
}

async function apiCall({ endpoint, accessKeyId, accessKeySecret, action, parameters }) {
  const url = signedUrl(endpoint, accessKeyId, accessKeySecret, action, parameters);
  const response = await new Promise((resolve, reject) => {
    const requestHandle = request(url, { method: 'GET', timeout: 15_000 }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(chunk));
      incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    requestHandle.on('timeout', () => requestHandle.destroy(new Error('Alibaba Cloud DNS request timed out')));
    requestHandle.on('error', reject);
    requestHandle.end();
  });

  let result;
  try {
    result = JSON.parse(response.body);
  } catch {
    fail(`Alibaba Cloud DNS returned a non-JSON response (HTTP ${response.status})`);
  }
  if (response.status < 200 || response.status >= 300 || result.Code) {
    const detail = result.Message || result.Code || `HTTP ${response.status}`;
    const requestId = result.RequestId ? ` (RequestId: ${result.RequestId})` : '';
    fail(`Alibaba Cloud DNS API ${action} failed: ${detail}${requestId}`);
  }
  return result;
}

function readEnvFile(file) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch (error) {
    fail(`cannot read env file ${file}: ${error.message}`);
  }
  // Credentials must not be stored in a group/world-readable file on Unix.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(file).mode & 0o077;
      if (mode !== 0) fail(`env file ${file} is readable by group/others; run chmod 600`);
    } catch (error) {
      if (error.message.startsWith('env file ')) throw error;
    }
  }
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) fail(`invalid env file line: ${trimmed}`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function parseArgs(argv) {
  const args = { command: 'ensure', name: '', value: '', type: 'A', ttl: '600', line: 'default', replace: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--help' || item === '-h') args.help = true;
    else if (item === '--delete') args.command = 'delete';
    else if (item === '--replace') args.replace = true;
    else if (item === '--dry-run') args.dryRun = true;
    else if (item.startsWith('--')) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!['envFile', 'name', 'value', 'type', 'ttl', 'line', 'domain'].includes(key)) fail(`unknown option: ${item}`);
      const value = argv[++index];
      if (!value || value.startsWith('--')) fail(`${item} requires a value`);
      args[key] = value;
    } else fail(`unexpected argument: ${item}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node tools/aliyun-dns-record.mjs --name cam-edge --type A --value 192.0.2.10
  node tools/aliyun-dns-record.mjs --delete --name cam-edge --type A --value 192.0.2.10

Options:
  --env-file FILE   Load credentials and defaults from a chmod-600 file
  --name NAME       RR label (cam-edge) or FQDN (cam-edge.example.com)
  --domain DOMAIN   Managed domain, e.g. example.com (default: ALIYUN_DNS_DOMAIN)
  --type TYPE       A, AAAA, CNAME, TXT, MX, NS, SRV or CAA (default: A)
  --value VALUE     Record value
  --ttl SECONDS     TTL for a new/updated record (default: 600)
  --line LINE       AliDNS line, normally default (default: default)
  --replace         Replace the only conflicting record with the requested value
  --delete          Delete the exact matching record
  --dry-run         Resolve and display the planned operation without changing DNS
`);
}

function normalizeRecord(args) {
  const domain = String(args.domain || process.env.ALIYUN_DNS_DOMAIN || '').trim().replace(/\.$/, '').toLowerCase();
  if (!domain || domain.includes('/') || domain.includes(':')) fail('ALIYUN_DNS_DOMAIN/--domain must be a DNS domain such as example.com');
  const input = String(args.name || '').trim().replace(/\.$/, '').toLowerCase();
  if (!input) fail('--name is required');
  const fqdn = input === domain || input === '@' ? domain : input;
  let rr;
  if (input === '@' || input === domain) rr = '@';
  else if (input.endsWith(`.${domain}`)) rr = input.slice(0, -(domain.length + 1));
  else if (!input.includes('.')) rr = input;
  else fail(`--name must be a label below ${domain} or its FQDN`);
  if (!rr || rr.includes('.')) fail('only a single-level secondary domain label is supported');
  const type = String(args.type || 'A').toUpperCase();
  if (!ALLOWED_TYPES.has(type)) fail(`unsupported DNS record type: ${type}`);
  const value = String(args.value || '').trim();
  if (!value) fail('--value is required');
  const ttl = Number(args.ttl || 600);
  if (!Number.isInteger(ttl) || ttl < 600 || ttl > 86400) fail('--ttl must be an integer between 600 and 86400');
  const line = String(args.line || 'default').trim();
  return { domain, rr, fqdn: `${rr === '@' ? domain : `${rr}.${domain}`}`, type, value, ttl, line };
}

function sameValue(left, right) {
  return String(left).trim().replace(/\.$/, '').toLowerCase() === String(right).trim().replace(/\.$/, '').toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.envFile) readEnvFile(args.envFile);
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;
  if (!accessKeyId || !accessKeySecret) fail('ALIYUN_ACCESS_KEY_ID and ALIYUN_ACCESS_KEY_SECRET are required');
  const record = normalizeRecord(args);
  const endpoint = process.env.ALIYUN_DNS_ENDPOINT || DEFAULT_ENDPOINT;
  const recordsResult = await apiCall({
    endpoint,
    accessKeyId,
    accessKeySecret,
    action: 'DescribeDomainRecords',
    parameters: { DomainName: record.domain, RRKeyWord: record.rr, TypeKeyWord: record.type, PageNumber: '1', PageSize: '500' }
  });
  const records = (recordsResult.DomainRecords?.Record || []).filter((item) =>
    String(item.RR).toLowerCase() === record.rr && String(item.Type).toUpperCase() === record.type && String(item.Line || 'default') === record.line
  );
  const exact = records.find((item) => sameValue(item.Value, record.value));
  if (args.command === 'delete') {
    if (!exact) return console.log(`No matching record found: ${record.fqdn} ${record.type} ${record.value}`);
    if (args.dryRun) return console.log(`[dry-run] delete ${record.fqdn} ${record.type} ${record.value} (RecordId ${exact.RecordId})`);
    await apiCall({ endpoint, accessKeyId, accessKeySecret, action: 'DeleteDomainRecord', parameters: { RecordId: exact.RecordId } });
    return console.log(`Deleted ${record.fqdn} ${record.type} ${record.value}`);
  }
  if (exact) {
    if (Number(exact.TTL) === record.ttl) return console.log(`Already configured: ${record.fqdn} ${record.type} ${record.value}`);
    if (!args.replace) fail(`record exists with the same value but TTL ${exact.TTL}; use --replace to change TTL`);
    if (args.dryRun) return console.log(`[dry-run] update ${record.fqdn} TTL ${exact.TTL} -> ${record.ttl}`);
    await apiCall({ endpoint, accessKeyId, accessKeySecret, action: 'UpdateDomainRecord', parameters: { RecordId: exact.RecordId, RR: record.rr, Type: record.type, Value: record.value, TTL: String(record.ttl), Line: record.line } });
    return console.log(`Updated ${record.fqdn} TTL to ${record.ttl}`);
  }
  if (records.length > 0 && !args.replace) {
    fail(`a conflicting ${record.type} record already exists for ${record.fqdn}; use --replace only when replacing the sole existing record`);
  }
  if (records.length > 1 && args.replace) fail(`more than one ${record.type} record exists for ${record.fqdn}; refusing automatic replacement`);
  if (args.replace && records.length === 1) {
    if (args.dryRun) return console.log(`[dry-run] update ${record.fqdn} ${records[0].Value} -> ${record.value}`);
    await apiCall({ endpoint, accessKeyId, accessKeySecret, action: 'UpdateDomainRecord', parameters: { RecordId: records[0].RecordId, RR: record.rr, Type: record.type, Value: record.value, TTL: String(record.ttl), Line: record.line } });
    return console.log(`Updated ${record.fqdn} ${record.type} to ${record.value}`);
  }
  if (args.dryRun) return console.log(`[dry-run] add ${record.fqdn} ${record.type} ${record.value} TTL ${record.ttl}`);
  const added = await apiCall({ endpoint, accessKeyId, accessKeySecret, action: 'AddDomainRecord', parameters: { DomainName: record.domain, RR: record.rr, Type: record.type, Value: record.value, TTL: String(record.ttl), Line: record.line } });
  console.log(`Added ${record.fqdn} ${record.type} ${record.value} (RecordId ${added.RecordId})`);
}

main().catch((error) => {
  console.error(`aliyun-dns-record: ${error.message}`);
  process.exitCode = 1;
});

