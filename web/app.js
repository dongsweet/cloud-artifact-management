const state = { candidates: [], selectedId: null, pollTimer: null };

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

function formatBytes(value) {
  if (!Number.isFinite(Number(value))) return '-';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = -1;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[unit]}`;
}

function statusLabel(status) {
  return { CREATED: '待接收', RECEIVING: '接收中', PARTIAL: '待完成', FAILED: '失败', COMPLETED: '已完成' }[status] ?? status;
}

function statusClass(status) {
  return { CREATED: 'text-bg-secondary', RECEIVING: 'text-bg-info', PARTIAL: 'text-bg-warning', FAILED: 'text-bg-danger', COMPLETED: 'text-bg-success' }[status] ?? 'text-bg-secondary';
}

function showAlert(message, type = 'success') {
  const alert = $('#alert');
  alert.className = `alert alert-${type}`;
  alert.textContent = message;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.setTimeout(() => alert.classList.add('d-none'), 5000);
}

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message ?? `请求失败（${response.status}）`);
  return body;
}

function setView(view) {
  const views = ['candidates', 'create', 'detail'];
  views.forEach((name) => $(`#view-${name}`).classList.toggle('d-none', name !== view));
  document.querySelectorAll('[data-view]').forEach((link) => link.classList.toggle('active', link.dataset.view === view && link.classList.contains('nav-link')));
  const title = view === 'create' ? '创建接收任务' : view === 'detail' ? '候选详情' : '候选制品';
  $('#page-title').textContent = title;
  $('#breadcrumb-title').textContent = title;
  if (view === 'candidates') loadCandidates().catch((error) => showAlert(error.message, 'danger'));
  if (view === 'create') $('#create-form').reset();
}

function renderCandidates(items) {
  state.candidates = items;
  $('#count-total').textContent = items.length;
  $('#count-receiving').textContent = items.filter((item) => item.status === 'RECEIVING').length;
  $('#count-completed').textContent = items.filter((item) => item.status === 'COMPLETED').length;
  const rows = $('#candidate-rows');
  if (items.length === 0) {
    rows.innerHTML = '<tr><td colspan="7" class="text-center text-body-secondary py-4">暂无候选制品</td></tr>';
    return;
  }
  rows.innerHTML = items.map((item) => {
    const progress = item.chunkCount === 0 ? 100 : Math.round((item.completedParts / item.chunkCount) * 100);
    return `<tr><td><span class="font-monospace small">${escapeHtml(item.candidateId.slice(-18))}</span></td><td>${escapeHtml(item.version)}</td><td><div class="fw-semibold text-truncate file-name">${escapeHtml(item.fileName)}</div><small class="text-body-secondary">${escapeHtml(item.architecture ?? '-')}</small></td><td>${formatBytes(item.size)}</td><td><div class="progress compact-progress"><div class="progress-bar" style="width:${progress}%"></div></div><small class="text-body-secondary">${item.completedParts}/${item.chunkCount}</small></td><td><span class="badge ${statusClass(item.status)}">${statusLabel(item.status)}</span></td><td><button class="btn btn-outline-primary btn-sm" data-candidate="${escapeHtml(item.candidateId)}" title="查看候选详情"><i class="bi bi-eye"></i><span class="visually-hidden">查看</span></button></td></tr>`;
  }).join('');
  rows.querySelectorAll('[data-candidate]').forEach((button) => button.addEventListener('click', () => openDetail(button.dataset.candidate)));
}

async function loadCandidates() {
  const result = await api('/api/v1/candidates?limit=100');
  renderCandidates(result.items);
}

function renderDetail(candidate, parts) {
  state.selectedId = candidate.candidateId;
  $('#detail-title').textContent = candidate.fileName;
  const fields = [
    ['候选 ID', `<span class="font-monospace">${escapeHtml(candidate.candidateId)}</span>`],
    ['研发地址', `<span class="text-break">${escapeHtml(candidate.sourceUrl)}</span>`],
    ['版本 / 架构', `${escapeHtml(candidate.version)} / ${escapeHtml(candidate.architecture ?? '-')}`],
    ['目标范围', escapeHtml((candidate.targets ?? []).join('、') || '-')],
    ['大小', formatBytes(candidate.size)],
    ['完整摘要', `<span class="font-monospace small text-break">${escapeHtml(candidate.finalSha256 ?? candidate.expectedSha256 ?? '接收完成后生成')}</span>`],
    ['状态', `<span class="badge ${statusClass(candidate.status)}">${statusLabel(candidate.status)}</span>`],
    ...(candidate.error ? [['错误信息', `<span class="text-danger text-break">${escapeHtml(candidate.error)}</span>`]] : [])
  ];
  $('#detail-fields').innerHTML = fields.map(([label, value]) => `<dt class="col-sm-3 col-lg-2">${label}</dt><dd class="col-sm-9 col-lg-10">${value}</dd>`).join('');
  const completed = parts?.completedParts?.length ?? candidate.completedParts;
  const count = parts?.chunkCount ?? candidate.chunkCount;
  const progress = count === 0 ? 100 : Math.round((completed / count) * 100);
  $('#detail-progress').style.width = `${progress}%`;
  $('#detail-progress').textContent = `${progress}%（${completed}/${count}）`;
  $('#receive-button').disabled = candidate.status === 'COMPLETED' || candidate.status === 'RECEIVING';
  $('#complete-button').disabled = candidate.status === 'COMPLETED' || (parts?.missingParts?.length ?? candidate.missingParts) > 0;
}

async function loadDetail(candidateId) {
  const [candidate, parts] = await Promise.all([api(`/api/v1/candidates/${encodeURIComponent(candidateId)}`), api(`/api/v1/candidates/${encodeURIComponent(candidateId)}/parts`)]);
  renderDetail(candidate, parts);
  return candidate;
}

async function openDetail(candidateId) {
  try {
    setView('detail');
    await loadDetail(candidateId);
    window.location.hash = `detail/${encodeURIComponent(candidateId)}`;
  } catch (error) { showAlert(error.message, 'danger'); }
}

async function receiveCandidate() {
  try {
    await api(`/api/v1/candidates/${encodeURIComponent(state.selectedId)}/receive`, { method: 'POST', body: '{}' });
    showAlert('接收任务已启动');
    window.clearInterval(state.pollTimer);
    state.pollTimer = window.setInterval(async () => {
      try {
        const candidate = await loadDetail(state.selectedId);
        if (candidate?.status === 'COMPLETED' || candidate?.status === 'FAILED') window.clearInterval(state.pollTimer);
      } catch { window.clearInterval(state.pollTimer); }
    }, 1500);
  } catch (error) { showAlert(error.message, 'danger'); }
}

async function completeCandidate() {
  try {
    await api(`/api/v1/candidates/${encodeURIComponent(state.selectedId)}/complete`, { method: 'POST', body: '{}' });
    showAlert('候选文件已完成合并和摘要校验');
    await loadDetail(state.selectedId);
  } catch (error) { showAlert(error.message, 'danger'); }
}

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = {
    sourceUrl: $('#source-url').value.trim(), fileName: $('#file-name').value.trim(), version: $('#version').value.trim(),
    architecture: $('#architecture').value.trim() || null, targets: $('#targets').value.split(',').map((value) => value.trim()).filter(Boolean),
    size: Number($('#size').value), sha256: $('#sha256').value.trim() || null
  };
  try {
    const candidate = await api('/api/v1/candidates', { method: 'POST', body: JSON.stringify(payload) });
    showAlert(`候选任务 ${candidate.candidateId} 已创建`);
    await openDetail(candidate.candidateId);
  } catch (error) { showAlert(error.message, 'danger'); }
});

document.querySelectorAll('[data-view]').forEach((element) => element.addEventListener('click', (event) => {
  event.preventDefault();
  if (element.dataset.view) { window.location.hash = element.dataset.view; setView(element.dataset.view); }
}));
$('#receive-button').addEventListener('click', receiveCandidate);
$('#complete-button').addEventListener('click', completeCandidate);

setView('candidates');
