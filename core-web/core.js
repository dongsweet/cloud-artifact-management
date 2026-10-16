let csrf = null;
let forcedPasswordChange = false;
let currentUser = null;
let coreRoles = {};
let coreUsers = [];
let resetUserId = null;
let cloudMappings = null;
let requestPollTimer = null;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const statusLabels = { CLOUD_PENDING:'待提交云管', CLOUD_SUBMITTED:'云管处理中', APPROVED:'已审批', REJECTED:'已拒绝', CLOUD_STATUS_UNCONFIRMED:'状态未确认', CLOSED:'已关单' };
const submissionStateLabels = { IDLE:'等待提交', QUEUED:'重试已排队', SUBMITTING:'正在提交', RETRY_WAIT:'等待自动重试', SUBMITTED:'已提交' };
function headers(options = {}) { return { ...(options.headers ?? {}), ...(csrf ? { 'x-cam-core-csrf': csrf } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: headers(options) }); const body = await response.json().catch(() => ({})); if (!response.ok) { if (response.status === 401 && path !== '/api/v1/auth/login') showLogin(); throw new Error(body.error?.message ?? `请求失败（${response.status}）`); } return body; }
function clearMessage() { const el = $('#alert'); el.className = 'alert d-none'; el.textContent = ''; }
function showLogin() { forcedPasswordChange = false; $('#app').classList.add('d-none'); $('#password-change').classList.add('d-none'); $('#login').classList.remove('d-none'); clearMessage(); }
function showPasswordChange(forced) { forcedPasswordChange = forced; $('#password-title').textContent = forced ? '修改初始密码' : '修改密码'; $('#password-help').textContent = forced ? '首次登录必须修改初始密码。' : '修改密码后需要重新登录。'; $('#password-cancel').classList.toggle('d-none', forced); $('#password-error').classList.add('d-none'); $('#password-change').classList.remove('d-none'); }
function showApp(user) { currentUser = user; forcedPasswordChange = Boolean(user.mustChangePassword); $('#login').classList.add('d-none'); $('#app').classList.remove('d-none'); clearMessage(); $('#user-label').textContent = `${user.displayName}（${user.username}）`; if (user.mustChangePassword) showPasswordChange(true); else { $('#password-change').classList.add('d-none'); startRequestPolling(); } return user; }
function statusBadge(value) { const kind = value === 'APPROVED' ? 'success' : value === 'REJECTED' ? 'danger' : 'warning'; return `<span class="badge text-bg-${kind}">${escapeHtml(statusLabels[value] ?? value)}</span>`; }
function message(text, type = 'success') { const el = $('#alert'); el.className = `alert alert-${type}`; el.textContent = text; }
function renderCloudMappings(mappings = null) {
  cloudMappings = mappings;
  $('#cloud-id-priority').value = mappings?.priority?.id ?? '';
  $('#cloud-id-source').value = mappings?.source?.id ?? '';
  $('#cloud-id-business-type').value = mappings?.businessType?.id ?? '';
  $('#cloud-id-dept').value = mappings?.dept?.id ?? '';
  $('#cloud-id-team').value = mappings?.team?.id ?? '';
  $('#cloud-id-process-users').value = mappings?.processUserIds?.join(', ') ?? '';
}
function requestSubject(item) {
  if (!item.productName || !item.version || !item.roundNo) return '历史审批请求';
  return `${item.productName} / ${item.displayVersion ?? item.version} · 第 ${item.roundNo} 轮固化申请`;
}
function displayTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function retryCountdown(value) {
  const retryAt = new Date(value).getTime();
  if (!Number.isFinite(retryAt)) return '';
  const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
  return seconds ? `约 ${seconds} 秒后自动重试` : '自动重试即将执行';
}
function render(items) {
  $('#rows').innerHTML = items.length ? items.map((item) => `<tr><td><div class="fw-semibold">${escapeHtml(requestSubject(item))}</div>${item.reportTitle ? `<div class="small text-body-secondary">${escapeHtml(item.reportTitle)}</div>` : '<div class="small text-body-secondary">旧版请求未携带软件版本信息</div>'}</td><td>${statusBadge(item.status)}${item.status === 'CLOUD_PENDING' ? `<div class="small text-body-secondary mt-1">${escapeHtml(submissionStateLabels[item.cloudSubmissionState] ?? '等待提交')}${item.cloudSubmissionAttempts ? ` · 累计 ${escapeHtml(item.cloudSubmissionAttempts)} 次` : ''}</div>${item.cloudSubmissionState === 'RETRY_WAIT' && item.cloudRetryAt ? `<div class="small text-warning-emphasis mt-1">${escapeHtml(retryCountdown(item.cloudRetryAt))}</div>` : ''}${item.lastError ? `<div class="small text-danger mt-1" title="${escapeHtml(item.lastError)}">最近错误：${escapeHtml(item.lastError.length > 80 ? `${item.lastError.slice(0, 80)}…` : item.lastError)}</div>` : ''}` : ''}</td><td>${escapeHtml(item.cloudApprovalId ?? '-')}<br><span class="small text-body-secondary">${escapeHtml(item.cloudStatus ?? '-')}</span></td><td class="font-monospace small" title="${escapeHtml(item.manifestSha256)}">${escapeHtml(item.manifestSha256?.slice(0, 16))}…</td><td>${escapeHtml(displayTime(item.updatedAt))}</td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm detail-button" data-id="${escapeHtml(item.requestId)}">详情</button></div></td></tr>`).join('') : '<tr><td colspan="6" class="text-center text-body-secondary py-4">暂无审批请求</td></tr>';
  document.querySelectorAll('.detail-button').forEach((button) => { button.onclick = () => showDetail(button.dataset.id); });
}
async function load({ quiet = false } = {}) { try { render((await api('/api/v1/approval-requests')).items); if (!quiet) clearMessage(); if ($('#detail').open && $('#detail').dataset.requestId) await showDetail($('#detail').dataset.requestId); } catch (error) { if (!quiet) message(error.message, 'danger'); } }
function startRequestPolling() { if (requestPollTimer) return; requestPollTimer = setInterval(() => { if (!$('#app').classList.contains('d-none') && !$('#page-requests').classList.contains('d-none') && !document.hidden) void load({ quiet: true }); }, 5000); }
function renderArtifacts(items) {
  $('#artifact-rows').innerHTML = items.length ? items.map((item) => { const files = item.files ?? []; const stored = files.filter((file) => file.stored).length; return `<tr><td><div class="fw-semibold">${escapeHtml(item.productName ?? '历史产品')} / ${escapeHtml(item.displayVersion ?? item.version ?? '-')}</div><div class="small text-body-secondary">${item.roundNo ? `第 ${escapeHtml(item.roundNo)} 轮` : escapeHtml(item.roundId)}</div></td><td>${escapeHtml(item.releaseId)}</td><td><div>${escapeHtml(item.cloudApprovalId ?? '-')}</div><div class="small text-body-secondary">${escapeHtml(item.transferTaskId ?? item.cloudTransferTaskId ?? '-')}</div></td><td>${files.length ? `<span class="badge text-bg-${stored === files.length ? 'success' : 'warning'}">${stored} / ${files.length} 个文件已入库</span><div class="small text-body-secondary mt-1">${files.filter((file) => file.source === 'INHERITED').length} 个继承项按摘要复用</div>` : '<span class="text-body-secondary">旧版申请未携带文件清单</span>'}</td><td class="font-monospace small" title="${escapeHtml(item.manifestSha256)}">${escapeHtml(item.manifestSha256?.slice(0, 16))}…</td><td>${escapeHtml(displayTime(item.receivedAt))}</td><td><button class="btn btn-outline-primary btn-sm artifact-detail" data-id="${escapeHtml(item.requestId)}">审批记录</button></td></tr>`; }).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无已接收的正式发布基线。审批通过后，完成网闸交付并收到回执后会显示在这里。</td></tr>';
  document.querySelectorAll('.artifact-detail').forEach((button) => { button.onclick = async () => { location.hash = 'requests'; showPage('requests'); await showDetail(button.dataset.id); }; });
}
async function loadArtifacts() { try { renderArtifacts((await api('/api/v1/artifacts')).items); clearMessage(); } catch (error) { message(error.message, 'danger'); } }
async function showDetail(id) {
  const item = (await api(`/api/v1/approval-requests/${encodeURIComponent(id)}`)).item;
  const dialog = $('#detail');
  dialog.dataset.requestId = id;
  $('#detail .card-title').textContent = requestSubject(item);
  const cloudRetryStatus = item.status === 'CLOUD_PENDING'
    ? `${submissionStateLabels[item.cloudSubmissionState] ?? '等待提交'}（累计 ${item.cloudSubmissionAttempts ?? 0} 次）`
    : '-';
  const fields = [
    ['审批事项', requestSubject(item)], ['验证报告标题', item.reportTitle ?? '旧版请求未携带'],
    ['软件产品', item.productName ?? '-'], ['软件版本', item.displayVersion ?? item.version ?? '-'], ['内部修订号', item.revision > 0 ? `r${item.revision}` : '首版（无后缀）'],
    ['候选轮次', item.roundNo ? `第 ${item.roundNo} 轮` : '-'], ['申请编号', item.requestId],
    ['发布版本标识', item.releaseId], ['候选轮次标识', item.roundId],
    ['状态', statusLabels[item.status] ?? item.status], ['云管提交状态', cloudRetryStatus],
    ['最近提交尝试', item.cloudSubmissionAttemptedAt ? displayTime(item.cloudSubmissionAttemptedAt) : '-'],
    ['下次自动重试', item.cloudRetryAt ? `${retryCountdown(item.cloudRetryAt)}（${displayTime(item.cloudRetryAt)}）` : '-'],
    ['云管审批 ID', item.cloudApprovalId ?? '-'], ['传输任务 ID', item.cloudTransferTaskId ?? '-'],
    ['清单 SHA-256', item.manifestSha256],
    ['报告文件', item.reportReceived ? `<a href="/api/v1/approval-requests/${encodeURIComponent(id)}/report-file" target="_blank" rel="noopener">${escapeHtml(item.reportFileName ?? '下载报告')}</a>` : (item.reportFileName ? `${item.reportFileName}（待接收）` : '-')],
    ['报告 SHA-256', item.reportSha256 ?? '-'],
    ['报告状态', item.reportReceived ? `Core 已校验（${item.reportReceivedSha256 ?? ''}）` : '待从 Edge 接收'],
    ['正式制品文件', item.artifacts?.length ? `${item.artifacts.filter((file) => file.stored).length} / ${item.artifacts.length} 已入库：${item.artifacts.map((file) => `${file.packageKey} → ${file.fileName}${file.stored ? '' : '（待接收）'}`).join('；')}` : '旧版申请未携带文件清单'],
    ['云管附件标识', item.cloudAttachmentId ?? '待上传'], ['最后错误', item.lastError ?? '-']
  ];
  $('#fields').innerHTML = fields.map(([label, value]) => `<dt class="col-sm-3">${escapeHtml(label)}</dt><dd class="col-sm-9 ${String(value).startsWith('<a ') ? '' : 'font-monospace small'}">${String(value).startsWith('<a ') ? value : escapeHtml(value)}</dd>`).join('');
  const actions = [];
  if (item.status === 'CLOUD_PENDING' && currentUser?.roles?.includes('CORE_ADMIN')) {
    const busy = ['QUEUED', 'SUBMITTING'].includes(item.cloudSubmissionState);
    actions.push(`<button id="retry-cloud-button" class="btn btn-warning" ${busy ? 'disabled' : ''}>${busy ? '正在提交…' : '立即重试云管提交'}</button>`);
  }
  if (item.status === 'CLOUD_SUBMITTED') actions.push('<button id="sync-button" class="btn btn-primary">查询云管结果</button>');
  if (item.status === 'APPROVED' && item.transferTaskId) actions.push('<button id="close-button" class="btn btn-success">确认关单</button>');
  $('#actions').innerHTML = actions.join('');
  if (!dialog.open) dialog.showModal();
  $('#retry-cloud-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在提交…';
    try {
      const result = await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' });
      message(result.inProgress ? '云管提交已在处理中' : '已触发云管提交重试');
      await load();
      await showDetail(id);
    } catch (error) {
      message(error.message, 'danger');
      button.disabled = false;
      button.textContent = '立即重试云管提交';
    }
  });
  $('#sync-button')?.addEventListener('click', async () => {
    try { await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/sync`, { method: 'POST' }); message('已同步云管状态'); await load(); await showDetail(id); }
    catch (error) { message(error.message, 'danger'); }
  });
  $('#close-button')?.addEventListener('click', async () => {
    if (!window.confirm('确认将该审批工单关单？')) return;
    try { await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}' }); message('已完成关单'); await load(); await showDetail(id); }
    catch (error) { message(error.message, 'danger'); }
  });
}
async function loadCloudConfig() {
  const form = $('#cloud-config-form');
  renderCloudMappings();
  try {
    const result = await api('/api/v1/cloud/config');
    const item = result.item ?? {};
    for (const element of form.elements) if (element.name) element.value = item[element.name] ?? '';
    renderCloudMappings(item.resolvedMappings ?? null);
    const mappingStatus = item.resolvedMappings ? '匹配 ID 已保存，后续工单会复用；云管字典变化时请重新测试并保存' : '尚无已保存的匹配 ID，请测试并保存配置';
    $('#cloud-status').textContent = `连接参数：${result.secretConfigured ? '已配置' : '未配置'}；业务参数来源：${result.source === 'database' ? 'Core 数据库' : '.env 默认值'}；${mappingStatus}`;
  } catch (error) { message(error.message, 'danger'); }
}
async function loadGateConfig() {
  const form = $('#gate-config-form');
  try {
    const result = await api('/api/v1/gate/config');
    const item = result.item ?? {};
    for (const element of form.elements) if (element.name && item[element.name] !== undefined) element.value = item[element.name];
    $('#gate-secret-status').value = result.secretConfigured ? (result.previousSecretConfigured ? '当前密钥已配置（轮换过渡中）' : '已配置') : '未配置';
    $('#gate-config-status').textContent = `配置来源：${result.item?.source === 'database' ? 'Core 数据库' : '.env 默认值'}；映射模式固定为 mapping。`;
    await loadGateKeys();
  } catch (error) { message(error.message, 'danger'); }
}
async function loadGateKeys() {
  const result = await api('/api/v1/gate/keys');
  $('#gate-identity-bundle').value = JSON.stringify(result.identityBundle, null, 2);
  $('#gate-peer-fingerprint').textContent = result.item.peerTrusted ? result.item.peerFingerprint : '尚未配对';
  $('#gate-key-state').textContent = result.item.keyConfigured ? `当前密钥 ${result.item.activeKeyId}；${result.item.previousKeyExpiresAt ? `旧密钥过渡至 ${new Date(result.item.previousKeyExpiresAt).toLocaleString()}` : '无旧密钥过渡'}` : '尚未建立共享密钥，完成双端身份配对后可自动初始化';
  $('#gate-secret-status').value = result.item.keyConfigured ? (result.item.previousKeyExpiresAt ? '自动管理（新旧密钥过渡中）' : '自动管理（已配置）') : '等待 Edge 配对并初始化';
  $('#gate-rotation-days').value = result.item.rotationIntervalDays;
  $('#gate-grace-hours').value = result.item.gracePeriodHours;
}
function showPage(page) {
  const artifacts = page === 'artifacts'; const cloud = page === 'cloud-config'; const gate = page === 'gate-config'; const users = page === 'users';
  $('#page-requests').classList.toggle('d-none', artifacts || cloud || gate || users); $('#page-artifacts').classList.toggle('d-none', !artifacts); $('#page-cloud-config').classList.toggle('d-none', !cloud); $('#page-gate-config').classList.toggle('d-none', !gate); $('#page-users').classList.toggle('d-none', !users);
  $('#page-title').textContent = artifacts ? '正式制品' : cloud ? '云管对接配置' : gate ? '网闸对接配置' : users ? '账号管理' : '云管审批请求';
  document.querySelectorAll('[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  if (artifacts) loadArtifacts();
  if (cloud) loadCloudConfig();
  if (gate) loadGateConfig();
  if (users) loadUsers();
}
async function loadUsers() {
  try {
    const result = await api('/api/v1/users'); coreRoles = result.roles; coreUsers = result.items;
    $('#user-rows').innerHTML = coreUsers.map((user) => `<tr><td>${escapeHtml(user.username)}<div class="small text-body-secondary">${escapeHtml(user.displayName)}</div></td><td>${user.roles.map((role) => escapeHtml(coreRoles[role] ?? role)).join('、')}</td><td>${user.status === 'ACTIVE' ? '启用' : '禁用'}${user.mustChangePassword ? ' / 待改密码' : ''}${user.lockedUntil > Date.now() ? ' / 锁定' : ''}</td><td>${escapeHtml(user.lastLoginAt ?? '-')}</td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm" data-user-edit="${escapeHtml(user.id)}"><i class="bi bi-pencil"></i> 编辑角色</button><button class="btn btn-outline-warning btn-sm" data-user-reset="${escapeHtml(user.id)}" ${user.id === currentUser?.id ? 'disabled title="请使用右上角修改密码"' : ''}><i class="bi bi-key"></i> 重置密码</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-body-secondary py-4">暂无账号</td></tr>';
    document.querySelectorAll('[data-user-edit]').forEach((button) => { button.onclick = () => openUserEditor(button.dataset.userEdit); });
    document.querySelectorAll('[data-user-reset]').forEach((button) => { button.onclick = () => openUserReset(button.dataset.userReset); });
  } catch (error) { message(error.message, 'danger'); }
}
function openUserEditor(userId = null) {
  const user = coreUsers.find((item) => item.id === userId); const form = $('#user-form'); form.reset(); form.dataset.userId = userId ?? '';
  $('#user-editor-title').textContent = user ? '编辑账号与角色' : '创建账号'; $('#user-name').disabled = Boolean(user); $('#user-name').value = user?.username ?? ''; $('#user-display').value = user?.displayName ?? ''; $('#user-status').value = user?.status ?? 'ACTIVE';
  $('#user-password-field').classList.toggle('d-none', Boolean(user)); $('#user-password').required = !user;
  $('#user-roles').innerHTML = Object.entries(coreRoles).map(([role, label]) => `<label class="form-check form-check-inline"><input class="form-check-input" type="checkbox" value="${escapeHtml(role)}" ${user?.roles.includes(role) ? 'checked' : ''}><span class="form-check-label">${escapeHtml(label)}</span></label>`).join('');
  $('#user-error').classList.add('d-none'); $('#user-editor').classList.remove('d-none'); $('#user-reset').classList.add('d-none'); $('#user-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function openUserReset(userId) { const user = coreUsers.find((item) => item.id === userId); if (!user) return; resetUserId = userId; $('#reset-form').reset(); $('#reset-user-label').textContent = `账号：${user.displayName}（${user.username}）`; $('#reset-error').classList.add('d-none'); $('#user-editor').classList.add('d-none'); $('#user-reset').classList.remove('d-none'); $('#user-reset').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').classList.add('d-none'); try { const result = await api('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) }); csrf = result.csrfToken; showApp(result.user); if (!result.user.mustChangePassword) await load(); } catch (error) { $('#login-error').textContent = error.message; $('#login-error').classList.remove('d-none'); } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#password-error').classList.add('d-none'); if ($('#new-password').value !== $('#repeat-password').value) { $('#password-error').textContent = '两次新密码不一致'; $('#password-error').classList.remove('d-none'); return; } try { await api('/api/v1/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oldPassword: $('#old-password').value, password: $('#new-password').value }) }); $('#password-form').reset(); showLogin(); } catch (error) { $('#password-error').textContent = error.message; $('#password-error').classList.remove('d-none'); } });
$('#change-password').addEventListener('click', () => showPasswordChange(false));
$('#password-cancel').addEventListener('click', () => { if (!forcedPasswordChange) { $('#password-form').reset(); $('#password-change').classList.add('d-none'); } });
$('#logout').addEventListener('click', async () => { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); }); $('#refresh').addEventListener('click', load);
$('#detail-close').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (event) => { if (event.target === $('#detail')) $('#detail').close(); }); $('#artifacts-refresh').addEventListener('click', loadArtifacts);
document.querySelectorAll('[data-page]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); location.hash = link.dataset.page; showPage(link.dataset.page); }));
$('#new-user').addEventListener('click', () => openUserEditor()); $('#user-cancel').addEventListener('click', () => $('#user-editor').classList.add('d-none')); $('#reset-cancel').addEventListener('click', () => $('#user-reset').classList.add('d-none'));
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const userId = form.dataset.userId; const roles = [...document.querySelectorAll('#user-roles input:checked')].map((input) => input.value); const body = { username: $('#user-name').value, displayName: $('#user-display').value, status: $('#user-status').value, roles }; if (!userId) body.password = $('#user-password').value; try { const result = await api(userId ? `/api/v1/users/${encodeURIComponent(userId)}` : '/api/v1/users', { method: userId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); message(userId ? '账号信息已保存；该账号需要重新登录' : `账号 ${result.user.username} 已创建，首次登录须修改初始密码`); $('#user-editor').classList.add('d-none'); if (userId === currentUser?.id) { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); } else await loadUsers(); } catch (error) { $('#user-error').textContent = error.message; $('#user-error').classList.remove('d-none'); } });
$('#reset-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api(`/api/v1/users/${encodeURIComponent(resetUserId)}/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#reset-password').value }) }); $('#user-reset').classList.add('d-none'); message('密码已重置；该账号下次登录须修改初始密码'); await loadUsers(); } catch (error) { $('#reset-error').textContent = error.message; $('#reset-error').classList.remove('d-none'); } });
$('#cloud-config-form').addEventListener('submit', async (event) => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); try { const result = await api('/api/v1/cloud/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); renderCloudMappings(result.item.resolvedMappings); message('云管业务参数和匹配 ID 已保存；后续工单将复用这些 ID。'); await loadCloudConfig(); } catch (error) { message(error.message, 'danger'); } });
$('#cloud-test').addEventListener('click', async () => { const button = $('#cloud-test'); button.disabled = true; try { const config = Object.fromEntries(new FormData($('#cloud-config-form'))); const result = await api('/api/v1/cloud/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) }); renderCloudMappings(result.mappings); $('#cloud-status').textContent = '连接和参数校验成功；点击“保存配置”后，匹配 ID 将持久化并供后续工单复用。'; message('云管连接正常，全部工单参数校验成功。'); } catch (error) { renderCloudMappings(); $('#cloud-status').textContent = '校验失败，请检查填写项后重新测试。'; message(`连接或字典解析失败：${error.message}`, 'danger'); } finally { button.disabled = false; } });
$('#cloud-config-form').addEventListener('input', () => { renderCloudMappings(); $('#cloud-status').textContent = '参数已修改，需重新测试并保存以更新匹配 ID。'; clearMessage(); });
$('#gate-config-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); message('网闸映射配置已保存'); await loadGateConfig(); } catch (error) { message(error.message, 'danger'); } });
$('#gate-test').addEventListener('click', async () => { const button = $('#gate-test'); button.disabled = true; try { const result = await api('/api/v1/gate/config/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData($('#gate-config-form')))) }); $('#gate-config-status').textContent = `控制通道测试成功：${Object.keys(result.checks).map((key) => `${key}=${result.checks[key].service ?? 'ready'}`).join('，')}`; message('网闸映射通道测试成功'); } catch (error) { $('#gate-config-status').textContent = '映射通道测试失败，请检查网闸虚拟地址和策略。'; message(error.message, 'danger'); } finally { button.disabled = false; } });
$('#gate-trust-peer').addEventListener('click', async () => { try { const identityBundle = JSON.parse($('#gate-peer-bundle-input').value); await api('/api/v1/gate/keys/trusted-peer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityBundle }) }); $('#gate-peer-bundle-input').value = ''; await loadGateKeys(); message('Edge 身份已配对；Core 将按轮换策略自动建立密钥'); } catch (error) { message(error.message, 'danger'); } });
$('#gate-schedule').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/keys/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rotationIntervalDays: Number($('#gate-rotation-days').value), gracePeriodHours: Number($('#gate-grace-hours').value) }) }); await loadGateKeys(); message('自动轮换策略已保存'); } catch (error) { message(error.message, 'danger'); } });
$('#gate-rotate-now').addEventListener('click', async () => { const button = $('#gate-rotate-now'); button.disabled = true; try { await api('/api/v1/gate/keys/rotate', { method: 'POST', headers: { 'content-type': 'application/json' } }); await loadGateKeys(); message('共享密钥已完成轮换'); } catch (error) { message(error.message, 'danger'); } finally { button.disabled = false; } });
try { const result = await api('/api/v1/auth/me'); csrf = result.csrfToken; showApp(result.user); if (!result.user.mustChangePassword) await load(); } catch { showLogin(); }
