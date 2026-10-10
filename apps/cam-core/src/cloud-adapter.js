import { readFileSync } from 'node:fs';

export class CloudAdapter {
  constructor({ baseUrl = process.env.CAM_CLOUD_API_BASE_URL, token = process.env.CAM_CLOUD_API_TOKEN, tokenFile = process.env.CAM_CLOUD_API_TOKEN_FILE, createPath = process.env.CAM_CLOUD_CREATE_PATH ?? '/api/v1/release-approvals', statusPath = process.env.CAM_CLOUD_STATUS_PATH ?? '/api/v1/release-approvals/{approvalId}', closePath = process.env.CAM_CLOUD_CLOSE_PATH ?? '/api/v1/release-approvals/{approvalId}/close', timeoutMs = Number(process.env.CAM_CLOUD_TIMEOUT_MS ?? 10000), fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl?.replace(/\/$/, '') || null;
    this.token = token || (tokenFile ? readFileSync(tokenFile, 'utf8').trim() : null);
    this.createPath = createPath;
    this.statusPath = statusPath;
    this.closePath = closePath;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  enabled() { return Boolean(this.baseUrl && this.fetch); }

  async request(path, { method = 'GET', body } = {}) {
    if (!this.enabled()) throw Object.assign(new Error('cloud adapter is not configured'), { code: 'cloud_not_configured' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers = { accept: 'application/json' };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const response = await this.fetch(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      const text = await response.text();
      let value; try { value = text ? JSON.parse(text) : {}; } catch { throw new Error(`cloud API returned non-JSON response (${response.status})`); }
      if (!response.ok) throw Object.assign(new Error(value.message ?? value.error ?? `cloud API returned ${response.status}`), { code: 'cloud_api_error', statusCode: response.status });
      return value;
    } finally { clearTimeout(timer); }
  }

  async createApproval(envelope) {
    const value = await this.request(this.createPath, { method: 'POST', body: envelope });
    return { approvalId: value.approvalId ?? value.id, status: value.status ?? 'PENDING', ...value };
  }

  async getApproval(approvalId) {
    const value = await this.request(this.statusPath.replace('{approvalId}', encodeURIComponent(approvalId)));
    return { approvalId, ...value };
  }

  async closeApproval(approvalId, body) {
    return this.request(this.closePath.replace('{approvalId}', encodeURIComponent(approvalId)), { method: 'POST', body });
  }
}
