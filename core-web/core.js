let csrf = null;
let forcedPasswordChange = false;
let currentUser = null;
let coreRoles = {};
let coreUsers = [];
let coreAgents = [];
let resetUserId = null;
let cloudMappings = null;
let requestPollTimer = null;
let gatePeerTrusted = false;
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
}
async function load({ quiet = false } = {}) { try { render((await api('/api/v1/approval-requests')).items); if (!quiet) clearMessage(); if ($('#detail').open && $('#detail').dataset.requestId) await showDetail($('#detail').dataset.requestId); } catch (error) { if (!quiet) message(error.message, 'danger'); } }
function startRequestPolling() { if (requestPollTimer) return; requestPollTimer = setInterval(() => { if (!$('#app').classList.contains('d-none') && !$('#page-requests').classList.contains('d-none') && !document.hidden) void load({ quiet: true }); }, 5000); }
function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = -1;
  do { size /= 1024; unit++; } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
}
function renderArtifactFile(file) {
  const source = file.source === 'INHERITED' ? '复用已有文件' : '本版本文件';
  const state = file.stored ? '<span class="badge text-bg-success">已入库</span>' : '<span class="badge text-bg-warning">待入库</span>';
  const download = file.downloadUrl ? `<a class="btn btn-outline-primary btn-sm" href="${escapeHtml(file.downloadUrl)}" download="${escapeHtml(file.fileName)}">下载</a>` : '<span class="small text-body-secondary">文件尚未入库</span>';
  return `<tr><td><div class="fw-semibold">${escapeHtml(file.packageKey)}</div><span class="badge text-bg-light border">${escapeHtml(source)}</span></td><td>${escapeHtml(file.fileName)}</td><td class="text-nowrap">${escapeHtml(formatBytes(file.sizeBytes))}</td><td><code class="cam-artifact-digest" title="${escapeHtml(file.sha256)}">${escapeHtml(file.sha256)}</code></td><td>${state}</td><td>${download}</td></tr>`;
}
function renderArtifacts(items) {
  const products = new Map();
  for (const item of items) {
    const productName = item.productName || '历史产品';
    if (!products.has(productName)) products.set(productName, []);
    products.get(productName).push(item);
  }
  $('#artifact-rows').innerHTML = products.size ? [...products.entries()].map(([productName, releases]) => `<article class="card cam-artifact-product"><div class="card-header d-flex align-items-center justify-content-between"><h4 class="h6 mb-0"><i class="bi bi-box-seam me-2 text-primary"></i>${escapeHtml(productName)}</h4><span class="small text-body-secondary">${releases.length} 个正式版本</span></div><div class="card-body d-grid gap-3">${releases.map((item, index) => {
    const files = item.files ?? [];
    const stored = files.filter((file) => file.stored).length;
    const version = item.displayVersion ?? item.version ?? '未知版本';
    return `<details class="cam-artifact-version" ${index === 0 ? 'open' : ''}><summary><span class="cam-artifact-version-name">${escapeHtml(version)}</span><span class="badge text-bg-${stored === files.length && files.length ? 'success' : 'warning'}">${stored} / ${files.length} 个文件已入库</span><span class="small text-body-secondary">接收于 ${escapeHtml(displayTime(item.receivedAt))}</span></summary><div class="cam-artifact-version-body"><div class="cam-artifact-metadata"><span><span class="text-body-secondary">发布标识</span><code>${escapeHtml(item.releaseId ?? '-')}</code></span><span><span class="text-body-secondary">云管审批</span><code>${escapeHtml(item.cloudApprovalId ?? '-')}</code></span><span><span class="text-body-secondary">传输任务</span><code>${escapeHtml(item.transferTaskId ?? '-')}</code></span><span><span class="text-body-secondary">清单 SHA-256</span><code title="${escapeHtml(item.manifestSha256)}">${escapeHtml(item.manifestSha256 ?? '-')}</code></span></div>${files.length ? `<div class="table-responsive"><table class="table table-sm table-hover align-middle mb-0"><thead><tr><th>包标识 / 来源</th><th>文件名</th><th>大小</th><th>SHA-256</th><th>状态</th><th></th></tr></thead><tbody>${files.map(renderArtifactFile).join('')}</tbody></table></div>` : '<div class="alert alert-warning mb-0">该历史申请未提供正式文件清单。</div>'}<div class="d-flex justify-content-end mt-3"><button class="btn btn-outline-secondary btn-sm artifact-detail" data-id="${escapeHtml(item.requestId)}">查看审批记录</button></div></div></details>`;
  }).join('')}</div></article>`).join('') : '<div class="text-center text-body-secondary py-5">暂无已接收的正式版本。审批通过并收到制品后，会按软件和版本展示在这里。</div>';
  document.querySelectorAll('.artifact-detail').forEach((button) => { button.onclick = async () => { location.hash = 'requests'; showPage('requests'); await showDetail(button.dataset.id); }; });
}
async function loadArtifacts() { try { renderArtifacts((await api('/api/v1/artifacts')).items); clearMessage(); } catch (error) { message(error.message, 'danger'); } }
function renderAgents(items) {
  coreAgents = items ?? [];
  $('#agent-rows').innerHTML = coreAgents.length ? coreAgents.map((agent) => {
    const active = agent.status === 'ACTIVE';
    const keyState = agentRotationLabel(agent);
    return `<tr><td><div class="fw-semibold">${escapeHtml(agent.name)}</div><div class="small text-body-secondary font-monospace">${escapeHtml(agent.agentId)}</div></td><td>${escapeHtml(agent.centerId)}</td><td><span class="badge text-bg-${active ? 'success' : 'secondary'}">${active ? '启用' : '已禁用'}</span><div class="small text-${agent.rotationError ? 'danger' : 'body-secondary'} mt-1">${escapeHtml(keyState)}</div>${agent.rotationError ? `<div class="small text-danger">${escapeHtml(agent.rotationError)}</div><div class="small text-body-secondary">已尝试 ${agent.rotationAttempts} 次 · ${escapeHtml(displayTime(agent.rotationRetryAt))} 重试</div>` : ''}</td><td><code class="small d-inline-block text-break" style="max-width:12rem">${escapeHtml(agent.keyId ?? '-')}</code></td><td>${escapeHtml(agent.lastSeenAt ? displayTime(agent.lastSeenAt) : '尚未连接')}</td><td>${escapeHtml(displayTime(agent.nextRotationAt))}<div class="small text-body-secondary">每 ${escapeHtml(agent.rotationDays)} 天 · 过渡 ${escapeHtml(agent.graceHours)} 小时</div></td><td class="cam-actions-cell"><div class="cam-action-buttons"><button class="btn btn-outline-primary btn-sm agent-rotation-button" data-id="${escapeHtml(agent.agentId)}"><i class="bi bi-arrow-repeat me-1"></i>身份轮换</button><button class="btn btn-outline-${active ? 'warning' : 'success'} btn-sm agent-status-button" data-id="${escapeHtml(agent.agentId)}" data-status="${active ? 'DISABLED' : 'ACTIVE'}">${active ? '禁用' : '启用'}</button></div></td></tr>`;
  }).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无已注册 Agent</td></tr>';
  document.querySelectorAll('.agent-status-button').forEach((button) => { button.onclick = () => updateAgentStatus(button); });
  document.querySelectorAll('.agent-rotation-button').forEach((button) => { button.onclick = () => openAgentRotation(button.dataset.id); });
  if ($('#agent-rotation-dialog').open) renderAgentRotationSummary();
}
function agentRotationLabel(agent) {
  if (!agent.keyId) return '待身份配对';
  if (agent.rotationState === 'RETRY_WAIT') return '轮换失败，等待重试';
  if (agent.rotationState === 'AWAITING_CONFIRMATION') return '等待 Agent 签名确认';
  if (agent.rotationState === 'REQUESTED') return '等待 Agent 执行轮换';
  return agent.previousKeyExpiresAt && Date.parse(agent.previousKeyExpiresAt) > Date.now() ? `配对成功 · 旧身份过渡至 ${displayTime(agent.previousKeyExpiresAt)}` : '配对成功 · 身份有效';
}
function renderAgentRotationSummary() {
  const agent = coreAgents.find((item) => item.agentId === $('#agent-rotation-dialog').dataset.agentId);
  if (!agent) return;
  $('#agent-rotation-summary').textContent = `${agent.name} · ${agent.centerId}\n${agentRotationLabel(agent)}\n最近换钥：${displayTime(agent.rotatedAt)}\n签名确认：${agent.confirmedAt ? displayTime(agent.confirmedAt) : '尚未确认'}\n下次轮换：${displayTime(agent.nextRotationAt)}${agent.rotationRequestedAt ? `\n请求时间：${displayTime(agent.rotationRequestedAt)}` : ''}${agent.rotationError ? `\n最近错误：${agent.rotationError}\n已尝试 ${agent.rotationAttempts} 次，下次重试：${displayTime(agent.rotationRetryAt)}` : ''}`;
  $('#agent-rotate-now').disabled = agent.status !== 'ACTIVE' || !agent.confirmedAt || Boolean(agent.rotationRequestedAt);
}
function openAgentRotation(agentId) {
  const agent = coreAgents.find((item) => item.agentId === agentId);
  $('#agent-rotation-dialog').dataset.agentId = agentId;
  $('#agent-rotation-days').value = agent.rotationDays;
  $('#agent-grace-hours').value = agent.graceHours;
  $('#agent-rotation-error').classList.add('d-none');
  renderAgentRotationSummary();
  $('#agent-rotation-dialog').showModal();
}
async function loadAgentServiceIdentity() { try { const item = await api('/api/v1/agent-service-identity'); $('#agent-service-public-key').value = item.publicKey ?? ''; $('#agent-service-fingerprint').textContent = item.fingerprint ? `指纹：${item.fingerprint}` : ''; } catch (error) { message(error.message, 'danger'); } }
async function loadAgents() { try { renderAgents((await api('/api/v1/agents')).items); await loadAgentServiceIdentity(); } catch (error) { message(error.message, 'danger'); } }
async function updateAgentStatus(button) {
  const nextStatus = button.dataset.status;
  button.disabled = true;
  try {
    await api(`/api/v1/agents/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: nextStatus }) });
    message(nextStatus === 'ACTIVE' ? 'Agent 已启用' : 'Agent 已禁用');
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
  if (item.status === 'CLOUD_PENDING' && currentUser?.roles?.includes('CORE_ADMIN')) {
    const busy = ['QUEUED', 'SUBMITTING'].includes(item.cloudSubmissionState);
    actions.push(`<button id="retry-cloud-button" class="btn btn-warning" ${busy ? 'disabled' : ''}>${busy ? '正在提交…' : '立即重试云管提交'}</button>`);
  }
  if (item.status === 'CLOUD_SUBMITTED') actions.push('<button id="sync-button" class="btn btn-primary">查询云管结果</button>');
  if (item.status === 'APPROVED' && !item.transferTaskId && item.cloudTransferTaskId && currentUser?.roles?.includes('CORE_ADMIN')) actions.push('<button id="prepare-transfer-button" class="btn btn-primary"><i class="bi bi-send-check me-1"></i>准备正式制品传输</button>');
  if (item.status === 'APPROVED' && item.transferStatus === 'RECEIVED') actions.push('<button id="close-button" class="btn btn-success">确认关单</button>');
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
    $('#gate-secret-status').value = result.secretConfigured ? (result.previousSecretConfigured ? '当前密钥已配置（轮换过渡中）' : '已配置') : '未配置';
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
  $('#gate-peer-state').textContent = gatePeerTrusted ? editingPeer ? '替换身份会撤销当前共享密钥，双方需要重新确认配对' : '已保存对端身份；日常密钥轮换不需要重新粘贴身份包' : '首次配对需要导入对端身份包';
  $('#gate-trust-peer').classList.toggle('d-none', gatePeerTrusted && peerEditor.dataset.editing !== 'true');
  const states = { UNPAIRED: '未导入对端身份，业务传输已禁用', KEY_PENDING: '身份已保存，等待双端互信和密钥协商', CONFIRMING: '等待对端确认首个密钥，业务传输已禁用', PAIRED: '双向配对完成，业务密钥可用' };
  $('#gate-key-state').textContent = states[item.pairingState] ?? '等待确认配对状态';
  const paired = item.pairingState === 'PAIRED';
  $('#gate-pairing-badge').className = `badge text-bg-${paired ? 'success' : 'warning'}`;
  $('#gate-pairing-badge').textContent = paired ? '已配对' : item.pairingState === 'UNPAIRED' ? '未配对' : '配对中';
  const rotationStates = { IDLE: '当前无协商任务', PROPOSAL_PENDING: '等待对端接收密钥提案', PREPARED: '提案已接收，等待 Core 确认', CONFIRM_PENDING: '等待对端确认生效' };
  const rotationSummary = rotationStates[item.rotationState] ?? item.rotationState ?? '等待配对';
  const transitionSummary = item.previousKeyExpiresAt ? `${rotationSummary}；旧密钥过渡至 ${displayTime(item.previousKeyExpiresAt)}` : rotationSummary;
  const fields = [
    ['当前密钥标识', item.activeKeyId ?? '尚未生成'],
    ['协商进度', transitionSummary],
    ['最近完成轮换', item.lastRotationAt ? displayTime(item.lastRotationAt) : '暂无记录'],
    ['下次自动轮换', item.nextRotationAt ? displayTime(item.nextRotationAt) : '配对完成后安排'],
  ];
  $('#gate-key-summary').innerHTML = fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const retry = $('#gate-key-retry');
  retry.classList.toggle('d-none', !item.lastRotationError && !item.retryAt);
  retry.textContent = [item.lastRotationError && `最近失败：${item.lastRotationError}`, item.retryAt && `下次自动重试：${displayTime(item.retryAt)}`, (item.lastRotationError || item.retryAt) && '可点击“测试身份配对”立即重试。'].filter(Boolean).join('；');
  $('#gate-secret-status').value = states[item.pairingState] ?? '等待确认配对状态';
  const events = { PEER_TRUSTED: '已保存对端身份', PEER_REPLACED_KEYS_RETIRED: '对端身份已更换，旧密钥已撤销', ROTATION_PROPOSAL_CREATED: '已发起密钥协商', ROTATION_PROPOSAL_ACCEPTED: '已接收密钥提案', ROTATION_ACTIVATED_CORE: '等待 Edge 确认密钥', ROTATION_CONFIRMED_CORE: '双方密钥确认完成', ROTATION_CONFIRMED_EDGE: '业务密钥已生效', ROTATION_RETRY_WAIT: '协商失败，等待重试', SCHEDULE_UPDATED: '轮换策略已更新', BOOTSTRAP_SECRET_RETIRED: '旧初始化密钥已撤销' };
  $('#gate-key-events').innerHTML = (item.recentEvents ?? []).slice(0, 5).map((event) => `<div class="cam-gate-event"><time>${escapeHtml(displayTime(event.at))}</time><span>${escapeHtml(events[event.type] ?? event.type)}</span></div>`).join('') || '<p class="small text-body-secondary mb-0">暂无配对与轮换记录</p>';
  if (!preserveInputs) { $('#gate-rotation-days').value = item.rotationIntervalDays; $('#gate-grace-hours').value = item.gracePeriodHours; }
  $('#gate-rotate-now').disabled = !item.peerTrusted;
}
function showPage(page) {
  const artifacts = page === 'artifacts'; const cloud = page === 'cloud-config'; const gate = page === 'gate-config'; const agents = page === 'agents'; const users = page === 'users';
  $('#page-requests').classList.toggle('d-none', artifacts || cloud || gate || agents || users); $('#page-artifacts').classList.toggle('d-none', !artifacts); $('#page-cloud-config').classList.toggle('d-none', !cloud); $('#page-gate-config').classList.toggle('d-none', !gate); $('#page-agents').classList.toggle('d-none', !agents); $('#page-users').classList.toggle('d-none', !users);
  $('#page-title').textContent = artifacts ? '正式制品' : cloud ? '云管对接配置' : gate ? '网闸对接配置' : agents ? 'Agent 管理' : users ? '账号管理' : '云管审批请求';
  document.querySelectorAll('[data-page]').forEach((link) => link.classList.toggle('active', link.dataset.page === page));
  if (artifacts) loadArtifacts();
  if (cloud) loadCloudConfig();
  if (gate) loadGateConfig();
  if (agents) loadAgents();
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
$('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close('cancel'));
$('#confirm-submit').addEventListener('click', () => $('#confirm-dialog').close('confirm'));
$('#confirm-dialog').addEventListener('click', (event) => { if (event.target === $('#confirm-dialog')) $('#confirm-dialog').close('cancel'); });
$('#agents-refresh').addEventListener('click', loadAgents);
$('#agent-service-copy').addEventListener('click', async () => { const value = $('#agent-service-public-key').value; if (!value) return; try { await navigator.clipboard.writeText(value); message('Core 服务公钥已复制'); } catch { $('#agent-service-public-key').select(); message('浏览器未授权自动复制，请按 Ctrl+C 复制'); } });
$('#agent-service-rotate').addEventListener('click', async (event) => { if (!await confirmDialog({ title: '轮换 Core 服务密钥', text: '轮换后必须把新公钥配置到所有 Agent，并在过渡期内保留旧公钥。确认继续吗？', confirmLabel: '确认轮换', confirmClass: 'btn-warning' })) return; event.currentTarget.disabled = true; try { const result = await api('/api/v1/agent-service-identity/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); $('#agent-service-public-key').value = result.publicKey ?? ''; $('#agent-service-fingerprint').textContent = `新指纹：${result.fingerprint ?? '-'} · 旧公钥过渡至 ${displayTime(result.previousKeyExpiresAt)}`; message('Core 服务密钥已轮换，请立即更新所有 Agent 的 Core 公钥配置'); } catch (error) { message(error.message, 'danger'); } finally { event.currentTarget.disabled = false; } });
$('#agent-rotation-close').addEventListener('click', () => $('#agent-rotation-dialog').close());
$('#agent-rotation-dialog').addEventListener('click', (event) => { if (event.target === $('#agent-rotation-dialog')) $('#agent-rotation-dialog').close(); });
async function changeAgentRotation(action, body) {
  const agentId = $('#agent-rotation-dialog').dataset.agentId;
  $('#agent-rotation-error').classList.add('d-none');
  try {
    await api(`/api/v1/agents/${encodeURIComponent(agentId)}/${action}`, { method: action === 'rotate' ? 'POST' : 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    message(action === 'rotate' ? '轮换请求已保存，等待 Agent 主动连接并确认新身份' : 'Agent 自动轮换策略已保存');
    await loadAgents();
  } catch (error) { $('#agent-rotation-error').textContent = error.message; $('#agent-rotation-error').classList.remove('d-none'); }
}
$('#agent-rotation-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  try { await changeAgentRotation('rotation-policy', { rotationDays: Number($('#agent-rotation-days').value), graceHours: Number($('#agent-grace-hours').value) }); }
  finally { button.disabled = false; }
});
$('#agent-rotate-now').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { await changeAgentRotation('rotate', {}); } finally { renderAgentRotationSummary(); }
});
document.querySelectorAll('[data-page]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); location.hash = link.dataset.page; showPage(link.dataset.page); }));
$('#agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
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
$('#new-user').addEventListener('click', () => openUserEditor()); $('#user-cancel').addEventListener('click', () => $('#user-editor').classList.add('d-none')); $('#reset-cancel').addEventListener('click', () => $('#user-reset').classList.add('d-none'));
$('#user-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const userId = form.dataset.userId; const roles = [...document.querySelectorAll('#user-roles input:checked')].map((input) => input.value); const body = { username: $('#user-name').value, displayName: $('#user-display').value, status: $('#user-status').value, roles }; if (!userId) body.password = $('#user-password').value; try { const result = await api(userId ? `/api/v1/users/${encodeURIComponent(userId)}` : '/api/v1/users', { method: userId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); message(userId ? '账号信息已保存；该账号需要重新登录' : `账号 ${result.user.username} 已创建，首次登录须修改初始密码`); $('#user-editor').classList.add('d-none'); if (userId === currentUser?.id) { await api('/api/v1/auth/logout', { method: 'POST' }).catch(() => {}); showLogin(); } else await loadUsers(); } catch (error) { $('#user-error').textContent = error.message; $('#user-error').classList.remove('d-none'); } });
$('#reset-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api(`/api/v1/users/${encodeURIComponent(resetUserId)}/password`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#reset-password').value }) }); $('#user-reset').classList.add('d-none'); message('密码已重置；该账号下次登录须修改初始密码'); await loadUsers(); } catch (error) { $('#reset-error').textContent = error.message; $('#reset-error').classList.remove('d-none'); } });
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
$('#gate-peer-edit').addEventListener('click', () => { $('#gate-pairing-result').classList.add('d-none'); $('#gate-peer-editor').classList.remove('d-none'); $('#gate-peer-editor').dataset.editing = 'true'; $('#gate-peer-fingerprint').classList.add('d-none'); $('#gate-peer-fingerprint-label').textContent = '导入 Edge 导出的身份包'; $('#gate-peer-edit').classList.add('d-none'); $('#gate-peer-cancel').classList.remove('d-none'); $('#gate-peer-bundle-input').focus(); $('#gate-peer-state').textContent = '替换身份会撤销当前共享密钥，双方需要重新确认配对'; });
$('#gate-peer-cancel').addEventListener('click', () => { $('#gate-peer-editor').classList.add('d-none'); $('#gate-peer-editor').dataset.editing = ''; $('#gate-peer-fingerprint').classList.remove('d-none'); $('#gate-peer-fingerprint-label').textContent = '已信任的身份指纹'; $('#gate-peer-cancel').classList.add('d-none'); $('#gate-peer-edit').classList.remove('d-none'); $('#gate-peer-bundle-input').value = ''; $('#gate-peer-state').textContent = '已取消身份替换'; });
$('#gate-trust-peer').addEventListener('click', async () => { try { if (gatePeerTrusted && !await confirmDialog({ title: '重新配对 Edge 身份', text: '替换对端身份会撤销当前共享密钥，双方需要重新完成身份确认。确定继续吗？', confirmLabel: '确认替换', confirmClass: 'btn-warning' })) return; const identityBundle = JSON.parse($('#gate-peer-bundle-input').value); await api('/api/v1/gate/keys/trusted-peer', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identityBundle }) }); $('#gate-peer-bundle-input').value = ''; $('#gate-peer-editor').dataset.editing = ''; await loadGateKeys(); message('Edge 身份已保存；双方完成互信和密钥确认后才算配对成功'); } catch (error) { message(error.message, 'danger'); } });
$('#gate-pairing-test').addEventListener('click', async (event) => {
  const button = event.currentTarget; const notice = $('#gate-pairing-result');
  button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>测试中';
  notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = '正在测试身份配对与密钥认证…';
  try {
    const result = await api('/api/v1/gate/keys/test', { method: 'POST' });
    notice.className = 'alert alert-success mt-3 mb-0';
    notice.textContent = `配对测试通过：本端 Core 与对端 ${result.checks.remote.role} 均已配对，密钥认证成功（${displayTime(new Date().toISOString())}）。`;
  } catch (error) { notice.className = 'alert alert-danger mt-3 mb-0'; notice.textContent = `配对测试未通过：${error.message}`; }
  finally { await loadGateKeys({ preserveInputs: true }).catch(() => {}); button.disabled = false; button.innerHTML = '<i class="bi bi-shield-check me-1"></i>测试身份配对'; }
});
$('#gate-schedule').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/keys/schedule', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rotationIntervalDays: Number($('#gate-rotation-days').value), gracePeriodHours: Number($('#gate-grace-hours').value) }) }); await loadGateKeys(); message('自动轮换策略已保存'); } catch (error) { message(error.message, 'danger'); } });
$('#gate-rotate-now').addEventListener('click', async () => { const button = $('#gate-rotate-now'); button.disabled = true; try { await api('/api/v1/gate/keys/rotate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); await loadGateKeys(); message('共享密钥已完成轮换'); } catch (error) { message(error.message, 'danger'); } finally { button.disabled = false; } });
try { const result = await api('/api/v1/auth/me'); csrf = result.csrfToken; showApp(result.user); if (!result.user.mustChangePassword) await load(); } catch { showLogin(); }

setInterval(() => { if (!document.hidden && !$('#page-gate-config').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadGateKeys({ preserveInputs: true }).catch(() => {}); }, 5000);
setInterval(() => { if (!document.hidden && !$('#page-agents').classList.contains('d-none') && !$('#app').classList.contains('d-none')) void loadAgents(); }, 5000);
