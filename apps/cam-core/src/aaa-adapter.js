import { Agent } from 'undici';

const text = (value) => value === undefined || value === null ? '' : String(value).trim();

function failure(message, code, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function parseJson(raw, status) {
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw failure(`AAA 返回了非 JSON 响应（HTTP ${status}）`, 'aaa_api_error', 502); }
}

function responseData(value) {
  return value && typeof value === 'object' && Object.hasOwn(value, 'data') ? value.data : value;
}

function responseSucceeded(value) {
  if (!value || typeof value !== 'object') return true;
  if (value.success !== undefined) return value.success === true && (!value.errorCode || String(value.errorCode) === '0');
  if (value.code !== undefined) return String(value.code) === '0';
  return true;
}

function explicitResponseSuccess(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.success === true) return value.errorCode === undefined || String(value.errorCode) === '0';
  return value.code !== undefined && String(value.code) === '0';
}

function configValue(env, key) { return text(env?.[key]); }

export function normalizeAaaConfig(input = {}) {
  const config = {
    baseUrl: text(input.baseUrl).replace(/\/$/u, ''),
    tenantName: text(input.tenantName),
    accessServerName: text(input.accessServerName),
    sharedSecret: text(input.sharedSecret),
    timeoutMs: Number(input.timeoutMs ?? 10000),
    allowHttp: input.allowHttp === true || input.allowHttp === 'true',
    skipTlsVerification: input.skipTlsVerification === true || input.skipTlsVerification === 'true'
  };
  if (config.baseUrl) {
    let url;
    try { url = new URL(config.baseUrl); } catch { throw failure('AAA 地址必须是有效的 URL', 'aaa_config_invalid', 400); }
    if (!['https:', ...(config.allowHttp ? ['http:'] : [])].includes(url.protocol)) throw failure('AAA 地址必须使用 HTTPS', 'aaa_config_invalid', 400);
    if (url.search || url.hash || url.username || url.password || url.pathname !== '/') throw failure('AAA 地址不能包含查询参数、片段、账号密码或路径', 'aaa_config_invalid', 400);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) throw failure('AAA 请求超时必须在 1000 至 120000 毫秒之间', 'aaa_config_invalid', 400);
  return config;
}

/** Read only the API-device credentials required for DKEY AM real-time login. */
export function readAaaConfig(env = process.env) {
  return normalizeAaaConfig({
    baseUrl: configValue(env, 'CAM_AAA_BASE_URL').replace(/\/$/u, ''),
    tenantName: configValue(env, 'CAM_AAA_TENANT_NAME'),
    accessServerName: configValue(env, 'CAM_AAA_ACCESS_SERVER_NAME'),
    sharedSecret: configValue(env, 'CAM_AAA_SHARED_SECRET'),
    timeoutMs: Number(configValue(env, 'CAM_AAA_TIMEOUT_MS') || 10000),
    allowHttp: configValue(env, 'CAM_AAA_ALLOW_HTTP') === 'true',
    skipTlsVerification: configValue(env, 'CAM_AAA_SKIP_TLS_VERIFICATION') === 'true'
  });
}

export class AaaConfigStore {
  constructor(db, { env = process.env } = {}) {
    this.db = db;
    this.envConfig = readAaaConfig(env);
    db.exec('CREATE TABLE IF NOT EXISTS core_aaa_config (config_id INTEGER PRIMARY KEY CHECK (config_id = 1), config_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL)');
  }
  get() {
    const row = this.db.prepare('SELECT * FROM core_aaa_config WHERE config_id = 1').get();
    const stored = row ? JSON.parse(row.config_json) : {};
    // Environment values remain deployment defaults. Once an administrator saves
    // the secret from the page, the database value takes precedence. The secret
    // is intentionally never included in publicValue().
    const config = normalizeAaaConfig({ ...this.envConfig, ...stored, sharedSecret: stored.sharedSecret || this.envConfig.sharedSecret });
    return { config, source: row ? 'database' : 'environment', updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null, secretConfigured: Boolean(config.sharedSecret) };
  }
  save(input, actorId = null) {
    const current = this.get().config;
    const submittedSecret = text(input?.sharedSecret);
    const config = normalizeAaaConfig({ ...current, ...input, sharedSecret: submittedSecret || current.sharedSecret });
    const timestamp = new Date().toISOString();
    this.db.prepare('INSERT INTO core_aaa_config (config_id, config_json, updated_by, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(config_id) DO UPDATE SET config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at').run(JSON.stringify({ baseUrl: config.baseUrl, tenantName: config.tenantName, accessServerName: config.accessServerName, timeoutMs: config.timeoutMs, allowHttp: config.allowHttp, skipTlsVerification: config.skipTlsVerification, sharedSecret: config.sharedSecret }), actorId, timestamp);
    return this.get();
  }
  publicValue() {
    const current = this.get();
    return { baseUrl: current.config.baseUrl, tenantName: current.config.tenantName, accessServerName: current.config.accessServerName, timeoutMs: current.config.timeoutMs, allowHttp: current.config.allowHttp, skipTlsVerification: current.config.skipTlsVerification, source: current.source, updatedBy: current.updatedBy, updatedAt: current.updatedAt, configured: Boolean(current.config.baseUrl && current.config.tenantName && current.config.accessServerName && current.secretConfigured), secretConfigured: current.secretConfigured };
  }
}

export class DkeyAmAdapter {
  constructor({ env = process.env, config = undefined, fetchImpl = globalThis.fetch } = {}) {
    this.config = normalizeAaaConfig(config ?? readAaaConfig(env));
    this.fetch = fetchImpl;
    this.insecureDispatcher = this.config.skipTlsVerification ? this.createInsecureDispatcher() : undefined;
  }

  createInsecureDispatcher() { return new Agent({ connect: { rejectUnauthorized: false } }); }

  dispatcherFor(config) {
    if (!config.skipTlsVerification || new URL(config.baseUrl).protocol !== 'https:') return { dispatcher: undefined, temporary: false };
    if (this.config.skipTlsVerification) return { dispatcher: this.insecureDispatcher, temporary: false };
    return { dispatcher: this.createInsecureDispatcher(), temporary: true };
  }

  enabled() {
    const { baseUrl, tenantName, accessServerName, sharedSecret } = this.config;
    return Boolean(this.fetch && baseUrl && tenantName && accessServerName && sharedSecret);
  }

  updateConfig(config) {
    const next = normalizeAaaConfig(config);
    const verificationChanged = next.skipTlsVerification !== this.config.skipTlsVerification;
    const previousDispatcher = this.insecureDispatcher;
    this.config = next;
    if (verificationChanged) {
      this.insecureDispatcher = next.skipTlsVerification ? this.createInsecureDispatcher() : undefined;
      if (previousDispatcher) void previousDispatcher.close().catch(() => {});
    }
  }

  async close() {
    const dispatcher = this.insecureDispatcher;
    this.insecureDispatcher = undefined;
    if (dispatcher) await dispatcher.close();
  }

  async testConfiguration(input = this.config, loginName = '') {
    const config = normalizeAaaConfig(input);
    const username = text(loginName);
    if (!config.baseUrl || !config.tenantName || !config.accessServerName || !config.sharedSecret) throw failure('AAA 参数尚未完整配置', 'aaa_not_configured', 503);
    if (!username) throw failure('请输入一个已存在的 AAA 测试用户名', 'aaa_test_user_required', 400);
    const url = new URL('/am/webauth/1/strong/passwordRequirement', `${config.baseUrl}/`);
    const { dispatcher, temporary } = this.dispatcherFor(config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const form = new URLSearchParams({
        tenantName: config.tenantName,
        accessServerName: config.accessServerName,
        sharedSecret: config.sharedSecret,
        loginName: username
      });
      const response = await this.fetch(url, {
        method: 'POST',
        redirect: 'manual',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: form,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      });
      const raw = await response.text();
      if (response.status >= 300 && response.status < 400) throw failure(`AAA 认证接口返回 HTTP ${response.status}，请检查服务地址和接口访问策略`, 'aaa_api_redirect', 502);
      const value = parseJson(raw, response.status);
      if (!response.ok) throw failure(`AAA 配置校验请求失败（HTTP ${response.status}）`, 'aaa_api_error', response.status >= 500 ? 503 : 502);
      if (!explicitResponseSuccess(value)) {
        const errorCode = value?.errorCode ?? value?.code;
        const detail = text(value?.message ?? value?.msg);
        throw failure(`AAA 参数校验失败${errorCode !== undefined ? `（错误码 ${errorCode}）` : ''}${detail ? `：${detail}` : ''}`, 'aaa_config_rejected', 400);
      }
      const data = responseData(value) ?? {};
      const policyFields = ['staticPasswordRequired', 'dynamicPasswordRequired', 'needsGetDynamicPassword', 'dynamicPasswordEnforced'];
      if (!data || typeof data !== 'object' || Array.isArray(data) || !policyFields.some((field) => typeof data[field] === 'boolean')) throw failure('AAA 配置校验接口未返回用户认证策略', 'aaa_api_error', 502);
      return {
        valid: true,
        loginName: username,
        policy: {
          staticPasswordRequired: data.staticPasswordRequired,
          dynamicPasswordRequired: data.dynamicPasswordRequired,
          needsGetDynamicPassword: data.needsGetDynamicPassword,
          dynamicPasswordEnforced: data.dynamicPasswordEnforced
        }
      };
    } catch (error) {
      if (error.code === 'aaa_api_error' || error.code === 'aaa_api_redirect' || error.code === 'aaa_config_rejected') throw error;
      if (error.name === 'AbortError' || error.cause?.code === 'UND_ERR_ABORTED') throw failure('AAA 连接测试超时，请稍后重试', 'aaa_timeout', 504);
      throw failure(`AAA 连接失败（${url.host}）`, 'aaa_unavailable', 503);
    } finally {
      clearTimeout(timer);
      if (temporary) await dispatcher.close().catch(() => {});
    }
  }

  async authenticate({ loginName, password, terminalIp = undefined, terminalMac = undefined } = {}) {
    if (!this.enabled()) throw failure('AAA 实时认证参数尚未完整配置', 'aaa_not_configured', 503);
    if (!text(loginName) || typeof password !== 'string') throw failure('请输入 AAA 用户名和密码', 'aaa_credentials_invalid', 401);
    const url = new URL('/am/webauth/1/strong/authenticate', `${this.config.baseUrl}/`);
    const { dispatcher, temporary } = this.dispatcherFor(this.config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const form = new URLSearchParams({
        tenantName: this.config.tenantName,
        accessServerName: this.config.accessServerName,
        sharedSecret: this.config.sharedSecret,
        loginName: text(loginName),
        password,
        ...(text(terminalIp) ? { terminalIp: text(terminalIp) } : {}),
        ...(text(terminalMac) ? { terminalMac: text(terminalMac) } : {})
      });
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: form,
        signal: controller.signal,
        ...(dispatcher ? { dispatcher } : {})
      });
      const raw = await response.text();
      const value = parseJson(raw, response.status);
      if (!response.ok) {
        if ([400, 401, 403, 422].includes(response.status)) throw failure('AAA 用户名或密码错误', 'aaa_rejected', 401);
        throw failure(`AAA 认证服务请求失败（HTTP ${response.status}）`, 'aaa_api_error', response.status >= 500 ? 503 : 502);
      }
      if (!responseSucceeded(value)) throw failure('AAA 用户名或密码错误', 'aaa_rejected', 401);
      const data = responseData(value) ?? value;
      return { username: text(loginName), raw: data };
    } catch (error) {
      if (error.code === 'aaa_not_configured' || error.code === 'aaa_credentials_invalid' || error.code === 'aaa_rejected' || error.code === 'aaa_api_error') throw error;
      if (error.name === 'AbortError' || error.cause?.code === 'UND_ERR_ABORTED' || error.code === 'UND_ERR_ABORTED') throw failure('AAA 认证请求超时，请稍后重试', 'aaa_timeout', 504);
      throw failure(`AAA 连接失败（${url.host}）：${error.code ?? 'network_error'}`, 'aaa_unavailable', 503);
    } finally {
      clearTimeout(timer);
      if (temporary) await dispatcher.close().catch(() => {});
    }
  }
}
