import { renderGatePairing } from './gate-pairing.js?v=20261020-peer-save-feedback';
import { refreshPaginatedTables } from './table-pagination.js?v=20261020-table-pagination';
import { mountArtifactCatalog } from './artifact-catalog.js?v=20261020-shared-artifact-catalog';
let csrf = null;
document.querySelector('#gate-pairing-mount').innerHTML = renderGatePairing('core');
let forcedPasswordChange = false;
let currentUser = null;
let coreRoles = {};
let edgeRoles = {};
let coreUsers = [];
let coreAgents = [];
let distributionTasks = [];
let distributionArtifacts = [];
let resetUserId = null;
let cloudMappings = null;
let requestPollTimer = null;
let gatePeerTrusted = false;
const $ = (selector) => document.querySelector(selector);
const pagePermissions = Object.freeze({
  requests: 'businessRead',
  artifacts: 'businessRead',
  distribution: 'businessRead',
  agents: 'configRead',
  'cloud-config': 'configRead',
  'aaa-config': 'configRead',
  'gate-config': 'configRead',
  users: 'userAdmin'
});
function canCore(permission) {
  const roles = currentUser?.roles ?? [];
  return {
    businessRead: ['CORE_SYSTEM_ADMIN', 'CORE_OPERATOR', 'CORE_AUDITOR'],
    businessWrite: ['CORE_SYSTEM_ADMIN', 'CORE_OPERATOR'],
    configRead: ['CORE_SYSTEM_ADMIN', 'CORE_SECURITY_ADMIN', 'CORE_AUDITOR'],
    configWrite: ['CORE_SYSTEM_ADMIN', 'CORE_SECURITY_ADMIN'],
    userAdmin: ['CORE_SECURITY_ADMIN']
  }[permission]?.some((role) => roles.includes(role));
}
function applyRoleMenu() {
  document.querySelectorAll('[data-menu-group-item]').forEach((item) => {
    const page = item.querySelector('[data-page]')?.dataset.page;
    item.classList.toggle('d-none', !canCore(pagePermissions[page]));
  });
  document.querySelectorAll('[data-menu-group]').forEach((header) => {
    const group = header.dataset.menuGroup;
    const items = [...document.querySelectorAll(`[data-menu-group-item="${group}"]`)];
    header.classList.toggle('d-none', !items.some((item) => !item.classList.contains('d-none')));
  });
  $('#distribution-form')?.classList.toggle('d-none', !canCore('businessWrite'));
}
function firstAllowedPage() {
  return Object.keys(pagePermissions).find((page) => canCore(pagePermissions[page])) ?? 'requests';
}
function mountAaaConfigPage() {
  const cloudLink = document.querySelector('[data-page="cloud-config"]');
  if (!cloudLink || document.querySelector('[data-page="aaa-config"]')) return;
  cloudLink.parentElement.insertAdjacentHTML('beforebegin', '<li class="nav-item" data-menu-group-item="management"><a href="#aaa-config" class="nav-link" data-page="aaa-config"><span class="nav-icon bi bi-person-badge"></span><p>AAA 对接配置</p></a></li>');
  $('#page-cloud-config').insertAdjacentHTML('beforebegin', '<section id="page-aaa-config" class="d-none"><div class="card"><div class="card-header cam-action-header"><h3 class="card-title">AAA 对接配置</h3><span id="aaa-config-badge" class="badge text-bg-secondary">未配置</span></div><form id="aaa-config-form"><div class="card-body"><div class="alert alert-info"><i class="bi bi-info-circle me-1"></i>这里维护 DKEY AM 的连接参数。共享密钥只在提交时写入 Core 数据库，页面刷新后不回显，仅显示是否已配置。</div><div id="aaa-config-error" class="alert alert-danger d-none"></div><div class="row g-3"><div class="col-md-6"><label class="form-label" for="aaa-base-url">AAA 服务地址</label><input id="aaa-base-url" name="baseUrl" class="form-control" type="url" placeholder="https://aaa.example.cn:8443" required></div><div class="col-md-6"><label class="form-label" for="aaa-timeout">请求超时（毫秒）</label><input id="aaa-timeout" name="timeoutMs" class="form-control" type="number" min="1000" max="120000" required></div><div class="col-md-6"><label class="form-label" for="aaa-tenant">租户名称</label><input id="aaa-tenant" name="tenantName" class="form-control" maxlength="128" required></div><div class="col-md-6"><label class="form-label" for="aaa-access-server">认证设备名称</label><input id="aaa-access-server" name="accessServerName" class="form-control" maxlength="128" required></div><div class="col-md-6"><label class="form-label" for="aaa-test-login-name">测试用户名</label><input id="aaa-test-login-name" class="form-control" maxlength="128" autocomplete="off"><div class="form-text">填写现有 AAA 用户；无需密码，不保存。</div></div><div class="col-md-8"><label class="form-label" for="aaa-shared-secret">API 共享密钥</label><input id="aaa-shared-secret" name="sharedSecret" class="form-control" type="password" autocomplete="new-password" placeholder="留空表示保持当前密钥"></div><div class="col-md-4"><label class="form-label" for="aaa-secret-status">当前状态</label><input id="aaa-secret-status" class="form-control bg-body-secondary" readonly></div><div class="col-12"><div class="form-check form-switch"><input id="aaa-skip-tls-verification" name="skipTlsVerification" class="form-check-input" type="checkbox"><label class="form-check-label" for="aaa-skip-tls-verification">跳过 HTTPS 证书校验</label><div class="form-text">勾选后不验证证书颁发机构、有效期和主机名。</div></div></div><div id="aaa-config-status" class="col-12 small text-body-secondary" role="status"></div></div></div><div class="card-footer d-flex justify-content-end gap-2"><button id="aaa-test" type="button" class="btn btn-outline-primary"><i class="bi bi-plug me-1"></i>测试配置</button><button class="btn btn-primary" type="submit"><i class="bi bi-check-lg me-1"></i>保存配置</button></div></form></div></section>');
}
mountAaaConfigPage();
$('#login .card-title').textContent = 'CAM Core · 内网发布审批';
$('.sidebar-brand .brand-text').textContent = 'CAM Core';
$('#page-artifacts .card-title').textContent = '正式制品';
$('#page-distribution .card-title').textContent = 'Agent 分发';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const statusLabels = { CLOUD_PENDING:'待提交云管', CLOUD_SUBMITTED:'云管处理中', APPROVED:'已审批', REJECTED:'已拒绝', CLOUD_STATUS_UNCONFIRMED:'状态未确认', CLOSED:'已关单' };
const submissionStateLabels = { IDLE:'等待提交', QUEUED:'重试已排队', SUBMITTING:'正在提交', RETRY_WAIT:'等待自动重试', SUBMITTED:'已提交' };
function headers(options = {}) { return { ...(options.headers ?? {}), ...(csrf ? { 'x-cam-core-csrf': csrf } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: headers(options) }); const body = await response.json().catch(() => ({})); if (!response.ok) { if (response.status === 401 && path !== '/api/v1/auth/login') showLogin(); throw new Error(body.error?.message ?? `请求失败（${response.status}）`); } return body; }
function clearMessage() { const el = $('#alert'); el.className = 'alert d-none'; el.textContent = ''; }
function showLogin() { forcedPasswordChange = false; $('#app').classList.add('d-none'); $('#password-change').classList.add('d-none'); $('#login').classList.remove('d-none'); clearMessage(); }
function showPasswordChange(forced) { forcedPasswordChange = forced; $('#password-title').textContent = forced ? '修改初始密码' : '修改密码'; $('#password-help').textContent = forced ? '首次登录必须修改初始密码。' : '修改密码后需要重新登录。'; $('#password-cancel').classList.toggle('d-none', forced); $('#password-error').classList.add('d-none'); $('#password-change').classList.remove('d-none'); }
function showApp(user) { currentUser = user; forcedPasswordChange = Boolean(user.mustChangePassword); $('#login').classList.add('d-none'); $('#app').classList.remove('d-none'); $('#change-password').classList.toggle('d-none', user.authSource === 'AAA'); clearMessage(); $('#user-label').textContent = `${user.displayName}（${user.username}）`; applyRoleMenu(); if (user.mustChangePassword) showPasswordChange(true); else { $('#password-change').classList.add('d-none'); startRequestPolling(); } return user; }
function statusBadge(value) { const kind = value === 'APPROVED' ? 'success' : value === 'REJECTED' ? 'danger' : 'warning'; return `<span class="badge text-bg-${kind}">${escapeHtml(statusLabels[value] ?? value)}</span>`; }
function message(text, type = 'success') { const el = $('#alert'); el.className = `alert alert-${type}`; el.textContent = text; }
function confirmDialog({ title, text, confirmLabel = '确认', confirmClass = 'btn-primary' }) {
  const dialog = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const confirmButton = $('#confirm-submit');
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `btn ${confirmClass}`;
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
    dialog.showModal();
  });
}
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
  refreshPaginatedTables($('#page-requests'));
}
async function load({ quiet = false } = {}) { try { render((await api('/api/v1/approval-requests')).items); if (!quiet) clearMessage(); if ($('#detail').open && $('#detail').dataset.requestId) await showDetail($('#detail').dataset.requestId); } catch (error) { if (!quiet) message(error.message, 'danger'); } }
function startRequestPolling() { if (requestPollTimer) return; requestPollTimer = setInterval(() => { if (!$('#app').classList.contains('d-none') && !$('#page-requests').classList.contains('d-none') && !document.hidden) void load({ quiet: true }); }, 5000); }
let artifactItems = [];
let artifactCatalog = null;
function coreArtifactStatus(item) {
  const files = item.files ?? [];
  const stored = files.filter((file) => file.stored).length;
  const complete = files.length > 0 && stored === files.length;
  return { key: complete ? 'STORED' : 'MISSING', label: `${stored} / ${files.length} 个包已入库`, color: complete ? 'success' : 'warning' };
}
async function loadArtifacts() {
  try {
    artifactItems = (await api('/api/v1/artifacts')).items ?? [];
    artifactCatalog?.update(artifactItems);
    if (!artifactCatalog) artifactCatalog = mountArtifactCatalog($('#artifact-catalog'), artifactItems, {
      statusOptions: [{ key: 'STORED', label: '全部文件已入库' }, { key: 'MISSING', label: '有文件未入库' }],
      statusFor: coreArtifactStatus,
      onHistory: async (item) => { location.hash = 'requests'; showPage('requests'); await showDetail(item.requestId); },
      emptyLabel: '暂无已接收的正式版本。审批通过并收到制品后，会显示在这里。'
    });
    clearMessage();
  } catch (error) { message(error.message, 'danger'); }
}
function renderAgents(items) {
  coreAgents = items ?? [];
  $('#agent-rows').innerHTML = coreAgents.length ? coreAgents.map((agent) => {
    const active = agent.status === 'ACTIVE';
    const pending = agent.status === 'PENDING';
    const statusLabel = active ? '启用' : pending ? '待 Agent 验证' : '已禁用';
    const statusColor = active ? 'success' : pending ? 'warning' : 'secondary';
    const keyState = agentRotationLabel(agent);
    return `<tr><td><div class="fw-semibold">${escapeHtml(agent.name)}</div><div class="small text-body-secondary font-monospace">${escapeHtml(agent.agentId)}</div></td><td>${escapeHtml(agent.centerId)}</td><td><span class="badge text-bg-${statusColor}">${statusLabel}</span><div class="small text-${agent.rotationError ? 'danger' : 'body-secondary'} mt-1">${escapeHtml(keyState)}</div>${pending ? '<div class="small text-body-secondary">Agent 使用已配置的 Core 公钥完成签名校验后自动启用。</div>' : ''}${agent.rotationError ? `<div class="small text-danger">${escapeHtml(agent.rotationError)}</div><div class="small text-body-secondary">已尝试 ${agent.rotationAttempts} 次 · ${escapeHtml(displayTime(agent.rotationRetryAt))} 重试</div>` : ''}</td><td><code class="small d-inline-block text-break" style="max-width:12rem">${escapeHtml(agent.keyId ?? '-')}</code></td><td>${escapeHtml(agent.lastSeenAt ? displayTime(agent.lastSeenAt) : '尚未连接')}</td><td>${escapeHtml(displayTime(agent.nextRotationAt))}<div class="small text-body-secondary">每 ${escapeHtml(agent.rotationDays)} 天 · 过渡 ${escapeHtml(agent.graceHours)} 小时</div></td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm agent-rotation-button" data-id="${escapeHtml(agent.agentId)}" ${active ? '' : 'disabled'}><i class="bi bi-arrow-repeat me-1"></i>身份轮换</button><button class="btn btn-outline-${active || pending ? 'warning' : 'success'} btn-sm agent-status-button" data-id="${escapeHtml(agent.agentId)}" data-status="${active || pending ? 'DISABLED' : 'ACTIVE'}">${active ? '禁用' : pending ? '取消启用' : '启用并验证'}</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无已注册 Agent</td></tr>';
  document.querySelectorAll('.agent-status-button').forEach((button) => { button.onclick = () => updateAgentStatus(button); });
  document.querySelectorAll('.agent-rotation-button').forEach((button) => { button.onclick = () => requestAgentRotation(button.dataset.id, button); });
  refreshPaginatedTables($('#page-agents'));
}
function agentRotationLabel(agent) {
  if (!agent.keyId) return '待身份配对';
  if (agent.rotationState === 'RETRY_WAIT') return '轮换失败，等待重试';
  if (agent.rotationState === 'AWAITING_CONFIRMATION') return '等待 Agent 签名确认';
  if (agent.rotationState === 'REQUESTED') return '等待 Agent 执行轮换';
  return agent.previousKeyExpiresAt && Date.parse(agent.previousKeyExpiresAt) > Date.now() ? `配对成功 · 旧身份过渡至 ${displayTime(agent.previousKeyExpiresAt)}` : '配对成功 · 身份有效';
}
async function requestAgentRotation(agentId, button) {
  const agent = coreAgents.find((item) => item.agentId === agentId);
  if (!agent || !await confirmDialog({
    title: '轮换 Agent 身份',
    text: `将为 ${agent.name} 排队身份轮换。Agent 主动连接 Core 后会生成并持久化新密钥；离线时继续使用现有身份，Core 保留请求，Agent 重连后执行，失败会自动重试。旧身份在新身份切换后保留 ${agent.graceHours} 小时过渡期。风险主要是 Agent 本地密钥数据丢失或损坏时需要重新配对；正常断网可恢复。确认发起吗？`,
    confirmLabel: '发起轮换', confirmClass: 'btn-warning'
  })) return;
  if (button) button.disabled = true;
  try {
    await api(`/api/v1/agents/${encodeURIComponent(agentId)}/rotate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    message('身份轮换请求已排队，等待 Agent 主动连接');
    await loadAgents();
  } catch (error) { message(error.message, 'danger'); }
  finally { if (button) button.disabled = false; }
}
async function loadAgentServiceIdentity() { try { const item = await api('/api/v1/agent-service-identity'); $('#agent-service-public-key').value = item.publicKey ?? ''; $('#agent-service-fingerprint').textContent = item.fingerprint ? `指纹：${item.fingerprint}` : ''; $('#agent-default-rotation-days').value = item.agentRotationPolicy?.rotationDays ?? 90; $('#agent-default-grace-hours').value = item.agentRotationPolicy?.graceHours ?? 24; const pending = item.pendingRotation; $('#agent-service-rotate').disabled = Boolean(pending); $('#agent-service-rotation-status').textContent = pending ? `等待 Agent 确认新身份：${pending.confirmed}/${pending.total}；最晚 ${displayTime(pending.activationDeadlineAt)} 启用，逾期未确认的 Agent 将跳过并需重新配对。新指纹：${pending.fingerprint}` : item.lastRotationSkippedAgentCount ? `上次轮换已完成；${item.lastRotationSkippedAgentCount} 个未确认 Agent 已跳过，重新接入需重新配对。旧身份过渡至 ${displayTime(item.previousKeyExpiresAt)}` : item.previousFingerprint ? `上次轮换已完成；旧身份过渡至 ${displayTime(item.previousKeyExpiresAt)}` : 'Core 身份已与所有已注册 Agent 同步'; } catch (error) { message(error.message, 'danger'); } }
async function loadAgents() { try { renderAgents((await api('/api/v1/agents')).items); await loadAgentServiceIdentity(); } catch (error) { message(error.message, 'danger'); } }
function renderDistributionOptions() {
  const artifactSelect = $('#distribution-artifact');
  const agentSelect = $('#distribution-agent');
  const artifactValue = artifactSelect.value;
  const agentValue = agentSelect.value;
  artifactSelect.innerHTML = '<option value="">请选择正式版本</option>' + distributionArtifacts.map((item) => `<option value="${escapeHtml(item.artifactId)}">${escapeHtml(`${item.productName ?? '历史产品'} · ${item.displayVersion ?? item.version ?? '未知版本'}（${item.packageCount} 个包）`)}</option>`).join('');
  agentSelect.innerHTML = '<option value="">请选择 Agent</option>' + coreAgents.filter((item) => item.status === 'ACTIVE').map((item) => `<option value="${escapeHtml(item.agentId)}">${escapeHtml(item.name)} · ${escapeHtml(item.centerId)}</option>`).join('');
  artifactSelect.value = distributionArtifacts.some((item) => item.artifactId === artifactValue) ? artifactValue : '';
  agentSelect.value = coreAgents.some((item) => item.agentId === agentValue && item.status === 'ACTIVE') ? agentValue : '';
}
function distributionProgress(task) {
  const progress = task.progress ?? {};
  if (progress.totalParts) return `${progress.completedParts ?? 0} / ${progress.totalParts} 分块${progress.fileName ? ` · ${progress.fileName}` : ''}`;
  return progress.state === 'ready' ? '全部文件已校验' : '等待 Agent 拉取';
}
function renderDistributionTasks() {
  const labels = { QUEUED: '排队中', RUNNING: '传输中', COMPLETED: '已就绪' };
  $('#distribution-rows').innerHTML = distributionTasks.length ? distributionTasks.map((task) => {
    const agent = coreAgents.find((item) => item.agentId === task.agentId);
    const artifact = distributionArtifacts.find((item) => item.artifactId === task.artifactId);
    const status = labels[task.status] ?? task.status;
    return `<tr><td><code>${escapeHtml(task.taskId)}</code></td><td>${escapeHtml(agent?.name ?? task.agentId)}</td><td>${escapeHtml(artifact ? `${artifact.productName ?? '历史产品'} · ${artifact.displayVersion ?? artifact.version ?? '未知版本'}` : task.artifactId)}</td><td><span class="badge text-bg-${task.status === 'COMPLETED' ? 'success' : task.status === 'RUNNING' ? 'primary' : 'warning'}">${escapeHtml(status)}</span>${task.lastError ? `<div class="small text-danger mt-1">${escapeHtml(task.lastError)}</div>` : ''}</td><td>${escapeHtml(distributionProgress(task))}${task.attempts ? `<div class="small text-body-secondary">失败重试 ${escapeHtml(task.attempts)} 次</div>` : ''}</td><td>${escapeHtml(displayTime(task.updatedAt))}</td></tr>`;
  }).join('') : '<tr><td colspan="6" class="text-center text-body-secondary py-4">暂无分发任务</td></tr>';
  refreshPaginatedTables($('#page-distribution'));
}
async function loadDistribution() {
  try {
    const [artifacts, agents, tasks] = await Promise.all([api('/api/v1/artifacts'), api('/api/v1/agents'), api('/api/v1/distribution-tasks')]);
    distributionArtifacts = (artifacts.items ?? []).map((item) => ({ ...item, packageCount: (item.files ?? []).length }));
    coreAgents = agents.items ?? [];
    distributionTasks = tasks.items ?? [];
    renderDistributionOptions(); renderDistributionTasks(); clearMessage();
  } catch (error) { message(error.message, 'danger'); }
}
async function createDistributionTask(event) {
  event.preventDefault();
  const button = event.submitter; button.disabled = true; $('#distribution-error').classList.add('d-none');
  try { await api('/api/v1/distribution-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactId: $('#distribution-artifact').value, agentId: $('#distribution-agent').value }) }); message('分发任务已创建，目标 Agent 会主动拉取'); $('#distribution-form').reset(); await loadDistribution(); }
  catch (error) { $('#distribution-error').textContent = error.message; $('#distribution-error').classList.remove('d-none'); }
  finally { button.disabled = false; }
}
async function updateAgentStatus(button) {
  const nextStatus = button.dataset.status;
  button.disabled = true;
  try {
    await api(`/api/v1/agents/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) });
    message(nextStatus === 'ACTIVE' ? '已发起 Agent 身份验证；验证通过后将自动启用。' : 'Agent 已禁用');
    await loadAgents();
  } catch (error) { message(error.message, 'danger'); button.disabled = false; }
}
async function showDetail(id) {
  const item = (await api(`/api/v1/approval-requests/${encodeURIComponent(id)}`)).item;
  const dialog = $('#detail');
  dialog.dataset.requestId = id;
  $('#detail .card-title').textContent = requestSubject(item);
  $('#detail-status').innerHTML = statusBadge(item.status);
  const cloudRetryStatus = item.status === 'CLOUD_PENDING'
    ? `${submissionStateLabels[item.cloudSubmissionState] ?? '等待提交'}（累计 ${item.cloudSubmissionAttempts ?? 0} 次）`
    : '-';
  const detailField = (label, value, { mono = false, wide = false } = {}) => `<div class="cam-detail-field${wide ? ' cam-detail-field-wide' : ''}"><div class="cam-detail-label">${escapeHtml(label)}</div><div class="cam-detail-value${mono ? ' font-monospace' : ''}">${value}</div></div>`;
  const textField = (label, value, options) => detailField(label, escapeHtml(value ?? '-'), options);
  const reportLink = item.reportReceived
    ? `<a href="/api/v1/approval-requests/${encodeURIComponent(id)}/report-file" target="_blank" rel="noopener">${escapeHtml(item.reportFileName ?? '下载验证报告')} <i class="bi bi-download ms-1"></i></a>`
    : escapeHtml(item.reportFileName ? `${item.reportFileName}（待接收）` : '暂无报告文件');
  const files = item.artifacts ?? [];
  const fileList = files.length
    ? `<div class="cam-artifact-list">${files.map((file) => `<div class="cam-artifact-row"><i class="bi bi-${file.stored ? 'check-circle-fill text-success' : 'hourglass-split text-warning'}"></i><div class="cam-artifact-main"><div class="fw-semibold">${escapeHtml(file.packageKey)} <span class="text-body-secondary fw-normal">· ${escapeHtml(file.fileName)}</span></div><div class="small text-body-secondary">${escapeHtml(file.source === 'INHERITED' ? `继承自 ${file.inheritedFromRoundId ?? '前序轮次'}` : '本轮制品')} · ${escapeHtml(file.sizeBytes)} 字节</div><code class="cam-break-anywhere">SHA-256 ${escapeHtml(file.sha256)}</code></div><span class="badge text-bg-${file.stored ? 'success' : 'secondary'}">${file.stored ? '已入库' : '待接收'}</span></div>`).join('')}</div>`
    : `<div class="text-body-secondary">${item.transferTaskId ? '正式制品明细尚未同步，Edge 后续传输时会按原获批 SHA-256 补齐清单。' : '该申请尚未关联正式制品清单。'}</div>`;
  const retryPanel = item.status === 'CLOUD_PENDING'
    ? `<div class="cam-retry-panel"><div><span class="fw-semibold">${escapeHtml(cloudRetryStatus)}</span>${item.cloudSubmissionAttemptedAt ? `<span class="small text-body-secondary ms-2">最近尝试：${escapeHtml(displayTime(item.cloudSubmissionAttemptedAt))}</span>` : ''}</div>${item.cloudRetryAt ? `<div class="small text-warning-emphasis mt-1"><i class="bi bi-clock me-1"></i>${escapeHtml(retryCountdown(item.cloudRetryAt))} · ${escapeHtml(displayTime(item.cloudRetryAt))}</div>` : ''}${item.lastError ? `<div class="small text-danger mt-2"><i class="bi bi-exclamation-circle me-1"></i>${escapeHtml(item.lastError)}</div>` : ''}</div>`
    : `<div class="cam-retry-panel cam-retry-panel-muted">${escapeHtml(statusLabels[item.status] ?? item.status)}${item.cloudWorkflowStep ? ` · 云管环节：${escapeHtml(item.cloudWorkflowStep)}` : ''}${item.lastError ? `<div class="small text-danger mt-2"><i class="bi bi-exclamation-circle me-1"></i>${escapeHtml(item.lastError)}</div>` : ''}</div>`;
  const transferLabel = item.transferStatus === 'RECEIVED'
    ? '传输完成，Core 已收到回执'
    : item.transferTaskId
      ? '已准备传输，等待网闸传输并回执'
      : item.status === 'APPROVED'
        ? (item.cloudTransferTaskId ? '审批已通过，待准备传输' : '审批已通过，等待云管返回传输任务')
        : '审批通过后可准备传输';
  const notificationFailed = ['SENDING', 'RETRY_WAIT'].includes(item.transferNotificationState);
  const transferPanel = `<div class="cam-transfer-state"><span class="badge text-bg-${item.transferStatus === 'RECEIVED' ? 'success' : item.transferTaskId ? 'primary' : item.status === 'APPROVED' ? 'warning' : 'secondary'}">${escapeHtml(transferLabel)}</span>${item.transferTaskId && item.transferNotificationAttempts ? `<div class="small text-body-secondary mt-1">授权通知 Edge：${item.transferNotificationState === 'DELIVERED' ? '已送达' : item.transferNotificationState === 'RETRY_WAIT' ? '等待自动重试' : item.transferNotificationState === 'SENDING' ? '发送中' : '准备中'} · 已尝试 ${item.transferNotificationAttempts} 次</div>` : ''}${notificationFailed && item.transferNotificationLastError ? `<div class="small text-danger mt-1">${escapeHtml(item.transferNotificationLastError)}</div>` : ''}${item.transferStatus === 'RECEIVED' && item.updatedAt ? `<div class="small text-body-secondary mt-1">最近更新：${escapeHtml(displayTime(item.updatedAt))}</div>` : ''}${item.status === 'APPROVED' && !item.transferTaskId ? '<div class="small text-body-secondary mt-1">准备动作会绑定云管审批返回的任务编号和已批准清单，不会修改制品内容。</div>' : ''}</div>`;
  $('#fields').innerHTML = `
    <section class="cam-detail-section"><h4><i class="bi bi-box-seam me-2"></i>发布信息</h4><div class="cam-detail-grid">
      ${textField('软件产品', item.productName)}${textField('软件版本', item.displayVersion ?? item.version)}${textField('候选轮次', item.roundNo ? `第 ${item.roundNo} 轮` : '-')}${textField('验证报告标题', item.reportTitle ?? '旧版请求未携带')}
      ${textField('申请编号', item.requestId, { mono: true })}${textField('发布版本标识', item.releaseId, { mono: true })}${textField('候选轮次标识', item.roundId, { mono: true })}${textField('审批同意暗号', item.approvalCodeConfigured ? '已生成（详情中隐藏）' : '旧版申请未生成', { wide: true })}
    </div></section>
    <section class="cam-detail-section"><h4><i class="bi bi-arrow-left-right me-2"></i>审批与传输</h4><div class="cam-detail-grid">
      ${detailField('云管提交状态', retryPanel, { wide: true })}${textField('云管审批 ID', item.cloudApprovalId, { mono: true })}${detailField('云管处理意见', item.cloudResponseSummary ? escapeHtml(item.cloudResponseSummary) : '<span class="text-body-secondary">云管尚未返回处理意见</span>', { wide: true })}${textField('传输任务 ID', item.cloudTransferTaskId, { mono: true })}
      ${detailField('正式制品传输进度', transferPanel, { wide: true })}
      ${textField('清单 SHA-256', item.manifestSha256, { mono: true, wide: true })}${textField('云管附件标识', item.cloudAttachmentId ?? '待上传', { mono: true })}
    </div></section>
    <section class="cam-detail-section"><h4><i class="bi bi-file-earmark-check me-2"></i>验证报告</h4><div class="cam-detail-grid">
      ${detailField('报告文件', reportLink)}${textField('接收状态', item.reportReceived ? 'Core 已校验' : '待从 Edge 接收')}${textField('报告 SHA-256', item.reportSha256, { mono: true, wide: true })}
    </div></section>
    <section class="cam-detail-section"><h4><i class="bi bi-archive me-2"></i>正式制品 <span class="small text-body-secondary fw-normal">${files.length ? `${files.filter((file) => file.stored).length} / ${files.length} 个已入库` : ''}</span></h4>${fileList}</section>`;
  const actions = [];
  if (item.status === 'CLOUD_PENDING' && canCore('businessWrite')) {
    const busy = ['QUEUED', 'SUBMITTING'].includes(item.cloudSubmissionState);
    actions.push(`<button id="retry-cloud-button" class="btn btn-warning" ${busy ? 'disabled' : ''}>${busy ? '正在提交…' : '立即重试云管提交'}</button>`);
  }
  if (item.status === 'CLOUD_SUBMITTED' && canCore('businessWrite')) actions.push('<button id="sync-button" class="btn btn-primary">查询云管结果</button>');
  if (item.status === 'APPROVED' && !item.transferTaskId && item.cloudTransferTaskId && canCore('businessWrite')) actions.push('<button id="prepare-transfer-button" class="btn btn-primary"><i class="bi bi-send-check me-1"></i>准备正式制品传输</button>');
  if (item.status === 'APPROVED' && item.transferStatus === 'RECEIVED' && canCore('businessWrite')) actions.push('<button id="close-button" class="btn btn-success">确认关单</button>');
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
  $('#prepare-transfer-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>正在准备…';
    try {
      await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/transfer-authorize`, {
        method: 'POST', body: JSON.stringify({ manifestSha256: item.manifestSha256, transferTaskId: item.cloudTransferTaskId })
      });
      message('已准备正式制品传输。传输任务已绑定获批清单，等待网闸发送与接收回执。');
      await load();
      await showDetail(id);
    } catch (error) {
      message(error.message, 'danger');
      button.disabled = false;
      button.innerHTML = '<i class="bi bi-send-check me-1"></i>准备正式制品传输';
    }
  });
  $('#close-button')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: '确认关单', text: '确认将该审批工单关单？', confirmLabel: '确认关单', confirmClass: 'btn-success' })) return;
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
    $('#gate-secret-status').value = result.identityConfigured ? (result.previousIdentityConfigured ? '身份已配对（旧身份过渡中）' : '身份已配对') : '尚未配对';
    $('#gate-config-status').textContent = `配置来源：${result.item?.source === 'database' ? 'Core 数据库' : '.env 默认值'}；映射模式固定为 mapping。`;
    await loadGateKeys();
  } catch (error) { message(error.message, 'danger'); }
}
async function loadGateKeys({ preserveInputs = false } = {}) {
  const result = await api('/api/v1/gate/keys');
  const item = result.item;
  $('#gate-identity-bundle').value = JSON.stringify(result.identityBundle, null, 2);
  $('#gate-peer-fingerprint').textContent = item.peerFingerprint ?? '尚未导入';
  gatePeerTrusted = Boolean(item.peerFingerprint);
  const peerEditor = $('#gate-peer-editor'); const peerEdit = $('#gate-peer-edit'); const peerCancel = $('#gate-peer-cancel');
  if (!gatePeerTrusted) { peerEditor.dataset.editing = ''; peerEditor.classList.remove('d-none'); peerEdit.classList.add('d-none'); peerCancel.classList.add('d-none'); }
  else if (!preserveInputs && peerEditor.dataset.editing !== 'true') { peerEditor.classList.add('d-none'); peerEdit.classList.remove('d-none'); peerCancel.classList.add('d-none'); $('#gate-peer-bundle-input').value = ''; }
  const editingPeer = !gatePeerTrusted || peerEditor.dataset.editing === 'true';
  $('#gate-peer-fingerprint').classList.toggle('d-none', editingPeer);
  $('#gate-peer-fingerprint-label').textContent = editingPeer ? '导入 Edge 导出的身份包' : '已信任的身份指纹';
  $('#gate-peer-state').textContent = gatePeerTrusted ? editingPeer ? '替换信任身份会中断现有业务通道，需重新完成双方配对' : '已信任对端身份；日常轮换会自动更新对端公钥' : '首次配对需要导入对端身份包';
  $('#gate-trust-peer').classList.toggle('d-none', gatePeerTrusted && peerEditor.dataset.editing !== 'true');
  const states = { UNPAIRED: '未导入对端身份，业务传输已禁用', KEY_PENDING: '尚未完成身份配对', PAIRED: '双向身份配对完成，签名业务通道可用' };
  $('#gate-key-state').textContent = states[item.pairingState] ?? '等待确认配对状态';
  const paired = item.pairingState === 'PAIRED';
  $('#gate-pairing-badge').className = `badge text-bg-${paired ? 'success' : 'warning'}`;
  $('#gate-pairing-badge').textContent = paired ? '已配对' : item.pairingState === 'UNPAIRED' ? '未配对' : '配对中';
  const rotationStates = { IDLE: '当前无身份轮换任务', PROPOSAL_PENDING: '等待对端确认新身份' };
  const rotationSummary = rotationStates[item.rotationState] ?? item.rotationState ?? '等待配对';
  const transitionSummary = item.previousKeyExpiresAt ? `${rotationSummary}；旧密钥过渡至 ${displayTime(item.previousKeyExpiresAt)}` : rotationSummary;
  const fields = [
    ['本端公钥指纹', item.activeKeyId ?? '尚未生成'],
    ['身份轮换状态', transitionSummary],
    ['最近完成轮换', item.lastRotationAt ? displayTime(item.lastRotationAt) : '暂无记录'],
    ['下次自动轮换', item.nextRotationAt ? displayTime(item.nextRotationAt) : '配对完成后安排'],
  ];
  $('#gate-key-summary').innerHTML = fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const retry = $('#gate-key-retry');
  retry.classList.toggle('d-none', !item.lastRotationError && !item.retryAt);
  retry.textContent = [item.lastRotationError && `最近失败：${item.lastRotationError}`, item.retryAt && `下次自动重试：${displayTime(item.retryAt)}`, (item.lastRotationError || item.retryAt) && '可点击“测试身份配对”立即重试。'].filter(Boolean).join('；');
  $('#gate-secret-status').value = states[item.pairingState] ?? '等待确认配对状态';
  const events = { PEER_TRUSTED: '已保存对端身份', PEER_REPLACED_KEYS_RETIRED: '对端身份已更换，旧身份已撤销', IDENTITY_ROTATION_PROPOSED: '已发起本端身份轮换', PEER_IDENTITY_ROTATED: '已信任对端新身份', IDENTITY_ROTATION_ACTIVATED: '本端新身份已启用', ROTATION_RETRY_WAIT: '身份轮换失败，等待重试', SCHEDULE_UPDATED: '身份轮换策略已更新', SHARED_SECRETS_RETIRED: '已清除旧版共享密钥' };
  $('#gate-key-events').innerHTML = (item.recentEvents ?? []).slice(0, 5).map((event) => `<div class="cam-gate-event"><time>${escapeHtml(displayTime(event.at))}</time><span>${escapeHtml(events[event.type] ?? event.type)}</span></div>`).join('') || '<p class="small text-body-secondary mb-0">暂无配对与轮换记录</p>';
  if (!preserveInputs) { $('#gate-rotation-days').value = item.rotationIntervalDays; $('#gate-grace-hours').value = item.gracePeriodHours; }
  $('#gate-rotate-now').disabled = !item.peerTrusted;
  return item;
}
function showPage(page) {
  const validPages = new Set(['requests', 'artifacts', 'distribution', 'cloud-config', 'aaa-config', 'gate-config', 'agents', 'users']);
  if (!validPages.has(page)) page = 'requests';
  if (!canCore(pagePermissions[page])) page = firstAllowedPage();
  if (window.location.hash.slice(1).split('?')[0] !== page) history.replaceState(null, '', `#${page}`);
  const artifacts = page === 'artifacts'; const distribution = page === 'distribution'; const cloud = page === 'cloud-config'; const aaa = page === 'aaa-config'; const gate = page === 'gate-config'; const agents = page === 'agents'; const users = page === 'users';
  $('#page-requests').classList.toggle('d-none', artifacts || distribution || cloud || aaa || gate || agents || users); $('#page-artifacts').classList.toggle('d-none', !artifacts); $('#page-distribution').classList.toggle('d-none', !distribution); $('#page-cloud-config').classList.toggle('d-none', !cloud); $('#page-aaa-config').classList.toggle('d-none', !aaa); $('#page-gate-config').classList.toggle('d-none', !gate); $('#page-agents').classList.toggle('d-none', !agents); $('#page-users').classList.toggle('d-none', !users);
  $('#page-title').textContent = artifacts ? '正式制品' : distribution ? 'Agent 分发' : cloud ? '云管对接配置' : aaa ? 'AAA 对接配置' : gate ? '网闸对接配置' : agents ? 'Agent 管理' : users ? '账号管理' : '审批请求';
  document.querySelectorAll('[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  if (artifacts) loadArtifacts();
  if (distribution) loadDistribution();
  if (cloud) loadCloudConfig();
  if (aaa) loadAaaConfig();
  if (gate) loadGateConfig();
  if (agents) loadAgents();
  if (users) loadUsers();
}
function pageFromHash() {
  const value = window.location.hash.slice(1).split('?')[0];
  return value || 'requests';
}
async function loadAaaConfig() {
  try {
    const result = await api('/api/v1/aaa/config');
    const item = result.item ?? {};
    $('#aaa-base-url').value = item.baseUrl ?? '';
    $('#aaa-tenant').value = item.tenantName ?? '';
    $('#aaa-access-server').value = item.accessServerName ?? '';
    $('#aaa-timeout').value = item.timeoutMs ?? 10000;
    $('#aaa-skip-tls-verification').checked = item.skipTlsVerification === true;
    $('#aaa-shared-secret').value = '';
    $('#aaa-secret-status').value = item.secretConfigured ? '已配置（页面不显示）' : '未配置';
    $('#aaa-config-badge').className = `badge text-bg-${item.configured ? 'success' : 'warning'}`;
    $('#aaa-config-badge').textContent = item.configured ? '已配置' : '未配置';
    $('#aaa-config-status').textContent = item.updatedAt ? `最近保存：${displayTime(item.updatedAt)}；共享密钥不会回显。` : item.source === 'environment' ? '当前使用部署环境默认值；输入新密钥并保存后可改为页面配置。' : '尚未保存 AAA 配置。';
  } catch (error) { message(error.message, 'danger'); }
}
function aaaConfigFormBody() {
  return { baseUrl: $('#aaa-base-url').value.trim(), tenantName: $('#aaa-tenant').value.trim(), accessServerName: $('#aaa-access-server').value.trim(), sharedSecret: $('#aaa-shared-secret').value, timeoutMs: Number($('#aaa-timeout').value), skipTlsVerification: $('#aaa-skip-tls-verification').checked };
}
async function loadUsers() {
  try {
    const result = await api('/api/v1/users'); coreRoles = result.roles; edgeRoles = result.edgeRoles ?? {}; coreUsers = result.items;
    $('#user-rows').innerHTML = coreUsers.map((user) => `<tr><td>${escapeHtml(user.username)}<div class="small text-body-secondary">${escapeHtml(user.displayName)}</div></td><td>${user.authSource === 'AAA' ? 'AAA 实时认证' : 'Core 本地认证'}<div class="small text-body-secondary">Core：${user.roles.map((role) => escapeHtml(coreRoles[role] ?? role)).join('、') || '无'}<br>Edge：${user.edgeEnabled ? user.edgeRoles.map((role) => escapeHtml(edgeRoles[role] ?? role)).join('、') : '未授权'}</div></td><td><span class="badge text-bg-${((user.coreEnabled ?? (user.status === 'ACTIVE')) ? 'success' : 'secondary')}">Core：${((user.coreEnabled ?? (user.status === 'ACTIVE')) ? '允许登录' : '已禁用')}</span><div class="small text-body-secondary mt-1">Edge：${user.edgeEnabled ? '允许登录' : '已禁用'}${user.mustChangePassword ? ' / 待改密码' : ''}${user.lockedUntil > Date.now() ? ' / 锁定' : ''}</div></td><td>${escapeHtml(user.lastLoginAt ?? '-')}</td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm" data-user-edit="${escapeHtml(user.id)}"><i class="bi bi-pencil"></i> 编辑账号</button>${user.authSource === 'AAA' ? '<span class="small text-body-secondary">密码由 AAA 管理</span>' : `<button class="btn btn-outline-warning btn-sm" data-user-reset="${escapeHtml(user.id)}" ${user.id === currentUser?.id ? 'disabled title="请使用右上角修改密码"' : ''}><i class="bi bi-key"></i> 重置密码</button>`}</div></td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-body-secondary py-4">暂无账号</td></tr>';
    refreshPaginatedTables($('#page-users'));
    document.querySelectorAll('[data-user-edit]').forEach((button) => { button.onclick = () => openUserEditor(button.dataset.userEdit); });
    document.querySelectorAll('[data-user-reset]').forEach((button) => { button.onclick = () => openUserReset(button.dataset.userReset); });
  } catch (error) { message(error.message, 'danger'); }
}
let userDialog = null;
function ensureUserDialog() {
  if (userDialog) return userDialog;
  const editor = $('#user-editor');
  const reset = $('#user-reset');
  userDialog = document.createElement('dialog');
  userDialog.id = 'user-editor-dialog';
  userDialog.className = 'cam-user-modal';
  editor.parentElement.insertBefore(userDialog, editor);
  userDialog.append(editor, reset);
  editor.classList.remove('d-none');
  reset.classList.add('d-none');
  userDialog.addEventListener('click', (event) => { if (event.target === userDialog) userDialog.close(); });
  userDialog.addEventListener('close', () => { editor.classList.add('d-none'); reset.classList.add('d-none'); });
  return userDialog;
}
function closeUserDialog() { if (userDialog?.open) userDialog.close(); }
function selectedUserAuthSource() { return document.querySelector('input[name="user-auth-source"]:checked')?.value ?? 'LOCAL'; }
function updateUserCredentialFields(editing = Boolean($('#user-form').dataset.userId)) {
  const aaa = selectedUserAuthSource() === 'AAA';
  const password = $('#user-password');
  $('#user-password-field').classList.toggle('d-none', editing);
  password.disabled = editing || aaa;
  password.required = !editing && !aaa;
  if (aaa) password.value = '';
}
function openUserEditor(userId = null) {
  const dialog = ensureUserDialog(); const user = coreUsers.find((item) => item.id === userId); const form = $('#user-form'); form.reset(); form.dataset.userId = userId ?? '';
  $('#user-editor-title').textContent = user ? '编辑账号与角色' : '创建账号'; $('#user-name').disabled = Boolean(user); $('#user-name').value = user?.username ?? ''; $('#user-display').value = user?.displayName ?? ''; $('#user-core-enabled').checked = user ? Boolean(user.coreEnabled ?? (user.status === 'ACTIVE')) : true;
  document.querySelectorAll('input[name="user-auth-source"]').forEach((input) => { input.checked = input.value === (user?.authSource ?? 'LOCAL'); input.disabled = Boolean(user); });
  updateUserCredentialFields(Boolean(user));
  $('#user-roles').innerHTML = Object.entries(coreRoles).map(([role, label]) => `<label class="form-check form-check-inline"><input class="form-check-input" type="checkbox" value="${escapeHtml(role)}" ${user?.roles.includes(role) ? 'checked' : ''}><span class="form-check-label">${escapeHtml(label)}</span></label>`).join('');
  $('#user-edge-enabled').checked = Boolean(user?.edgeEnabled);
  $('#user-edge-roles').innerHTML = Object.entries(edgeRoles).map(([role, label]) => `<label class="form-check form-check-inline"><input class="form-check-input" type="checkbox" value="${escapeHtml(role)}" ${user?.edgeRoles.includes(role) ? 'checked' : ''}><span class="form-check-label">${escapeHtml(label)}</span></label>`).join('');
  $('#user-error').classList.add('d-none'); $('#user-editor').classList.remove('d-none'); $('#user-reset').classList.add('d-none'); if (!dialog.open) dialog.showModal();
}
function openUserReset(userId) { const dialog = ensureUserDialog(); const user = coreUsers.find((item) => item.id === userId); if (!user) return; resetUserId = userId; $('#reset-form').reset(); $('#reset-user-label').textContent = `账号：${user.displayName}（${user.username}）`; $('#reset-error').classList.add('d-none'); $('#user-editor').classList.add('d-none'); $('#user-reset').classList.remove('d-none'); if (!dialog.open) dialog.showModal(); }
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').classList.add('d-none'); try { const result = await api('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) }); csrf = result.csrfToken; showApp(result.user); if (!result.user.mustChangePassword) { showPage(pageFromHash()); if (pageFromHash() === 'requests' && canCore('businessRead')) await load(); } } catch (error) { $('#login-error').textContent = error.message; $('#login-error').classList.remove('d-none'); } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#password-error').classList.add('d-none'); if ($('#new-password').value !== $('#repeat-password').value) { $('#password-error').textContent = '两次新密码不一致'; $('#password-error').classList.remove('d-none'); return; } try { await api('/api/v1/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oldPassword: $('#old-password').value, password: $('#new-password').value }) }); $('#password-form').reset(); showLogin(); } catch (error) { $('#password-error').textContent = error.message; $('#password-error').classList.remove('d-none'); } });
$('#change-password').addEventListener('click', () => showPasswordChange(false));
$('#password-cancel').addEventListener('click', () => { if (!forcedPasswordChange) { $('#password-form').reset(); $('#password-change').classList.add('d-none'); } });
$('#logout').addEventListener('click', async () => { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); }); $('#refresh').addEventListener('click', load);
$('#detail-close').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('click', (event) => { if (event.target === $('#detail')) $('#detail').close(); }); $('#artifacts-refresh').addEventListener('click', loadArtifacts);
$('#distribution-refresh').addEventListener('click', loadDistribution);
$('#distribution-form').addEventListener('submit', createDistributionTask);
$('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close('cancel'));
$('#confirm-submit').addEventListener('click', () => $('#confirm-dialog').close('confirm'));
$('#confirm-dialog').addEventListener('click', (event) => { if (event.target === $('#confirm-dialog')) $('#confirm-dialog').close('cancel'); });
$('#agents-refresh').addEventListener('click', loadAgents);
$('#agent-service-copy').addEventListener('click', async () => { const value = $('#agent-service-public-key').value; if (!value) return; try { await navigator.clipboard.writeText(value); message('Core 服务公钥已复制'); } catch { $('#agent-service-public-key').select(); message('浏览器未授权自动复制，请按 Ctrl+C 复制'); } });
$('#agent-service-rotate').addEventListener('click', async (event) => { if (!await confirmDialog({ title: '轮换 Core 服务身份', text: 'Core 会生成新身份，并由当前身份签名发送提案。全部 Agent 确认后会提前切换；否则最多等待上方设置的旧身份过渡期，到期后照常启用新身份。届时未确认的 Agent 会被跳过，之后重新接入需要重新配对。确认发起吗？', confirmLabel: '发起轮换', confirmClass: 'btn-warning' })) return; event.currentTarget.disabled = true; try { const result = await api('/api/v1/agent-service-identity/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); message(result.pendingRotation ? `Core 新身份已暂存，等待 ${result.pending} 个 Agent 确认，最晚于 ${displayTime(result.activationDeadlineAt)} 启用` : 'Core 服务身份已轮换'); await loadAgents(); } catch (error) { message(error.message, 'danger'); } finally { event.currentTarget.disabled = false; } });
$('#agent-rotation-policy-save').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true;
  try {
    const result = await api('/api/v1/agent-rotation-policy', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rotationDays: Number($('#agent-default-rotation-days').value), graceHours: Number($('#agent-default-grace-hours').value) }) });
    $('#agent-default-rotation-days').value = result.item.rotationDays;
    $('#agent-default-grace-hours').value = result.item.graceHours;
    message('Agent 统一身份轮换策略已保存');
    await loadAgents();
  } catch (error) { message(error.message, 'danger'); }
  finally { button.disabled = false; }
});
document.querySelectorAll('[data-page]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); location.hash = link.dataset.page; showPage(link.dataset.page); }));
window.addEventListener('hashchange', () => { if (!$('#app').classList.contains('d-none')) showPage(pageFromHash()); });
$('#agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = event.submitter ?? document.querySelector('button[form="agent-form"][type="submit"]') ?? form.querySelector('button[type="submit"]');
  $('#agent-error').classList.add('d-none');
  button.disabled = true;
  try {
    const result = await api('/api/v1/agents', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    message(`Agent 已注册，等待本机签名确认；身份指纹：${result.item.fingerprint}`);
    await loadAgents();
  } catch (error) { $('#agent-error').textContent = error.message; $('#agent-error').classList.remove('d-none'); }
  finally { button.disabled = false; }
});
$('#new-user').addEventListener('click', () => openUserEditor()); $('#user-cancel').addEventListener('click', closeUserDialog); $('#reset-cancel').addEventListener('click', closeUserDialog);
document.querySelectorAll('input[name="user-auth-source"]').forEach((input) => input.addEventListener('change', () => updateUserCredentialFields(false)));
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const userId = form.dataset.userId; const roles = [...document.querySelectorAll('#user-roles input:checked')].map((input) => input.value); const edgeRolesSelected = [...document.querySelectorAll('#user-edge-roles input:checked')].map((input) => input.value); const body = { username: $('#user-name').value, displayName: $('#user-display').value, authSource: selectedUserAuthSource(), coreEnabled: $('#user-core-enabled').checked, roles, edgeEnabled: $('#user-edge-enabled').checked, edgeRoles: edgeRolesSelected }; if (!userId && body.authSource === 'LOCAL') body.password = $('#user-password').value; try { const result = await api(userId ? `/api/v1/users/${encodeURIComponent(userId)}` : '/api/v1/users', { method: userId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); message(userId ? '账号信息已保存；该账号需要重新登录' : body.authSource === 'AAA' ? `AAA 账号 ${result.user.username} 已登记并分配 CAM 角色` : `本地账号 ${result.user.username} 已创建，首次登录须修改初始密码`); closeUserDialog(); if (userId === currentUser?.id) { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); } else await loadUsers(); } catch (error) { $('#user-error').textContent = error.message; $('#user-error').classList.remove('d-none'); } });
$('#reset-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api(`/api/v1/users/${encodeURIComponent(resetUserId)}/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#reset-password').value }) }); closeUserDialog(); message('密码已重置；该账号下次登录须修改初始密码'); await loadUsers(); } catch (error) { $('#reset-error').textContent = error.message; $('#reset-error').classList.remove('d-none'); } });
$('#cloud-config-form').addEventListener('submit', async (event) => { event.preventDefault(); const body = Object.fromEntries(new FormData(event.currentTarget)); try { const result = await api('/api/v1/cloud/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); renderCloudMappings(result.item.resolvedMappings); message('云管业务参数和匹配 ID 已保存；后续工单将复用这些 ID。'); await loadCloudConfig(); } catch (error) { message(error.message, 'danger'); } });
$('#cloud-test').addEventListener('click', async () => { const button = $('#cloud-test'); button.disabled = true; try { const config = Object.fromEntries(new FormData($('#cloud-config-form'))); const result = await api('/api/v1/cloud/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) }); renderCloudMappings(result.mappings); $('#cloud-status').textContent = '连接和参数校验成功；点击“保存配置”后，匹配 ID 将持久化并供后续工单复用。'; message('云管连接正常，全部工单参数校验成功。'); } catch (error) { renderCloudMappings(); $('#cloud-status').textContent = '校验失败，请检查填写项后重新测试。'; message(`连接或字典解析失败：${error.message}`, 'danger'); } finally { button.disabled = false; } });
$('#aaa-config-form').addEventListener('submit', async (event) => { event.preventDefault(); const button = $('#aaa-config-form button[type="submit"]'); button.disabled = true; $('#aaa-config-error').classList.add('d-none'); try { await api('/api/v1/aaa/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(aaaConfigFormBody()) }); message('AAA 对接配置已保存'); await loadAaaConfig(); } catch (error) { $('#aaa-config-error').textContent = error.message; $('#aaa-config-error').classList.remove('d-none'); } finally { button.disabled = false; } });
$('#aaa-test').addEventListener('click', async () => { const button = $('#aaa-test'); button.disabled = true; $('#aaa-config-error').classList.add('d-none'); try { const testLoginName = $('#aaa-test-login-name').value.trim(); const result = await api('/api/v1/aaa/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...aaaConfigFormBody(), testLoginName }) }); message(`AAA 参数校验成功，已读取用户“${testLoginName}”的认证策略；配置尚未保存，请确认后点击“保存配置”。`); } catch (error) { $('#aaa-config-error').textContent = error.message; $('#aaa-config-error').classList.remove('d-none'); } finally { button.disabled = false; } });
$('#cloud-config-form').addEventListener('input', () => { renderCloudMappings(); $('#cloud-status').textContent = '参数已修改，需重新测试并保存以更新匹配 ID。'; clearMessage(); });
$('#gate-config-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/config', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); message('网闸映射配置已保存'); await loadGateConfig(); } catch (error) { message(error.message, 'danger'); } });
$('#gate-test').addEventListener('click', async () => { const button = $('#gate-test'); button.disabled = true; try { const result = await api('/api/v1/gate/config/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData($('#gate-config-form')))) }); $('#gate-config-status').textContent = `控制通道测试成功：${Object.keys(result.checks).map((key) => `${key}=${result.checks[key].service ?? 'ready'}`).join('，')}`; message('网闸映射通道测试成功'); } catch (error) { $('#gate-config-status').textContent = '映射通道测试失败，请检查网闸虚拟地址和策略。'; message(error.message, 'danger'); } finally { button.disabled = false; } });
$('#gate-copy-identity').addEventListener('click', async () => {
  const input = $('#gate-identity-bundle');
  if (!input.value) return;
  try { await navigator.clipboard.writeText(input.value); $('#gate-copy-state').textContent = '身份包已复制，请在 Edge 导入。'; }
  catch { input.focus(); input.select(); $('#gate-copy-state').textContent = '浏览器未授权自动复制，已选中身份包，请按 Ctrl+C 复制。'; }
});
$('#gate-peer-edit').addEventListener('click', () => { $('#gate-pairing-result').classList.add('d-none'); $('#gate-peer-editor').classList.remove('d-none'); $('#gate-peer-editor').dataset.editing = 'true'; $('#gate-peer-fingerprint').classList.add('d-none'); $('#gate-peer-fingerprint-label').textContent = '导入 Edge 导出的身份包'; $('#gate-peer-edit').classList.add('d-none'); $('#gate-peer-cancel').classList.remove('d-none'); $('#gate-trust-peer').classList.remove('d-none'); $('#gate-peer-bundle-input').focus({ preventScroll: true }); $('#gate-peer-state').textContent = '替换对端身份会关闭业务通道，双方需重新测试配对'; });
$('#gate-peer-cancel').addEventListener('click', () => { $('#gate-peer-editor').classList.add('d-none'); $('#gate-peer-editor').dataset.editing = ''; $('#gate-peer-fingerprint').classList.remove('d-none'); $('#gate-peer-fingerprint-label').textContent = '已信任的身份指纹'; $('#gate-peer-cancel').classList.add('d-none'); $('#gate-trust-peer').classList.add('d-none'); $('#gate-peer-edit').classList.remove('d-none'); $('#gate-peer-bundle-input').value = ''; $('#gate-peer-state').textContent = '已取消身份替换'; });
$('#gate-trust-peer').addEventListener('click', async (event) => {
  const button = event.currentTarget; const original = button.innerHTML; const notice = $('#gate-pairing-result'); let identitySaved = false;
  notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = gatePeerTrusted ? '请在确认框中确认替换 Edge 身份。' : '正在保存 Edge 身份…';
  button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>保存中';
  try {
    if (gatePeerTrusted && !await confirmDialog({ title: '重新配对 Edge 身份', text: '替换对端身份会关闭业务通道，双方需重新完成配对测试。确定继续吗？', confirmLabel: '确认替换', confirmClass: 'btn-warning' })) { notice.className = 'alert alert-secondary mt-3 mb-0'; notice.textContent = '已取消身份替换。'; return; }
    notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = '正在保存身份并刷新配对状态…';
    const identityBundle = JSON.parse($('#gate-peer-bundle-input').value);
    await api('/api/v1/gate/keys/trusted-peer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityBundle }) }); identitySaved = true;
    $('#gate-peer-bundle-input').value = ''; $('#gate-peer-editor').dataset.editing = '';
    const item = await loadGateKeys();
    notice.className = 'alert alert-success mt-3 mb-0'; notice.textContent = `Edge 身份已保存。当前状态：${item.pairingState === 'PAIRED' ? '双向身份配对完成，签名业务通道可用' : '身份已更新，等待重新测试配对'}。`;
  } catch (error) {
    notice.className = `alert alert-${identitySaved ? 'warning' : 'danger'} mt-3 mb-0`;
    notice.textContent = identitySaved ? `身份已保存，但状态刷新失败：${error.message}` : `身份未保存：${error.message}`;
  } finally { button.disabled = false; button.innerHTML = original; }
});
$('#gate-pairing-test').addEventListener('click', async (event) => {
  const button = event.currentTarget; const notice = $('#gate-pairing-result');
  button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>测试中';
  notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = '正在测试身份配对与签名认证…';
  try {
    const result = await api('/api/v1/gate/keys/test', { method: 'POST' });
    notice.className = 'alert alert-success mt-3 mb-0';
    notice.textContent = `配对测试通过：本端 Core 与对端 ${result.checks.remote.role} 均已配对，签名认证成功（${displayTime(new Date().toISOString())}）。`;
  } catch (error) { notice.className = 'alert alert-danger mt-3 mb-0'; notice.textContent = `配对测试未通过：${error.message}`; }
  finally { await loadGateKeys({ preserveInputs: true }).catch(() => {}); button.disabled = false; button.innerHTML = '<i class="bi bi-shield-check me-1"></i>测试身份配对'; }
});
$('#gate-schedule').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/keys/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rotationIntervalDays: Number($('#gate-rotation-days').value), gracePeriodHours: Number($('#gate-grace-hours').value) }) }); await loadGateKeys(); message('自动轮换策略已保存'); } catch (error) { message(error.message, 'danger'); } });
$('#gate-rotate-now').addEventListener('click', async () => { const button = $('#gate-rotate-now'); button.disabled = true; try { await api('/api/v1/gate/keys/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await loadGateKeys(); message('本端身份公私钥已完成轮换'); } catch (error) { message(error.message, 'danger'); } finally { button.disabled = false; } });
try { const result = await api('/api/v1/auth/me'); csrf = result.csrfToken; showApp(result.user); if (!result.user.mustChangePassword) { showPage(pageFromHash()); if (pageFromHash() === 'requests' && canCore('businessRead')) await load(); } } catch { showLogin(); }

setInterval(() => { if (!document.hidden && !$('#page-gate-config').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadGateKeys({ preserveInputs: true }).catch(() => {}); }, 5000);
setInterval(() => { if (!document.hidden && !$('#page-agents').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadAgents(); }, 5000);
