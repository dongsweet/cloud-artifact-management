import { renderGatePairing } from './gate-pairing.js?v=20261020-peer-save-feedback';
import { refreshPaginatedTables } from './table-pagination.js?v=20261020-table-pagination';
import { mountArtifactCatalog } from './artifact-catalog.js?v=20261020-shared-artifact-catalog';
import { auditEventsMarkup, mountAuditEvents } from './audit-events.js?v=20261022-audit-permissions';
import { CORE_PAGE_PERMISSIONS, canCorePage, hasCorePermission } from './role-permissions.js?v=20261025-transfer-monitor';
import { renderRoleGroups } from './role-display.js?v=20261022-role-display';
import { mountAaaConfig } from './aaa-config.js?v=20261023-shared-aaa-ui';
import { renderTransferFileTable } from './transfer-file-table.js?v=20261026-transfer-file-table';
import { displayTransferState } from './task-state.js?v=20261027-transfer-state';
let csrf = null;
document.querySelector('#gate-pairing-mount').innerHTML = renderGatePairing('core');
let forcedPasswordChange = false;
let currentUser = null;
let coreRoles = {};
let edgeRoles = {};
let coreUsers = [];
let coreAgents = [];
let coreServiceIdentityState = null;
let distributionTasks = [];
let distributionArtifacts = [];
let transferMonitor = { edgeToCore: [], coreToAgent: [], summary: {} };
let resetUserId = null;
let cloudMappings = null;
let requestPollTimer = null;
let detailPollTimer = null;
let detailPollRequestId = null;
let detailRefreshInFlight = false;
let gatePeerTrusted = false;
const $ = (selector) => document.querySelector(selector);
// Keep task dialogs outside page sections so they remain usable when opened from
// the unified transfer monitor page.
document.querySelector('.app-content .container-fluid')?.append($('#detail'), $('#distribution-detail'));
const pagePermissions = CORE_PAGE_PERMISSIONS;
function canCore(permission) {
  return hasCorePermission(currentUser?.roles ?? [], permission);
}
function applyRoleMenu() {
  document.querySelectorAll('[data-menu-group-item]').forEach((item) => {
    const page = item.querySelector('[data-page]')?.dataset.page;
    item.classList.toggle('d-none', !canCorePage(currentUser?.roles ?? [], page));
  });
  document.querySelectorAll('[data-menu-group]').forEach((header) => {
    const group = header.dataset.menuGroup;
    const items = [...document.querySelectorAll(`[data-menu-group-item="${group}"]`)];
    header.classList.toggle('d-none', !items.some((item) => !item.classList.contains('d-none')));
  });
  $('#distribution-form')?.classList.toggle('d-none', !canCore('businessWrite'));
}
function firstAllowedPage() {
  return Object.keys(pagePermissions).find((page) => canCorePage(currentUser?.roles ?? [], page)) ?? 'requests';
}
let aaaConfigComponent;
function mountAaaConfigPage() {
  const mount = $('#aaa-config-mount');
  if (!mount) return;
  aaaConfigComponent = mountAaaConfig(mount, { request: (path, options) => api(path, options), csrf: () => csrf, csrfHeader: 'x-cam-core-csrf', onMessage: message });
}
mountAaaConfigPage();
function mountAuditPage() {
  const mount = $('#audit-events-mount');
  if (mount) mount.innerHTML = auditEventsMarkup();
}
mountAuditPage();
const loadAuditEvents = mountAuditEvents($('#audit-events-mount'), api, (error) => message(error.message, 'danger'));
$('#login .card-title').textContent = 'CAM Core · 内网发布审批';
$('.sidebar-brand .brand-text').textContent = 'CAM Core';
$('#page-artifacts .card-title').textContent = '正式制品';
$('#page-distribution .card-title').textContent = 'Agent 分发';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
const statusLabels = { CLOUD_PENDING:'待提交云管', CLOUD_SUBMITTED:'云管处理中', APPROVED:'已审批', REJECTED:'已拒绝', CLOUD_STATUS_UNCONFIRMED:'状态未确认', WITHDRAWN:'已撤回', CLOSED:'已关单' };
const submissionStateLabels = { IDLE:'等待提交', QUEUED:'重试已排队', SUBMITTING:'正在提交', RETRY_WAIT:'等待自动重试', SUBMITTED:'已提交' };
function headers(options = {}) { return { ...(options.headers ?? {}), ...(csrf ? { 'x-cam-core-csrf': csrf } : {}) }; }
async function api(path, options = {}) { const response = await fetch(path, { ...options, headers: headers(options) }); const body = await response.json().catch(() => ({})); if (!response.ok) { if (response.status === 401 && path !== '/api/v1/auth/login') showLogin(); throw new Error(body.error?.message ?? `请求失败（${response.status}）`); } return body; }
function clearMessage() { const el = $('#alert'); el.className = 'alert d-none'; el.textContent = ''; }
function showLogin() {
  forcedPasswordChange = false;
  currentUser = null;
  csrf = null;
  document.querySelectorAll('dialog[open]').forEach((dialog) => dialog.close('session-expired'));
  stopDetailPolling();
  document.body.classList.remove('modal-open');
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => backdrop.remove());
  $('#app').classList.add('d-none');
  $('#login').classList.remove('d-none');
  clearMessage();
}
function showPasswordChange(forced) { forcedPasswordChange = forced; $('#password-title').textContent = forced ? '修改初始密码' : '修改密码'; $('#password-help').textContent = forced ? '首次登录必须修改初始密码。' : '修改密码后需要重新登录。'; $('#password-cancel').classList.remove('d-none'); $('#password-error').classList.add('d-none'); const dialog = $('#password-change'); if (!dialog.open) dialog.showModal(); }
function showApp(user) { currentUser = user; forcedPasswordChange = Boolean(user.mustChangePassword); $('#login').classList.add('d-none'); $('#app').classList.remove('d-none'); $('#change-password').classList.toggle('d-none', user.authSource === 'AAA'); clearMessage(); $('#user-label').textContent = `${user.displayName}（${user.username}）`; applyRoleMenu(); if (user.mustChangePassword) showPasswordChange(true); else startRequestPolling(); return user; }
function statusBadge(value) { const kind = value === 'APPROVED' ? 'success' : value === 'REJECTED' ? 'danger' : value === 'WITHDRAWN' ? 'secondary' : 'warning'; return `<span class="badge text-bg-${kind}">${escapeHtml(statusLabels[value] ?? value)}</span>`; }
const cloudStatusLabels = { APPROVED: '审批通过', REJECTED: '已拒绝', PENDING: '审批中', PROCESSING: '处理中', UNKNOWN: '待确认', CLOUD_STATUS_UNCONFIRMED: '待确认' };
function cloudStatusBadge(value, localStatus = null) {
  if (localStatus === 'WITHDRAWN') return '<span class="badge text-bg-secondary">云管：已忽略（本地撤回）</span>';
  if (!value) return '<span class="badge text-bg-secondary">未提交</span>';
  const kind = value === 'APPROVED' ? 'success' : value === 'REJECTED' ? 'danger' : value === 'UNKNOWN' ? 'warning' : 'info';
  return `<span class="badge text-bg-${kind}">云管：${escapeHtml(cloudStatusLabels[value] ?? value)}</span>`;
}
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
  $('#rows').innerHTML = items.length ? items.map((item) => `<tr><td><div class="fw-semibold">${escapeHtml(requestSubject(item))}</div>${item.reportTitle ? `<div class="small text-body-secondary">${escapeHtml(item.reportTitle)}</div>` : '<div class="small text-body-secondary">旧版请求未携带软件版本信息</div>'}</td><td>${statusBadge(item.status)}${item.status === 'CLOUD_PENDING' ? `<div class="small text-body-secondary mt-1">${escapeHtml(submissionStateLabels[item.cloudSubmissionState] ?? '等待提交')}${item.cloudSubmissionAttempts ? ` · 累计 ${item.cloudSubmissionAttempts} 次` : ''}</div>${item.cloudSubmissionState === 'RETRY_WAIT' && item.cloudRetryAt ? `<div class="small text-warning-emphasis mt-1">${escapeHtml(retryCountdown(item.cloudRetryAt))}</div>` : ''}${item.lastError ? `<div class="small text-danger mt-1" title="${escapeHtml(item.lastError)}">最近错误：${escapeHtml(item.lastError.length > 80 ? `${item.lastError.slice(0, 80)}…` : item.lastError)}</div>` : ''}` : ''}</td><td class="font-monospace small" title="${escapeHtml(item.manifestSha256)}">${escapeHtml(item.manifestSha256?.slice(0, 16))}…</td><td>${escapeHtml(displayTime(item.updatedAt))}</td><td class="text-end">${cloudStatusBadge(item.cloudStatus, item.status)}${item.cloudApprovalId ? `<div class="small text-body-secondary font-monospace text-break mt-1">${escapeHtml(item.cloudApprovalId)}</div>` : ''}</td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm detail-button" data-id="${escapeHtml(item.requestId)}">详情</button></div></td></tr>`).join('') : '<tr><td colspan="6" class="text-center text-body-secondary py-4">暂无审批请求</td></tr>';
  document.querySelectorAll('.detail-button').forEach((button) => { button.onclick = () => showDetail(button.dataset.id); });
  refreshPaginatedTables($('#page-requests'));
}
async function load({ quiet = false } = {}) { try { render((await api('/api/v1/approval-requests')).items); if (!quiet) clearMessage(); if ($('#detail').open && $('#detail').dataset.requestId && !detailPollTimer) await showDetail($('#detail').dataset.requestId); } catch (error) { if (!quiet) message(error.message, 'danger'); } }
function startRequestPolling() { if (requestPollTimer) return; requestPollTimer = setInterval(() => { if (!$('#app').classList.contains('d-none') && !$('#page-requests').classList.contains('d-none') && !document.hidden) void load({ quiet: true }); }, 5000); }
function stopDetailPolling() { if (detailPollTimer) clearInterval(detailPollTimer); detailPollTimer = null; detailPollRequestId = null; detailRefreshInFlight = false; }
function startDetailPolling(requestId) {
  detailPollRequestId = requestId;
  if (detailPollTimer) return;
  detailPollTimer = setInterval(() => {
    const dialog = $('#detail');
    if (!dialog.open || !detailPollRequestId || $('#app').classList.contains('d-none') || document.hidden) return;
    if (detailRefreshInFlight) return;
    detailRefreshInFlight = true;
    void showDetail(detailPollRequestId).catch(() => {}).finally(() => { detailRefreshInFlight = false; });
  }, 5000);
}
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
    const coreIdentityState = coreIdentityRotationLabel(agent);
    return `<tr><td><div class="fw-semibold">${escapeHtml(agent.name)}</div><div class="small text-body-secondary font-monospace">Agent 编号：${escapeHtml(agent.agentId)}</div></td><td>${escapeHtml(agent.centerId)}</td><td><span class="badge text-bg-${statusColor}">${statusLabel}</span><div class="small text-${agent.rotationError ? 'danger' : 'body-secondary'} mt-1">${escapeHtml(keyState)}</div>${pending ? '<div class="small text-body-secondary">Agent 使用已配置的 Core 公钥完成签名校验后自动启用。</div>' : ''}${agent.rotationError ? `<div class="small text-danger">${escapeHtml(agent.rotationError)}</div><div class="small text-body-secondary">已尝试 ${agent.rotationAttempts} 次 · ${escapeHtml(displayTime(agent.rotationRetryAt))} 重试</div>` : ''}<div class="small ${coreIdentityState.danger ? 'text-danger' : 'text-body-secondary'} mt-1">${escapeHtml(coreIdentityState.label)}</div>${coreIdentityState.detail ? `<div class="small ${coreIdentityState.danger ? 'text-danger' : 'text-body-secondary'}">${escapeHtml(coreIdentityState.detail)}</div>` : ''}</td><td><div class="small text-body-secondary">身份密钥指纹</div><code class="small d-inline-block text-break" style="max-width:12rem">${escapeHtml(agent.keyId ?? '-')}</code></td><td>${escapeHtml(agent.lastSeenAt ? displayTime(agent.lastSeenAt) : '尚未连接')}</td><td>${escapeHtml(displayTime(agent.nextRotationAt))}<div class="small text-body-secondary">每 ${escapeHtml(agent.rotationDays)} 天 · 过渡 ${escapeHtml(agent.graceHours)} 小时</div></td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm agent-rotation-button" data-id="${escapeHtml(agent.agentId)}" ${active ? '' : 'disabled'}><i class="bi bi-arrow-repeat me-1"></i>身份轮换</button><button class="btn btn-outline-${active || pending ? 'warning' : 'success'} btn-sm agent-status-button" data-id="${escapeHtml(agent.agentId)}" data-status="${active || pending ? 'DISABLED' : 'ACTIVE'}">${active ? '禁用' : pending ? '取消启用' : '启用并验证'}</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无已注册 Agent</td></tr>';
  document.querySelectorAll('.agent-status-button').forEach((button) => { button.onclick = () => updateAgentStatus(button); });
  document.querySelectorAll('.agent-rotation-button').forEach((button) => { button.onclick = () => requestAgentRotation(button.dataset.id, button); });
  refreshPaginatedTables($('#page-agents'));
}
function coreIdentityRotationLabel(agent) {
  if (agent.coreIdentityError) return { label: 'Core 身份确认失败', detail: `${agent.coreIdentityError}${agent.coreIdentityAttempts ? ` · 已尝试 ${agent.coreIdentityAttempts} 次` : ''}${agent.coreIdentityRetryAt ? ` · ${displayTime(agent.coreIdentityRetryAt)} 重试` : ''}`, danger: true };
  const pending = coreServiceIdentityState?.pendingRotation;
  if (pending) return agent.coreIdentityRotationId === pending.rotationId
    ? { label: 'Core 新身份已自动确认', detail: `已确认 ${pending.confirmed}/${pending.total} 个 Agent`, danger: false }
    : { label: '等待 Agent 自动确认 Core 新身份', detail: `已确认 ${pending.confirmed}/${pending.total} 个 Agent`, danger: false };
  return { label: 'Core 身份已同步', detail: '', danger: false };
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
async function loadAgentServiceIdentity() { try { const item = await api('/api/v1/agent-service-identity'); coreServiceIdentityState = item; $('#agent-service-public-key').value = item.publicKey ?? ''; $('#agent-service-fingerprint').textContent = item.fingerprint ? `指纹：${item.fingerprint}` : ''; $('#agent-default-rotation-days').value = item.agentRotationPolicy?.rotationDays ?? 90; $('#agent-default-grace-hours').value = item.agentRotationPolicy?.graceHours ?? 24; const pending = item.pendingRotation; const fileNotice = item.identityFile?.generatedAtStartup ? '警告：Core 启动时未找到身份文件，已生成新身份；已登记 Agent 需要重新配对。请检查 Core 数据目录持久化。' : item.identityFile?.status === 'missing' ? '警告：Core 身份文件缺失。当前进程仍可能使用内存中的身份，但重启后将生成新身份并需要重新配对。' : item.identityFile?.status === 'unreadable' ? '警告：Core 身份文件不可读，无法保证重启后保持当前身份。' : ''; $('#agent-service-rotation-status').textContent = fileNotice || (pending ? `等待 Agent 确认新身份：${pending.confirmed}/${pending.total}；最晚 ${displayTime(pending.activationDeadlineAt)} 启用，逾期未确认的 Agent 将跳过并需重新配对。新指纹：${pending.fingerprint}` : item.lastRotationSkippedAgentCount ? `上次轮换已完成；${item.lastRotationSkippedAgentCount} 个未确认 Agent 已跳过，重新接入需重新配对。旧身份过渡至 ${displayTime(item.previousKeyExpiresAt)}` : item.previousFingerprint ? `上次轮换已完成；旧身份过渡至 ${displayTime(item.previousKeyExpiresAt)}` : 'Core 身份已与所有已注册 Agent 同步'); $('#agent-service-rotation-status').classList.toggle('text-danger', Boolean(fileNotice)); renderAgents(coreAgents); } catch (error) { message(error.message, 'danger'); } }
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
  if (progress.state === 'ready') return '全部文件已校验';
  if (task.status === 'SCHEDULED') return '等待计划开始';
  if (task.lastError && task.retryAt && Date.parse(task.retryAt) > Date.now()) return `等待重试 · ${displayTime(task.retryAt)}`;
  return '等待 Agent 拉取';
}
function distributionDisplayStatus(task) {
  return task.displayStatus ?? displayTransferState(task.status, { controlState: task.controlState, retryAt: task.retryAt, hasError: Boolean(task.lastError) });
}
function renderDistributionTasks() {
  const labels = { SCHEDULED: '待安排', QUEUED: '排队中', RETRY_WAIT: '重试等待', TRANSFERRING: '传输中', VERIFYING: '校验中', WAITING_CONFIRMATION: '等待确认', COMPLETED: '已完成', PAUSE_REQUESTED: '等待暂停', PAUSED: '已暂停', CANCEL_REQUESTED: '等待取消', CANCELLED: '已取消' };
  $('#distribution-rows').innerHTML = distributionTasks.length ? distributionTasks.map((task) => {
    const agent = coreAgents.find((item) => item.agentId === task.agentId);
    const artifact = distributionArtifacts.find((item) => item.artifactId === task.artifactId);
    const displayStatus = distributionDisplayStatus(task);
    const status = labels[displayStatus] ?? displayStatus;
    const color = displayStatus === 'COMPLETED' ? 'success' : ['TRANSFERRING', 'VERIFYING', 'WAITING_CONFIRMATION'].includes(displayStatus) ? 'primary' : displayStatus === 'SCHEDULED' ? 'info' : displayStatus === 'RETRY_WAIT' ? 'danger' : ['PAUSED', 'CANCELLED'].includes(displayStatus) ? 'secondary' : 'warning';
    return `<tr><td><code>${escapeHtml(task.taskId)}</code></td><td>${escapeHtml(agent?.name ?? task.agentId)}</td><td>${escapeHtml(artifact ? `${artifact.productName ?? '历史产品'} · ${artifact.displayVersion ?? artifact.version ?? '未知版本'}` : task.artifactId)}</td><td><span class="badge text-bg-${color}">${escapeHtml(status)}</span>${task.lastError ? `<div class="small text-danger mt-1">${escapeHtml(task.lastError)}</div>` : ''}</td><td>${escapeHtml(displayTime(task.scheduledAt))}</td><td>${escapeHtml(task.chunkConcurrency ?? '-')}</td><td>${escapeHtml(distributionProgress(task))}${task.attempts ? `<div class="small text-body-secondary">失败重试 ${escapeHtml(task.attempts)} 次</div>` : ''}</td><td>${escapeHtml(displayTime(task.updatedAt))}</td><td class="text-end"><button type="button" class="btn btn-outline-primary btn-sm distribution-detail-button" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-eye me-1"></i>详情</button></td></tr>`;
  }).join('') : '<tr><td colspan="9" class="text-center text-body-secondary py-4">暂无传输任务</td></tr>';
  refreshPaginatedTables($('#page-distribution'));
  document.querySelectorAll('.distribution-detail-button').forEach((button) => { button.onclick = () => showDistributionDetail(button.dataset.taskId); });
}
async function loadDistribution() {
  try {
    const [artifacts, agents, tasks] = await Promise.all([api('/api/v1/artifacts'), api('/api/v1/distribution-agents'), api('/api/v1/distribution-tasks')]);
    distributionArtifacts = (artifacts.items ?? []).map((item) => ({ ...item, packageCount: (item.files ?? []).length }));
    coreAgents = agents.items ?? [];
    distributionTasks = tasks.items ?? [];
    renderDistributionOptions(); renderDistributionTasks(); clearMessage();
  } catch (error) { message(error.message, 'danger'); }
}
const monitorStatusLabels = {
  WAITING_AUTHORIZATION: '待安排', WAITING_EDGE: '待安排', EDGE_STARTED: '传输中', WAITING_RECEIPT: '等待确认', RECOVERY_SENDING: '传输中', RETRY_WAIT: '重试等待', NOTIFICATION_RETRY_WAIT: '重试等待', NOTIFICATION_FAILED: '失败', RECEIVING: '传输中', ASSEMBLY_PENDING: '校验中', ASSEMBLING: '校验中', VERIFYING: '校验中', VERIFY_FAILED: '失败', FAILED: '失败', COMPLETED: '已完成',
  SCHEDULED: '待安排', QUEUED: '排队中', TRANSFERRING: '传输中', WAITING_CONFIRMATION: '等待确认', PAUSE_REQUESTED: '等待暂停', PAUSED: '已暂停', CANCEL_REQUESTED: '等待取消', CANCELLED: '已取消'
};
const monitorStatusColors = { WAITING_AUTHORIZATION: 'secondary', WAITING_EDGE: 'secondary', EDGE_STARTED: 'primary', WAITING_RECEIPT: 'primary', RECOVERY_SENDING: 'primary', RETRY_WAIT: 'warning', NOTIFICATION_RETRY_WAIT: 'warning', NOTIFICATION_FAILED: 'danger', RECEIVING: 'primary', ASSEMBLY_PENDING: 'info', ASSEMBLING: 'info', VERIFYING: 'info', VERIFY_FAILED: 'danger', FAILED: 'danger', COMPLETED: 'success', SCHEDULED: 'info', QUEUED: 'warning', TRANSFERRING: 'primary', WAITING_CONFIRMATION: 'primary', PAUSE_REQUESTED: 'warning', PAUSED: 'secondary', CANCEL_REQUESTED: 'danger', CANCELLED: 'secondary' };
function monitorStatusBadge(status) { return `<span class="badge text-bg-${monitorStatusColors[status] ?? 'secondary'}">${escapeHtml(monitorStatusLabels[status] ?? status ?? '-')}</span>`; }
function monitorProgressText(summary) {
  if (!summary) return '-';
  const files = `${summary.completedFiles ?? 0} / ${summary.fileCount ?? 0} 个文件`;
  const bytes = `${formatTransferBytes(summary.receivedBytes ?? summary.completedBytes ?? 0)} / ${formatTransferBytes(summary.totalBytes ?? 0)}`;
  return `${files}<div class="small text-body-secondary">${escapeHtml(bytes)}</div>`;
}
function renderTransferMonitor(data) {
  transferMonitor = data ?? { edgeToCore: [], coreToAgent: [], summary: {} };
  const canControl = canCore('businessWrite');
  const edgeItems = transferMonitor.edgeToCore ?? [];
  const agentItems = transferMonitor.coreToAgent ?? [];
  const edgeSummary = transferMonitor.summary?.edgeToCore ?? {};
  const agentSummary = transferMonitor.summary?.coreToAgent ?? {};
  const stats = [
    ['Edge → Core 接收中', edgeSummary.transferring ?? 0, 'primary'], ['Edge → Core 恢复中', edgeSummary.recovering ?? 0, 'info'], ['Edge → Core 重试等待', edgeSummary.retry ?? 0, 'danger'], ['Edge → Core 已完成', edgeSummary.completed ?? 0, 'success'],
    ['Core → Agent 排队', (agentSummary.scheduled ?? 0) + (agentSummary.queued ?? 0), 'warning'], ['Core → Agent 传输中', agentSummary.transferring ?? 0, 'primary'], ['Core → Agent 重试', agentSummary.retry ?? 0, 'danger'], ['Core → Agent 暂停', agentSummary.paused ?? 0, 'secondary'], ['Core → Agent 已取消', agentSummary.cancelled ?? 0, 'secondary'], ['Core → Agent 已完成', agentSummary.completed ?? 0, 'success']
  ];
  $('#transfer-monitor-summary').innerHTML = stats.map(([label, value, color]) => `<div class="col-6 col-md"><div class="border rounded p-2 h-100"><div class="small text-body-secondary">${escapeHtml(label)}</div><div class="h5 mb-0 mt-1 text-${color}">${escapeHtml(value)}</div></div></div>`).join('');
  $('#monitor-edge-rows').innerHTML = edgeItems.length ? edgeItems.map((item) => {
    const recoverable = item.status === 'RETRY_WAIT' && item.requestId;
    const fallbackRecoverable = item.status === 'FAILED' && item.terminal && item.requestId;
    const notificationRetryable = item.status === 'NOTIFICATION_FAILED' && item.requestId;
    const version = item.productName ? `${item.productName} · ${item.displayVersion ?? item.version ?? '未知版本'}` : '历史申请';
    const round = item.roundNo ? `第 ${item.roundNo} 轮` : '-';
    const deadline = item.status === 'WAITING_EDGE' ? item.startDeadlineAt : item.idleDeadlineAt;
    const recovery = Number(item.recoveryAttempts ?? 0) > 0 ? `<div class="small text-body-secondary">协调恢复 ${escapeHtml(item.recoveryAttempts)}${item.recoveryLimit ? ` / ${escapeHtml(item.recoveryLimit)}` : ''} 次</div>` : '';
    return `<tr><td><div class="fw-semibold">${escapeHtml(version)}</div><div class="small text-body-secondary font-monospace">${escapeHtml(item.requestId)}</div></td><td>${escapeHtml(round)}<div class="small text-body-secondary font-monospace">${escapeHtml(item.roundId ?? '-')}</div></td><td><code>${escapeHtml(item.transferTaskId ?? '-')}</code></td><td>${monitorStatusBadge(item.displayStatus ?? item.status)}${deadline ? `<div class="small text-body-secondary mt-1">${item.status === 'WAITING_EDGE' ? '开始截止' : '空闲截止'}：${escapeHtml(displayTime(deadline))}</div>` : ''}${item.lastActivityAt ? `<div class="small text-body-secondary">最后活动：${escapeHtml(displayTime(item.lastActivityAt))}</div>` : ''}</td><td>${monitorProgressText(item.summary)}</td><td>${escapeHtml(item.attempts ?? 0)}${recovery}${item.retryAt ? `<div class="small text-warning-emphasis">${escapeHtml(displayTime(item.retryAt))}</div>` : ''}</td><td>${item.lastError ? `<span class="small text-danger" title="${escapeHtml(item.lastError)}">${escapeHtml(item.lastError.length > 80 ? `${item.lastError.slice(0, 80)}…` : item.lastError)}</span>` : '-'}</td><td>${escapeHtml(displayTime(item.updatedAt))}</td><td class="cam-actions-cell"><div class="cam-action-buttons"><button type="button" class="btn btn-outline-primary btn-sm monitor-edge-detail" data-request-id="${escapeHtml(item.requestId)}"><i class="bi bi-eye me-1"></i>详情</button>${canControl && notificationRetryable ? `<button type="button" class="btn btn-outline-danger btn-sm monitor-edge-notification-retry" data-request-id="${escapeHtml(item.requestId)}"><i class="bi bi-send me-1"></i>重新通知 Edge</button>` : ''}${canControl && recoverable ? `<button type="button" class="btn btn-outline-warning btn-sm monitor-edge-retry" data-request-id="${escapeHtml(item.requestId)}"><i class="bi bi-arrow-repeat me-1"></i>立即恢复</button>` : ''}${canControl && fallbackRecoverable ? `<button type="button" class="btn btn-outline-warning btn-sm monitor-edge-fallback" data-request-id="${escapeHtml(item.requestId)}"><i class="bi bi-arrow-repeat me-1"></i>重试 Edge → Core 传输</button>` : ''}</div></td></tr>`;
  }).join('') : '<tr><td colspan="9" class="text-center text-body-secondary py-4">暂无 Edge → Core 传输任务</td></tr>';
  $('#monitor-agent-rows').innerHTML = agentItems.length ? agentItems.map((task) => {
    const retryable = task.displayStatus === 'RETRY_WAIT' || (task.displayStatus === 'QUEUED' && task.lastError);
    const version = task.productName ? `${task.productName} · ${task.displayVersion ?? task.version ?? '未知版本'}` : task.artifactId;
    const progress = task.progress ?? {};
    const completedFiles = progress.completedFiles ?? 0;
    const totalFiles = task.fileCount ?? task.files?.length ?? 0;
    const totalBytes = task.totalBytes ?? 0;
    const completedBytes = task.completedBytes ?? progress.bytesDownloaded ?? 0;
    const progressText = `${completedFiles} / ${totalFiles} 个文件<div class="small text-body-secondary">${escapeHtml(formatTransferBytes(completedBytes))} / ${escapeHtml(formatTransferBytes(totalBytes))}</div>`;
    const stateControl = !canControl ? '' : task.displayStatus === 'PAUSED' ? `<button type="button" class="btn btn-outline-primary btn-sm monitor-agent-control" data-action="resume" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-play me-1"></i>继续</button>` : ['SCHEDULED', 'QUEUED', 'TRANSFERRING', 'RETRY_WAIT', 'PAUSE_REQUESTED'].includes(task.displayStatus) ? `<button type="button" class="btn btn-outline-warning btn-sm monitor-agent-control" data-action="pause" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-pause me-1"></i>暂停</button><button type="button" class="btn btn-outline-danger btn-sm monitor-agent-control" data-action="cancel" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-x-circle me-1"></i>取消</button>` : '';
    return `<tr><td><div class="fw-semibold">${escapeHtml(task.agentName ?? task.agentId)}</div><div class="small text-body-secondary">${escapeHtml(task.centerId ?? task.agentId)}</div></td><td>${escapeHtml(version)}${task.roundNo ? `<div class="small text-body-secondary">第 ${escapeHtml(task.roundNo)} 轮</div>` : ''}</td><td><code>${escapeHtml(task.taskId)}</code></td><td>${monitorStatusBadge(task.displayStatus)}</td><td>${progressText}</td><td>${escapeHtml(task.chunkConcurrency ?? '-')}</td><td>${escapeHtml(task.attempts ?? 0)}${task.retryAt && task.displayStatus === 'RETRY_WAIT' ? `<div class="small text-warning-emphasis">${escapeHtml(displayTime(task.retryAt))}</div>` : ''}</td><td>${task.lastError ? `<span class="small text-danger" title="${escapeHtml(task.lastError)}">${escapeHtml(task.lastError.length > 80 ? `${task.lastError.slice(0, 80)}…` : task.lastError)}</span>` : '-'}</td><td class="cam-actions-cell"><div class="cam-action-buttons"><button type="button" class="btn btn-outline-primary btn-sm monitor-agent-detail" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-eye me-1"></i>详情</button>${canControl && task.displayStatus === 'SCHEDULED' ? `<button type="button" class="btn btn-outline-primary btn-sm monitor-agent-start" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-play me-1"></i>立即开始</button>` : ''}${canControl && retryable ? `<button type="button" class="btn btn-outline-warning btn-sm monitor-agent-retry" data-task-id="${escapeHtml(task.taskId)}"><i class="bi bi-arrow-repeat me-1"></i>重试</button>` : ''}${stateControl}</div></td></tr>`;
  }).join('') : '<tr><td colspan="9" class="text-center text-body-secondary py-4">暂无 Core → Agent 传输任务</td></tr>';
  refreshPaginatedTables($('#page-transfer-monitor'));
  document.querySelectorAll('.monitor-edge-detail').forEach((button) => { button.onclick = () => showDetail(button.dataset.requestId); });
  document.querySelectorAll('.monitor-agent-detail').forEach((button) => { button.onclick = () => showDistributionDetail(button.dataset.taskId); });
  document.querySelectorAll('.monitor-edge-retry').forEach((button) => { button.onclick = () => retryEdgeTransfer(button.dataset.requestId, button); });
  document.querySelectorAll('.monitor-edge-fallback').forEach((button) => { button.onclick = () => retryEdgeTransfer(button.dataset.requestId, button, { fallback: true }); });
  document.querySelectorAll('.monitor-edge-notification-retry').forEach((button) => { button.onclick = () => retryEdgeNotification(button.dataset.requestId, button); });
  document.querySelectorAll('.monitor-agent-start').forEach((button) => { button.onclick = () => controlDistributionTask(button.dataset.taskId, 'start', button); });
  document.querySelectorAll('.monitor-agent-retry').forEach((button) => { button.onclick = () => controlDistributionTask(button.dataset.taskId, 'retry', button); });
  document.querySelectorAll('.monitor-agent-control').forEach((button) => { button.onclick = () => controlDistributionState(button.dataset.taskId, button.dataset.action, button); });
}
async function loadTransferMonitor() {
  try { renderTransferMonitor(await api('/api/v1/transfer-monitor')); clearMessage(); }
  catch (error) { message(error.message, 'danger'); }
}
async function retryEdgeTransfer(requestId, button, { fallback = false } = {}) {
  if (fallback && !await confirmDialog({ title: '重试 Edge → Core 传输', text: '自动恢复次数已用尽。请先确认 Edge、网闸和存储故障已修复；本次重试会保留已接收分块和已入库制品。确认继续吗？', confirmLabel: '重试', confirmClass: 'btn-warning' })) return;
  button.disabled = true;
  try {
    const result = await api(`/api/v1/approval-requests/${encodeURIComponent(requestId)}/transfer/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fallback }) });
    await loadTransferMonitor();
    message(result.idempotent ? '恢复命令已在发送或 Edge 已在处理该任务' : fallback ? '已发起重试，正在等待 Edge 确认' : '已向 Edge 下发恢复指令，正在等待确认');
  } catch (error) { message(error.message, 'danger'); button.disabled = false; }
}
async function retryEdgeNotification(requestId, button) {
  button.disabled = true;
  try {
    await api(`/api/v1/approval-requests/${encodeURIComponent(requestId)}/transfer/notification-retry`, { method: 'POST', body: '{}' });
    await loadTransferMonitor();
    message('已重新通知 Edge 接收传输任务');
  } catch (error) { message(error.message, 'danger'); button.disabled = false; }
}
async function controlDistributionTask(taskId, action, button) {
  button.disabled = true;
  try {
    await api(`/api/v1/distribution-tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST', body: '{}' });
    await loadTransferMonitor();
    await loadDistribution();
    message(action === 'start' ? '已将任务放入可领取队列' : '已将任务立即放回重试队列');
  } catch (error) { message(error.message, 'danger'); button.disabled = false; }
}
async function controlDistributionState(taskId, action, button) {
  if (action === 'cancel' && !await confirmDialog({ title: '取消传输任务', text: '取消后任务将停止领取，已完成的文件会保留，但任务不能继续或重试。确认取消吗？', confirmLabel: '取消任务', confirmClass: 'btn-danger' })) return;
  button.disabled = true;
  try {
    await api(`/api/v1/distribution-tasks/${encodeURIComponent(taskId)}/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) });
    await loadTransferMonitor();
    message(action === 'pause' ? '已请求暂停任务' : action === 'resume' ? '任务已继续排队' : '已请求取消任务');
  }
  catch (error) { message(error.message, 'danger'); button.disabled = false; }
}
async function createDistributionTask(event) {
  event.preventDefault();
  const button = event.submitter; button.disabled = true; $('#distribution-error').classList.add('d-none');
  try {
    const startAt = $('#distribution-start-at').value ? new Date($('#distribution-start-at').value).toISOString() : null;
    await api('/api/v1/distribution-tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ artifactId: $('#distribution-artifact').value, agentId: $('#distribution-agent').value, scheduledAt: startAt, chunkConcurrency: Number($('#distribution-concurrency').value) }) });
    message(startAt ? '传输计划已创建，Agent 将在计划时间自动开始' : '传输计划已创建，目标 Agent 将自动开始'); $('#distribution-form').reset(); $('#distribution-concurrency').value = 4; await loadDistribution();
  }
  catch (error) { $('#distribution-error').textContent = error.message; $('#distribution-error').classList.remove('d-none'); }
  finally { button.disabled = false; }
}
async function showDistributionDetail(taskId) {
  try {
    const task = (await api(`/api/v1/distribution-tasks/${encodeURIComponent(taskId)}`)).item;
    const artifact = distributionArtifacts.find((item) => item.artifactId === task.artifactId);
    const agent = coreAgents.find((item) => item.agentId === task.agentId);
    const labels = { SCHEDULED: '待安排', QUEUED: '排队中', RETRY_WAIT: '重试等待', TRANSFERRING: '传输中', VERIFYING: '校验中', WAITING_CONFIRMATION: '等待确认', COMPLETED: '已完成', PAUSE_REQUESTED: '等待暂停', PAUSED: '已暂停', CANCEL_REQUESTED: '等待取消', CANCELLED: '已取消' };
    const displayStatus = distributionDisplayStatus(task);
    $('#distribution-detail-title').textContent = artifact ? `${artifact.productName ?? '历史产品'} · ${artifact.displayVersion ?? artifact.version ?? '未知版本'}` : task.artifactId;
    const progress = task.progress ?? {};
    const detailFiles = (task.files ?? []).map((file) => {
      const current = progress.sha256 === file.sha256;
      const completed = displayStatus === 'COMPLETED' || progress.state === 'ready';
      return { ...file, status: completed ? 'COMPLETED' : current ? 'TRANSFERRING' : 'WAITING', completedParts: current ? progress.completedParts : null, totalParts: current ? progress.totalParts : null, bytesDownloaded: completed ? Number(file.sizeBytes ?? 0) : current ? Number(progress.bytesDownloaded ?? 0) : 0 };
    });
    const distributionFileProgress = (file) => {
      const bytes = `${escapeHtml(formatTransferBytes(file.bytesDownloaded))} / ${escapeHtml(formatTransferBytes(file.sizeBytes))}`;
      if (file.status === 'COMPLETED') return bytes;
      const totalParts = Number(file.totalParts);
      const completedParts = Number(file.completedParts);
      const chunks = Number.isInteger(totalParts) && totalParts > 0
        ? `${escapeHtml(Number.isInteger(completedParts) && completedParts >= 0 ? completedParts : 0)} / ${escapeHtml(totalParts)} 个分块`
        : '尚未开始';
      return `${chunks}<div>${bytes}</div>`;
    };
    const fileTable = renderTransferFileTable(detailFiles, { escapeHtml, formatBytes: formatTransferBytes, statusFor: (file) => file.status === 'COMPLETED' ? { label: file.reused ? '已完成（复用）' : '已完成', color: 'success' } : file.status === 'TRANSFERRING' ? { label: '传输中', color: 'primary' } : { label: '待传输', color: 'secondary' }, progressFor: distributionFileProgress });
    const statusColor = displayStatus === 'COMPLETED' ? 'success' : ['TRANSFERRING', 'VERIFYING', 'WAITING_CONFIRMATION'].includes(displayStatus) ? 'primary' : displayStatus === 'SCHEDULED' ? 'info' : displayStatus === 'RETRY_WAIT' ? 'warning' : ['PAUSED', 'CANCELLED'].includes(displayStatus) ? 'secondary' : 'warning';
    $('#distribution-detail-content').innerHTML = `<div class="row g-2 mb-3"><div class="col-md-4"><div class="small text-body-secondary">传输任务编号</div><code>${escapeHtml(task.taskId)}</code></div><div class="col-md-4"><div class="small text-body-secondary">目标 Agent</div><span>${escapeHtml(agent?.name ?? task.agentId)}</span></div><div class="col-md-4"><div class="small text-body-secondary">状态</div><span class="badge text-bg-${statusColor}">${escapeHtml(labels[displayStatus] ?? displayStatus)}</span></div><div class="col-md-4"><div class="small text-body-secondary">计划开始</div><span>${escapeHtml(displayTime(task.scheduledAt))}</span></div><div class="col-md-4"><div class="small text-body-secondary">单文件并发</div><span>${escapeHtml(task.chunkConcurrency ?? '-')} 线程</span></div><div class="col-md-4"><div class="small text-body-secondary">尝试次数</div><span>${escapeHtml(task.attempts ?? 0)}</span></div></div>${task.lastError ? `<div class="alert alert-danger">${escapeHtml(task.lastError)}</div>` : ''}<div class="small text-body-secondary mb-2">${escapeHtml(distributionProgress(task))}</div>${fileTable}`;
    $('#distribution-detail').showModal();
  } catch (error) { message(error.message, 'danger'); }
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
function formatTransferBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
function transferProgressLabel(status) {
  return { WAITING_AUTHORIZATION: '等待 Core 授权', WAITING_EDGE: '等待 Edge 开始传输', EDGE_STARTED: 'Edge 已开始，等待首个分块', WAITING_RECEIPT: '等待 Core 回执确认', RECOVERY_SENDING: '正在向 Edge 发送恢复命令', RETRY_WAIT: '等待协调恢复', NOTIFICATION_RETRY_WAIT: '等待重新通知 Edge', NOTIFICATION_FAILED: 'Edge 任务通知失败', FAILED: '传输失败', RECEIVING: 'Edge → Core 接收中', ASSEMBLY_PENDING: '已收齐，准备组装', ASSEMBLING: '组装中', VERIFYING: '校验并准备回执', VERIFY_FAILED: '校验不通过', COMPLETED: '已完成' }[status] ?? status ?? '未开始';
}
function transferProgressColor(status) {
  return status === 'COMPLETED' ? 'success' : status === 'FAILED' || status === 'VERIFY_FAILED' || status === 'NOTIFICATION_FAILED' ? 'danger' : status === 'RETRY_WAIT' || status === 'NOTIFICATION_RETRY_WAIT' || status === 'WAITING_EDGE' || status === 'ASSEMBLY_PENDING' ? 'warning' : status === 'RECOVERY_SENDING' ? 'info' : ['EDGE_STARTED', 'WAITING_RECEIPT', 'RECEIVING', 'ASSEMBLING', 'VERIFYING'].includes(status) ? 'primary' : 'secondary';
}
function transferFailureCodeLabel(code) {
  return ({ '23': '请求超时', ETIMEDOUT: '请求超时', TimeoutError: '请求超时', ECONNABORTED: '请求被中止', edge_start_timeout: '等待 Edge 开始传输超时', edge_idle_timeout: '传输空闲超时', edge_recovery_dispatch_failed: '恢复指令未送达 Edge', artifacts_incomplete: '正式制品未全部入库' })[String(code)] ?? String(code);
}
function edgeControlStateLabel(status) {
  return {
    ACCEPTED: '已接单，等待开始', STARTED: '已开始，等待首个分块', RECEIVING: '正在发送',
    WAITING_RECEIPT: '等待回执确认', RETRY_WAIT: '等待协调恢复', RECOVERY_SENDING: 'Core 正在请求恢复',
    FAILED: '已停止', RECEIVED: '已完成'
  }[status] ?? (status || '尚未接单');
}
const coreTransferFileStatus = {
  COMPLETED: { label: '已入库', color: 'success' }, ASSEMBLY_PENDING: { label: '已收齐，准备组装', color: 'warning' },
  ASSEMBLING: { label: '组装中', color: 'info' }, VERIFYING: { label: '校验中', color: 'info' },
  VERIFY_FAILED: { label: '校验不通过', color: 'danger' }, RECEIVING: { label: '接收中', color: 'primary' }, WAITING: { label: '待接收', color: 'secondary' }
};
function coreTransferFileProgress(file) {
  const bytes = `${escapeHtml(formatTransferBytes(file.receivedBytes))} / ${escapeHtml(formatTransferBytes(file.sizeBytes))}`;
  if (file.status === 'COMPLETED') return bytes;
  const chunks = file.status === 'ASSEMBLING'
    ? `${escapeHtml(file.assemblyParts ?? 0)} / ${escapeHtml(file.chunkCount ?? 0)} 个分块`
    : file.chunkCount ? `${escapeHtml(file.receivedParts)} / ${escapeHtml(file.chunkCount)} 个分块` : (file.stored ? '完整文件' : '尚未开始');
  const note = file.status === 'ASSEMBLY_PENDING' ? '分块已齐，等待 Core 组装' : file.status === 'VERIFYING' ? '完整文件已组装，正在校验' : '';
  return `${chunks}<div>${bytes}</div>${note ? `<div class="text-warning-emphasis">${escapeHtml(note)}</div>` : ''}`;
}
function transferProgressMarkup(progress) {
  if (!progress) return '<div class="text-body-secondary">暂无传输进度数据</div>';
  const summary = progress.summary ?? {};
  const percent = Number(summary.percent ?? 0);
  const files = progress.files ?? [];
  const notification = progress.notification ?? {};
  const notificationText = notification.state === 'DELIVERED' ? 'Edge 已确认接收传输任务' : notification.state === 'RETRY_WAIT' ? `Edge 通知等待重试${notification.lastError ? `：${notification.lastError}` : ''}` : notification.state === 'SENDING' ? '正在通知 Edge' : progress.transferTaskId ? '等待通知 Edge' : '尚未创建传输任务';
  const edge = progress.edge ?? {};
  const edgeState = edgeControlStateLabel(edge.status);
  const edgeDeadline = edge.status === 'ACCEPTED' ? edge.startDeadlineAt : edge.idleDeadlineAt;
  const edgeDeadlineLabel = edge.status === 'ACCEPTED' ? '等待开始截止' : '空闲截止';
  const edgeControlDetails = edge.status ? `<div class="small text-body-secondary mt-2"><span>Edge 控制状态：${escapeHtml(edgeState)}</span>${edge.lastActivityAt ? ` <span class="ms-2">最后活动：${escapeHtml(displayTime(edge.lastActivityAt))}</span>` : ''}${edgeDeadline ? ` <span class="ms-2">${edgeDeadlineLabel}：${escapeHtml(displayTime(edgeDeadline))}</span>` : ''}${Number(edge.recoveryAttempts ?? 0) > 0 ? ` <span class="ms-2">协调恢复：${escapeHtml(edge.recoveryAttempts)} 次</span>` : ''}</div>` : '';
  const edgeFailure = progress.edgeFailure;
  const failureState = edgeFailure?.terminal ? '，自动重试已停止，可由操作员手动重试' : edgeFailure?.status === 'RECOVERY_SENDING' ? '，Core 正在向 Edge 发送重试指令' : edgeFailure?.status === 'RETRY_WAIT' ? '，Core 已安排自动重试，等待下一次尝试' : edgeFailure ? '，已记录最近失败原因，等待 Edge 继续传输' : '';
  const failurePanel = edgeFailure ? `<div class="alert alert-danger py-2 mt-2 mb-0"><div><strong>Edge 传输异常${edgeFailure.code ? `（${escapeHtml(transferFailureCodeLabel(edgeFailure.code))}）` : ''}</strong>${failureState}</div><div class="text-break mt-1">${escapeHtml(edgeFailure.message)}</div><div class="small mt-1">Edge 已尝试 ${escapeHtml(edgeFailure.attempts ?? 0)} 次${Number(edgeFailure.recoveryAttempts ?? 0) > 0 ? `；协调恢复 ${escapeHtml(edgeFailure.recoveryAttempts)}${edgeFailure.recoveryLimit ? ` / ${escapeHtml(edgeFailure.recoveryLimit)}` : ''} 次` : ''}${edgeFailure.retryAt ? `；下次自动恢复：${escapeHtml(displayTime(edgeFailure.retryAt))}` : ''}</div></div>` : '';
  const storedGap = Number(summary.receivedBytes ?? 0) > Number(summary.storedBytes ?? 0);
  const storageHint = storedGap ? `<div class="small text-body-secondary mt-2"><i class="bi bi-info-circle me-1"></i>分块已接收 ${escapeHtml(formatTransferBytes(summary.receivedBytes))}，其中 ${escapeHtml(formatTransferBytes(summary.storedBytes))} 已完成组装、校验并入库；其余文件正在组装或等待校验。</div>` : '';
  const fileTable = renderTransferFileTable(files, { escapeHtml, formatBytes: formatTransferBytes, statusFor: (file) => coreTransferFileStatus[file.status] ?? { label: file.status ?? '-', color: 'secondary' }, progressFor: coreTransferFileProgress, emptyLabel: 'Edge 尚未同步正式制品清单' });
  return `<div class="cam-transfer-progress-summary"><div class="cam-transfer-progress-stat"><span>已入库文件</span><strong>${escapeHtml(summary.completedFiles ?? 0)} / ${escapeHtml(summary.fileCount ?? 0)}</strong></div><div class="cam-transfer-progress-stat"><span>已接收字节</span><strong>${escapeHtml(formatTransferBytes(summary.receivedBytes))} / ${escapeHtml(formatTransferBytes(summary.totalBytes))}</strong></div><div class="cam-transfer-progress-stat"><span>验证报告</span><strong>${progress.report?.received ? '已接收' : '待接收'}</strong></div><div class="cam-transfer-progress-stat"><span>Edge 控制状态</span><strong>${escapeHtml(edgeState)}</strong></div></div><div class="progress cam-transfer-progress-bar" role="progressbar" aria-label="Edge 到 Core 制品入库进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar progress-bar-striped ${['RECEIVING', 'ASSEMBLY_PENDING', 'ASSEMBLING', 'VERIFYING'].includes(progress.status) ? 'progress-bar-animated' : ''}" style="width:${percent}%">${percent}%</div></div>${storageHint}${edgeControlDetails}<div class="d-flex justify-content-between align-items-center small text-body-secondary mt-2"><span><span class="badge text-bg-${transferProgressColor(progress.status)}">${escapeHtml(transferProgressLabel(progress.status))}</span>${progress.transferTaskId ? ` <code>${escapeHtml(progress.transferTaskId)}</code>` : ''}</span><span>${escapeHtml(progress.updatedAt ? displayTime(progress.updatedAt) : '-')}</span></div><div class="small text-body-secondary mt-1">任务通知：${escapeHtml(notificationText)}</div>${failurePanel}<details class="cam-transfer-files" data-detail-key="transfer-files"><summary><i class="bi bi-chevron-right me-2"></i>文件与分块明细</summary>${fileTable}</details>`;
}
async function showDetail(id) {
  const encodedId = encodeURIComponent(id);
  const [{ item }, transferResult] = await Promise.all([
    api(`/api/v1/approval-requests/${encodedId}`),
    api(`/api/v1/approval-requests/${encodedId}/transfer-progress`).catch(() => ({ item: null }))
  ]);
  const transferProgress = transferResult?.item ?? null;
  const dialog = $('#detail');
  const openDetailSections = new Set([...dialog.querySelectorAll('details[data-detail-key]')].filter((section) => section.open).map((section) => section.dataset.detailKey));
  dialog.dataset.requestId = id;
  $('#detail .card-title').textContent = requestSubject(item);
  const cloudKicker = item.status === 'WITHDRAWN' ? '云管：已忽略（本地撤回）' : (cloudStatusLabels[item.cloudStatus] ? `云管：${cloudStatusLabels[item.cloudStatus]}` : '云管：未提交');
  $('#detail-kicker').innerHTML = `固化申请详情 <span class="badge text-bg-${item.status === 'WITHDRAWN' ? 'secondary' : item.cloudStatus === 'APPROVED' ? 'success' : item.cloudStatus === 'REJECTED' ? 'danger' : 'warning'} ms-2">${escapeHtml(cloudKicker)}</span><span class="badge text-bg-${item.status === 'WITHDRAWN' ? 'secondary' : item.status === 'APPROVED' ? 'success' : item.status === 'REJECTED' ? 'danger' : 'warning'} ms-2">${escapeHtml(statusLabels[item.status] ?? item.status)}</span>`;
  $('#detail-request-id').textContent = item.requestId ?? '';
  const cloudRetryStatus = item.status === 'CLOUD_PENDING'
    ? `${submissionStateLabels[item.cloudSubmissionState] ?? '等待提交'}（累计 ${item.cloudSubmissionAttempts ?? 0} 次）`
    : '-';
  const detailField = (label, value, { mono = false, wide = false } = {}) => `<div class="cam-detail-field${wide ? ' cam-detail-field-wide' : ''}"><div class="cam-detail-label">${escapeHtml(label)}</div><div class="cam-detail-value${mono ? ' font-monospace' : ''}">${value}</div></div>`;
  const textField = (label, value, options) => detailField(label, escapeHtml(value ?? '-'), options);
  const reportLink = item.reportReceived
    ? `<a href="/api/v1/approval-requests/${encodeURIComponent(id)}/report-file" target="_blank" rel="noopener">${escapeHtml(item.reportFileName ?? '下载验证报告')} <i class="bi bi-download ms-1"></i></a>`
    : escapeHtml(item.reportFileName ? `${item.reportFileName}（待接收）` : '暂无报告文件');
  const retryPanel = item.status === 'WITHDRAWN'
    ? '<div class="cam-retry-panel cam-retry-panel-muted">已撤回；Core 不再提交或查询云管流程，云管侧原流程不作处理。</div>'
    : item.status === 'CLOUD_PENDING'
    ? `<div class="cam-retry-panel"><div><span class="fw-semibold">${escapeHtml(cloudRetryStatus)}</span>${item.cloudSubmissionAttemptedAt ? `<span class="small text-body-secondary ms-2">最近尝试：${escapeHtml(displayTime(item.cloudSubmissionAttemptedAt))}</span>` : ''}</div>${item.cloudRetryAt ? `<div class="small text-warning-emphasis mt-1"><i class="bi bi-clock me-1"></i>${escapeHtml(retryCountdown(item.cloudRetryAt))} · ${escapeHtml(displayTime(item.cloudRetryAt))}</div>` : ''}${item.lastError ? `<div class="small text-danger mt-2"><i class="bi bi-exclamation-circle me-1"></i>${escapeHtml(item.lastError)}</div>` : ''}</div>`
    : `<div class="cam-retry-panel cam-retry-panel-muted">${escapeHtml(item.cloudApprovalId ? '云管工单已提交' : (statusLabels[item.status] ?? item.status))}${item.cloudWorkflowStep ? ` · 云管环节：${escapeHtml(item.cloudWorkflowStep)}` : ''}${item.lastError ? `<div class="small text-danger mt-2"><i class="bi bi-exclamation-circle me-1"></i>${escapeHtml(item.lastError)}</div>` : ''}</div>`;
  const transferLabel = item.status === 'WITHDRAWN'
    ? '申请已撤回，不进入制品传输'
    : item.transferStatus === 'RECEIVED'
    ? '传输完成，Core 已收到回执'
    : item.transferTaskId
      ? '已准备传输，等待网闸传输并回执'
      : item.status === 'APPROVED'
        ? (item.cloudTransferTaskId ? '审批已通过，待准备传输' : '审批已通过，等待云管返回传输任务')
        : '审批通过后可准备传输';
  const notificationFailed = ['SENDING', 'RETRY_WAIT', 'FAILED'].includes(item.transferNotificationState);
  const transferPanel = `<div class="cam-transfer-state"><span class="badge text-bg-${item.transferStatus === 'RECEIVED' ? 'success' : item.transferTaskId ? 'primary' : item.status === 'APPROVED' ? 'warning' : 'secondary'}">${escapeHtml(transferLabel)}</span>${item.transferTaskId && item.transferNotificationAttempts ? `<div class="small text-body-secondary mt-1">授权通知 Edge：${item.transferNotificationState === 'DELIVERED' ? '已送达' : item.transferNotificationState === 'RETRY_WAIT' ? '等待自动重试' : item.transferNotificationState === 'FAILED' ? '已停止自动重试' : item.transferNotificationState === 'SENDING' ? '发送中' : '准备中'} · 已尝试 ${item.transferNotificationAttempts} 次</div>` : ''}${notificationFailed && item.transferNotificationLastError ? `<div class="small text-danger mt-1">${escapeHtml(item.transferNotificationLastError)}</div>` : ''}${item.transferStatus === 'RECEIVED' && item.updatedAt ? `<div class="small text-body-secondary mt-1">最近更新：${escapeHtml(displayTime(item.updatedAt))}</div>` : ''}${item.status === 'APPROVED' && !item.transferTaskId ? '<div class="small text-body-secondary mt-1">准备动作会绑定云管审批返回的任务编号和已批准清单，不会修改制品内容。</div>' : ''}</div>`;
  const transferProgressPanel = transferProgressMarkup(transferProgress);
  const cloudApprovalPanel = `<div class="cam-status-panel">${item.cloudApprovalId ? `<div class="small text-body-secondary font-monospace text-break">${escapeHtml(item.cloudApprovalId)}</div>` : '<div class="small text-body-secondary">尚未创建云管工单</div>'}${item.cloudWorkflowStep ? `<div class="small text-body-secondary mt-1">当前环节：${escapeHtml(item.cloudWorkflowStep)}</div>` : ''}<div class="small mt-1">${item.cloudResponseSummary ? escapeHtml(item.cloudResponseSummary) : '<span class="text-body-secondary">尚未返回处理意见</span>'}</div></div>`;
  const reportPanel = `<div>${reportLink}</div><div class="small text-body-secondary mt-1">${item.reportReceived ? 'Core 已校验' : '待从 Edge 接收'}</div>`;
  const versionPanel = `<div>${escapeHtml(item.displayVersion ?? item.version ?? '-')}<div class="small text-body-secondary font-monospace mt-1">${escapeHtml(item.releaseId ?? '-')}</div></div>`;
  const roundPanel = `<div>${escapeHtml(item.roundNo ? `第 ${item.roundNo} 轮` : '-')}<div class="small text-body-secondary font-monospace mt-1">${escapeHtml(item.roundId ?? '-')}</div></div>`;
  const submitterLabel = item.submittedByDisplayName && item.submittedByUsername
    ? `${item.submittedByDisplayName}（${item.submittedByUsername}）`
    : item.submittedByDisplayName || item.submittedByUsername || '未知账号';
  $('#fields').innerHTML = `
    <section class="cam-detail-section"><h4><i class="bi bi-box-seam me-2"></i>发布信息</h4><div class="cam-detail-grid">
      ${textField('软件产品', item.productName)}${detailField('软件版本', versionPanel)}${detailField('候选轮次', roundPanel)}${textField('验证报告标题', item.reportTitle ?? '旧版请求未携带')}${textField('验证环境', item.environment ?? '旧版请求未携带')}${textField('提交人', submitterLabel)}
    </div></section>
    <section class="cam-detail-section"><h4><i class="bi bi-arrow-left-right me-2"></i>处理状态</h4><div class="cam-detail-grid">
      ${detailField('云管审批', cloudApprovalPanel)}${detailField('云管提交', retryPanel)}${detailField('正式制品传输', transferPanel)}${detailField('验证报告', reportPanel)}${detailField('正式制品文件清单', transferProgressPanel, { wide: true })}
    </div></section>
    <section class="cam-detail-section"><h4><i class="bi bi-shield-check me-2"></i>完整性摘要</h4><div class="cam-detail-grid">
      ${textField('清单 SHA-256', item.manifestSha256, { mono: true })}${textField('报告 SHA-256', item.reportSha256, { mono: true })}
    </div></section>`;
  dialog.querySelectorAll('details[data-detail-key]').forEach((section) => { section.open = openDetailSections.has(section.dataset.detailKey); });
  const actions = [];
  if (item.status === 'CLOUD_PENDING' && canCore('businessWrite')) {
    const busy = ['QUEUED', 'SUBMITTING'].includes(item.cloudSubmissionState);
    actions.push(`<button id="retry-cloud-button" class="btn btn-warning" ${busy ? 'disabled' : ''}>${busy ? '正在提交…' : '立即重试云管提交'}</button>`);
  }
  if (['CLOUD_PENDING', 'CLOUD_SUBMITTED', 'CLOUD_STATUS_UNCONFIRMED'].includes(item.status) && canCore('businessWrite')) actions.push('<button id="withdraw-button" class="btn btn-outline-danger"><i class="bi bi-arrow-counterclockwise me-1"></i>撤回申请</button>');
  if (item.status === 'CLOUD_SUBMITTED' && canCore('businessWrite')) actions.push('<button id="sync-button" class="btn btn-primary">查询云管结果</button>');
  if (item.status === 'APPROVED' && !item.transferTaskId && item.cloudTransferTaskId && canCore('businessWrite')) actions.push('<button id="prepare-transfer-button" class="btn btn-primary"><i class="bi bi-send-check me-1"></i>准备正式制品传输</button>');
  if (item.status === 'APPROVED' && item.transferTaskId && item.transferNotificationState === 'FAILED' && canCore('businessWrite')) actions.push('<button id="edge-notification-retry-button" class="btn btn-danger"><i class="bi bi-send me-1"></i>重新通知 Edge</button>');
  if (item.status === 'APPROVED' && item.transferTaskId && item.transferEdgeStatus === 'RETRY_WAIT' && canCore('businessWrite')) actions.push('<button id="edge-transfer-retry-button" class="btn btn-warning"><i class="bi bi-arrow-repeat me-1"></i>立即恢复 Edge → Core 传输</button>');
  if (item.status === 'APPROVED' && item.transferTaskId && item.transferEdgeStatus === 'FAILED' && item.transferEdgeFailureTerminal && canCore('businessWrite')) actions.push('<button id="edge-transfer-fallback-button" class="btn btn-warning"><i class="bi bi-arrow-repeat me-1"></i>重试 Edge → Core 传输</button>');
  if (item.status === 'APPROVED' && item.transferStatus === 'RECEIVED' && canCore('businessWrite')) actions.push('<button id="close-button" class="btn btn-success">确认关单</button>');
  $('#actions').innerHTML = actions.join('');
  startDetailPolling(id);
  if (!dialog.open) dialog.showModal();
  $('#retry-cloud-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '正在提交…';
    try {
      const result = await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' });
      await load();
      await showDetail(id);
      message(result.inProgress ? '云管提交已在处理中' : '已触发云管提交重试');
    } catch (error) {
      message(error.message, 'danger');
      button.disabled = false;
      button.textContent = '立即重试云管提交';
    }
  });
  $('#sync-button')?.addEventListener('click', async () => {
    try { await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/sync`, { method: 'POST' }); await load(); await showDetail(id); message('已同步云管状态'); }
    catch (error) { message(error.message, 'danger'); }
  });
  $('#withdraw-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!await confirmDialog({ title: '撤回固化申请', text: '撤回只改变 Core 本地审批状态，不会调用云管撤回接口；撤回后 Core 不再提交或查询该云管流程。确认撤回吗？', confirmLabel: '撤回申请', confirmClass: 'btn-danger' })) return;
    button.disabled = true;
    try { await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/withdraw`, { method: 'POST', body: '{}' }); await load(); await showDetail(id); message('固化申请已撤回，Core 将不再处理云管流程'); }
    catch (error) { message(error.message, 'danger'); button.disabled = false; }
  });
  $('#prepare-transfer-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>正在准备…';
    try {
      await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/transfer-authorize`, {
        method: 'POST', body: JSON.stringify({ manifestSha256: item.manifestSha256, transferTaskId: item.cloudTransferTaskId })
      });
      await load();
      await showDetail(id);
      message('已准备正式制品传输。传输任务已绑定获批清单，等待网闸发送与接收回执。');
    } catch (error) {
      message(error.message, 'danger');
      button.disabled = false;
      button.innerHTML = '<i class="bi bi-send-check me-1"></i>准备正式制品传输';
    }
  });
  $('#edge-transfer-retry-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>正在请求 Edge 重试…';
    try {
      const result = await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/transfer/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fallback: false }) });
      await load();
      await showDetail(id);
        message(result.idempotent ? '恢复命令已在发送或 Edge 已在处理该传输任务' : '已向 Edge 下发恢复指令，正在等待确认');
    } catch (error) {
      message(error.message, 'danger');
      button.disabled = false;
      button.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>重试 Edge → Core 传输';
    }
  });
  $('#edge-notification-retry-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/transfer/notification-retry`, { method: 'POST', body: '{}' });
      await load();
      await showDetail(id);
      message('已重新通知 Edge 接收传输任务');
    } catch (error) { message(error.message, 'danger'); button.disabled = false; }
  });
  $('#edge-transfer-fallback-button')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!await confirmDialog({ title: '重试 Edge → Core 传输', text: '自动恢复次数已用尽。请先确认 Edge、网闸和存储故障已修复；本次重试会保留已接收分块和已入库制品。确认继续吗？', confirmLabel: '重试', confirmClass: 'btn-warning' })) return;
    button.disabled = true;
    button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>正在请求恢复…';
    try {
      const result = await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/transfer/recover`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fallback: true }) });
      await load();
      await showDetail(id);
      message(result.idempotent ? '恢复命令已在发送或 Edge 已在处理该传输任务' : '已发起重试，正在等待 Edge 确认');
    } catch (error) {
      message(error.message, 'danger');
      button.disabled = false;
      button.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i>重试 Edge → Core 传输';
    }
  });
  $('#close-button')?.addEventListener('click', async () => {
    if (!await confirmDialog({ title: '确认关单', text: '确认将该审批工单关单？', confirmLabel: '确认关单', confirmClass: 'btn-success' })) return;
    try { await api(`/api/v1/approval-requests/${encodeURIComponent(id)}/close`, { method: 'POST', body: '{}' }); await load(); await showDetail(id); message('已完成关单'); }
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
  ensureGateTransferTimeoutFields();
  const form = $('#gate-config-form');
  const legacyTransferInput = form.querySelector('[name="edgeTransferUrl"]');
  if (legacyTransferInput) {
    legacyTransferInput.required = false;
    legacyTransferInput.readOnly = true;
    legacyTransferInput.setAttribute('aria-readonly', 'true');
    legacyTransferInput.classList.add('bg-body-secondary');
    legacyTransferInput.placeholder = '暂不配置';
    const label = legacyTransferInput.closest('.col-md-6')?.querySelector('label');
    if (label) label.textContent = 'Edge 制品/回执地址（内侧，暂不启用）';
  }
  try {
    const result = await api('/api/v1/gate/config');
    const item = result.item ?? {};
    for (const element of form.elements) if (element.name && item[element.name] !== undefined) element.value = item[element.name];
    $('#gate-secret-status').value = result.identityConfigured ? (result.previousIdentityConfigured ? '身份已配对（旧身份过渡中）' : '身份已配对') : '尚未配对';
    $('#gate-config-status').textContent = `配置来源：${result.item?.source === 'database' ? 'Core 数据库' : '.env 默认值'}；映射模式固定为 mapping。`;
    await loadGateKeys();
  } catch (error) { message(error.message, 'danger'); }
}
function ensureGateTransferTimeoutFields() {
  const form = $('#gate-config-form');
  if (form.querySelector('[name="transferStartTimeoutMs"]')) return;
  const transferTimeout = form.querySelector('[name="transferTimeoutMs"]');
  const anchor = transferTimeout?.closest('.col-md-4');
  if (!anchor) return;
  const start = document.createElement('div');
  start.className = 'col-md-4';
  start.innerHTML = '<label class="form-label">等待 Edge 开始超时（毫秒）</label><input name="transferStartTimeoutMs" type="number" class="form-control" required>';
  const heartbeat = document.createElement('div');
  heartbeat.className = 'col-md-4';
  heartbeat.innerHTML = '<label class="form-label">传输心跳间隔（毫秒）</label><input name="transferHeartbeatMs" type="number" class="form-control" required>';
  const idle = document.createElement('div');
  idle.className = 'col-md-4';
  idle.innerHTML = '<label class="form-label">传输空闲超时（毫秒）</label><input name="transferIdleTimeoutMs" type="number" class="form-control" required>';
  anchor.insertAdjacentElement('afterend', start);
  start.insertAdjacentElement('afterend', heartbeat);
  heartbeat.insertAdjacentElement('afterend', idle);
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
function showPage(page, loadData = true) {
  if (!Object.hasOwn(pagePermissions, page)) page = firstAllowedPage();
  if (!canCorePage(currentUser?.roles ?? [], page)) page = firstAllowedPage();
  if (window.location.hash.slice(1).split('?')[0] !== page) history.replaceState(null, '', `#${page}`);
  const pages = ['requests', 'artifacts', 'distribution', 'transfer-monitor', 'cloud-config', 'aaa-config', 'gate-config', 'agents', 'users', 'audit'];
  for (const item of pages) $(`#page-${item}`).classList.toggle('d-none', item !== page);
  const titles = { requests: '审批请求', artifacts: '正式制品', distribution: 'Agent 分发', 'transfer-monitor': '传输监测', 'cloud-config': '云管对接配置', 'aaa-config': 'AAA 对接配置', 'gate-config': '网闸对接配置', agents: 'Agent 管理', users: '账号管理', audit: '审计日志' };
  $('#page-title').textContent = titles[page] ?? '审批请求';
  document.querySelectorAll('[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  if (!loadData || forcedPasswordChange) return;
  if (page === 'artifacts') loadArtifacts();
  if (page === 'distribution') loadDistribution();
  if (page === 'transfer-monitor') loadTransferMonitor();
  if (page === 'cloud-config') loadCloudConfig();
  if (page === 'aaa-config') void aaaConfigComponent?.load();
  if (page === 'gate-config') loadGateConfig();
  if (page === 'agents') loadAgents();
  if (page === 'users') loadUsers();
  if (page === 'audit') void loadAuditEvents();
}
function pageFromHash() {
  const value = window.location.hash.slice(1).split('?')[0];
  return value || 'requests';
}
async function loadUsers() {
  try {
    const result = await api('/api/v1/users');
    coreRoles = result.roles;
    edgeRoles = result.edgeRoles ?? {};
    coreUsers = result.items;
    $('#user-rows').innerHTML = coreUsers.map((user) => {
      const coreEnabled = user.coreEnabled ?? (user.status === 'ACTIVE');
      const edgeEnabled = user.edgeEnabled === true;
      const roleDisplay = renderRoleGroups([
        { scope: 'Core', roles: user.roles.map((role) => coreRoles[role] ?? role), emptyLabel: '无' },
        { scope: 'Edge', roles: edgeEnabled ? (user.edgeRoles ?? []).map((role) => edgeRoles[role] ?? role) : [], emptyLabel: edgeEnabled ? '无' : '未授权' }
      ]);
      const accountType = user.authSource === 'AAA' ? 'AAA' : '本地';
      const accountTypeColor = user.authSource === 'AAA' ? 'info' : 'primary';
      const accountState = [
        user.mustChangePassword ? '<span class="badge text-bg-warning">待改密码</span>' : '',
        user.lockedUntil > Date.now() ? '<span class="badge text-bg-danger">账号锁定</span>' : ''
      ].filter(Boolean).join(' ');
      const passwordAction = user.authSource === 'AAA'
        ? '<button type="button" class="btn btn-outline-secondary btn-sm cam-user-password-action" disabled title="密码由 AAA 管理"><i class="bi bi-shield-lock me-1"></i>AAA 管理</button>'
        : `<button class="btn btn-outline-warning btn-sm cam-user-password-action" data-user-reset="${escapeHtml(user.id)}" ${user.id === currentUser?.id ? 'disabled title="请使用右上角修改密码"' : ''}><i class="bi bi-key me-1"></i>重置密码</button>`;
      return `<tr>
        <td>${escapeHtml(user.username)}<div class="small text-body-secondary">${escapeHtml(user.displayName)}</div></td>
        <td><span class="badge text-bg-${accountTypeColor}">${accountType}</span></td>
        <td>${roleDisplay}</td>
        <td><div class="cam-user-login-permissions">
          <span class="badge text-bg-${coreEnabled ? 'success' : 'secondary'}">Core：${coreEnabled ? '允许登录' : '已禁用'}</span>
          <span class="badge text-bg-${edgeEnabled ? 'success' : 'secondary'}">Edge：${edgeEnabled ? '允许登录' : '已禁用'}</span>
        </div>${accountState ? `<div class="small mt-1">${accountState}</div>` : ''}</td>
        <td>${escapeHtml(user.lastLoginAt ?? '-')}</td>
        <td class="cam-actions-cell"><div class="cam-action-buttons">
          <button class="btn btn-outline-primary btn-sm" data-user-edit="${escapeHtml(user.id)}"><i class="bi bi-pencil me-1"></i>编辑账号</button>
          ${passwordAction}
        </div></td>
      </tr>`;
    }).join('') || '<tr><td colspan="6" class="text-center text-body-secondary py-4">暂无账号</td></tr>';
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
  userDialog.className = 'cam-account-modal';
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
$('#login-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#login-error').classList.add('d-none'); try { const result = await api('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) }); csrf = result.csrfToken; showApp(result.user); showPage(pageFromHash(), !result.user.mustChangePassword); if (!result.user.mustChangePassword && pageFromHash() === 'requests' && canCore('businessRead')) await load(); } catch (error) { $('#login-error').textContent = error.message; $('#login-error').classList.remove('d-none'); } });
$('#password-form').addEventListener('submit', async (event) => { event.preventDefault(); $('#password-error').classList.add('d-none'); if ($('#new-password').value !== $('#repeat-password').value) { $('#password-error').textContent = '两次新密码不一致'; $('#password-error').classList.remove('d-none'); return; } try { await api('/api/v1/auth/password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ oldPassword: $('#old-password').value, password: $('#new-password').value }) }); $('#password-form').reset(); showLogin(); } catch (error) { $('#password-error').textContent = error.message; $('#password-error').classList.remove('d-none'); } });
$('#change-password').addEventListener('click', () => showPasswordChange(false));
$('#password-change').addEventListener('cancel', (event) => { if (forcedPasswordChange) event.preventDefault(); });
$('#password-change').addEventListener('click', (event) => { if (event.target !== $('#password-change')) return; if (forcedPasswordChange) event.preventDefault(); else $('#password-change').close('backdrop'); });
$('#password-cancel').addEventListener('click', async () => {
  if (!forcedPasswordChange) { $('#password-form').reset(); $('#password-change').close('cancel'); return; }
  const button = $('#password-cancel');
  button.disabled = true;
  $('#password-error').classList.add('d-none');
  try { await api('/api/v1/auth/logout', { method: 'POST' }); $('#password-form').reset(); showLogin(); }
  catch (error) { $('#password-error').textContent = error.message; $('#password-error').classList.remove('d-none'); }
  finally { button.disabled = false; }
});
$('#logout').addEventListener('click', async () => { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); }); $('#refresh').addEventListener('click', load);
$('#detail-close').addEventListener('click', () => $('#detail').close());
$('#detail').addEventListener('close', stopDetailPolling);
$('#detail').addEventListener('click', (event) => { if (event.target === $('#detail')) $('#detail').close(); }); $('#artifacts-refresh').addEventListener('click', loadArtifacts);
$('#distribution-refresh').addEventListener('click', loadDistribution);
$('#transfer-monitor-refresh').addEventListener('click', loadTransferMonitor);
$('#distribution-form').addEventListener('submit', createDistributionTask);
$('#distribution-detail-close').addEventListener('click', () => $('#distribution-detail').close());
$('#distribution-detail').addEventListener('click', (event) => { if (event.target === $('#distribution-detail')) $('#distribution-detail').close(); });
$('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close('cancel'));
$('#confirm-submit').addEventListener('click', () => $('#confirm-dialog').close('confirm'));
$('#confirm-dialog').addEventListener('click', (event) => { if (event.target === $('#confirm-dialog')) $('#confirm-dialog').close('cancel'); });
$('#agents-refresh').addEventListener('click', loadAgents);
$('#agent-service-copy').addEventListener('click', async () => { const value = $('#agent-service-public-key').value; if (!value) return; try { await navigator.clipboard.writeText(value); message('Core 服务公钥已复制'); } catch { $('#agent-service-public-key').select(); message('浏览器未授权自动复制，请按 Ctrl+C 复制'); } });
$('#agent-service-rotate').addEventListener('click', async (event) => { const button = event.currentTarget; if (!await confirmDialog({ title: '轮换 Core 服务身份', text: 'Core 会生成新身份，并由当前身份签名发送提案。全部 Agent 确认后会提前切换；否则最多等待上方设置的旧身份过渡期，到期后照常启用新身份。届时未确认的 Agent 会被跳过，之后重新接入需要重新配对。确认发起吗？', confirmLabel: '发起轮换', confirmClass: 'btn-warning' })) return; button.disabled = true; try { const result = await api('/api/v1/agent-service-identity/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); message(result.pendingRotation ? `Core 新身份已暂存，等待 ${result.pending} 个 Agent 确认，最晚于 ${displayTime(result.activationDeadlineAt)} 启用` : 'Core 服务身份已轮换'); await loadAgents(); } catch (error) { message(error.message, 'danger'); } finally { button.disabled = false; } });
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
try { const result = await api('/api/v1/auth/me'); csrf = result.csrfToken; showApp(result.user); showPage(pageFromHash(), !result.user.mustChangePassword); if (!result.user.mustChangePassword && pageFromHash() === 'requests' && canCore('businessRead')) await load(); } catch { showLogin(); }

setInterval(() => { if (!forcedPasswordChange && !document.hidden && !$('#page-gate-config').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadGateKeys({ preserveInputs: true }).catch(() => {}); }, 5000);
setInterval(() => { if (!forcedPasswordChange && !document.hidden && !$('#page-agents').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadAgents(); }, 5000);
setInterval(() => { if (!forcedPasswordChange && !document.hidden && !$('#page-distribution').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadDistribution(); }, 5000);
setInterval(() => { if (!forcedPasswordChange && !document.hidden && !$('#page-transfer-monitor').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadTransferMonitor(); }, 5000);
