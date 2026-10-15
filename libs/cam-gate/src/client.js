export async function gateHealthCheck(baseUrl, { timeoutMs = 10000 } = {}) {
  if (!baseUrl) throw Object.assign(new Error('映射通道地址未配置'), { code: 'gate_not_configured' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/health/ready`, { signal: controller.signal, headers: { accept: 'application/json', 'x-cam-gate-probe': '1' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(`映射通道返回 HTTP ${response.status}`), { code: 'gate_health_failed', statusCode: response.status });
    return { ok: true, status: body.status ?? 'ok', service: body.service ?? null };
  } catch (error) {
    if (error.name === 'AbortError') throw Object.assign(new Error('映射通道连接超时'), { code: 'gate_timeout' });
    throw error;
  } finally { clearTimeout(timer); }
}

