import { initAccountUI, currentUser, userLabel, csrfHeaders, showLogin, renderAccountView, hasRole } from './account-ui.js?v=20261023-menu-groups';
import { renderGatePairing } from './gate-pairing.js?v=20261020-peer-save-feedback';
import { canEdgePage } from './role-permissions.js?v=20261023-auditor-scope';
import { displayTransferState } from './task-state.js?v=20261027-transfer-state';
const state = { products: [], releases: [], view: 'products', productId: null, releaseId: null, roundId: null, candidateId: null, pollTimer: null, queueTimer: null, currentRoundCandidates: [], currentRoundQueue: [], batchSubmitting: false, routeGeneration: 0, importFile: null, importPreview: null, nextRoundPreview: null };
document.querySelector('#gate-pairing-mount').innerHTML = renderGatePairing('edge');
document.querySelector('#view-log-collections .alert-info')?.remove();
let importPreviewRequestId = 0;
let revisionBaseReleaseId = null;
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

function showAlert(message, type = 'success') {
  const alert = $('#alert');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  window.setTimeout(() => alert.classList.add('d-none'), 5000);
}

function statusLabel(status) { return { OPEN: '开放', SEALED: '已固化封存', SUPERSEDED: '已由后续轮次替代', CREATED: '待接收', RECEIVING: '接收中', PARTIAL: '待完成', ASSEMBLING: '组装校验中', FAILED: '失败', COMPLETED: '已完成', DRAFT: '固化草稿', PENDING_APPROVAL: '等待审批', APPROVED: '审批通过，已固化', REJECTED: '审批驳回', WITHDRAWN: '已撤回', IDLE: '尚未准备传输', READY: '待安排', SENDING: '传输中', RECEIVED: '已完成', WAITING_CONFIRMATION: '等待确认', VERIFYING: '校验中', RETRY_WAIT: '重试等待', TRANSFERRING: '传输中', COLLECTING: '收集中', PACKAGING: '打包中', EXPIRED: '已过期' }[status] ?? status; }
function statusClass(status) { return { OPEN: 'text-bg-primary', SEALED: 'text-bg-success', SUPERSEDED: 'text-bg-secondary', CREATED: 'text-bg-secondary', RECEIVING: 'text-bg-info', PARTIAL: 'text-bg-warning', ASSEMBLING: 'text-bg-primary', FAILED: 'text-bg-danger', COMPLETED: 'text-bg-success', DRAFT: 'text-bg-secondary', PENDING_APPROVAL: 'text-bg-warning', APPROVED: 'text-bg-success', REJECTED: 'text-bg-danger', WITHDRAWN: 'text-bg-secondary' }[status] ?? 'text-bg-secondary'; }
function internalDeliveryLabel(status) { return status === 'DELIVERED' ? '已进入内网，等待审批' : '正在进入内网，系统会自动重试'; }
function formatBytes(value) { if (!Number.isFinite(Number(value))) return '-'; if (value < 1024) return `${value} B`; const units = ['KB', 'MB', 'GB', 'TB']; let amount = value; let index = -1; while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; } return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`; }

async function api(path, options = {}) {
  const headers = { ...csrfHeaders(), ...(options.headers ?? {}) };
  if (options.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { if (response.status === 401 && !path.startsWith('/api/v1/auth/')) { window.clearInterval(state.pollTimer); window.clearInterval(state.queueTimer); showLogin(); } throw new Error(body.error?.message ?? `请求失败（${response.status}）`); }
  return body;
}

function routeHash(view, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value));
  const encoded = query.toString();
  return `#${view}${encoded ? `?${encoded}` : ''}`;
}

function navigate(view, params = {}) {
  window.location.hash = routeHash(view, params);
}

function routeContext() {
  const [viewPart, queryPart = ''] = window.location.hash.slice(1).split('?');
  const params = new URLSearchParams(queryPart);
  return {
    view: ['products', 'releases', 'rounds', 'candidates', 'release-detail', 'candidate-detail', 'gate-config', 'log-collections', 'users', 'grants', 'audit'].includes(viewPart) ? viewPart : 'products',
    productId: params.get('productId'),
    releaseId: params.get('releaseId'),
    roundId: params.get('roundId'),
    candidateId: params.get('candidateId')
  };
}

function paramsForState(overrides = {}) {
  const value = (key) => Object.hasOwn(overrides, key) ? overrides[key] : state[key];
  return { productId: value('productId'), releaseId: value('releaseId'), roundId: value('roundId') };
}

function renderShell(view) {
  const views = ['products', 'releases', 'rounds', 'candidates', 'release-detail', 'candidate-detail', 'gate-config', 'log-collections', 'users', 'grants', 'audit'];
  views.forEach((name) => $(`#view-${name}`).classList.toggle('d-none', name !== view));
  const activeRoute = view === 'release-detail' ? 'rounds' : view === 'candidate-detail' ? 'candidates' : view;
  document.querySelectorAll('.sidebar-menu a').forEach((link) => link.classList.toggle('active', (link.dataset.route ?? link.hash.slice(1)) === activeRoute));
  document.querySelectorAll('.sidebar-menu a').forEach((link) => {
    const route = link.dataset.route ?? link.hash.slice(1);
    link.parentElement.classList.toggle('d-none', !canEdgePage(currentUser()?.roles ?? [], route));
  });
    const titles = { products: '软件产品', releases: '发布版本', rounds: '候选轮次', candidates: '候选包文件清单', 'release-detail': '发布版本详情', 'candidate-detail': '候选包详情', 'gate-config': '对接配置', 'log-collections': '日志收集', users: '账号管理', grants: '下载授权', audit: '审计日志' };
  $('#page-title').textContent = titles[view] ?? '软件产品';
}

function renderBreadcrumb() {
  const labels = [];
  const product = state.products.find((item) => item.productId === state.productId);
  if (state.view === 'users' || state.view === 'grants' || state.view === 'audit') labels.push([{ users: '账号管理', grants: '下载授权', audit: '审计日志' }[state.view]]);
  else if (state.view === 'products') labels.push(['软件产品']);
  else if (state.view === 'releases') {
    if (state.productId) labels.push([product?.name ?? '软件产品', routeHash('releases', { productId: state.productId })]);
    labels.push(['发布版本']);
  } else if (state.view === 'rounds' || state.view === 'release-detail') {
    if (state.productId) labels.push([product?.name ?? state.currentRelease?.productName ?? '软件产品', routeHash('releases', { productId: state.productId })]);
    if (state.currentRelease) labels.push([state.currentRelease.version, routeHash('release-detail', { releaseId: state.currentRelease.releaseId })]);
    labels.push([state.view === 'rounds' ? '候选轮次' : `第 ${state.currentRound?.roundNo ?? ''} 轮`]);
  } else {
    if (state.productId) labels.push([product?.name ?? state.currentCandidate?.productName ?? '软件产品', routeHash('releases', { productId: state.productId })]);
    const version = state.currentRelease?.version ?? state.currentCandidate?.releaseVersion;
    if (version) labels.push([version, routeHash('rounds', { productId: state.productId, releaseId: state.releaseId })]);
    if (state.currentRound || state.roundId) labels.push([state.currentRound ? `第 ${state.currentRound.roundNo} 轮` : '候选轮次', routeHash('candidates', paramsForState())]);
    labels.push([state.view === 'candidates' ? '候选包' : state.currentCandidate?.fileName ?? '候选包']);
  }
  $('#breadcrumbs').innerHTML = '<li class="breadcrumb-item">CAM Edge</li>' + labels.map(([label, href], index) => {
    const active = index === labels.length - 1;
    if (active || !href) return `<li class="breadcrumb-item${active ? ' active' : ''}">${escapeHtml(label)}</li>`;
    return `<li class="breadcrumb-item"><a href="${href}">${escapeHtml(label)}</a></li>`;
  }).join('');
}

function setOptions(element, items, selected, label, firstLabel = '全部') {
  element.innerHTML = `<option value="">${firstLabel}</option>${items.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(label(item))}</option>`).join('')}`;
  element.value = items.some((item) => item.id === selected) ? selected : '';
}

async function getProducts() {
  return (await api('/api/v1/products')).items;
}

async function getReleases(productId = null) {
  const query = productId ? `?productId=${encodeURIComponent(productId)}` : '';
  return (await api(`/api/v1/releases${query}`)).items;
}

async function getRoundsByFilter({ productId = null, releaseId = null } = {}) {
  const query = new URLSearchParams();
  if (productId) query.set('productId', productId);
  if (releaseId) query.set('releaseId', releaseId);
  const suffix = query.toString() ? `?${query}` : '';
  return (await api(`/api/v1/rounds${suffix}`)).items;
}

function ensureIntegrationConfigFields() {
  $('#gate-config-nav p').textContent = '对接配置';
  $('#view-gate-config > .card > .card-header .card-title').textContent = '对接配置';
  const form = $('#gate-config-form');
  if (form.querySelector('[name="sourceAllowlist"]')) return;
  const status = $('#gate-config-status');
  const wrapper = document.createElement('div');
  wrapper.className = 'col-12';
  wrapper.innerHTML = '<hr class="my-2"><label class="form-label" for="gate-source-allowlist">可信下载来源</label><textarea id="gate-source-allowlist" name="sourceAllowlist" class="form-control font-monospace" rows="3" placeholder="每行填写一个主机名或 IP 地址"></textarea><div class="form-text">仅允许候选包从这些主机名或 IP 地址下载；支持 *.example.com 通配域名。不填写时禁止接收候选包。</div>';
  status.parentNode.insertBefore(wrapper, status);
}

function ensureGateTransferTimeoutFields() {
  const form = $('#gate-config-form');
  if (form.querySelector('[name="transferStartTimeoutMs"]')) return;
  const transferTimeout = form.querySelector('[name="transferTimeoutMs"]');
  const anchor = transferTimeout?.closest('.col-md-4');
  if (!anchor) return;
  const start = document.createElement('div');
  start.className = 'col-md-4';
  start.innerHTML = '<label class="form-label">等待开始超时（毫秒）</label><input name="transferStartTimeoutMs" type="number" class="form-control" required>';
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

async function loadGateConfig() {
  ensureIntegrationConfigFields();
  ensureGateTransferTimeoutFields();
  const form = $('#gate-config-form');
  const modeInput = form.querySelector('[name="mode"]');
  if (modeInput) {
    modeInput.readOnly = true;
    modeInput.setAttribute('aria-readonly', 'true');
    modeInput.classList.add('bg-body-secondary');
  }
  const coreControlInput = form.querySelector('[name="coreControlUrl"]');
  if (coreControlInput) {
    coreControlInput.required = false;
    coreControlInput.readOnly = true;
    coreControlInput.setAttribute('aria-readonly', 'true');
    coreControlInput.classList.add('bg-body-secondary');
    coreControlInput.placeholder = '由部署配置文件提供';
    const label = coreControlInput.closest('.col-md-6')?.querySelector('label');
    if (label) label.textContent = 'Core 控制地址（外侧，取配置文件）';
  }
  try {
    const result = await api('/api/v1/gate/config'); const item = result.item ?? {};
    for (const element of form.elements) if (element.name && item[element.name] !== undefined) element.value = element.name === 'sourceAllowlist' && Array.isArray(item[element.name]) ? item[element.name].join('\n') : item[element.name];
    $('#gate-secret-status').value = result.identityConfigured ? (result.previousIdentityConfigured ? '身份已配对（旧身份过渡中）' : '身份已配对') : '尚未配对';
    $('#gate-config-status').textContent = `配置来源：${item.source === 'database' ? 'Edge 数据库' : '.env 默认值'}；映射模式固定为 mapping。`;
    await loadGateKeys();
  } catch (error) { showAlert(error.message, 'danger'); }
}

async function loadGateKeys({ preserveInputs = false } = {}) {
  const result = await api('/api/v1/gate/keys');
  const item = result.item;
  $('#gate-identity-bundle').value = JSON.stringify(result.identityBundle, null, 2);
  $('#gate-peer-fingerprint').textContent = item.peerFingerprint ?? '尚未导入';
  const peerTrusted = Boolean(item.peerFingerprint); const peerEditor = $('#gate-peer-editor');
  if (!peerTrusted) { peerEditor.dataset.editing = ''; peerEditor.classList.remove('d-none'); $('#gate-peer-edit').classList.add('d-none'); $('#gate-peer-cancel').classList.add('d-none'); }
  else if (!preserveInputs && peerEditor.dataset.editing !== 'true') { peerEditor.classList.add('d-none'); $('#gate-peer-edit').classList.remove('d-none'); $('#gate-peer-cancel').classList.add('d-none'); $('#gate-peer-bundle-input').value = ''; }
  const editingPeer = !peerTrusted || peerEditor.dataset.editing === 'true';
  $('#gate-peer-fingerprint').classList.toggle('d-none', editingPeer);
  $('#gate-peer-fingerprint-label').textContent = editingPeer ? '导入 Core 导出的身份包' : '已信任的身份指纹';
  $('#gate-peer-state').textContent = peerTrusted ? editingPeer ? '替换信任身份会中断现有业务通道，需重新完成双方配对' : '已信任对端身份；日常轮换会自动更新对端公钥' : '首次配对需要导入对端身份包';
  $('#gate-trust-peer').classList.toggle('d-none', peerTrusted && peerEditor.dataset.editing !== 'true');
  const states = { UNPAIRED: '未导入对端身份，业务传输已禁用', KEY_PENDING: '尚未完成身份配对', PAIRED: '双向身份配对完成，签名业务通道可用' };
  $('#gate-key-state').textContent = states[item.pairingState] ?? '等待确认配对状态';
  const paired = item.pairingState === 'PAIRED';
  $('#gate-pairing-badge').className = `badge text-bg-${paired ? 'success' : 'warning'}`;
  $('#gate-pairing-badge').textContent = paired ? '已配对' : item.pairingState === 'UNPAIRED' ? '未配对' : '配对中';
  const rotationStates = { IDLE: '当前无身份轮换任务', PROPOSAL_PENDING: '等待对端确认新身份' };
  const rotationSummary = rotationStates[item.rotationState] ?? item.rotationState ?? '等待配对';
  const transitionSummary = item.previousKeyExpiresAt ? `${rotationSummary}；旧密钥过渡至 ${new Date(item.previousKeyExpiresAt).toLocaleString()}` : rotationSummary;
  const fields = [
    ['本端公钥指纹', item.activeKeyId ?? '尚未生成'],
    ['身份轮换状态', transitionSummary],
    ['最近完成轮换', item.lastRotationAt ? new Date(item.lastRotationAt).toLocaleString() : '暂无记录'],
    ['下次自动轮换', item.nextRotationAt ? new Date(item.nextRotationAt).toLocaleString() : '由 Core 统一安排'],
  ];
  $('#gate-key-summary').innerHTML = fields.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
  const retry = $('#gate-key-retry');
  retry.classList.toggle('d-none', !item.lastRotationError && !item.retryAt);
  retry.textContent = [item.lastRotationError && `最近失败：${item.lastRotationError}`, item.retryAt && `下次自动重试：${new Date(item.retryAt).toLocaleString()}`].filter(Boolean).join('；');
  $('#gate-secret-status').value = states[item.pairingState] ?? '等待确认配对状态';
  const events = { PEER_TRUSTED: '已保存对端身份', PEER_REPLACED_KEYS_RETIRED: '对端身份已更换，旧身份已撤销', IDENTITY_ROTATION_PROPOSED: '已发起本端身份轮换', PEER_IDENTITY_ROTATED: '已信任对端新身份', IDENTITY_ROTATION_ACTIVATED: '本端新身份已启用', ROTATION_RETRY_WAIT: '身份轮换失败，等待重试', SCHEDULE_UPDATED: '身份轮换策略已更新', SHARED_SECRETS_RETIRED: '已清除旧版共享密钥' };
  $('#gate-key-events').innerHTML = (item.recentEvents ?? []).slice(0, 5).map((event) => `<div class="cam-gate-event"><time>${escapeHtml(new Date(event.at).toLocaleString())}</time><span>${escapeHtml(events[event.type] ?? event.type)}</span></div>`).join('') || '<p class="small text-body-secondary mb-0">暂无配对与轮换记录</p>';
  if (!preserveInputs) { $('#gate-rotation-days').value = item.rotationIntervalDays; $('#gate-grace-hours').value = item.gracePeriodHours; }
  $('#gate-rotate-now').disabled = !item.peerTrusted;
  return item;
}

function logCollectionStatusClass(status) { return status === 'READY' ? 'text-bg-success' : status === 'FAILED' ? 'text-bg-danger' : 'text-bg-warning'; }
function logCollectionStatusLabel(status) { return { READY: '可下载', COLLECTING: '收集中', FAILED: '收集失败' }[status] ?? statusLabel(status); }
function renderLogCollections(items = []) {
  $('#log-collection-rows').innerHTML = items.length ? items.map((item) => `<tr><td>${escapeHtml(new Date(item.fromAt).toLocaleString())} 至 ${escapeHtml(new Date(item.toAt).toLocaleString())}</td><td>${escapeHtml((item.categories ?? []).join('、'))}</td><td><span class="badge ${logCollectionStatusClass(item.status)}">${escapeHtml(logCollectionStatusLabel(item.status))}</span>${item.lastError ? `<div class="small text-danger mt-1">${escapeHtml(item.lastError)}</div>` : ''}</td><td>${escapeHtml(new Date(item.createdAt).toLocaleString())}</td><td>${item.status === 'READY' ? `<a class="btn btn-sm btn-outline-primary" href="/api/v1/log-collections/${encodeURIComponent(item.jobId)}/download"><i class="bi bi-download me-1"></i>下载</a>` : '-'}</td></tr>`).join('') : '<tr><td colspan="5" class="text-center text-body-secondary py-4">暂无日志收集任务</td></tr>';
}
async function loadLogCollections() { const result = await api('/api/v1/log-collections'); renderLogCollections(result.items ?? []); }

function productFilterItems(products) { return products.map((item) => ({ id: item.productId, name: item.name })); }
function releaseLabel(item) { return `${item.productName} / ${item.displayVersion ?? (item.revision > 0 ? `${item.version}-r${item.revision}` : item.version)}`; }
function releaseFilterItems(releases) { return releases.map((item) => ({ id: item.releaseId, name: releaseLabel(item) })); }
function roundFilterItems(rounds) { return rounds.map((item) => ({ id: item.roundId, name: `${item.productName} / ${item.version} / 第 ${item.roundNo} 轮` })); }

async function loadProducts(generation = state.routeGeneration) {
  const products = await getProducts();
  if (generation !== state.routeGeneration) return;
  state.products = products;
  $('#product-rows').innerHTML = state.products.length ? state.products.map((item) => {
    const canDelete = item.releaseCount === 0;
    const deleteTitle = canDelete ? '删除没有发布版本的产品' : '已有发布版本，不能删除';
    return `<tr><td class="fw-semibold">${escapeHtml(item.name)}</td><td class="font-monospace small">${escapeHtml(item.productId)}</td><td><div class="d-flex gap-1"><button class="btn btn-outline-primary btn-sm" data-product-releases="${escapeHtml(item.productId)}">查看版本</button><button class="btn btn-outline-danger btn-sm" data-delete-product="${escapeHtml(item.productId)}" title="${deleteTitle}" aria-label="删除软件产品" ${canDelete ? '' : 'disabled'}><i class="bi bi-trash"></i><span class="visually-hidden">删除</span></button></div></td></tr>`;
  }).join('') : '<tr><td colspan="3" class="text-center text-body-secondary py-4">暂无软件产品</td></tr>';
  document.querySelectorAll('[data-product-releases]').forEach((button) => button.addEventListener('click', () => navigate('releases', { productId: button.dataset.productReleases })));
  document.querySelectorAll('[data-delete-product]').forEach((button) => button.addEventListener('click', () => deleteProduct(button.dataset.deleteProduct)));
}

async function deleteProduct(productId) {
  const product = state.products.find((item) => item.productId === productId);
  if (!product || !await confirmAction({ title: '删除软件产品', message: `确定删除软件产品“${product.name}”吗？`, detail: '仅允许删除没有发布版本的产品。此操作不可恢复。' })) return;
  try { await api(`/api/v1/products/${encodeURIComponent(productId)}`, { method: 'DELETE' }); showAlert('软件产品已删除'); await loadProducts(); }
  catch (error) { showAlert(error.message, 'danger'); }
}

async function loadReleases(generation = state.routeGeneration) {
  state.currentRelease = null;
  state.currentRound = null;
  const products = await getProducts();
  if (generation !== state.routeGeneration) return;
  state.products = products;
  setOptions($('#release-product-filter'), productFilterItems(products), state.productId, (item) => item.name);
  const releases = await getReleases(state.productId);
  if (generation !== state.routeGeneration) return;
  state.releases = releases;
  $('#release-rows').innerHTML = releases.length ? releases.map((item) => {
    const canDelete = item.status === 'OPEN' && item.candidateCount === 0;
    const deleteTitle = canDelete ? '删除空的发布版本' : '已有候选包或版本已封存，不能删除';
    return `<tr><td>${escapeHtml(item.productName)}</td><td class="fw-semibold">${escapeHtml(item.displayVersion ?? item.version)}${item.revision > 0 ? `<div class="small text-body-secondary">研发版本 ${escapeHtml(item.version)} · 内部修订 ${item.revision}</div>` : ''}</td><td>${item.completedCandidateCount}/${item.candidateCount}</td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span></td><td><div class="d-flex gap-1"><button class="btn btn-outline-primary btn-sm" data-release="${escapeHtml(item.releaseId)}" title="查看发布版本"><i class="bi bi-eye"></i><span class="visually-hidden">查看</span></button><button class="btn btn-outline-danger btn-sm" data-delete-release="${escapeHtml(item.releaseId)}" title="${deleteTitle}" aria-label="删除发布版本" ${canDelete ? '' : 'disabled'}><i class="bi bi-trash"></i><span class="visually-hidden">删除</span></button></div></td></tr>`;
  }).join('') : '<tr><td colspan="5" class="text-center text-body-secondary py-4">暂无发布版本</td></tr>';
  document.querySelectorAll('[data-release]').forEach((button) => button.addEventListener('click', () => navigate('release-detail', { releaseId: button.dataset.release })));
  document.querySelectorAll('[data-delete-release]').forEach((button) => button.addEventListener('click', () => deleteRelease(button.dataset.deleteRelease)));
}

async function deleteRelease(releaseId) {
  const release = state.releases.find((item) => item.releaseId === releaseId);
  if (!release || !await confirmAction({ title: '删除发布版本', message: `确定删除发布版本“${release.productName} ${release.version}”吗？`, detail: '仅允许删除没有候选包的开放版本。此操作不可恢复。' })) return;
  try { await api(`/api/v1/releases/${encodeURIComponent(releaseId)}`, { method: 'DELETE' }); showAlert('发布版本已删除'); await loadReleases(); }
  catch (error) { showAlert(error.message, 'danger'); }
}

async function loadRounds(generation = state.routeGeneration) {
  state.currentRound = null;
  const products = await getProducts();
  if (generation !== state.routeGeneration) return;
  state.products = products;
  if (state.releaseId && !state.productId) {
    const release = await api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}`);
    if (generation !== state.routeGeneration) return;
    state.productId = release.productId;
  }
  setOptions($('#round-product-filter'), productFilterItems(products), state.productId, (item) => item.name);
  const releases = await getReleases(state.productId);
  if (generation !== state.routeGeneration) return;
  state.releases = releases;
  state.currentRelease = releases.find((item) => item.releaseId === state.releaseId) ?? null;
  setOptions($('#round-release-filter'), releaseFilterItems(releases), state.releaseId, (item) => item.name);
  const rounds = await getRoundsByFilter({ productId: state.productId, releaseId: state.releaseId });
  if (generation !== state.routeGeneration) return;
  $('#round-rows').innerHTML = rounds.length ? rounds.map((round) => { const displayStatus = round.effectiveStatus ?? (round.releaseStatus === 'SEALED' ? 'SUPERSEDED' : round.approvalPending ? 'PENDING_APPROVAL' : round.status); const statusText = displayStatus === 'SUPERSEDED' && round.supersededByRoundNo ? `已由第 ${round.supersededByRoundNo} 轮替代` : statusLabel(displayStatus); return `<tr><td>${escapeHtml(round.productName)}</td><td>${escapeHtml(round.displayVersion ?? round.version)}</td><td class="fw-semibold">第 ${round.roundNo} 轮</td><td>${round.completedCandidateCount}/${round.candidateCount}</td><td><span class="badge ${statusClass(displayStatus)}">${statusText}</span></td><td>${new Date(round.createdAt).toLocaleString()}</td><td><button class="btn btn-outline-primary btn-sm" data-round-candidates="${escapeHtml(round.roundId)}" data-product="${escapeHtml(round.productId)}" data-release="${escapeHtml(round.releaseId)}" title="查看轮次详情和候选包"><i class="bi bi-eye"></i><span class="visually-hidden">查看轮次详情和候选包</span></button></td></tr>`; }).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无候选轮次</td></tr>';
  document.querySelectorAll('[data-round-candidates]').forEach((button) => button.addEventListener('click', () => navigate('release-detail', { productId: button.dataset.product, releaseId: button.dataset.release, roundId: button.dataset.roundCandidates })));
}

async function candidateRowsFor(releaseId) {
  return (await api(`/api/v1/candidates?releaseId=${encodeURIComponent(releaseId)}&limit=200`)).items;
}

function candidateInventoryItems(candidates, selectedRound = null) {
  const grouped = new Map();
  for (const candidate of candidates) {
    const digest = candidate.status === 'COMPLETED' && candidate.finalSha256 ? candidate.finalSha256.toLowerCase() : null;
    const key = digest ? `sha256:${digest}` : `candidate:${candidate.candidateId}`;
    const current = grouped.get(key) ?? { ...candidate, references: [], candidateIds: [] };
    current.candidateIds.push(candidate.candidateId);
    const references = selectedRound
      ? [{ roundId: selectedRound.roundId, roundNo: selectedRound.roundNo, releaseId: selectedRound.releaseId, displayVersion: selectedRound.displayVersion, productName: selectedRound.productName, packageKey: candidate.packageKey }]
      : (candidate.rounds ?? []);
    for (const reference of references) {
      const signature = `${reference.roundId ?? ''}:${reference.packageKey ?? ''}`;
      if (!current.references.some((item) => `${item.roundId ?? ''}:${item.packageKey ?? ''}` === signature)) current.references.push(reference);
    }
    grouped.set(key, current);
  }
  return [...grouped.values()].map((item) => ({ ...item, references: item.references.sort((a, b) => `${a.displayVersion ?? ''}:${a.roundNo ?? ''}:${a.packageKey ?? ''}`.localeCompare(`${b.displayVersion ?? ''}:${b.roundNo ?? ''}:${b.packageKey ?? ''}`)) }));
}

async function loadCandidates(generation = state.routeGeneration) {
  const products = await getProducts();
  if (generation !== state.routeGeneration) return;
  state.products = products;
  let selectedRound = null;
  if (state.roundId) {
    selectedRound = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}`);
    if (generation !== state.routeGeneration) return;
    state.releaseId = selectedRound.releaseId;
    state.productId = selectedRound.productId;
  }
  if (state.releaseId && !state.productId) {
    const release = await api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}`);
    if (generation !== state.routeGeneration) return;
    state.productId = release.productId;
  }
  setOptions($('#candidate-product-filter'), productFilterItems(products), state.productId, (item) => item.name);
  const releases = await getReleases(state.productId);
  if (generation !== state.routeGeneration) return;
  state.releases = releases;
  state.currentRelease = releases.find((item) => item.releaseId === state.releaseId) ?? null;
  setOptions($('#candidate-release-filter'), releaseFilterItems(releases), state.releaseId, (item) => item.name);
  const rounds = await getRoundsByFilter({ productId: state.productId, releaseId: state.releaseId });
  if (generation !== state.routeGeneration) return;
  setOptions($('#candidate-round-filter'), roundFilterItems(rounds), state.roundId, (item) => item.name, '全部');

  let candidates;
  if (state.roundId) candidates = (await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/candidates`)).items;
  else if (state.releaseId) candidates = await candidateRowsFor(state.releaseId);
  else if (state.productId) candidates = (await api(`/api/v1/candidates?productId=${encodeURIComponent(state.productId)}&limit=200`)).items;
  else candidates = (await api('/api/v1/candidates?limit=200')).items;
  if (generation !== state.routeGeneration) return;
  state.currentRound = selectedRound;
  const inventory = candidateInventoryItems(candidates, selectedRound);
  const completed = candidates.filter((item) => item.status === 'COMPLETED' && item.finalSha256);
  const uniqueDigests = new Set(completed.map((item) => item.finalSha256.toLowerCase()));
  const pending = candidates.filter((item) => item.status !== 'COMPLETED');
  $('#candidate-summary').innerHTML = [
    ['候选记录', candidates.length],
    ['已校验文件', completed.length],
    ['唯一文件（SHA-256）', uniqueDigests.size],
    ['重复引用', Math.max(0, completed.length - uniqueDigests.size)],
    ['待接收 / 异常', pending.length]
  ].map(([label, value]) => `<div class="col-6 col-md"><div class="border rounded p-2 h-100"><div class="small text-body-secondary">${escapeHtml(label)}</div><div class="h5 mb-0 mt-1">${escapeHtml(value)}</div></div></div>`).join('');
  $('#candidate-rows').innerHTML = inventory.length ? inventory.map((item) => {
    const references = item.references;
    const products = [...new Set(references.map((reference) => reference.productName).filter(Boolean))];
    const versions = [...new Set(references.map((reference) => reference.displayVersion ?? '-'))];
    const rounds = [...new Set(references.map((reference) => `${reference.displayVersion ?? '-'} · 第 ${reference.roundNo ?? '-'} 轮`))];
    const packageKeys = [...new Set(references.map((reference) => reference.packageKey).filter(Boolean))];
    return `<tr><td>${escapeHtml(products.join('、') || item.productName || '-')}</td><td>${escapeHtml(versions.join('、') || item.releaseDisplayVersion || item.releaseVersion || '-')}</td><td class="small">${rounds.length ? rounds.map((round) => escapeHtml(round)).join('<br>') : '-'}</td><td>${escapeHtml(item.type ?? '-')}</td><td class="text-break">${escapeHtml(packageKeys.join('、') || item.packageKey || '-')}</td><td class="file-name text-break">${escapeHtml(item.fileName)}</td><td>${escapeHtml(item.architecture ?? '-')}</td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span>${item.candidateIds.length > 1 ? `<div class="small text-body-secondary mt-1">${item.candidateIds.length} 条候选记录共用此 SHA-256</div>` : ''}</td><td><button class="btn btn-outline-primary btn-sm" data-candidate-open="${escapeHtml(item.candidateId)}" title="查看文件"><i class="bi bi-eye"></i><span class="visually-hidden">查看文件</span></button></td></tr>`;
  }).join('') : '<tr><td colspan="9" class="text-center text-body-secondary py-4">暂无候选包</td></tr>';
  document.querySelectorAll('[data-candidate-open]').forEach((button) => button.addEventListener('click', () => navigate('candidate-detail', { candidateId: button.dataset.candidateOpen, ...paramsForState() })));
}

async function loadReleaseDetail(generation = state.routeGeneration) {
  if (!state.releaseId) return navigate('releases');
  // Clear detail state before loading another release. Otherwise the previous
  // release's freeze panel can remain visible while the new release is loaded
  // (and is especially noticeable when the new release has no rounds yet).
  state.currentRound = null;
  state.currentRoundCandidates = [];
  state.currentFreeze = null;
  $('#round-summary').innerHTML = '';
  $('#round-audit').innerHTML = '';
  $('#round-freeze-panel').innerHTML = '';
  $('#round-candidate-rows').innerHTML = '';
  $('#round-queue-summary').textContent = '';
  const [release, roundsResponse] = await Promise.all([
    api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}`),
    api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}/rounds`)
  ]);
  const rounds = roundsResponse.items;
  state.nextRoundPreview = roundsResponse.nextRound;
  if (generation !== state.routeGeneration) return;
  state.productId = release.productId;
  state.currentRelease = release;
  $('#release-title').textContent = `${release.productName} / ${release.displayVersion ?? release.version}`;
  $('#release-fields').innerHTML = [['软件产品', escapeHtml(release.productName)], ['研发版本', escapeHtml(release.version)], ['内部修订号', release.revision > 0 ? `r${release.revision}` : '首版（无后缀）'], ['版本间关系', release.baseReleaseDisplayVersion ? `继承 ${escapeHtml(release.baseReleaseDisplayVersion)} 的已固化清单` : '首个内部版本'], ['状态', `<span class="badge ${statusClass(release.status)}">${statusLabel(release.status)}</span>`]].map(([label, value]) => `<dt class="col-sm-3 col-lg-2">${label}</dt><dd class="col-sm-9 col-lg-10">${value}</dd>`).join('');
  $('#round-select').innerHTML = rounds.length ? rounds.map((round) => `<option value="${escapeHtml(round.roundId)}">第 ${round.roundNo} 轮 · ${round.completedCandidateCount}/${round.candidateCount} 已完成</option>`).join('') : '<option value="">暂无轮次</option>';
  $('#new-round-button').disabled = !roundsResponse.nextRound?.canCreate;
  $('#new-round-button').title = roundsResponse.nextRound?.blockedReason ?? '基于当前最新轮次创建下一轮';
  $('#new-round-button').disabled = release.approvalPending || !roundsResponse.nextRound?.canCreate;
  $('#create-revision-button').hidden = release.status !== 'SEALED';
  $('#create-revision-button').onclick = () => {
    revisionBaseReleaseId = release.releaseId;
    $('#release-modal-title').textContent = '创建内部修订版';
    $('#release-product').innerHTML = `<option value="${escapeHtml(release.productId)}">${escapeHtml(release.productName)}</option>`;
    $('#release-product').value = release.productId;
    $('#release-product').disabled = true;
    $('#release-version').value = release.version;
    $('#release-version').readOnly = true;
    $('#release-version-help').textContent = '内部修订版固定沿用该研发版本号，并继承上一已固化版本的清单。';
    modal('release').show();
  };
  if (!rounds.some((round) => round.roundId === state.roundId)) state.roundId = rounds[0]?.roundId ?? null;
  $('#round-select').value = state.roundId ?? '';
  if (state.roundId) await loadRound(generation); else renderRound(null, []);
}

async function loadRound(generation = state.routeGeneration) {
  if (!state.roundId) return;
  const [round, candidates] = await Promise.all([
    api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}`),
    api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/candidates`)
  ]);
  if (generation !== state.routeGeneration) return;
  state.productId = round.productId;
  state.releaseId = round.releaseId;
  state.currentRound = round;
  state.currentRoundCandidates = candidates.items;
  await renderRound(round, candidates.items);
  await loadRoundFreeze(round, candidates.items, generation);
}

async function loadRoundFreeze(round, candidates, generation = state.routeGeneration) {
  const panel = $('#round-freeze-panel');
  const response = await api(`/api/v1/rounds/${encodeURIComponent(round.roundId)}/freezes`);
  if (generation !== state.routeGeneration || state.roundId !== round.roundId) return;
  const freeze = response.item;
  state.currentFreeze = freeze;
  const complete = candidates.length > 0 && candidates.every((item) => item.status === 'COMPLETED' && item.finalSha256);
  const canSubmit = hasRole('EDGE_OPERATOR');
  const locked = ['PENDING_APPROVAL', 'APPROVED'].includes(freeze?.status);
  const readOnly = round.readOnly || locked || round.releaseStatus === 'SEALED' || round.approvalPending;
  for (const selector of ['#new-package-button', '#import-packages-button', '#batch-receive-button']) $(selector).disabled = readOnly;
  document.querySelectorAll('[data-round-candidate-delete]').forEach((button) => { button.disabled = readOnly; button.title = round.readOnly ? round.readOnlyReason : locked ? '轮次审批或固化期间不可修改' : button.title; });
  let html = '';
  if (!freeze) {
    html = `<div class="alert alert-light border d-flex justify-content-between align-items-center gap-2 mb-0"><span>本轮尚未提交验证报告。${complete ? '所有候选包均已完成，可以申请固化。' : '需先完成本轮全部候选包接收。'}</span>${canSubmit && !round.readOnly ? `<button id="freeze-start" class="btn btn-outline-primary btn-sm" ${complete ? '' : 'disabled'}><i class="bi bi-file-earmark-check me-1"></i>提交验证报告</button>` : ''}</div>`;
  } else {
    const transferDisplayStatus = freeze.transferStatus ? displayTransferState(freeze.transferStatus, { retryAt: freeze.transferRetryAt, hasError: Boolean(freeze.transferLastError) }) : null;
    const transferText = freeze.status === 'APPROVED' ? `<div class="col-12"><strong>正式制品传输：</strong><span class="badge ${transferDisplayStatus === 'COMPLETED' ? 'text-bg-success' : transferDisplayStatus === 'FAILED' ? 'text-bg-danger' : transferDisplayStatus === 'RETRY_WAIT' ? 'text-bg-warning' : 'text-bg-primary'}">${statusLabel(transferDisplayStatus ?? freeze.transferStatus)}</span>${freeze.transferTaskId ? `<span class="small text-body-secondary ms-2 font-monospace">任务 ${escapeHtml(freeze.transferTaskId)}</span>` : ''}${freeze.transferAttempts ? `<span class="small text-body-secondary ms-2">已尝试 ${freeze.transferAttempts} 次</span>` : ''}${freeze.transferRetryExhausted ? '<span class="small text-danger ms-2">已停止自动重试</span>' : freeze.transferRetryAt ? `<span class="small text-warning-emphasis ms-2">下次重试：${escapeHtml(new Date(freeze.transferRetryAt).toLocaleString())}</span>` : ''}${freeze.transferLastError ? `<div class="alert alert-danger py-2 mt-2 mb-0 text-break"><strong>${freeze.transferErrorCode ? `错误码 ${escapeHtml(freeze.transferErrorCode)}：` : '最近错误：'}</strong>${escapeHtml(freeze.transferLastError)}</div>` : ''}</div>` : '';
    const submitter = freeze.submittedByDisplayName && freeze.submittedByUsername ? `${freeze.submittedByDisplayName}（${freeze.submittedByUsername}）` : userLabel(freeze.submittedBy);
    html = `<div class="card card-outline ${freeze.status === 'APPROVED' ? 'card-success' : freeze.status === 'REJECTED' ? 'card-danger' : freeze.status === 'WITHDRAWN' ? 'card-secondary' : 'card-primary'} mb-0"><div class="card-header d-flex align-items-center"><strong>验证报告与版本固化</strong><span class="badge ms-auto ${statusClass(freeze.status)}">${statusLabel(freeze.status)}</span></div><div class="card-body"><div class="row g-2"><div class="col-lg-4"><strong>报告：</strong>${escapeHtml(freeze.reportTitle)}</div><div class="col-lg-4"><strong>结论：</strong>${freeze.conclusion === 'PASS' ? '通过' : '有条件通过'}</div><div class="col-lg-4"><strong>提交人：</strong>${escapeHtml(submitter)}</div><div class="col-lg-4"><strong>提交时间：</strong>${escapeHtml(freeze.submittedAt ?? freeze.createdAt)}</div><div class="col-12"><strong>验证环境：</strong><span class="text-break">${escapeHtml(freeze.environment ?? '-')}</span></div><div class="col-12"><strong>清单摘要：</strong><code class="text-break">${escapeHtml(freeze.manifestSha256)}</code></div>${freeze.status === 'PENDING_APPROVAL' ? `<div class="col-12"><strong>审批状态：</strong>${escapeHtml(internalDeliveryLabel(freeze.dispatchStatus))}</div>` : ''}${freeze.status === 'WITHDRAWN' ? '<div class="col-12"><strong>审批状态：</strong>Core 已撤回本次申请，可重新提交验证报告。</div>' : ''}${transferText}${freeze.status === 'REJECTED' && freeze.decisionComment ? `<div class="col-12"><strong>审批意见：</strong>${escapeHtml(freeze.decisionComment)}</div>` : ''}${freeze.reportFileName ? `<div class="col-12"><a href="/api/v1/freezes/${encodeURIComponent(freeze.freezeId)}/report-file" target="_blank" rel="noopener">下载验证报告</a><span class="small text-body-secondary ms-2">${escapeHtml(freeze.reportFileName)}</span></div>` : ''}</div>${freeze.status === 'DRAFT' && canSubmit ? '<button id="freeze-resume" class="btn btn-outline-primary btn-sm mt-3">继续上传并提交</button>' : ''}${['REJECTED', 'WITHDRAWN'].includes(freeze.status) && canSubmit ? '<button id="freeze-start" class="btn btn-outline-primary btn-sm mt-3">重新提交验证报告</button>' : ''}</div></div>`;
  }
  panel.innerHTML = html;
  $('#freeze-start')?.addEventListener('click', () => openFreezeForm());
  $('#freeze-resume')?.addEventListener('click', () => openFreezeForm(freeze));
}

function openFreezeForm(draft = null) {
  state.freezeDraftId = draft?.freezeId ?? null;
  $('#freeze-metadata-fields').classList.toggle('d-none', Boolean(draft));
  $('#freeze-title').required = !draft;
  $('#freeze-environment').required = !draft;
  $('#freeze-report').value = '';
  $('#freeze-report').required = true;
  modal('freeze').show();
}

async function renderRound(round, candidates) {
  if (!round) {
    state.currentFreeze = null;
    state.currentRoundQueue = [];
    for (const selector of ['#new-package-button', '#import-packages-button', '#batch-receive-button']) $(selector).disabled = true;
    $('#round-freeze-panel').innerHTML = '';
  }
  $('#delete-empty-round-button').hidden = !round?.canDeleteEmpty;
  $('#delete-empty-round-button').title = round?.staleEmptyBaseline ? '删除因旧版轮次编辑规则造成的陈旧空轮次' : round?.canDeleteEmpty ? '删除没有候选包变更的最新空轮次' : '仅最新且无候选包变更、附件或审批记录的轮次可删除';
  $('#round-summary').innerHTML = round ? `<div class="col-md-4"><div class="small-box text-bg-primary"><div class="inner"><h3>${round.roundNo}</h3><p>候选轮次</p></div></div></div><div class="col-md-4"><div class="small-box text-bg-success"><div class="inner"><h3>${round.completedCandidateCount}/${round.candidateCount}</h3><p>已完成候选包</p></div></div></div><div class="col-md-4"><div class="small-box text-bg-secondary"><div class="inner"><h3>${round.baseRoundId ? '继承' : '初始'}</h3><p>轮次来源</p></div></div></div>${round.releaseStatus === 'SEALED' ? '<div class="col-12"><div class="alert alert-success py-2 mb-0">该发布版本已审批通过并封存。需更新时，请创建新的内部修订版；该修订版会继承此版本的固化清单。</div></div>' : round.staleEmptyBaseline ? '<div class="col-12"><div class="alert alert-warning py-2 mb-0">本轮创建后，上一轮又新增了候选包；本轮当前显示的移除差异来自旧版允许修改历史轮次的行为。删除本轮后，上一轮将恢复为可编辑。</div></div>' : round.readOnly ? '<div class="col-12"><div class="alert alert-secondary py-2 mb-0">本轮已有后续轮次，当前为只读历史记录。</div></div>' : !round.hasChanges && round.baseRoundId ? '<div class="col-12"><div class="alert alert-warning py-2 mb-0">本轮仅继承基线，尚无候选包变更；可以删除空轮次，暂不能继续创建下一轮。</div></div>' : ''}` : '';
  const delta = round?.changeSummary;
  $('#round-audit').innerHTML = round ? `<div class="card card-outline card-secondary mb-0"><div class="card-body py-2"><div><strong>本轮说明：</strong>${escapeHtml(round.changeNote || '未填写')}</div><div class="small text-body-secondary mt-1">创建人：${escapeHtml(userLabel(round.createdBy))}　创建时间：${escapeHtml(round.createdAt || '-')}</div>${delta ? `<div class="small text-body-secondary mt-1">相对上一轮变更：新增 ${delta.added}、替换 ${delta.replaced}、移除 ${delta.removed}</div>` : ''}${round.readOnly ? `<div class="small text-body-secondary mt-1">${escapeHtml(round.readOnlyReason)}</div>` : ''}${round.attachments?.length ? `<div class="small mt-1">留痕附件：${round.attachments.map((item) => `<a class="me-2" href="/api/v1/round-attachments/${encodeURIComponent(item.attachmentId)}/file" target="_blank" rel="noopener">${escapeHtml(item.fileName)}</a><span class="text-body-secondary me-2">(${formatBytes(item.fileSize)})</span>`).join('')}</div>` : '<div class="small text-body-secondary mt-1">暂无留痕附件</div>'}</div></div>` : '';
  $('#round-candidate-rows').innerHTML = candidates.length ? candidates.map((item) => { const inheritedVersion = item.inheritedFromReleaseVersion ? `${item.inheritedFromReleaseVersion}${item.inheritedFromReleaseRevision > 0 ? `-r${item.inheritedFromReleaseRevision}` : ''} · ` : ''; return `<tr><td>${escapeHtml(item.type ?? '-')}</td><td>${escapeHtml(item.packageKey ?? item.fileName)}</td><td>${escapeHtml(item.fileName)}</td><td>${escapeHtml(item.architecture ?? '-')}</td><td class="font-monospace small">${escapeHtml(item.finalSha256 ?? item.expectedSha256 ?? '-')}</td><td><span class="badge ${item.mappingSource === 'INHERITED' ? 'text-bg-info' : 'text-bg-secondary'}" title="${item.mappingSource === 'INHERITED' ? '沿用已有候选清单，没有复制文件' : '在本轮加入的候选包'}">${item.mappingSource === 'INHERITED' ? `继承 ${escapeHtml(inheritedVersion)}第 ${item.inheritedFromRoundNo ?? '未知'} 轮` : '本轮新增'}</span></td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span></td><td><div class="d-flex gap-1"><button class="btn btn-outline-primary btn-sm" data-candidate="${escapeHtml(item.candidateId)}" title="查看候选包"><i class="bi bi-eye"></i><span class="visually-hidden">查看</span></button><button class="btn btn-outline-warning btn-sm" data-round-candidate-delete="${escapeHtml(item.candidateId)}" title="移出本轮；保留候选记录和文件" ${round?.readOnly || round?.releaseStatus === 'SEALED' || round?.approvalPending ? 'disabled' : ''}><i class="bi bi-dash-circle"></i><span class="visually-hidden">移出本轮</span></button></div></td></tr>`; }).join('') : '<tr><td colspan="8" class="text-center text-body-secondary py-4">本轮暂无候选包</td></tr>';
  for (const selector of ['#new-package-button', '#import-packages-button']) $(selector).disabled = !round || round.readOnly;
  document.querySelectorAll('[data-candidate]').forEach((button) => button.addEventListener('click', () => navigate('candidate-detail', { candidateId: button.dataset.candidate, ...paramsForState() })));
  document.querySelectorAll('[data-round-candidate-delete]').forEach((button) => button.addEventListener('click', () => detachRoundCandidate(button.dataset.roundCandidateDelete)));
  $('#delete-empty-round-button').onclick = round?.canDeleteEmpty ? () => deleteEmptyRound(round) : null;
  await updateRoundQueue(round, candidates);
}

async function updateRoundQueue(round, candidates) {
  if (!round) { state.currentRoundQueue = []; return; }
  try {
    const queue = (await api('/api/v1/receive-queue')).items.filter((item) => candidates.some((candidate) => candidate.candidateId === item.candidate_id));
    state.currentRoundQueue = queue;
    const completed = queue.filter((item) => item.status === 'COMPLETED').length;
    const active = queue.filter((item) => item.status === 'RUNNING').length;
    const queued = queue.filter((item) => item.status === 'QUEUED').length;
    const paused = queue.filter((item) => ['PAUSED', 'FAILED'].includes(item.status)).length;
    $('#round-queue-summary').textContent = queue.length ? `后台队列：${completed} 已完成，${active} 下载中，${queued} 排队中${paused ? `，${paused} 暂停/失败` : ''}` : '后台队列：尚未提交';
    const activeIds = new Set(queue.filter((item) => ['QUEUED', 'RUNNING'].includes(item.status)).map((item) => item.candidate_id));
    const canEnqueue = candidates.some((candidate) => candidate.status !== 'COMPLETED' && candidate.status !== 'RECEIVING' && !activeIds.has(candidate.candidateId));
    const button = $('#batch-receive-button');
    button.disabled = state.batchSubmitting || !canEnqueue;
    button.innerHTML = active || queued ? `<i class="bi bi-cloud-download me-1"></i>继续接收未入队包` : '<i class="bi bi-cloud-download me-1"></i>批量接收本轮';
  } catch { state.currentRoundQueue = []; $('#round-queue-summary').textContent = '后台队列状态暂不可用'; }
}

async function batchReceiveRound() {
  if (!state.roundId) return;
  const button = $('#batch-receive-button');
  if (button.disabled) return;
  state.batchSubmitting = true;
  button.disabled = true;
  try {
    const result = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/receive-batch`, { method: 'POST', body: '{}' });
    const notes = [];
    if (result.enqueued) notes.push(`${result.enqueued} 个新加入队列`);
    if (result.alreadyActive) notes.push(`${result.alreadyActive} 个已在接收或排队`);
    if (result.completed) notes.push(`${result.completed} 个已完成`);
    showAlert(notes.length ? `批量接收处理完成：${notes.join('，')}` : '本轮没有需要接收的候选包');
    await loadRound(state.routeGeneration);
  } catch (error) { showAlert(error.message, 'danger'); }
  finally {
    state.batchSubmitting = false;
    if (state.currentRound && state.roundId) loadRound(state.routeGeneration).catch(() => {});
  }
}

async function detachRoundCandidate(candidateId) {
  if (!state.roundId || !await confirmAction({ title: '从本轮移除候选包', message: '确定从当前候选轮次移除这个候选包吗？', detail: '只解除当前轮次的引用，候选记录和已下载文件会保留，可被其他轮次继续使用。', confirmText: '从本轮移除', variant: 'warning' })) return;
  try {
    await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/candidates/${encodeURIComponent(candidateId)}`, { method: 'DELETE' });
    showAlert('候选包已从当前轮次移除');
    await loadRound(state.routeGeneration);
  } catch (error) { showAlert(error.message, 'danger'); }
}

async function deleteEmptyRound(round) {
  if (!round?.canDeleteEmpty) return;
  const confirmed = await confirmAction({
    title: '删除空候选轮次',
    message: `确定删除第 ${round.roundNo} 轮吗？`,
    detail: round.staleEmptyBaseline ? '本轮创建后，上一轮又新增了候选包，导致本轮被误判为移除了这些包。删除后上一轮恢复为当前可编辑轮次；恢复删除会保留审计记录。' : '本轮没有相对上一轮的候选包变更。删除后上一轮恢复为当前可编辑轮次；删除动作会保留审计记录。',
    confirmText: '删除空轮次',
    variant: 'danger'
  });
  if (!confirmed) return;
  try {
    await api(`/api/v1/rounds/${encodeURIComponent(round.roundId)}`, { method: 'DELETE' });
    showAlert(`第 ${round.roundNo} 轮空轮次已删除`);
    navigate('release-detail', { releaseId: round.releaseId, roundId: round.baseRoundId });
  } catch (error) { showAlert(error.message, 'danger'); }
}

async function loadCandidateDetail(generation = state.routeGeneration) {
  if (!state.candidateId) return navigate('candidates');
  const candidate = await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}`);
  const parts = await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}/parts`);
  if (generation !== state.routeGeneration) return;
  state.currentRound = state.roundId ? await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}`) : null;
  state.productId = state.currentRound?.productId ?? candidate.productId ?? null;
  state.releaseId = state.currentRound?.releaseId ?? candidate.releaseId ?? null;
  state.currentCandidate = candidate;
  renderCandidate(candidate, parts);
  if (['RECEIVING', 'ASSEMBLING'].includes(candidate.status)) startCandidatePolling();
}

function renderCandidate(candidate, parts) {
  const readOnly = !state.roundId;
  ['candidate-edit-button', 'candidate-delete-button', 'receive-button', 'pause-button'].forEach((id) => $(`#${id}`).classList.toggle('d-none', readOnly));
  const transferVisible = candidate.status !== 'COMPLETED';
  $('#candidate-transfer-controls').classList.toggle('d-none', !transferVisible);
  $('#candidate-transfer-progress').classList.toggle('d-none', !transferVisible);
  $('#candidate-title').textContent = candidate.fileName;
  $('#candidate-delete-button').innerHTML = '<i class="bi bi-trash me-1"></i>永久删除';
  $('#candidate-back-button').innerHTML = `<i class="bi bi-arrow-left me-1"></i>${state.roundId ? '返回候选轮次' : '返回候选包'}`;
  const declaredDigest = `<span class="font-monospace small text-break">MD5：${escapeHtml(candidate.expectedMd5 ?? '-')}<br>SHA-256：${escapeHtml(candidate.expectedSha256 ?? '-')}</span>`;
  const measuredDigest = `<span class="font-monospace small text-break">MD5：${escapeHtml(candidate.finalMd5 ?? '-')}<br>SHA-256：${escapeHtml(candidate.finalSha256 ?? (candidate.status === 'COMPLETED' ? '-' : '接收完成后生成'))}</span>`;
  const candidateDisplayVersion = candidate.releaseRevision > 0 ? `${candidate.releaseVersion}-r${candidate.releaseRevision}` : candidate.releaseVersion;
  const fields = [['候选 ID', `<span class="font-monospace">${escapeHtml(candidate.candidateId)}</span>`], ['软件 / 发布版本', `${escapeHtml(candidate.productName ?? '-')} / ${escapeHtml(candidateDisplayVersion ?? candidate.version)}`], ['研发地址', `<span class="text-break">${escapeHtml(candidate.sourceUrl)}</span>`], ['包标识', escapeHtml(candidate.packageKey ?? '-')], ['版本 / 架构', `${escapeHtml(candidate.version)} / ${escapeHtml(candidate.architecture ?? '-')}`], ['大小', formatBytes(candidate.size)], ['声明摘要', declaredDigest], ['实测摘要', measuredDigest], ['状态', `<span class="badge ${statusClass(candidate.status)}">${statusLabel(candidate.status)}</span>`], ...(candidate.error ? [['错误信息', `<span class="text-danger text-break">${escapeHtml(candidate.error)}</span>`]] : [])];
  const metadata = candidate.metadata ?? {};
  if (metadata.type || metadata.deploymentPackage || metadata.purpose || metadata.applicableProducts?.length || metadata.displaySize || metadata.documentationUrl || metadata.notes) {
    const imported = [
      ['类型', metadata.type], ['部署包', metadata.deploymentPackage], ['用途', metadata.purpose],
      ['适用产品', metadata.applicableProducts?.join('、')], ['表格大小说明', metadata.displaySize],
      ['部署文档', metadata.documentationUrl], ['备注', metadata.notes],
      ['导入来源', metadata.sourceSheet ? `${metadata.sourceSheet} 第 ${metadata.sourceRow} 行` : null]
    ].filter(([, value]) => value);
    fields.push(...imported.map(([label, value]) => [label, escapeHtml(value)]));
  }
  $('#candidate-fields').innerHTML = fields.map(([label, value]) => `<dt class="col-sm-3 col-lg-2">${label}</dt><dd class="col-sm-9 col-lg-10">${value}</dd>`).join('');
  const completed = parts.completedParts.length;
  const count = parts.chunkCount;
  const active = parts.transfer;
  const activeBytes = active?.bytes ?? 0;
  const activeSize = active ? (candidate.chunkSize ?? 0) : 0;
  const progress = count === 0 ? 0 : Math.min(100, Math.round(((completed + (activeSize ? activeBytes / activeSize : 0)) / count) * 100));
  $('#detail-progress').style.width = `${progress}%`;
  $('#detail-progress').textContent = `${progress}%（${completed}/${count}）`;
  $('#detail-progress').classList.toggle('progress-bar-animated', ['RECEIVING', 'PARTIAL', 'ASSEMBLING'].includes(candidate.status));
  $('#detail-progress-text').textContent = candidate.status === 'ASSEMBLING' ? `分块已全部接收，正在组装文件并校验摘要（${completed}/${count}）` : count ? `已接收 ${formatBytes(completed * (candidate.chunkSize ?? 0) + activeBytes)}，${completed}/${count} 个分块，${progress}%` : '等待获取文件大小';
  $('#receive-button').disabled = candidate.status === 'COMPLETED' || candidate.status === 'RECEIVING';
  $('#receive-button').innerHTML = candidate.status === 'PARTIAL' ? '<i class="bi bi-play-circle me-1"></i>继续接收' : '<i class="bi bi-cloud-download me-1"></i>开始接收';
  $('#pause-button').disabled = !['RECEIVING'].includes(candidate.status);
  $('#pause-button').innerHTML = '<i class="bi bi-pause-circle me-1"></i>暂停接收';
  $('#candidate-edit-button').disabled = ['RECEIVING', 'ASSEMBLING', 'COMPLETED'].includes(candidate.status);
  $('#candidate-delete-button').disabled = ['RECEIVING', 'ASSEMBLING'].includes(candidate.status);
}

async function receiveCandidate() {
  try {
    await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}/receive`, { method: 'POST', body: '{}' });
    showAlert('接收任务已启动');
    startCandidatePolling();
  } catch (error) { showAlert(error.message, 'danger'); }
}

function startCandidatePolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(async () => {
    if (state.view !== 'candidate-detail' || !state.candidateId) return window.clearInterval(state.pollTimer);
    try {
      const candidate = await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}`);
      const parts = await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}/parts`);
      renderCandidate(candidate, parts);
      if (['COMPLETED', 'FAILED', 'PARTIAL'].includes(candidate.status)) window.clearInterval(state.pollTimer);
    } catch { window.clearInterval(state.pollTimer); }
  }, 1000);
}

function startRoundQueuePolling() {
  window.clearTimeout(state.queueTimer);
  scheduleRoundQueuePolling();
}

function scheduleRoundQueuePolling() {
  if (state.view !== 'release-detail' || !state.roundId) return;
  if (['APPROVED', 'REJECTED', 'WITHDRAWN'].includes(state.currentFreeze?.status)) { state.queueTimer = null; return; }
  const receiving = state.currentRoundCandidates.some((candidate) => ['RECEIVING', 'ASSEMBLING'].includes(candidate.status));
  const queued = state.currentRoundQueue.some((item) => ['QUEUED', 'RUNNING'].includes(item.status));
  const delay = receiving || queued ? 2000 : state.currentFreeze?.status === 'PENDING_APPROVAL' ? 10000 : 30000;
  state.queueTimer = window.setTimeout(async () => {
    if (state.view !== 'release-detail' || !state.roundId) return;
    try { await loadRound(state.routeGeneration); } catch {}
    scheduleRoundQueuePolling();
  }, delay);
}

async function pauseCandidate() {
  const button = $('#pause-button');
  button.disabled = true;
  button.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>正在暂停';
  try {
    await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}/cancel-receive`, { method: 'POST', body: '{}' });
    showAlert('接收已暂停');
    await loadCandidateDetail(state.routeGeneration);
  } catch (error) {
    showAlert(error.message, 'danger');
    button.disabled = false;
    button.innerHTML = '<i class="bi bi-pause-circle me-1"></i>暂停接收';
  }
}

function openCandidateEditor() {
  const candidate = state.currentCandidate;
  if (!candidate) return;
  $('#package-modal-title').textContent = '编辑候选包';
  $('#package-submit-button').textContent = '确定';
  $('#package-form').dataset.editingCandidate = candidate.candidateId;
  $('#package-url').value = candidate.sourceUrl ?? ''; $('#package-file-name').value = candidate.fileName ?? '';
  $('#package-key').value = candidate.packageKey ?? ''; $('#package-version').value = candidate.version ?? '';
  $('#package-architecture').value = candidate.architecture ?? ''; $('#package-size').value = candidate.size ?? '';
  $('#package-md5').value = candidate.expectedMd5 ?? ''; $('#package-sha256').value = candidate.expectedSha256 ?? '';
  $('#package-targets').value = (candidate.targets ?? []).join(',');
  modal('package').show();
}

function resetImportDialog() {
  importPreviewRequestId += 1;
  state.importFile = null;
  state.importPreview = null;
  $('#import-file').value = '';
  $('#import-sheet').innerHTML = '';
  $('#import-sheet').disabled = true;
  $('#import-preview-button').disabled = true;
  $('#import-confirm-button').disabled = true;
  $('#import-summary').textContent = '';
  $('#import-mapping').classList.add('d-none');
  resetImportPreviewTable('请选择 Excel 文件并读取预览');
}

function resetImportPreviewTable(message) {
  $('#import-preview-head').innerHTML = '<tr><th><input id="import-select-all" type="checkbox" class="form-check-input" aria-label="选择全部有效行"></th><th>行</th><th>包标识（可修改）</th><th>文件名</th><th>架构</th><th>摘要</th><th>结果</th></tr>';
  $('#import-preview-rows').innerHTML = `<tr><td colspan="7" class="text-center text-body-secondary py-4">${escapeHtml(message)}</td></tr>`;
}

async function readImportPreview() {
  if (!state.importFile || !state.roundId) return;
  const selectedSheet = $('#import-sheet').value;
  const preserveCurrentMapping = state.importPreview?.sheet === selectedSheet;
  const requestId = ++importPreviewRequestId;
  const button = $('#import-preview-button');
  button.disabled = true;
  button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>读取中';
  state.importPreview = null;
  $('#import-confirm-button').disabled = true;
  $('#import-summary').textContent = '正在读取所选工作表…';
  $('#import-mapping').classList.add('d-none');
  $('#import-preview-rows').innerHTML = '<tr><td colspan="7" class="text-center text-body-secondary py-4">正在读取工作表预览…</td></tr>';
  try {
    const params = new URLSearchParams();
    if (selectedSheet) params.set('sheet', selectedSheet);
    const columnMapping = {};
    if (preserveCurrentMapping) document.querySelectorAll('[data-import-mapping]').forEach((select) => { columnMapping[select.dataset.importMapping] = select.value === '' ? null : Number(select.value); });
    if (Object.keys(columnMapping).length) params.set('mapping', JSON.stringify(columnMapping));
    const preview = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/import-preview${params.toString() ? `?${params}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: await state.importFile.arrayBuffer() });
    if (requestId !== importPreviewRequestId) return;
    state.importPreview = preview;
    const currentSheet = $('#import-sheet').value;
    $('#import-sheet').innerHTML = preview.sheets.map((sheet) => `<option value="${escapeHtml(sheet.name)}">${escapeHtml(sheet.name)}（表头第 ${sheet.headerRow} 行，识别 ${sheet.recognizedColumns} 列）</option>`).join('');
    $('#import-sheet').disabled = false;
    $('#import-sheet').value = preview.sheet || currentSheet;
    renderImportMapping(preview);
    renderImportPreview(preview);
  } catch (error) {
    if (requestId !== importPreviewRequestId) return;
    $('#import-summary').innerHTML = `<span class="text-danger">${escapeHtml(error.message)}</span>`;
    $('#import-preview-rows').innerHTML = '<tr><td colspan="7" class="text-center text-body-secondary py-4">所选工作表无法生成候选包预览，请检查表头或切换其他工作表</td></tr>';
  } finally {
    if (requestId === importPreviewRequestId) {
      button.disabled = !state.importFile;
      button.innerHTML = '读取预览';
    }
  }
}

function renderImportMapping(preview) {
  const fields = [
    ['sourceUrl', '下载地址', true], ['fileName', '文件名', false], ['packageKey', '包标识', false], ['deploymentPackage', '部署包名称', false],
    ['architecture', '架构', false], ['digest', '摘要', false], ['displaySize', '大小说明', false],
    ['type', '类型', false], ['applicableProducts', '所属产品', false], ['purpose', '用途', false],
    ['documentationUrl', '部署文档', false], ['notes', '备注', false], ['targets', '目标范围', false]
  ];
  $('#import-mapping').innerHTML = fields.map(([field, label, required]) => {
    const selected = preview.mapping[field];
    const options = `<option value="">${required ? '请选择列' : '不映射'}</option>${preview.columns.map((column) => `<option value="${column.index}" ${column.index === selected ? 'selected' : ''}>${escapeHtml(column.title)}</option>`).join('')}`;
    return `<div class="col-6 col-md-4 col-lg-3"><label class="form-label small mb-1" for="import-map-${field}">${label}</label><select id="import-map-${field}" class="form-select form-select-sm" data-import-mapping="${field}">${options}</select></div>`;
  }).join('');
  $('#import-mapping').insertAdjacentHTML('beforeend', '<div class="col-12"><div class="form-text">包标识未映射时，按“部署包名称 &gt; 类型 &gt; 文件名”生成，并追加架构。</div></div>');
  document.querySelectorAll('[data-import-mapping]').forEach((select) => select.addEventListener('change', readImportPreview));
  $('#import-mapping').classList.remove('d-none');
}

const importPreviewFieldLabels = {
  sourceUrl: '下载地址', fileName: '文件名', deploymentPackage: '部署包名称', architecture: '架构', digest: '摘要',
  displaySize: '大小说明', type: '类型', applicableProducts: '所属产品', purpose: '用途', documentationUrl: '部署文档', notes: '备注', targets: '目标范围'
};

function importPreviewFieldValue(row, field) {
  const metadata = row.candidate.sourceMetadata ?? {};
  if (field === 'sourceUrl') return row.candidate.sourceUrl;
  if (field === 'fileName') return row.candidate.fileName;
  if (field === 'architecture') return row.candidate.architecture;
  if (field === 'digest') return row.candidate.md5 ? `MD5 ${row.candidate.md5}` : row.candidate.sha256 ? `SHA-256 ${row.candidate.sha256}` : '-';
  if (field === 'targets') return row.candidate.targets?.join('、');
  if (field === 'applicableProducts') return metadata.applicableProducts?.join('、');
  return metadata[field];
}

function renderImportPreview(preview) {
  const valid = preview.rows.filter((row) => row.errors.length === 0);
  const invalid = preview.rows.length - valid.length;
  const mappedFields = Object.keys(preview.mapping).filter((field) => field !== 'packageKey' && importPreviewFieldLabels[field]);
  const emptyColspan = 4 + mappedFields.length;
  const notice = preview.notice ? `；<span class="text-warning">${escapeHtml(preview.notice)}</span>` : '';
  const counts = preview.importable === false
    ? `识别 ${preview.rows.length} 行，仅供查看`
    : `识别 ${preview.rows.length} 行，其中 <span class="text-success">${valid.length} 行可导入</span>，<span class="text-danger">${invalid} 行需处理</span>`;
  $('#import-summary').innerHTML = `工作表：<strong>${escapeHtml(preview.sheet)}</strong>；${counts}${preview.truncated ? '；超过 1000 行的内容已截断' : ''}${notice}`;
  $('#import-preview-head').innerHTML = `<tr><th><input id="import-select-all" type="checkbox" class="form-check-input" aria-label="选择全部有效行"></th><th>行</th><th>包标识（可修改）</th>${mappedFields.map((field) => `<th>${importPreviewFieldLabels[field]}</th>`).join('')}<th>结果</th></tr>`;
  $('#import-preview-rows').innerHTML = preview.rows.length ? preview.rows.map((row, index) => {
    const ok = row.errors.length === 0;
    const result = ok ? [`<span class="text-success">可导入</span>`, ...row.warnings.map((warning) => `<div class="text-warning small">${escapeHtml(warning)}</div>`)].join('') : `<span class="text-danger">${escapeHtml(row.errors.join('；'))}</span>`;
    const selectable = preview.importable !== false && ok;
    const mappedCells = mappedFields.map((field) => `<td class="text-break ${field === 'digest' ? 'font-monospace small' : ''}">${escapeHtml(importPreviewFieldValue(row, field) || '-')}</td>`).join('');
    return `<tr class="${ok ? '' : 'table-danger'}"><td>${selectable ? `<input type="checkbox" class="form-check-input import-row-select" data-import-index="${index}" checked>` : ''}</td><td>${row.rowNumber}</td><td><input class="form-control form-control-sm import-package-key" data-import-index="${index}" value="${escapeHtml(row.candidate.packageKey)}" ${selectable ? '' : 'disabled'}></td>${mappedCells}<td>${preview.importable === false ? `<span class="text-warning">${escapeHtml(preview.notice)}</span>` : result}</td></tr>`;
  }).join('') : `<tr><td colspan="${emptyColspan}" class="text-center text-body-secondary py-4">没有可识别的数据行</td></tr>`;
  $('#import-confirm-button').disabled = preview.importable === false || valid.length === 0;
  $('#import-select-all').checked = preview.importable !== false && valid.length > 0;
  document.querySelectorAll('.import-package-key').forEach((input) => input.addEventListener('input', () => { const row = state.importPreview.rows[Number(input.dataset.importIndex)]; if (row) row.candidate.packageKey = input.value; }));
}

async function confirmImport() {
  if (!state.importPreview || !state.roundId) return;
  if (state.importPreview.importable === false) { showAlert(state.importPreview.notice || '当前工作表不能导入', 'warning'); return; }
  const selected = [...document.querySelectorAll('.import-row-select:checked')].map((input) => {
    const row = state.importPreview.rows[Number(input.dataset.importIndex)];
    return { ...row.candidate, importRowNumber: row.rowNumber };
  });
  if (!selected.length) { showAlert('请至少选择一行有效记录', 'warning'); return; }
  const button = $('#import-confirm-button');
  button.disabled = true;
  button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>导入中';
  try {
    const result = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/import`, { method: 'POST', body: JSON.stringify({ items: selected }) });
    modal('import').hide();
    const skipped = result.errors?.length ? `；跳过：${result.errors.map((item) => `第 ${item.rowNumber} 行 ${item.message}`).join('；')}` : '';
    showAlert(`已导入 ${result.imported} 个候选包${skipped}`);
    await loadRound(state.routeGeneration);
  } catch (error) {
    showAlert(error.message, 'danger');
  } finally {
    button.disabled = false;
    button.textContent = '导入选中候选包';
  }
}

async function deleteCandidate() {
  const candidate = state.currentCandidate;
  if (!candidate || !await confirmAction({ title: '永久删除候选包', message: `确定永久删除候选包“${candidate.fileName}”吗？`, detail: '这会删除候选记录、本机已下载文件，并解除它在所有候选轮次中的引用。此操作不可恢复。' })) return;
  try {
    await api(`/api/v1/candidates/${encodeURIComponent(candidate.candidateId)}`, { method: 'DELETE' });
    showAlert('候选包已删除');
    navigate(state.roundId ? 'release-detail' : 'candidates', paramsForState());
  }
  catch (error) { showAlert(error.message, 'danger'); }
}

async function renderRoute() {
  if (!currentUser() || currentUser().mustChangePassword) return;
  const generation = ++state.routeGeneration;
  const route = routeContext();
  if (!canEdgePage(currentUser().roles ?? [], route.view)) {
    const fallback = ['products', 'gate-config', 'log-collections', 'users', 'audit', 'grants'].find((view) => canEdgePage(currentUser().roles ?? [], view)) ?? 'products';
    if (window.location.hash !== `#${fallback}`) window.location.hash = `#${fallback}`;
    return;
  }
  Object.assign(state, route);
  window.clearInterval(state.queueTimer);
  renderShell(state.view);
  try {
    if (state.view === 'users' || state.view === 'grants' || state.view === 'audit') await renderAccountView(state.view);
    if (state.view === 'products') await loadProducts(generation);
    if (state.view === 'releases') await loadReleases(generation);
    if (state.view === 'rounds') await loadRounds(generation);
    if (state.view === 'candidates') await loadCandidates(generation);
    if (state.view === 'release-detail') await loadReleaseDetail(generation);
    if (state.view === 'candidate-detail') await loadCandidateDetail(generation);
    if (state.view === 'gate-config') await loadGateConfig();
    if (state.view === 'log-collections') await loadLogCollections();
    if (generation === state.routeGeneration) renderBreadcrumb();
    if (state.view === 'release-detail' && generation === state.routeGeneration) startRoundQueuePolling();
  } catch (error) {
    if (generation === state.routeGeneration) showAlert(error.message, 'danger');
  }
}

function modal(name) { return bootstrap.Modal.getOrCreateInstance($(`#${name}-modal`)); }

let confirmationResolver = null;

function confirmAction({ title = '请确认操作', message, detail = '', confirmText = '确定', variant = 'danger' }) {
  $('#confirm-modal-title').textContent = title;
  $('#confirm-modal-message').textContent = message;
  $('#confirm-modal-detail').textContent = detail;
  $('#confirm-modal-detail').classList.toggle('d-none', !detail);
  const button = $('#confirm-modal-submit');
  button.textContent = confirmText;
  button.className = `btn btn-${variant}`;
  return new Promise((resolve) => {
    if (confirmationResolver) confirmationResolver(false);
    confirmationResolver = resolve;
    modal('confirm').show();
  });
}

function resolveConfirmation(confirmed) {
  if (!confirmationResolver) return;
  const resolve = confirmationResolver;
  confirmationResolver = null;
  resolve(confirmed);
}

$('#confirm-modal-submit').addEventListener('click', () => {
  resolveConfirmation(true);
  modal('confirm').hide();
});
$('#confirm-modal').addEventListener('hidden.bs.modal', () => resolveConfirmation(false));

document.querySelectorAll('[data-route]').forEach((element) => element.addEventListener('click', (event) => {
  event.preventDefault();
  const view = element.dataset.route;
  navigate(view, view === 'releases' || view === 'rounds' || view === 'candidates' ? paramsForState({ roundId: null }) : {});
}));

$('#release-product-filter').addEventListener('change', (event) => navigate('releases', { productId: event.target.value }));
$('#round-product-filter').addEventListener('change', (event) => navigate('rounds', { productId: event.target.value }));
$('#round-release-filter').addEventListener('change', (event) => navigate('rounds', { productId: state.productId, releaseId: event.target.value }));
$('#candidate-product-filter').addEventListener('change', (event) => navigate('candidates', { productId: event.target.value }));
$('#candidate-release-filter').addEventListener('change', (event) => navigate('candidates', { productId: state.productId, releaseId: event.target.value }));
$('#candidate-round-filter').addEventListener('change', (event) => navigate('candidates', { productId: state.productId, releaseId: state.releaseId, roundId: event.target.value }));
$('#round-select').addEventListener('change', (event) => navigate('release-detail', { releaseId: state.releaseId, roundId: event.target.value }));
$('#batch-receive-button').addEventListener('click', batchReceiveRound);
$('#freeze-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#freeze-submit');
  const file = $('#freeze-report').files[0];
  if (!file) return showAlert('请选择验证报告', 'warning');
  if (!/\.(docx|pdf|wps|txt|md)$/iu.test(file.name)) return showAlert('验证报告仅支持 DOCX、PDF、WPS、TXT、MD', 'warning');
  if (file.size > 20 * 1024 * 1024) return showAlert('验证报告不能超过 20 MiB', 'warning');
  button.disabled = true;
  try {
    let freezeId = state.freezeDraftId;
    if (!freezeId) {
      const draft = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/freezes`, { method: 'POST', body: JSON.stringify({ reportTitle: $('#freeze-title').value.trim(), conclusion: $('#freeze-conclusion').value, environment: $('#freeze-environment').value.trim() }) });
      freezeId = draft.freezeId;
    }
    await api(`/api/v1/freezes/${encodeURIComponent(freezeId)}/report`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-report-filename': encodeURIComponent(file.name) }, body: file });
    await api(`/api/v1/freezes/${encodeURIComponent(freezeId)}/submit`, { method: 'POST', body: '{}' });
    modal('freeze').hide();
    showAlert('申请已保存，本轮候选清单已锁定；系统将在后台投递至 Core 并创建云管工单，失败后自动重试');
    await loadRound(state.routeGeneration);
  } catch (error) { showAlert(error.message, 'danger'); }
  finally { button.disabled = false; }
});
$('#candidate-back-button').addEventListener('click', () => navigate(state.roundId ? 'release-detail' : 'candidates', paramsForState()));
$('#release-back-button').addEventListener('click', () => navigate('releases', { productId: state.productId }));
$('#receive-button').addEventListener('click', receiveCandidate);
$('#pause-button').addEventListener('click', pauseCandidate);
$('#candidate-edit-button').addEventListener('click', openCandidateEditor);
$('#candidate-delete-button').addEventListener('click', deleteCandidate);
$('#gate-config-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/config', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); showAlert('对接配置已保存'); await loadGateConfig(); } catch (error) { showAlert(error.message, 'danger'); } });
$('#gate-test').addEventListener('click', async () => { const button = $('#gate-test'); button.disabled = true; try { const result = await api('/api/v1/gate/config/test', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData($('#gate-config-form')))) }); $('#gate-config-status').textContent = `控制通道测试成功：${Object.keys(result.checks).map((key) => `${key}=${result.checks[key].service ?? 'ready'}`).join('，')}`; showAlert('网闸映射通道测试成功'); } catch (error) { $('#gate-config-status').textContent = '映射通道测试失败，请检查网闸虚拟地址和策略。'; showAlert(error.message, 'danger'); } finally { button.disabled = false; } });
$('#gate-copy-identity').addEventListener('click', async () => {
  const input = $('#gate-identity-bundle');
  if (!input.value) return;
  try { await navigator.clipboard.writeText(input.value); $('#gate-copy-state').textContent = '身份包已复制，请在 Core 导入。'; }
  catch { input.focus(); input.select(); $('#gate-copy-state').textContent = '浏览器未授权自动复制，已选中身份包，请按 Ctrl+C 复制。'; }
});
$('#gate-peer-edit').addEventListener('click', () => { $('#gate-peer-editor').classList.remove('d-none'); $('#gate-peer-editor').dataset.editing = 'true'; $('#gate-peer-fingerprint').classList.add('d-none'); $('#gate-peer-fingerprint-label').textContent = '导入 Core 导出的身份包'; $('#gate-peer-edit').classList.add('d-none'); $('#gate-peer-cancel').classList.remove('d-none'); $('#gate-trust-peer').classList.remove('d-none'); $('#gate-peer-bundle-input').focus({ preventScroll: true }); $('#gate-peer-state').textContent = '替换对端身份会关闭业务通道，双方需重新测试配对'; });
$('#gate-peer-cancel').addEventListener('click', () => { $('#gate-peer-editor').classList.add('d-none'); $('#gate-peer-editor').dataset.editing = ''; $('#gate-peer-fingerprint').classList.remove('d-none'); $('#gate-peer-fingerprint-label').textContent = '已信任的身份指纹'; $('#gate-peer-cancel').classList.add('d-none'); $('#gate-trust-peer').classList.add('d-none'); $('#gate-peer-edit').classList.remove('d-none'); $('#gate-peer-bundle-input').value = ''; $('#gate-peer-state').textContent = '已取消身份替换'; });
$('#gate-trust-peer').addEventListener('click', async (event) => {
  const button = event.currentTarget; const original = button.innerHTML; const notice = $('#gate-pairing-result'); let identitySaved = false;
  const peerTrusted = Boolean($('#gate-peer-fingerprint').textContent && $('#gate-peer-fingerprint').textContent !== '尚未配对' && $('#gate-peer-fingerprint').textContent !== '尚未导入');
  notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = peerTrusted ? '请在确认框中确认替换 Core 身份。' : '正在保存 Core 身份…';
  button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>保存中';
  try {
    if (peerTrusted && !await confirmAction({ title: '重新配对 Core 身份', message: '确定替换已信任的 Core 身份吗？', detail: '替换对端身份会关闭业务通道，双方需重新完成配对测试。', confirmText: '确认替换', variant: 'warning' })) { notice.className = 'alert alert-secondary mt-3 mb-0'; notice.textContent = '已取消身份替换。'; return; }
    notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = '正在保存身份并刷新配对状态…';
    const identityBundle = JSON.parse($('#gate-peer-bundle-input').value);
    await api('/api/v1/gate/keys/trusted-peer', { method: 'PUT', body: JSON.stringify({ identityBundle }) }); identitySaved = true;
    $('#gate-peer-bundle-input').value = ''; $('#gate-peer-editor').dataset.editing = '';
    const item = await loadGateKeys();
    notice.className = 'alert alert-success mt-3 mb-0'; notice.textContent = `Core 身份已保存。当前状态：${item.pairingState === 'PAIRED' ? '双向身份配对完成，签名业务通道可用' : '身份已更新，等待重新测试配对'}。`;
  } catch (error) {
    notice.className = `alert alert-${identitySaved ? 'warning' : 'danger'} mt-3 mb-0`;
    notice.textContent = identitySaved ? `身份已保存，但状态刷新失败：${error.message}` : `身份未保存：${error.message}`;
  } finally { button.disabled = false; button.innerHTML = original; }
});
$('#gate-pairing-test').addEventListener('click', async (event) => { const button = event.currentTarget; const notice = $('#gate-pairing-result'); button.disabled = true; button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>测试中'; notice.className = 'alert alert-info mt-3 mb-0'; notice.textContent = '正在测试身份配对与签名认证…'; try { const result = await api('/api/v1/gate/keys/test', { method: 'POST' }); notice.className = 'alert alert-success mt-3 mb-0'; notice.textContent = `配对测试通过：本端 Edge 与对端 ${result.checks.remote.role} 均已配对，签名认证成功（${new Date().toLocaleString()}）。`; showAlert('身份配对和 Core 签名控制通道均正常'); } catch (error) { notice.className = 'alert alert-danger mt-3 mb-0'; notice.textContent = `配对测试未通过：${error.message}`; showAlert(error.message, 'danger'); } finally { await loadGateKeys({ preserveInputs: true }).catch(() => {}); button.disabled = false; button.innerHTML = '<i class="bi bi-shield-check me-1"></i>测试身份配对'; } });
$('#gate-schedule').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/v1/gate/keys/schedule', { method: 'PUT', body: JSON.stringify({ rotationIntervalDays: Number($('#gate-rotation-days').value), gracePeriodHours: Number($('#gate-grace-hours').value) }) }); await loadGateKeys(); showAlert('本端身份轮换策略已保存'); } catch (error) { showAlert(error.message, 'danger'); } });
$('#gate-rotate-now').addEventListener('click', async (event) => { const button = event.currentTarget; button.disabled = true; try { await api('/api/v1/gate/keys/rotate', { method: 'POST', body: '{}' }); await loadGateKeys(); showAlert('Edge 身份公私钥已完成轮换'); } catch (error) { showAlert(error.message, 'danger'); } finally { button.disabled = false; } });
$('#log-collection-form').addEventListener('submit', async (event) => { event.preventDefault(); const fromAt = new Date($('#log-from').value).toISOString(); const toAt = new Date($('#log-to').value).toISOString(); const categories = [...document.querySelectorAll('[name="log-category"]:checked')].map((input) => input.value); try { await api('/api/v1/log-collections', { method: 'POST', body: JSON.stringify({ fromAt, toAt, categories, retentionDays: 7 }) }); showAlert('日志收集任务已创建，系统将在后台汇总并打包'); await loadLogCollections(); } catch (error) { showAlert(error.message, 'danger'); } });
window.addEventListener('hashchange', renderRoute);

document.querySelectorAll('[data-modal]').forEach((button) => button.addEventListener('click', async () => {
  if (button.dataset.modal === 'release') {
    revisionBaseReleaseId = null;
    $('#release-modal-title').textContent = '创建发布版本';
    $('#release-product').disabled = false;
    $('#release-version').readOnly = false;
    $('#release-version-help').textContent = '同一研发版本已有审批通过的固化基线时，系统自动创建下一个内部修订号（例如 8.0.6.2-r1），并继承上一版清单。';
    const products = await getProducts();
    $('#release-product').innerHTML = products.map((item) => `<option value="${escapeHtml(item.productId)}">${escapeHtml(item.name)}</option>`).join('');
    if (state.productId) $('#release-product').value = state.productId;
  }
  modal(button.dataset.modal).show();
}));

$('#product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try { await api('/api/v1/products', { method: 'POST', body: JSON.stringify({ name: $('#product-name').value.trim() }) }); modal('product').hide(); form.reset(); state.products = []; showAlert('软件产品已创建'); navigate('products'); }
  catch (error) { showAlert(error.message, 'danger'); }
});

$('#release-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const productId = $('#release-product').value;
  try {
    const release = revisionBaseReleaseId
      ? await api(`/api/v1/releases/${encodeURIComponent(revisionBaseReleaseId)}/revisions`, { method: 'POST', body: '{}' })
      : await api(`/api/v1/products/${encodeURIComponent(productId)}/releases`, { method: 'POST', body: JSON.stringify({ version: $('#release-version').value.trim() }) });
    // Every release starts with an auditable first collection round. The
    // release API remains backward compatible for non-UI callers; the UI
    // creates the initial round immediately and opens it for package entry.
    modal('release').hide(); form.reset(); revisionBaseReleaseId = null; $('#release-product').disabled = false; $('#release-version').readOnly = false; showAlert(release.revision > 0 ? `内部修订版 ${release.displayVersion} 已创建，继承 ${release.inheritedPackageCount} 个包` : '发布版本及第一轮候选轮次已创建'); navigate('release-detail', { releaseId: release.releaseId, roundId: release.initialRound.roundId });
  } catch (error) { showAlert(error.message, 'danger'); }
});

$('#release-modal').addEventListener('hidden.bs.modal', () => {
  if (!revisionBaseReleaseId) return;
  revisionBaseReleaseId = null;
  $('#release-form').reset();
  $('#release-modal-title').textContent = '创建发布版本';
  $('#release-product').disabled = false;
  $('#release-version').readOnly = false;
  $('#release-version-help').textContent = '同一研发版本已有审批通过的固化基线时，系统自动创建下一个内部修订号（例如 8.0.6.2-r1），并继承上一版清单。';
});

$('#new-round-button').addEventListener('click', async () => {
  $('#round-form').reset();
  const roundsResponse = state.releaseId ? await api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}/rounds`) : { items: [], nextRound: null };
  const nextRound = roundsResponse.nextRound;
  if (!nextRound?.canCreate) {
    showAlert(nextRound?.blockedReason ?? '当前轮次没有候选包变更，不能创建下一轮', 'warning');
    return;
  }
  $('#round-product-preview').value = nextRound?.productName ?? state.currentRelease?.productName ?? '-';
  $('#round-release-preview').value = nextRound?.displayVersion ?? state.currentRelease?.displayVersion ?? state.currentRelease?.version ?? '-';
  $('#round-number-preview').value = nextRound ? `第 ${nextRound.roundNo} 轮` : '-';
  modal('round').show();
});
$('#round-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.currentTarget.querySelector('button[type=submit]'); button.disabled = true;
  try {
    const round = await api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}/rounds`, { method: 'POST', body: JSON.stringify({ changeNote: $('#round-change-note').value.trim() }) });
    for (const file of Array.from($('#round-attachments').files ?? [])) { if (!/\.(docx|pdf|wps|txt|md)$/iu.test(file.name)) throw new Error('留痕附件仅支持 DOCX、PDF、WPS、TXT、MD'); const headers = { 'x-attachment-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' }; await api(`/api/v1/rounds/${encodeURIComponent(round.roundId)}/attachments`, { method: 'POST', headers, body: await file.arrayBuffer() }); }
    modal('round').hide(); showAlert(`第 ${round.roundNo} 轮已创建${round.baseRoundId ? '，已继承上一轮候选包' : ''}`); navigate('release-detail', { releaseId: state.releaseId, roundId: round.roundId });
  } catch (error) { showAlert(error.message, 'danger'); } finally { button.disabled = false; }
});

$('#new-package-button').addEventListener('click', () => {
  if (!state.roundId) { showAlert('请先创建候选轮次', 'warning'); return; }
  $('#package-form').reset();
  delete $('#package-form').dataset.editingCandidate;
  $('#package-modal-title').textContent = '添加候选包';
  $('#package-submit-button').textContent = '确定';
  modal('package').show();
});

$('#import-packages-button').addEventListener('click', () => {
  if (!state.roundId) { showAlert('请先创建候选轮次', 'warning'); return; }
  resetImportDialog();
  modal('import').show();
});
$('#import-file').addEventListener('change', (event) => {
  importPreviewRequestId += 1;
  state.importFile = event.target.files?.[0] ?? null;
  state.importPreview = null;
  $('#import-preview-button').disabled = !state.importFile;
  $('#import-preview-button').innerHTML = '读取预览';
  $('#import-sheet').disabled = true;
  $('#import-sheet').innerHTML = '';
  $('#import-confirm-button').disabled = true;
  $('#import-summary').textContent = '';
  $('#import-mapping').classList.add('d-none');
  $('#import-mapping').innerHTML = '';
  resetImportPreviewTable('请读取预览');
});
$('#import-preview-button').addEventListener('click', readImportPreview);
$('#import-sheet').addEventListener('change', readImportPreview);
$('#import-confirm-button').addEventListener('click', confirmImport);
$('#import-preview-head').addEventListener('change', (event) => {
  if (event.target.id === 'import-select-all') document.querySelectorAll('.import-row-select').forEach((checkbox) => { checkbox.checked = event.target.checked; });
});
$('#import-modal').addEventListener('hidden.bs.modal', resetImportDialog);

$('#package-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = { sourceUrl: $('#package-url').value.trim(), packageKey: $('#package-key').value.trim() || null, fileName: $('#package-file-name').value.trim() || null, version: $('#package-version').value.trim() || null, architecture: $('#package-architecture').value.trim() || null, size: $('#package-size').value === '' ? null : Number($('#package-size').value), md5: $('#package-md5').value.trim() || null, sha256: $('#package-sha256').value.trim() || null, targets: $('#package-targets').value.split(',').map((value) => value.trim()).filter(Boolean) };
    if (form.dataset.editingCandidate) {
      const candidate = await api(`/api/v1/candidates/${encodeURIComponent(form.dataset.editingCandidate)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      modal('package').hide(); form.reset(); delete form.dataset.editingCandidate; $('#package-modal-title').textContent = '添加候选包'; $('#package-submit-button').textContent = '确定';
      showAlert(`候选包 ${candidate.fileName} 已更新`); await loadCandidateDetail();
      return;
    }
    const candidate = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/candidates`, { method: 'POST', body: JSON.stringify(payload) });
    modal('package').hide(); form.reset(); showAlert(`候选包 ${candidate.fileName} 已创建`); navigate('candidate-detail', { candidateId: candidate.candidateId, ...paramsForState() });
  } catch (error) { showAlert(error.message, 'danger'); }
});

initAccountUI({ api, refresh: renderRoute, context: () => ({ ...state, confirm: confirmAction }), alert: showAlert });

const logTo = new Date(); const logFrom = new Date(logTo.getTime() - 24 * 3600_000); const localInput = (date) => { const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 16); }; $('#log-from').value = localInput(logFrom); $('#log-to').value = localInput(logTo);
setInterval(() => { if (document.hidden || $('.app-wrapper').classList.contains('d-none')) return; if (!$('#view-gate-config').classList.contains('d-none')) void loadGateKeys({ preserveInputs: true }).catch(() => {}); if (!$('#view-log-collections').classList.contains('d-none')) void loadLogCollections().catch(() => {}); }, 5000);
