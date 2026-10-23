import { auditEventsMarkup, mountAuditEvents } from './audit-events.js?v=20261022-audit-permissions';
import { canEdgePage } from './role-permissions.js?v=20261023-auditor-scope';
import { renderRoleGroups } from './role-display.js?v=20261022-role-display';

let user = null, api, refresh, context, alert, labels = {}, users = [], exported = null;
let selectedGrantId = null, grantDetailTimer = null, grantDetailLoading = false;
let loadAuditEvents = null;
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const modal = (id) => bootstrap.Modal.getOrCreateInstance($(`#${id}-modal`));
export const currentUser = () => user;
export const hasRole = (...roles) => roles.some((r) => user?.roles?.includes(r));
export function csrfHeaders() {
  const token = document.cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith('cam_csrf='))?.slice(9);
  return token ? { 'x-cam-csrf': token } : {};
}
export function showLogin() {
  if (context) { window.clearInterval(context().pollTimer); window.clearInterval(context().queueTimer); }
  stopGrantDetailPolling();
  user = null; $('.app-wrapper').classList.add('d-none'); $('#account-login')?.classList.remove('d-none');
  $('#password-form')?.reset();
  const loginPassword = $('#login-password'); if (loginPassword) loginPassword.value = '';
  document.querySelectorAll('.modal.show').forEach((e) => bootstrap.Modal.getInstance(e)?.hide());
}
const input = (id, label, type = 'text', extra = '') => `<label for="${id}" class="form-label">${label}</label><input id="${id}" type="${type}" class="form-control mb-3" ${extra}>`;
function markup() {
  function dialog(id, title, fields, dialogClass = 'modal-dialog modal-lg') {
    return `<div class="modal fade" id="${id}-modal" tabindex="-1" aria-label="${title}" aria-hidden="true"><div class="${dialogClass}"><div class="modal-content"><form id="${id}-form"><div class="modal-header"><h5 class="modal-title" id="${id}-title">${title}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button></div><div class="modal-body"><div id="${id}-error" class="alert alert-danger d-none"></div>${fields}</div><div class="modal-footer"><button id="${id}-cancel" type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">取消</button><button type="submit" class="btn btn-primary">${id === 'password' ? '<i class="bi bi-check-lg me-1"></i>' : ''}确定</button></div></form></div></div></div>`;
  }
  document.body.insertAdjacentHTML('beforeend', `<div id="account-login" class="position-fixed top-0 start-0 w-100 h-100 bg-body-tertiary d-flex align-items-center justify-content-center" style="z-index:2000"><div class="card shadow" style="width:380px;max-width:95vw"><div class="card-header"><h3 class="card-title">CAM Edge · 制品管理</h3></div><form id="login-form"><div class="card-body"><div id="login-error" class="alert alert-danger d-none"></div>${input('login-name', '用户名', 'text', 'autocomplete="username" required')}${input('login-password', '密码', 'password', 'autocomplete="current-password" required')}<p class="small text-body-secondary">使用 CAM Core 中创建并获准登录 Edge 的账号。</p></div><div class="card-footer text-end"><button class="btn btn-primary" type="submit">登录</button></div></form></div></div>`
    + dialog('password', '修改密码', `<div id="password-help" class="alert alert-info">首次登录必须修改初始密码。</div>${input('old-password', '当前密码', 'password', 'autocomplete="current-password" required')}${input('new-password', '新密码（至少 12 个字符）', 'password', 'autocomplete="new-password" minlength="12" required')}${input('repeat-password', '确认新密码', 'password', 'autocomplete="new-password" minlength="12" required')}`, 'modal-dialog modal-dialog-centered cam-password-dialog')
    + dialog('grant', '创建下载授权', `<div id="grant-round-filters"><div class="row"><div class="col-md-4"><label for="grant-product" class="form-label">软件产品</label><select id="grant-product" class="form-select mb-3"><option value="">请选择软件产品</option></select></div><div class="col-md-4"><label for="grant-release" class="form-label">发布版本</label><select id="grant-release" class="form-select mb-3" disabled><option value="">请先选择软件产品</option></select></div><div class="col-md-4"><label for="grant-round" class="form-label">候选轮次</label><select id="grant-round" class="form-select mb-3" disabled><option value="">请先选择发布版本</option></select></div></div></div><div id="grant-candidate-summary" class="alert alert-light border d-none"></div><label class="form-label" for="grant-owner">下载责任人</label><input id="grant-owner" class="form-control bg-body-secondary mb-3" readonly><div class="row"><div class="col-md-4">${input('grant-days', '有效天数（1–30）', 'number', 'min="1" max="30" value="1" required')}</div><div class="col-md-4">${input('grant-total', '累计会话次数', 'number', 'min="1" max="10000" readonly required')}</div><div class="col-md-4">${input('grant-per-file', '每文件会话次数', 'number', 'min="1" max="10000" value="2" required')}</div></div><p class="small text-body-secondary">累计会话次数按所选文件数 × 每文件会话次数自动计算。续传复用原会话，不重复计数。仅可选择已完成并通过摘要校验的文件。</p><div id="grant-files" style="max-height:300px;overflow:auto"></div>`)
    + `<div class="modal fade" id="grant-export-modal" tabindex="-1" aria-label="授权清单" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">下载授权清单</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button></div><div class="modal-body"><div class="alert alert-warning">下载链接只在本次创建后显示，请立即保存并交给下载人员。</div><div id="grant-links"></div><p class="small mt-3">测试服务器下载：首次保存响应头 X-CAM-Download-Session；续传使用 Range 与同名请求头携带会话 ID。也可使用 Authorization: Bearer 传 Token。下载完成请核对 SHA-256。</p></div><div class="modal-footer"><button id="export-grant-json" class="btn btn-outline-primary"><i class="bi bi-filetype-json me-1"></i>导出 JSON</button><button id="export-grant-text" class="btn btn-outline-primary"><i class="bi bi-download me-1"></i>导出链接列表</button><button id="redownload-grant-list" class="btn btn-primary"><i class="bi bi-arrow-repeat me-1"></i>重新下载列表文件</button></div></div></div></div>`);
  $('#account-login .card-title').textContent = 'CAM Edge · 制品管理';
  function section(id, title, content, action) {
    return `<section id="view-${id}" class="d-none"><div class="card"><div class="card-header cam-card-header"><h3 class="card-title">${title}</h3>${action}</div><div class="card-body">${content}</div></div></section>`;
  }
  $('.app-content .container-fluid').insertAdjacentHTML('beforeend', section('users', '账号与角色', '<p class="small text-body-secondary">账号、Core 登录资格、Edge 登录资格和角色统一由 CAM Core 管理。此处只读展示当前已授权的 Edge 人员。</p><div class="table-responsive"><table class="table align-middle"><thead><tr><th>用户名 / 姓名</th><th>Edge 角色</th><th>状态</th><th>说明</th></tr></thead><tbody id="user-rows" data-paginate></tbody></table></div><section id="audit-events-section" class="mt-4 d-none"><h5>最近认证及操作审计</h5><p class="small text-body-secondary">仅审计管理员可查看。记录最近的认证事件和受保护操作。</p><div class="table-responsive"><table class="table table-sm table-hover align-middle"><thead><tr><th>时间</th><th>事件</th><th>调用身份</th><th>来源</th><th>详情</th></tr></thead><tbody id="auth-events" data-paginate></tbody></table></div></section>', '') + section('grants', '下载授权', '<p class="small text-body-secondary">按累计 / 单文件会话次数限制下载；续传复用会话。账号禁用后停止下载。Token 调用记录为授权持有者，不视为责任人本人认证。</p><div class="table-responsive"><table class="table align-middle"><thead><tr><th>授权 ID</th><th>授权轮次</th><th>责任人</th><th>文件数</th><th>已用 / 累计次数</th><th>到期 / 状态</th><th>操作</th></tr></thead><tbody id="grant-rows" data-paginate></tbody></table></div><div id="grant-detail" class="mt-4 d-none"></div>', '<button id="new-grant" class="btn btn-primary btn-sm">创建下载授权</button>'));
  $('#audit-events-section')?.remove();
  $('.app-content .container-fluid').insertAdjacentHTML('beforeend', section('audit', '审计日志', auditEventsMarkup(), ''));
  $('.sidebar-menu').insertAdjacentHTML('beforeend', '<li class="nav-item" id="grants-nav" data-menu-group-item="business"><a href="#grants" class="nav-link" data-route="grants"><span class="nav-icon bi bi-download"></span><p>下载授权</p></a></li><li class="nav-header" data-menu-group="security">账号安全</li><li class="nav-item" id="users-nav" data-menu-group-item="security"><a href="#users" class="nav-link" data-route="users"><span class="nav-icon bi bi-people"></span><p>账号管理</p></a></li><li class="nav-header" data-menu-group="audit">审计</li><li class="nav-item" id="audit-nav" data-menu-group-item="audit"><a href="#audit" class="nav-link" data-route="audit"><span class="nav-icon bi bi-journal-text"></span><p>审计日志</p></a></li>');
  document.querySelector('[data-menu-group="management"]')?.before($('#grants-nav'));
  $('.app-header .container-fluid').insertAdjacentHTML('beforeend', '<div class="ms-auto d-flex gap-2 align-items-center"><span id="account-name" class="small"></span><button id="change-password" class="btn btn-outline-secondary btn-sm">修改密码</button><button id="logout" class="btn btn-outline-secondary btn-sm">退出</button></div>');
  $('#new-package-button').insertAdjacentHTML('beforebegin', '<button id="round-grant" class="btn btn-outline-success btn-sm"><i class="bi bi-download me-1"></i>交付验证</button>');
  $('#candidate-edit-button').insertAdjacentHTML('beforebegin', '<button id="candidate-grant" class="btn btn-outline-success btn-sm"><i class="bi bi-download me-1"></i>下载 / 交付验证</button>');
}
function applyPermissions() {
  document.querySelectorAll('[data-modal], [data-delete-product], [data-delete-release], [data-round-candidate-delete], [data-candidate-delete], #new-round-button, #new-package-button, #import-packages-button, #batch-receive-button, #candidate-edit-button, #candidate-delete-button, #receive-button, #pause-button').forEach((e) => e.classList.toggle('d-none', !hasRole('EDGE_OPERATOR')));
  document.querySelectorAll('.sidebar-menu a').forEach((link) => {
    const route = link.dataset.route ?? link.hash.slice(1);
    link.parentElement.classList.toggle('d-none', !canEdgePage(user?.roles ?? [], route));
  });
  document.querySelectorAll('[data-menu-group]').forEach((header) => {
    const group = header.dataset.menuGroup;
    const items = [...document.querySelectorAll(`[data-menu-group-item="${group}"]`)];
    header.classList.toggle('d-none', !items.some((item) => !item.classList.contains('d-none')));
  });
  for (const id of ['round-grant', 'candidate-grant', 'new-grant']) $(`#${id}`).classList.toggle('d-none', !hasRole('EDGE_OPERATOR'));
  $('#candidate-grant').classList.toggle('d-none', !hasRole('EDGE_OPERATOR') || context().currentCandidate?.status !== 'COMPLETED');
}
async function acceptSession(result) {
  user = result.user; labels = result.roles;
  $('#account-name').textContent = `${user.displayName} (${user.username})`;
  $('#account-login').classList.add('d-none'); $('.app-wrapper').classList.remove('d-none'); applyPermissions();
  $('#password-title').textContent = user.mustChangePassword ? '修改初始密码' : '修改密码';
  $('#password-help').textContent = user.mustChangePassword ? '首次登录必须修改初始密码。' : '修改密码后需要重新登录。';
  $('#password-modal .btn-close').classList.toggle('d-none', Boolean(user.mustChangePassword));
  if (user.mustChangePassword) bootstrap.Modal.getOrCreateInstance($('#password-modal'), { backdrop: 'static', keyboard: false }).show();
  else if (!canEdgePage(user.roles ?? [], context().view)) { window.location.hash = `#${['products', 'gate-config', 'users', 'audit', 'grants'].find((view) => canEdgePage(user.roles ?? [], view)) ?? 'products'}`; await refresh(); }
  else await refresh();
}
async function submit(form, action, id) {
  const b = form.querySelector('[type="submit"]'); b.disabled = true; $(`#${id}-error`).classList.add('d-none');
  try { await action(); } catch (err) { const e = $(`#${id}-error`); e.textContent = err.message; e.classList.remove('d-none'); } finally { b.disabled = false; }
}
export async function initAccountUI(options) {
  ({ api, refresh, context, alert } = options); markup();
  loadAuditEvents = mountAuditEvents($('#view-audit'), api, (error) => alert(error.message, 'danger'));
  $('#password-modal').addEventListener('hide.bs.modal', (event) => { if (user?.mustChangePassword) event.preventDefault(); });
  new MutationObserver(applyPermissions).observe($('.app-main'), { childList: true, subtree: true });
  $('#login-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => { const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#login-name').value, password: $('#login-password').value }) }); $('#login-password').value = ''; await acceptSession(r); }, 'login'); };
  $('#logout').onclick = async () => { try { await api('/api/v1/auth/logout', { method: 'POST' }); showLogin(); } catch (e) { alert(e.message, 'danger'); } };
  $('#change-password').classList.add('d-none');
  $('#password-cancel').onclick = async () => {
    if (!user?.mustChangePassword) { $('#password-form').reset(); modal('password').hide(); return; }
    const button = $('#password-cancel'); button.disabled = true; $('#password-error').classList.add('d-none');
    try { await api('/api/v1/auth/logout', { method: 'POST' }); showLogin(); }
    catch (err) { $('#password-error').textContent = err.message; $('#password-error').classList.remove('d-none'); }
    finally { button.disabled = false; }
  };
  $('#password-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => { if ($('#new-password').value !== $('#repeat-password').value) throw new Error('两次新密码不一致'); await api('/api/v1/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword: $('#old-password').value, password: $('#new-password').value }) }); showLogin(); }, 'password'); };
  $('#new-grant').onclick = () => openGrant().catch((e) => alert(e.message, 'danger'));
  $('#round-grant').onclick = () => openGrant(context().roundId).catch((e) => alert(e.message, 'danger'));
  $('#candidate-grant').onclick = () => openGrant(null, context().candidateId).catch((e) => alert(e.message, 'danger'));
  $('#grant-product').onchange = () => loadGrantReleases().catch((e) => alert(e.message, 'danger'));
  $('#grant-release').onchange = () => loadGrantRounds().catch((e) => alert(e.message, 'danger'));
  $('#grant-round').onchange = () => loadGrantFiles().catch((e) => alert(e.message, 'danger'));
  $('#grant-per-file').oninput = updateGrantTotal;
  $('#grant-files').onchange = updateGrantTotal;
  $('#grant-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => {
    const candidateIds = [...document.querySelectorAll('#grant-files input:checked')].map((i) => i.value);
    if (!candidateIds.length) throw new Error('请选择已完成文件');
    exported = await api('/api/v1/download-grants', { method: 'POST', body: JSON.stringify({ candidateIds, roundId: $('#grant-round').value || null, expiresAt: new Date(Date.now() + Number($('#grant-days').value) * 86400000).toISOString(), maxSessionsPerFile: Number($('#grant-per-file').value) }) });
    exported.items.forEach((i) => { i.downloadUrl = new URL(i.downloadUrl, window.location.origin).href; });
    $('#grant-links').innerHTML = exported.items.map((i) => `<div class="mb-2"><a href="${esc(i.downloadUrl)}" referrerpolicy="no-referrer">${esc(i.fileName)}</a><div class="small font-monospace text-break">SHA-256: ${esc(i.sha256)}</div></div>`).join('');
    modal('grant').hide(); modal('grant-export').show(); if (context().view === 'grants') await renderAccountView('grants');
  }, 'grant'); };
  $('#export-grant-json').onclick = () => saveExport('json'); $('#export-grant-text').onclick = () => saveExport('txt'); $('#redownload-grant-list').onclick = () => saveExport('txt');
  $('#grant-export-modal').addEventListener('hidden.bs.modal', () => { exported = null; $('#grant-links').replaceChildren(); });
  try { await acceptSession(await api('/api/v1/auth/me')); } catch { showLogin(); }
}
async function openGrant(roundId, candidateId) {
  const products = await api('/api/v1/products');
  $('#grant-owner').value = `${user.displayName} (${user.username})`;
  $('#grant-days').value = '1'; $('#grant-per-file').value = '2'; $('#grant-total').value = '0';
  $('#grant-files').innerHTML = '<div class="text-body-secondary">请先选择候选轮次</div>';
  $('#grant-round-filters').classList.remove('d-none');
  $('#grant-candidate-summary').classList.add('d-none');
  $('#grant-release').innerHTML = '<option value="">请先选择软件产品</option>';
  $('#grant-release').disabled = true;
  $('#grant-round').innerHTML = '<option value="">请先选择发布版本</option>';
  $('#grant-round').disabled = true;
  $('#grant-product').innerHTML = '<option value="">请选择软件产品</option>' + products.items.map((p) => `<option value="${esc(p.productId)}">${esc(p.name)}</option>`).join('');
  $('#grant-product').disabled = false;
  if (candidateId) {
    const candidate = await api(`/api/v1/candidates/${encodeURIComponent(candidateId)}`);
    if (candidate.status !== 'COMPLETED') throw new Error('只能授权已完成的候选包');
    $('#grant-round-filters').classList.add('d-none');
    $('#grant-candidate-summary').textContent = `授权范围：当前候选包 · ${candidate.fileName}（${candidate.version} / ${candidate.architecture}）`;
    $('#grant-candidate-summary').classList.remove('d-none');
    renderGrantFiles([candidate]);
  } else if (roundId) {
    const round = await api(`/api/v1/rounds/${encodeURIComponent(roundId)}`);
    $('#grant-round-filters').classList.add('d-none');
    $('#grant-candidate-summary').textContent = `授权范围：${round.productName} · ${round.displayVersion} · 第 ${round.roundNo} 轮`;
    $('#grant-candidate-summary').classList.remove('d-none');
    $('#grant-product').value = round.productId;
    await loadGrantReleases(round.releaseId, roundId);
  } else {
    $('#grant-release').innerHTML = '<option value="">请先选择软件产品</option>';
    $('#grant-release').disabled = true;
    $('#grant-round').innerHTML = '<option value="">请先选择发布版本</option>';
    $('#grant-round').disabled = true;
  }
  $('#grant-error').classList.add('d-none'); modal('grant').show();
}

async function loadGrantReleases(selectedReleaseId = null, selectedRoundId = null) {
  const productId = $('#grant-product').value;
  $('#grant-release').innerHTML = '<option value="">请选择发布版本</option>';
  $('#grant-round').innerHTML = '<option value="">请先选择发布版本</option>';
  $('#grant-release').disabled = !productId;
  $('#grant-round').disabled = true;
  $('#grant-files').innerHTML = '<div class="text-body-secondary">请先选择候选轮次</div>';
  if (!productId) return;
  const releases = (await api(`/api/v1/releases?productId=${encodeURIComponent(productId)}`)).items;
  $('#grant-release').innerHTML = '<option value="">请选择发布版本</option>' + releases.map((r) => `<option value="${esc(r.releaseId)}">${esc(r.version)}</option>`).join('');
  if (selectedReleaseId) {
    $('#grant-release').value = selectedReleaseId;
    await loadGrantRounds(selectedRoundId);
  }
}

async function loadGrantRounds(selectedRoundId = null) {
  const releaseId = $('#grant-release').value;
  $('#grant-round').innerHTML = '<option value="">请选择候选轮次</option>';
  $('#grant-round').disabled = !releaseId;
  $('#grant-files').innerHTML = '<div class="text-body-secondary">请先选择候选轮次</div>';
  if (!releaseId) return;
  const rounds = (await api(`/api/v1/releases/${encodeURIComponent(releaseId)}/rounds`)).items;
  $('#grant-round').innerHTML = '<option value="">请选择候选轮次</option>' + rounds.map((r) => `<option value="${esc(r.roundId)}">第 ${r.roundNo} 轮</option>`).join('');
  if (selectedRoundId) {
    $('#grant-round').value = selectedRoundId;
    await loadGrantFiles();
  }
}

async function loadGrantFiles() {
  const roundId = $('#grant-round').value;
  if (!roundId) {
    $('#grant-files').innerHTML = '<div class="text-body-secondary">请先选择候选轮次</div>';
    return;
  }
  const files = (await api(`/api/v1/rounds/${encodeURIComponent(roundId)}/candidates`)).items;
  renderGrantFiles(files.filter((c) => c.status === 'COMPLETED'));
}

function renderGrantFiles(completed) {
  $('#grant-files').innerHTML = completed.length
    ? completed.map((c) => `<label class="form-check mb-2"><input class="form-check-input" type="checkbox" value="${esc(c.candidateId)}" checked><span class="form-check-label">${esc(c.fileName)} <small class="text-body-secondary">${esc(c.version)} / ${esc(c.architecture)}</small></span></label>`).join('')
    : '<div class="text-body-secondary">当前候选轮次没有已完成的候选包</div>';
  updateGrantTotal();
}
function updateGrantTotal() { const selectedCount = document.querySelectorAll('#grant-files input:checked').length; const perFile = Number($('#grant-per-file')?.value || 2); $('#grant-total').value = selectedCount * (Number.isSafeInteger(perFile) && perFile > 0 ? perFile : 0); }
function saveExport(type) {
  if (!exported) return;
  const text = type === 'json' ? JSON.stringify(exported, null, 2) : exported.items.map((i) => `${i.downloadUrl}\n# ${i.fileName} SHA-256=${i.sha256}`).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: type === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${exported.grantId}.${type}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function renderAccountView(view) {
  if (view !== 'grants') stopGrantDetailPolling();
  if (view === 'users') {
    if (!canEdgePage(user?.roles ?? [], 'users')) throw new Error('没有账号查看权限');
    users = (await api('/api/v1/users')).items;
    $('#user-rows').innerHTML = users.map((u) => `<tr><td>${esc(u.username)}<div class="small">${esc(u.displayName)}</div></td><td>${renderRoleGroups([{ scope: 'Edge', roles: u.roles.map((role) => labels[role] ?? role) }])}</td><td>${u.status === 'ACTIVE' ? '启用' : '禁用'}${u.mustChangePassword ? ' / 待改密码' : ''}${u.lockedUntil > Date.now() ? ' / 锁定' : ''}</td><td>-</td></tr>`).join('');
  }
  if (view === 'audit') {
    if (!canEdgePage(user?.roles ?? [], 'audit')) throw new Error('没有审计查看权限');
    await loadAuditEvents?.();
  }
  if (view === 'grants') {
    if (!hasRole('EDGE_OPERATOR', 'EDGE_AUDITOR')) throw new Error('没有下载授权权限');
    const grants = (await api('/api/v1/download-grants')).items;
    $('#grant-rows').innerHTML = grants.map((g) => {
      const person = g.responsiblePerson ?? {};
      const personLabel = person.displayName && person.username ? `${person.displayName}（${person.username}）` : person.username || person.displayName || g.principalId || '-';
      const roundLabel = g.roundId ? `${g.roundNo == null ? '' : `第 ${esc(g.roundNo)} 轮`}<div class="small text-body-secondary text-break">${esc(g.roundId)}</div>${g.productName || g.displayVersion ? `<div class="small text-body-secondary">${esc([g.productName, g.displayVersion].filter(Boolean).join(' · '))}</div>` : ''}` : '-';
      return `<tr><td class="small text-break">${esc(g.grantId)}</td><td>${roundLabel}</td><td>${esc(personLabel)}${person.id && !person.displayName && !person.username ? `<div class="small text-body-secondary text-break">${esc(person.id)}</div>` : ''}</td><td>${g.items.length}</td><td>${g.usedTotalSessions} / ${g.maxTotalSessions}</td><td>${new Date(g.expiresAt).toLocaleString()}<div>${g.revokedAt ? '已撤销' : Date.parse(g.expiresAt) <= Date.now() ? '已到期' : '有效'}</div></td><td><button class="btn btn-outline-primary btn-sm me-2" data-grant-log="${esc(g.grantId)}"><i class="bi bi-eye"></i> 明细</button>${g.createdBy === user.id && !g.revokedAt && hasRole('EDGE_OPERATOR') ? `<button class="btn btn-outline-danger btn-sm" data-revoke-grant="${esc(g.grantId)}">撤销</button>` : ''}</td></tr>`;
    }).join('') || '<tr><td colspan="7" class="text-center text-body-secondary">暂无授权；创建后请及时导出清单。</td></tr>';
    if (selectedGrantId && !grants.some((g) => g.grantId === selectedGrantId)) { selectedGrantId = null; stopGrantDetailPolling(); }
    document.querySelectorAll('[data-grant-log]').forEach((b) => { b.onclick = () => showGrantDetail(b.dataset.grantLog); });
    document.querySelectorAll('[data-revoke-grant]').forEach((b) => { b.onclick = async () => { if (!await context().confirm({ title: '撤销下载授权', message: '撤销后对应 Token 链接停止接受新的下载请求。', confirmText: '确定撤销' })) return; try { await api(`/api/v1/download-grants/${encodeURIComponent(b.dataset.revokeGrant)}`, { method: 'DELETE' }); await renderAccountView('grants'); } catch (e) { alert(e.message, 'danger'); } }; });
  }
}
function stopGrantDetailPolling() {
  if (grantDetailTimer) window.clearInterval(grantDetailTimer);
  grantDetailTimer = null;
  selectedGrantId = null;
  grantDetailLoading = false;
  $('#grant-detail')?.classList.add('d-none');
}
function bytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB']; let amount = n; let i = -1;
  while (amount >= 1024 && i < units.length - 1) { amount /= 1024; i += 1; }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[i]}`;
}
function sessionStatus(status) { return { ACTIVE: '发送中', INTERRUPTED: '已中断', COMPLETED: '已完成', FAILED: '失败' }[status] ?? status; }
async function showGrantDetail(grantId) {
  selectedGrantId = grantId;
  if (grantDetailTimer) window.clearInterval(grantDetailTimer);
  const load = async () => {
    if (grantDetailLoading || selectedGrantId !== grantId) return;
    grantDetailLoading = true;
    try {
      const g = await api(`/api/v1/download-grants/${encodeURIComponent(grantId)}`);
      if (selectedGrantId !== grantId) return;
      const itemMap = new Map(g.items.map((item) => [item.candidateId, item]));
      const sessions = g.sessions ?? [];
      $('#grant-detail').classList.remove('d-none');
      $('#grant-detail').innerHTML = `<div class="d-flex justify-content-between align-items-center mb-2"><h5 class="mb-0">传输明细：${esc(g.grantId)}</h5><button type="button" class="btn btn-outline-secondary btn-sm" id="close-grant-detail">关闭</button></div><p class="small text-body-secondary">累计传输表示服务器已写入连接的字节数；文件进度表示已连续接收的文件前缀。统计不代表接收端已经落盘。高频中断、恢复等过程写入运行日志。</p>${sessions.length ? `<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>文件</th><th>状态</th><th>文件进度</th><th>累计传输</th><th>来源 / 更新时间</th></tr></thead><tbody>${sessions.map((s) => { const item = itemMap.get(s.candidate_id); const size = Number(item?.size ?? 0); const covered = Number(s.covered_bytes ?? 0); const percent = size > 0 ? Math.min(100, Math.round((covered / size) * 100)) : 0; return `<tr><td class="text-break">${esc(item?.fileName ?? s.candidate_id)}</td><td>${esc(sessionStatus(s.status))}</td><td style="min-width:180px"><div class="progress" role="progressbar" aria-label="文件接收进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar ${s.status === 'COMPLETED' ? 'bg-success' : ''}" style="width:${percent}%">${percent}%</div></div><div class="small text-body-secondary mt-1">${bytes(covered)} / ${bytes(size)}</div></td><td>${bytes(s.bytes_sent)}</td><td class="small text-break">${esc(s.source_address ?? '-')}<br>${esc(s.updated_at ?? '-')}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="alert alert-light border">暂无传输会话。HEAD 探测、被拒绝的并发连接和零字节中断不会计入次数。</div>'}`;
      $('#close-grant-detail').onclick = stopGrantDetailPolling;
    } catch (e) { if (selectedGrantId === grantId) alert(e.message, 'danger'); }
    finally { grantDetailLoading = false; }
  };
  await load();
  if (selectedGrantId === grantId) grantDetailTimer = window.setInterval(load, 2000);
}
