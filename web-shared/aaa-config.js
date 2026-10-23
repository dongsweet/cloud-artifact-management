export function aaaConfigMarkup() {
  return `<div class="card"><div class="card-header cam-action-header"><h3 class="card-title">AAA 对接配置</h3><span id="aaa-config-badge" class="badge text-bg-secondary">未配置</span></div><form id="aaa-config-form"><div class="card-body"><div class="alert alert-info"><i class="bi bi-info-circle me-1"></i>这里维护 DKEY AM 的连接参数。共享密钥只在提交时写入本模块数据库，页面刷新后不回显，仅显示是否已配置。</div><div id="aaa-config-error" class="alert alert-danger d-none"></div><div class="row g-3"><div class="col-md-6"><label class="form-label" for="aaa-base-url">AAA 服务地址</label><input id="aaa-base-url" class="form-control" type="url" placeholder="https://aaa.example.cn:8443" required></div><div class="col-md-6"><label class="form-label" for="aaa-timeout">请求超时（毫秒）</label><input id="aaa-timeout" class="form-control" type="number" min="1000" max="120000" required></div><div class="col-md-6"><label class="form-label" for="aaa-tenant">租户名称</label><input id="aaa-tenant" class="form-control" maxlength="128" required></div><div class="col-md-6"><label class="form-label" for="aaa-access-server">认证设备名称</label><input id="aaa-access-server" class="form-control" maxlength="128" required></div><div class="col-md-8"><label class="form-label" for="aaa-shared-secret">API 共享密钥</label><input id="aaa-shared-secret" class="form-control" type="password" autocomplete="new-password" placeholder="留空表示保持当前密钥"></div><div class="col-md-4"><label class="form-label" for="aaa-secret-status">当前状态</label><input id="aaa-secret-status" class="form-control bg-body-secondary" readonly></div><div class="col-12"><div class="form-check form-switch"><input id="aaa-skip-tls-verification" class="form-check-input" type="checkbox"><label class="form-check-label" for="aaa-skip-tls-verification">跳过 HTTPS 证书校验</label><div class="form-text">勾选后不验证证书颁发机构、有效期和主机名。</div></div></div><div id="aaa-config-status" class="col-12 small text-body-secondary" role="status"></div></div></div><div class="card-footer d-flex justify-content-end gap-2"><button id="aaa-test" type="button" class="btn btn-outline-primary"><i class="bi bi-plug me-1"></i>测试配置</button><button class="btn btn-primary" type="submit"><i class="bi bi-check-lg me-1"></i>保存配置</button></div></form></div><dialog id="aaa-test-dialog" class="cam-aaa-test-modal" aria-labelledby="aaa-test-title"><div class="card"><div class="card-header d-flex align-items-center justify-content-between"><h3 id="aaa-test-title" class="card-title mb-0">测试 AAA 用户</h3><button id="aaa-test-close" type="button" class="btn-close" aria-label="关闭"></button></div><div class="card-body"><label class="form-label" for="aaa-test-login-name">测试用户名</label><input id="aaa-test-login-name" class="form-control" maxlength="128" autocomplete="off" aria-describedby="aaa-test-help"><div id="aaa-test-help" class="form-text">填写一个现有 AAA 用户；无需密码，不保存。</div><div id="aaa-test-result" class="alert d-none mt-3 mb-0" role="status" aria-live="polite"></div></div><div class="card-footer d-flex justify-content-end gap-2"><button id="aaa-test-cancel" type="button" class="btn btn-outline-secondary">关闭</button><button id="aaa-test-submit" type="button" class="btn btn-primary"><i class="bi bi-plug me-1"></i>开始校验</button></div></div></dialog>`;
}

const displayTime = (value) => value ? new Date(value).toLocaleString() : '';

/** Mount the shared Core/Agent AAA configuration form and behavior. */
export function mountAaaConfig(root, { request, csrf = () => '', csrfHeader = 'x-cam-core-csrf', onMessage = () => {} } = {}) {
  if (!root || typeof request !== 'function') throw new TypeError('AAA 配置组件缺少挂载节点或 request 函数');
  root.innerHTML = aaaConfigMarkup();
  const $ = (selector) => root.querySelector(selector);
  const errorBox = $('#aaa-config-error');
  const configBody = () => ({ baseUrl: $('#aaa-base-url').value.trim(), tenantName: $('#aaa-tenant').value.trim(), accessServerName: $('#aaa-access-server').value.trim(), sharedSecret: $('#aaa-shared-secret').value, timeoutMs: Number($('#aaa-timeout').value), skipTlsVerification: $('#aaa-skip-tls-verification').checked });
  const setError = (error) => { errorBox.textContent = error.message; errorBox.classList.remove('d-none'); };
  const hideError = () => errorBox.classList.add('d-none');
  const setResult = (type, text) => { const target = $('#aaa-test-result'); target.className = `alert alert-${type} mt-3 mb-0`; target.textContent = text; };
  const headers = () => ({ 'content-type': 'application/json', ...(csrf() ? { [csrfHeader]: csrf() } : {}) });
  async function load() {
    try {
      const { item = {} } = await request('/api/v1/aaa/config');
      $('#aaa-base-url').value = item.baseUrl ?? ''; $('#aaa-tenant').value = item.tenantName ?? '';
      $('#aaa-access-server').value = item.accessServerName ?? ''; $('#aaa-timeout').value = item.timeoutMs ?? 10000;
      $('#aaa-skip-tls-verification').checked = item.skipTlsVerification === true; $('#aaa-shared-secret').value = '';
      $('#aaa-secret-status').value = item.secretConfigured ? '已配置（页面不显示）' : '未配置';
      $('#aaa-config-badge').className = `badge text-bg-${item.configured ? 'success' : 'warning'}`;
      $('#aaa-config-badge').textContent = item.configured ? '已配置' : '未配置';
      $('#aaa-config-status').textContent = item.updatedAt ? `最近保存：${displayTime(item.updatedAt)}；共享密钥不会回显。` : item.source === 'environment' ? '当前使用部署环境默认值；输入新密钥并保存后可改为页面配置。' : '尚未保存 AAA 配置。';
      hideError();
    } catch (error) { setError(error); }
  }
  $('#aaa-config-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#aaa-config-form button[type="submit"]'); button.disabled = true; hideError();
    try { await request('/api/v1/aaa/config', { method: 'PUT', headers: headers(), body: JSON.stringify(configBody()) }); onMessage('AAA 对接配置已保存'); await load(); }
    catch (error) { setError(error); } finally { button.disabled = false; }
  });
  $('#aaa-test').addEventListener('click', () => { $('#aaa-test-login-name').value = ''; $('#aaa-test-result').className = 'alert d-none mt-3 mb-0'; $('#aaa-test-result').textContent = ''; $('#aaa-test-dialog').showModal(); $('#aaa-test-login-name').focus(); });
  $('#aaa-test-close').addEventListener('click', () => $('#aaa-test-dialog').close());
  $('#aaa-test-cancel').addEventListener('click', () => $('#aaa-test-dialog').close());
  $('#aaa-test-submit').addEventListener('click', async () => {
    const button = $('#aaa-test-submit'); const testLoginName = $('#aaa-test-login-name').value.trim();
    if (!testLoginName) { setResult('danger', '请输入测试用户名。'); $('#aaa-test-login-name').focus(); return; }
    button.disabled = true; setResult('info', '正在校验 AAA 用户和配置…');
    try { await request('/api/v1/aaa/test', { method: 'POST', headers: headers(), body: JSON.stringify({ ...configBody(), testLoginName }) }); setResult('success', `校验成功，已读取用户“${testLoginName}”的认证策略。`); }
    catch (error) { setResult('danger', error.message); } finally { button.disabled = false; }
  });
  return { load };
}
