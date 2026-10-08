const state = { products: [], releases: [], view: 'products', productId: null, releaseId: null, roundId: null, candidateId: null, pollTimer: null, queueTimer: null, routeGeneration: 0, importFile: null, importPreview: null };
const $ = (selector) => document.querySelector(selector);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

function showAlert(message, type = 'success') {
  const alert = $('#alert');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  window.setTimeout(() => alert.classList.add('d-none'), 5000);
}

function statusLabel(status) { return { OPEN: '开放', CREATED: '待接收', RECEIVING: '接收中', PARTIAL: '待完成', ASSEMBLING: '组装校验中', FAILED: '失败', COMPLETED: '已完成' }[status] ?? status; }
function statusClass(status) { return { OPEN: 'text-bg-primary', CREATED: 'text-bg-secondary', RECEIVING: 'text-bg-info', PARTIAL: 'text-bg-warning', ASSEMBLING: 'text-bg-primary', FAILED: 'text-bg-danger', COMPLETED: 'text-bg-success' }[status] ?? 'text-bg-secondary'; }
function queueLabel(status) { return { QUEUED: '排队中', RUNNING: '调度中', PAUSED: '已暂停', FAILED: '调度失败', CANCELLED: '已取消', COMPLETED: '已完成' }[status] ?? status; }
function queueClass(status) { return { QUEUED: 'text-bg-secondary', RUNNING: 'text-bg-info', PAUSED: 'text-bg-warning', FAILED: 'text-bg-danger', CANCELLED: 'text-bg-secondary', COMPLETED: 'text-bg-success' }[status] ?? 'text-bg-secondary'; }
function formatBytes(value) { if (!Number.isFinite(Number(value))) return '-'; if (value < 1024) return `${value} B`; const units = ['KB', 'MB', 'GB', 'TB']; let amount = value; let index = -1; while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index += 1; } return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`; }

async function api(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `请求失败（${response.status}）`);
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
    view: ['products', 'releases', 'rounds', 'candidates', 'release-detail', 'candidate-detail'].includes(viewPart) ? viewPart : 'products',
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
  const views = ['products', 'releases', 'rounds', 'candidates', 'release-detail', 'candidate-detail'];
  views.forEach((name) => $(`#view-${name}`).classList.toggle('d-none', name !== view));
  const activeRoute = view === 'release-detail' ? 'rounds' : view === 'candidate-detail' ? 'candidates' : view;
  document.querySelectorAll('[data-route]').forEach((link) => link.classList.toggle('active', link.dataset.route === activeRoute));
  const titles = { products: '软件产品', releases: '发布版本', rounds: '候选轮次', candidates: '候选包', 'release-detail': '发布版本详情', 'candidate-detail': '候选包详情' };
  $('#page-title').textContent = titles[view] ?? '软件产品';
}

function renderBreadcrumb() {
  const labels = [];
  const product = state.products.find((item) => item.productId === state.productId);
  if (state.view === 'products') labels.push(['软件产品']);
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
  $('#breadcrumbs').innerHTML = '<li class="breadcrumb-item">CAM</li>' + labels.map(([label, href], index) => {
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

async function getRounds(releaseId) {
  return (await api(`/api/v1/releases/${encodeURIComponent(releaseId)}/rounds`)).items;
}

function productFilterItems(products) { return products.map((item) => ({ id: item.productId, name: item.name })); }
function releaseFilterItems(releases) { return releases.map((item) => ({ id: item.releaseId, name: `${item.productName} / ${item.version}` })); }
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
    return `<tr><td>${escapeHtml(item.productName)}</td><td class="fw-semibold">${escapeHtml(item.version)}</td><td>${item.completedCandidateCount}/${item.candidateCount}</td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span></td><td><div class="d-flex gap-1"><button class="btn btn-outline-primary btn-sm" data-release="${escapeHtml(item.releaseId)}" title="查看发布版本"><i class="bi bi-eye"></i><span class="visually-hidden">查看</span></button><button class="btn btn-outline-danger btn-sm" data-delete-release="${escapeHtml(item.releaseId)}" title="${deleteTitle}" aria-label="删除发布版本" ${canDelete ? '' : 'disabled'}><i class="bi bi-trash"></i><span class="visually-hidden">删除</span></button></div></td></tr>`;
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
  const selectedReleases = state.releaseId ? releases.filter((item) => item.releaseId === state.releaseId) : releases;
  const roundsByRelease = await Promise.all(selectedReleases.map((release) => getRounds(release.releaseId)));
  if (generation !== state.routeGeneration) return;
  const rounds = roundsByRelease.flat();
  $('#round-rows').innerHTML = rounds.length ? rounds.map((round) => `<tr><td>${escapeHtml(round.productName)}</td><td>${escapeHtml(round.version)}</td><td class="fw-semibold">第 ${round.roundNo} 轮</td><td>${round.completedCandidateCount}/${round.candidateCount}</td><td><span class="badge ${statusClass(round.status)}">${statusLabel(round.status)}</span></td><td>${new Date(round.createdAt).toLocaleString()}</td><td><button class="btn btn-outline-primary btn-sm" data-round-candidates="${escapeHtml(round.roundId)}" data-product="${escapeHtml(round.productId)}" data-release="${escapeHtml(round.releaseId)}" title="查看轮次详情和候选包"><i class="bi bi-eye"></i><span class="visually-hidden">查看轮次详情和候选包</span></button></td></tr>`).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无候选轮次</td></tr>';
  document.querySelectorAll('[data-round-candidates]').forEach((button) => button.addEventListener('click', () => navigate('release-detail', { productId: button.dataset.product, releaseId: button.dataset.release, roundId: button.dataset.roundCandidates })));
}

async function candidateRowsFor(releaseId) {
  return (await api(`/api/v1/candidates?releaseId=${encodeURIComponent(releaseId)}&limit=200`)).items;
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
  const selectedReleases = state.releaseId ? releases.filter((item) => item.releaseId === state.releaseId) : releases;
  const roundsByRelease = await Promise.all(selectedReleases.map((release) => getRounds(release.releaseId)));
  if (generation !== state.routeGeneration) return;
  const rounds = roundsByRelease.flat();
  setOptions($('#candidate-round-filter'), roundFilterItems(rounds), state.roundId, (item) => item.name, '全部');

  let candidates;
  if (state.roundId) candidates = (await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/candidates`)).items;
  else if (state.releaseId) candidates = await candidateRowsFor(state.releaseId);
  else if (state.productId) candidates = (await Promise.all(selectedReleases.map((release) => candidateRowsFor(release.releaseId)))).flat();
  else candidates = (await api('/api/v1/candidates?limit=200')).items;
  if (generation !== state.routeGeneration) return;
  state.currentRound = selectedRound;
  $('#candidate-rows').innerHTML = candidates.length ? candidates.map((item) => {
    const release = selectedReleases.find((entry) => entry.releaseId === item.releaseId);
    return `<tr><td>${escapeHtml(item.productName ?? release?.productName ?? '-')}</td><td>${escapeHtml(item.releaseVersion ?? release?.version ?? '-')}</td><td>${selectedRound ? `第 ${selectedRound.roundNo} 轮` : '-'}</td><td>${escapeHtml(item.packageKey ?? '-')}</td><td class="file-name text-break">${escapeHtml(item.fileName)}</td><td>${escapeHtml(item.architecture ?? '-')}</td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span></td><td><div class="d-flex gap-1"><button class="btn btn-outline-primary btn-sm" data-candidate-open="${escapeHtml(item.candidateId)}" title="查看候选包"><i class="bi bi-eye"></i><span class="visually-hidden">查看</span></button><button class="btn btn-outline-danger btn-sm" data-candidate-delete="${escapeHtml(item.candidateId)}" title="删除候选包"><i class="bi bi-trash"></i><span class="visually-hidden">删除</span></button></div></td></tr>`;
  }).join('') : '<tr><td colspan="8" class="text-center text-body-secondary py-4">暂无候选包</td></tr>';
  document.querySelectorAll('[data-candidate-open]').forEach((button) => button.addEventListener('click', () => navigate('candidate-detail', { candidateId: button.dataset.candidateOpen, ...paramsForState() })));
  document.querySelectorAll('[data-candidate-delete]').forEach((button) => button.addEventListener('click', () => deleteCandidateById(button.dataset.candidateDelete)));
}

async function loadReleaseDetail(generation = state.routeGeneration) {
  if (!state.releaseId) return navigate('releases');
  const [release, rounds] = await Promise.all([
    api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}`),
    getRounds(state.releaseId)
  ]);
  if (generation !== state.routeGeneration) return;
  state.productId = release.productId;
  state.currentRelease = release;
  $('#release-title').textContent = `${release.productName} / ${release.version}`;
  $('#release-fields').innerHTML = [['软件产品', escapeHtml(release.productName)], ['发布版本', escapeHtml(release.version)], ['状态', `<span class="badge ${statusClass(release.status)}">${statusLabel(release.status)}</span>`]].map(([label, value]) => `<dt class="col-sm-3 col-lg-2">${label}</dt><dd class="col-sm-9 col-lg-10">${value}</dd>`).join('');
  $('#round-select').innerHTML = rounds.length ? rounds.map((round) => `<option value="${escapeHtml(round.roundId)}">第 ${round.roundNo} 轮 · ${round.completedCandidateCount}/${round.candidateCount} 已完成</option>`).join('') : '<option value="">暂无轮次</option>';
  if (!rounds.some((round) => round.roundId === state.roundId)) state.roundId = rounds[0]?.roundId ?? null;
  $('#round-select').value = state.roundId ?? '';
  if (state.roundId) await loadRound(generation); else { state.currentRound = null; renderRound(null, []); }
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
  renderRound(round, candidates.items);
}

function renderRound(round, candidates) {
  $('#round-summary').innerHTML = round ? `<div class="col-md-4"><div class="small-box text-bg-primary"><div class="inner"><h3>${round.roundNo}</h3><p>候选轮次</p></div></div></div><div class="col-md-4"><div class="small-box text-bg-success"><div class="inner"><h3>${round.completedCandidateCount}/${round.candidateCount}</h3><p>已完成候选包</p></div></div></div><div class="col-md-4"><div class="small-box text-bg-secondary"><div class="inner"><h3>${round.baseRoundId ? '继承' : '初始'}</h3><p>轮次来源</p></div></div></div>` : '';
  $('#round-candidate-rows').innerHTML = candidates.length ? candidates.map((item) => `<tr><td>${escapeHtml(item.packageKey ?? item.fileName)}</td><td>${escapeHtml(item.fileName)}</td><td>${escapeHtml(item.architecture ?? '-')}</td><td class="font-monospace small">${escapeHtml(item.finalSha256 ?? item.expectedSha256 ?? '-')}</td><td><span class="badge ${item.mappingSource === 'INHERITED' ? 'text-bg-info' : 'text-bg-secondary'}">${item.mappingSource === 'INHERITED' ? `继承${item.inheritedFromRoundId ? ` · ${escapeHtml(item.inheritedFromRoundId.slice(-8))}` : ''}` : '本轮新增'}</span></td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span></td><td><div class="d-flex gap-1"><button class="btn btn-outline-primary btn-sm" data-candidate="${escapeHtml(item.candidateId)}" title="查看候选包"><i class="bi bi-eye"></i><span class="visually-hidden">查看</span></button><button class="btn btn-outline-danger btn-sm" data-round-candidate-delete="${escapeHtml(item.candidateId)}" title="从本轮移除（保留候选记录）"><i class="bi bi-trash"></i><span class="visually-hidden">从本轮移除</span></button></div></td></tr>`).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">本轮暂无候选包</td></tr>';
  document.querySelectorAll('[data-candidate]').forEach((button) => button.addEventListener('click', () => navigate('candidate-detail', { candidateId: button.dataset.candidate, ...paramsForState() })));
  document.querySelectorAll('[data-round-candidate-delete]').forEach((button) => button.addEventListener('click', () => detachRoundCandidate(button.dataset.roundCandidateDelete)));
  updateRoundQueue(round, candidates);
}

async function updateRoundQueue(round, candidates) {
  if (!round) return;
  try {
    const queue = (await api('/api/v1/receive-queue')).items.filter((item) => candidates.some((candidate) => candidate.candidateId === item.candidate_id));
    const completed = queue.filter((item) => item.status === 'COMPLETED').length;
    const active = queue.filter((item) => item.status === 'RUNNING').length;
    $('#round-queue-summary').textContent = queue.length ? `后台队列：${completed}/${queue.length} 已完成，${active} 个下载中` : '后台队列：尚未提交';
    $('#batch-receive-button').disabled = !candidates.some((candidate) => candidate.status !== 'COMPLETED');
  } catch { $('#round-queue-summary').textContent = '后台队列状态暂不可用'; }
}

async function batchReceiveRound() {
  if (!state.roundId) return;
  const button = $('#batch-receive-button');
  button.disabled = true;
  try {
    const result = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/receive-batch`, { method: 'POST', body: '{}' });
    showAlert(`已加入后台下载队列：${result.enqueued} 个候选包`);
    await loadRound(state.routeGeneration);
  } catch (error) { showAlert(error.message, 'danger'); button.disabled = false; }
}

async function detachRoundCandidate(candidateId) {
  if (!state.roundId || !await confirmAction({ title: '从本轮移除候选包', message: '确定从当前候选轮次移除这个候选包吗？', detail: '只解除当前轮次的引用，候选记录和已下载文件会保留，可被其他轮次继续使用。', confirmText: '从本轮移除', variant: 'warning' })) return;
  try {
    await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/candidates/${encodeURIComponent(candidateId)}`, { method: 'DELETE' });
    showAlert('候选包已从当前轮次移除');
    await loadRound(state.routeGeneration);
  } catch (error) { showAlert(error.message, 'danger'); }
}

async function loadCandidateDetail(generation = state.routeGeneration) {
  if (!state.candidateId) return navigate('candidates');
  const candidate = await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}`);
  const parts = await api(`/api/v1/candidates/${encodeURIComponent(state.candidateId)}/parts`);
  if (generation !== state.routeGeneration) return;
  state.productId = candidate.productId ?? null;
  state.releaseId = candidate.releaseId ?? null;
  state.currentCandidate = candidate;
  state.currentRound = state.roundId ? await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}`) : null;
  renderCandidate(candidate, parts);
  if (['RECEIVING', 'ASSEMBLING'].includes(candidate.status)) startCandidatePolling();
}

function renderCandidate(candidate, parts) {
  $('#candidate-title').textContent = candidate.fileName;
  const fields = [['候选 ID', `<span class="font-monospace">${escapeHtml(candidate.candidateId)}</span>`], ['软件 / 发布版本', `${escapeHtml(candidate.productName ?? '-')} / ${escapeHtml(candidate.releaseVersion ?? candidate.version)}`], ['研发地址', `<span class="text-break">${escapeHtml(candidate.sourceUrl)}</span>`], ['包标识', escapeHtml(candidate.packageKey ?? '-')], ['版本 / 架构', `${escapeHtml(candidate.version)} / ${escapeHtml(candidate.architecture ?? '-')}`], ['大小', formatBytes(candidate.size)], ['MD5 / SHA-256', `<span class="font-monospace small text-break">${escapeHtml(candidate.expectedMd5 ?? '-')} / ${escapeHtml(candidate.finalSha256 ?? candidate.expectedSha256 ?? '接收完成后生成')}</span>`], ['状态', `<span class="badge ${statusClass(candidate.status)}">${statusLabel(candidate.status)}</span>`], ...(candidate.error ? [['错误信息', `<span class="text-danger text-break">${escapeHtml(candidate.error)}</span>`]] : [])];
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
  window.clearInterval(state.queueTimer);
  state.queueTimer = window.setInterval(() => {
    if (state.view !== 'release-detail' || !state.roundId) return window.clearInterval(state.queueTimer);
    loadRound(state.routeGeneration).catch(() => {});
  }, 2000);
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
  state.importFile = null;
  state.importPreview = null;
  $('#import-file').value = '';
  $('#import-sheet').innerHTML = '';
  $('#import-sheet').disabled = true;
  $('#import-preview-button').disabled = true;
  $('#import-confirm-button').disabled = true;
  $('#import-summary').textContent = '';
  $('#import-mapping').classList.add('d-none');
  $('#import-preview-rows').innerHTML = '<tr><td colspan="7" class="text-center text-body-secondary py-4">请选择 Excel 文件并读取预览</td></tr>';
}

async function readImportPreview() {
  if (!state.importFile || !state.roundId) return;
  const button = $('#import-preview-button');
  button.disabled = true;
  button.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>读取中';
  try {
    const params = new URLSearchParams();
    if ($('#import-sheet').value) params.set('sheet', $('#import-sheet').value);
    const columnMapping = {};
    document.querySelectorAll('[data-import-mapping]').forEach((select) => { columnMapping[select.dataset.importMapping] = select.value === '' ? null : Number(select.value); });
    if (Object.keys(columnMapping).length) params.set('mapping', JSON.stringify(columnMapping));
    const preview = await api(`/api/v1/rounds/${encodeURIComponent(state.roundId)}/import-preview${params.toString() ? `?${params}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, body: await state.importFile.arrayBuffer() });
    state.importPreview = preview;
    const currentSheet = $('#import-sheet').value;
    $('#import-sheet').innerHTML = preview.sheets.map((sheet) => `<option value="${escapeHtml(sheet.name)}">${escapeHtml(sheet.name)}（表头第 ${sheet.headerRow} 行，识别 ${sheet.recognizedColumns} 列）</option>`).join('');
    $('#import-sheet').disabled = false;
    $('#import-sheet').value = preview.sheet || currentSheet;
    renderImportMapping(preview);
    renderImportPreview(preview);
  } catch (error) {
    showAlert(error.message, 'danger');
  } finally {
    button.disabled = !state.importFile;
    button.innerHTML = '读取预览';
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
  $('#import-mapping').classList.remove('d-none');
}

function renderImportPreview(preview) {
  const valid = preview.rows.filter((row) => row.errors.length === 0);
  const invalid = preview.rows.length - valid.length;
  $('#import-summary').innerHTML = `工作表：<strong>${escapeHtml(preview.sheet)}</strong>；识别 ${preview.rows.length} 行，其中 <span class="text-success">${valid.length} 行可导入</span>，<span class="text-danger">${invalid} 行需处理</span>${preview.truncated ? '；超过 1000 行的内容已截断' : ''}`;
  $('#import-preview-rows').innerHTML = preview.rows.length ? preview.rows.map((row, index) => {
    const ok = row.errors.length === 0;
    const result = ok ? [`<span class="text-success">可导入</span>`, ...row.warnings.map((warning) => `<div class="text-warning small">${escapeHtml(warning)}</div>`)].join('') : `<span class="text-danger">${escapeHtml(row.errors.join('；'))}</span>`;
    const digest = row.candidate.md5 ? `MD5 ${row.candidate.md5}` : row.candidate.sha256 ? `SHA-256 ${row.candidate.sha256}` : '-';
    return `<tr class="${ok ? '' : 'table-danger'}"><td>${ok ? `<input type="checkbox" class="form-check-input import-row-select" data-import-index="${index}" checked>` : ''}</td><td>${row.rowNumber}</td><td><input class="form-control form-control-sm import-package-key" data-import-index="${index}" value="${escapeHtml(row.candidate.packageKey)}" ${ok ? '' : 'disabled'}></td><td class="text-break">${escapeHtml(row.candidate.fileName)}</td><td>${escapeHtml(row.candidate.architecture ?? '-')}</td><td class="font-monospace small text-break">${escapeHtml(digest)}</td><td>${result}</td></tr>`;
  }).join('') : '<tr><td colspan="7" class="text-center text-body-secondary py-4">没有可识别的数据行</td></tr>';
  $('#import-confirm-button').disabled = valid.length === 0;
  $('#import-select-all').checked = valid.length > 0;
  document.querySelectorAll('.import-package-key').forEach((input) => input.addEventListener('input', () => { const row = state.importPreview.rows[Number(input.dataset.importIndex)]; if (row) row.candidate.packageKey = input.value; }));
}

async function confirmImport() {
  if (!state.importPreview || !state.roundId) return;
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

async function deleteCandidateById(candidateId) {
  if (!await confirmAction({ title: '永久删除候选包', message: '确定永久删除这个候选包吗？', detail: '这会删除候选记录、本机已下载文件，并解除它在所有候选轮次中的引用。此操作不可恢复。' })) return;
  try { await api(`/api/v1/candidates/${encodeURIComponent(candidateId)}`, { method: 'DELETE' }); showAlert('候选包已删除'); await loadCandidates(); }
  catch (error) { showAlert(error.message, 'danger'); }
}

async function renderRoute() {
  const generation = ++state.routeGeneration;
  const route = routeContext();
  Object.assign(state, route);
  window.clearInterval(state.queueTimer);
  renderShell(state.view);
  try {
    if (state.view === 'products') await loadProducts(generation);
    if (state.view === 'releases') await loadReleases(generation);
    if (state.view === 'rounds') await loadRounds(generation);
    if (state.view === 'candidates') await loadCandidates(generation);
    if (state.view === 'release-detail') await loadReleaseDetail(generation);
    if (state.view === 'candidate-detail') await loadCandidateDetail(generation);
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
$('#candidate-back-button').addEventListener('click', () => navigate('candidates', paramsForState()));
$('#release-back-button').addEventListener('click', () => navigate('releases', { productId: state.productId }));
$('#receive-button').addEventListener('click', receiveCandidate);
$('#pause-button').addEventListener('click', pauseCandidate);
$('#candidate-edit-button').addEventListener('click', openCandidateEditor);
$('#candidate-delete-button').addEventListener('click', deleteCandidate);
window.addEventListener('hashchange', renderRoute);

document.querySelectorAll('[data-modal]').forEach((button) => button.addEventListener('click', async () => {
  if (button.dataset.modal === 'release') {
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
    const release = await api(`/api/v1/products/${encodeURIComponent(productId)}/releases`, { method: 'POST', body: JSON.stringify({ version: $('#release-version').value.trim() }) });
    modal('release').hide(); form.reset(); showAlert('发布版本已创建'); navigate('release-detail', { releaseId: release.releaseId });
  } catch (error) { showAlert(error.message, 'danger'); }
});

$('#new-round-button').addEventListener('click', async () => {
  try {
    const round = await api(`/api/v1/releases/${encodeURIComponent(state.releaseId)}/rounds`, { method: 'POST', body: JSON.stringify({ baseRoundId: state.roundId || null }) });
    showAlert(`第 ${round.roundNo} 轮已创建${round.baseRoundId ? '，已继承上一轮候选包' : ''}`);
    navigate('release-detail', { releaseId: state.releaseId, roundId: round.roundId });
  } catch (error) { showAlert(error.message, 'danger'); }
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
  state.importFile = event.target.files?.[0] ?? null;
  state.importPreview = null;
  $('#import-preview-button').disabled = !state.importFile;
  $('#import-sheet').disabled = true;
  $('#import-confirm-button').disabled = true;
  $('#import-summary').textContent = '';
  $('#import-mapping').classList.add('d-none');
  $('#import-preview-rows').innerHTML = '<tr><td colspan="7" class="text-center text-body-secondary py-4">请读取预览</td></tr>';
});
$('#import-preview-button').addEventListener('click', readImportPreview);
$('#import-sheet').addEventListener('change', readImportPreview);
$('#import-confirm-button').addEventListener('click', confirmImport);
$('#import-select-all').addEventListener('change', (event) => document.querySelectorAll('.import-row-select').forEach((checkbox) => { checkbox.checked = event.target.checked; }));
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
    modal('package').hide(); form.reset(); showAlert(`候选包 ${candidate.fileName} 已创建`); navigate('candidate-detail', { candidateId: candidate.candidateId });
  } catch (error) { showAlert(error.message, 'danger'); }
});

renderRoute();
