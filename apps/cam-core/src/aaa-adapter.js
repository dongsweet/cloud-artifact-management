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

function configValue(env, key) { return text(env?.[key]); }

/** Read only the API-device credentials required for DKEY AM real-time login. */
export function readAaaConfig(env = process.env) {
  const config = {
    baseUrl: configValue(env, 'CAM_AAA_BASE_URL').replace(/\/$/u, ''),
    tenantName: configValue(env, 'CAM_AAA_TENANT_NAME'),
    accessServerName: configValue(env, 'CAM_AAA_ACCESS_SERVER_NAME'),
    sharedSecret: configValue(env, 'CAM_AAA_SHARED_SECRET'),
    timeoutMs: Number(configValue(env, 'CAM_AAA_TIMEOUT_MS') || 10000),
    allowHttp: configValue(env, 'CAM_AAA_ALLOW_HTTP') === 'true'
  };
  if (config.baseUrl) {
    let url;
    try { url = new URL(config.baseUrl); } catch { throw failure('AAA 地址必须是有效的 URL', 'aaa_not_configured', 503); }
    if (!['https:', ...(config.allowHttp ? ['http:'] : [])].includes(url.protocol)) throw failure('AAA 地址必须使用 HTTPS', 'aaa_not_configured', 503);
    if (url.search || url.hash || url.username || url.password) throw failure('AAA 地址不能包含查询参数、片段或账号密码', 'aaa_not_configured', 503);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) throw failure('AAA 请求超时必须在 1000 至 120000 毫秒之间', 'aaa_not_configured', 503);
  return config;
}

export class DkeyAmAdapter {
  constructor({ env = process.env, config = undefined, fetchImpl = globalThis.fetch } = {}) {
    this.config = config ?? readAaaConfig(env);
    this.fetch = fetchImpl;
  }

  enabled() {
    const { baseUrl, tenantName, accessServerName, sharedSecret } = this.config;
    return Boolean(this.fetch && baseUrl && tenantName && accessServerName && sharedSecret);
  }

  async authenticate({ loginName, password, terminalIp = undefined, terminalMac = undefined } = {}) {
    if (!this.enabled()) throw failure('AAA 实时认证参数尚未完整配置', 'aaa_not_configured', 503);
    if (!text(loginName) || typeof password !== 'string') throw failure('请输入 AAA 用户名和密码', 'aaa_credentials_invalid', 401);
    const url = new URL('/am/webauth/1/strong/authenticate', `${this.config.baseUrl}/`);
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
        signal: controller.signal
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
    } finally { clearTimeout(timer); }
  }
}
