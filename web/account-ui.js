let user = null, api, refresh, context, alert, labels = {}, users = [], exported = null;
let selectedGrantId = null, grantDetailTimer = null, grantDetailLoading = false;
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
  document.querySelectorAll('.modal.show').forEach((e) => bootstrap.Modal.getInstance(e)?.hide());
}
const input = (id, label, type = 'text', extra = '') => `<label for="${id}" class="form-label">${label}</label><input id="${id}" type="${type}" class="form-control mb-3" ${extra}>`;
function markup() {
  function dialog(id, title, fields) {
    return `<div class="modal fade" id="${id}-modal" tabindex="-1" aria-label="${title}" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><form id="${id}-form"><div class="modal-header"><h5 class="modal-title" id="${id}-title">${title}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button></div><div class="modal-body"><div id="${id}-error" class="alert alert-danger d-none"></div>${fields}</div><div class="modal-footer"><button type="button" class="btn btn-outline-secondary" data-bs-dismiss="modal">取消</button><button type="submit" class="btn btn-primary">确定</button></div></form></div></div></div>`;
  }
  document.body.insertAdjacentHTML('beforeend', `<div id="account-login" class="position-fixed top-0 start-0 w-100 h-100 bg-body-tertiary d-flex align-items-center justify-content-center" style="z-index:2000"><div class="card shadow" style="width:380px;max-width:95vw"><div class="card-header"><h3 class="card-title">统一运维外部交换区 · 登录</h3></div><form id="login-form"><div class="card-body"><div id="login-error" class="alert alert-danger d-none"></div>${input('login-name', '用户名', 'text', 'autocomplete="username" required')}${input('login-password', '密码', 'password', 'autocomplete="current-password" required')}<p class="small text-body-secondary">使用外部交换区独立账号。</p></div><div class="card-footer text-end"><button class="btn btn-primary" type="submit">登录</button></div></form></div></div>`
    + dialog('password', '修改密码', `<p>首次登录或重置密码后须先修改密码，修改后重新登录。</p>${input('old-password', '原密码', 'password', 'autocomplete="current-password" required')}${input('new-password', '新密码（至少 12 个字符）', 'password', 'autocomplete="new-password" minlength="12" required')}${input('repeat-password', '确认新密码', 'password', 'autocomplete="new-password" minlength="12" required')}`)
    + dialog('user', '账号管理', `${input('user-name', '用户名', 'text', 'pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" required')}${input('user-display', '姓名', 'text', 'maxlength="100" required')}<div id="user-password-field">${input('user-password', '初始 / 重置密码（至少 12 个字符）', 'password', 'minlength="12" autocomplete="new-password"')}</div><div id="user-roles"></div><label for="user-status" class="form-label mt-3">状态</label><select id="user-status" class="form-select"><option value="ACTIVE">启用</option><option value="DISABLED">禁用</option></select><p class="small text-body-secondary mt-3">创建 / 重置后须修改初始密码。保存角色、状态或重置密码会撤销登录会话；保存账号也会解除登录锁定。</p>`)
    + dialog('grant', '创建下载授权', `<label for="grant-recipient" class="form-label">下载责任人</label><select id="grant-recipient" class="form-select mb-3" required></select><div class="row"><div class="col-md-4">${input('grant-days', '有效天数（1–30）', 'number', 'min="1" max="30" value="1" required')}</div><div class="col-md-4">${input('grant-total', '累计会话次数', 'number', 'min="1" max="10000" value="20" required')}</div><div class="col-md-4">${input('grant-per-file', '每文件会话次数', 'number', 'min="1" max="10000" value="2" required')}</div></div><p class="small text-body-secondary">续传携带同一会话 ID 不重复扣次数。只可选择已完成并通过摘要校验的文件。</p><div id="grant-files" style="max-height:300px;overflow:auto"></div>`)
    + `<div class="modal fade" id="grant-export-modal" tabindex="-1" aria-label="授权清单" aria-hidden="true"><div class="modal-dialog modal-lg"><div class="modal-content"><div class="modal-header"><h5 class="modal-title">下载授权清单</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button></div><div class="modal-body"><div class="alert alert-warning">带 Token 链接只在本次创建后显示，请及时导出并交给责任人。数据库不保存明文 Token；持有链接者可使用下载授权。</div><div id="grant-links"></div><p class="small mt-3">测试服务器下载：首次保存响应头 X-CAM-Download-Session；续传使用 Range 与同名请求头携带会话 ID。也可使用 Authorization: Bearer 传 Token。下载完成请核对 SHA-256。</p></div><div class="modal-footer"><button id="export-grant-json" class="btn btn-outline-primary"><i class="bi bi-filetype-json me-1"></i>导出 JSON</button><button id="export-grant-text" class="btn btn-outline-primary"><i class="bi bi-download me-1"></i>导出链接列表</button><button id="redownload-grant-list" class="btn btn-primary"><i class="bi bi-arrow-repeat me-1"></i>重新下载列表文件</button></div></div></div></div>`);
  function section(id, title, content, action) {
    return `<section id="view-${id}" class="d-none"><div class="card"><div class="card-header cam-card-header"><h3 class="card-title">${title}</h3>${action}</div><div class="card-body">${content}</div></div></section>`;
  }
  $('.app-content .container-fluid').insertAdjacentHTML('beforeend', section('users', '账号管理', '<div class="table-responsive"><table class="table align-middle"><thead><tr><th>用户名 / 姓名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody id="user-rows"></tbody></table></div><h5 class="mt-4">最近认证及操作审计</h5><div id="auth-events"></div>', '<button id="new-user" class="btn btn-primary btn-sm">创建账号</button>') + section('grants', '下载授权', '<p class="small text-body-secondary">按累计 / 单文件会话次数限制下载；续传复用会话。账号禁用后停止下载。Token 调用记录为授权持有者，不视为责任人本人认证。</p><div class="table-responsive"><table class="table align-middle"><thead><tr><th>授权 / 责任人</th><th>文件数</th><th>已用 / 累计次数</th><th>到期 / 状态</th><th>操作</th></tr></thead><tbody id="grant-rows"></tbody></table></div><div id="grant-detail" class="mt-4 d-none"></div>', '<button id="new-grant" class="btn btn-primary btn-sm">创建下载授权</button>'));
  $('.sidebar-menu').insertAdjacentHTML('beforeend', '<li class="nav-item" id="grants-nav"><a href="#grants" class="nav-link"><span class="nav-icon bi bi-download"></span><p>下载授权</p></a></li><li class="nav-item" id="users-nav"><a href="#users" class="nav-link"><span class="nav-icon bi bi-people"></span><p>账号管理</p></a></li>');
  $('.app-header .container-fluid').insertAdjacentHTML('beforeend', '<div class="ms-auto d-flex gap-2 align-items-center"><span id="account-name" class="small"></span><button id="change-password" class="btn btn-outline-secondary btn-sm">修改密码</button><button id="logout" class="btn btn-outline-secondary btn-sm">退出</button></div>');
  $('#new-package-button').insertAdjacentHTML('beforebegin', '<button id="round-grant" class="btn btn-outline-success btn-sm"><i class="bi bi-download me-1"></i>交付验证</button>');
  $('#candidate-edit-button').insertAdjacentHTML('beforebegin', '<button id="candidate-grant" class="btn btn-outline-success btn-sm"><i class="bi bi-download me-1"></i>下载 / 交付验证</button>');
}
function applyPermissions() {
  document.querySelectorAll('[data-modal], [data-delete-product], [data-delete-release], [data-round-candidate-delete], [data-candidate-delete], #new-round-button, #new-package-button, #import-packages-button, #batch-receive-button, #candidate-edit-button, #candidate-delete-button, #receive-button, #pause-button').forEach((e) => e.classList.toggle('d-none', !hasRole('CANDIDATE_RECEIVER')));
  $('#users-nav').classList.toggle('d-none', !hasRole('EDGE_ADMIN', 'EDGE_AUDITOR'));
  $('#grants-nav').classList.toggle('d-none', !hasRole('VALIDATOR', 'EDGE_AUDITOR'));
  for (const id of ['round-grant', 'candidate-grant', 'new-grant']) $(`#${id}`).classList.toggle('d-none', !hasRole('VALIDATOR'));
  $('#new-user').classList.toggle('d-none', !hasRole('EDGE_ADMIN'));
  $('#candidate-grant').classList.toggle('d-none', !hasRole('VALIDATOR') || context().currentCandidate?.status !== 'COMPLETED');
}
async function acceptSession(result) {
  user = result.user; labels = result.roles;
  $('#account-name').textContent = `${user.displayName} (${user.username})`;
  $('#account-login').classList.add('d-none'); $('.app-wrapper').classList.remove('d-none'); applyPermissions();
  if (user.mustChangePassword) bootstrap.Modal.getOrCreateInstance($('#password-modal'), { backdrop: 'static', keyboard: false }).show();
  else if (!hasRole('CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR')) { window.location.hash = '#users'; await refresh(); }
  else await refresh();
}
async function submit(form, action, id) {
  const b = form.querySelector('[type="submit"]'); b.disabled = true; $(`#${id}-error`).classList.add('d-none');
  try { await action(); } catch (err) { const e = $(`#${id}-error`); e.textContent = err.message; e.classList.remove('d-none'); } finally { b.disabled = false; }
}
export async function initAccountUI(options) {
  ({ api, refresh, context, alert } = options); markup();
  new MutationObserver(applyPermissions).observe($('.app-main'), { childList: true, subtree: true });
  $('#login-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => { const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: $('#login-name').value, password: $('#login-password').value }) }); $('#login-password').value = ''; await acceptSession(r); }, 'login'); };
  $('#logout').onclick = async () => { try { await api('/api/v1/auth/logout', { method: 'POST' }); showLogin(); } catch (e) { alert(e.message, 'danger'); } };
  $('#change-password').onclick = () => modal('password').show();
  $('#password-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => { if ($('#new-password').value !== $('#repeat-password').value) throw new Error('两次新密码不一致'); await api('/api/v1/auth/password', { method: 'POST', body: JSON.stringify({ oldPassword: $('#old-password').value, password: $('#new-password').value }) }); e.target.reset(); modal('password').hide(); showLogin(); }, 'password'); };
  $('#new-user').onclick = () => openUser();
  $('#user-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => {
    const id = e.target.dataset.id, mode = e.target.dataset.mode;
    const body = { username: $('#user-name').value, displayName: $('#user-display').value, roles: [...document.querySelectorAll('#user-roles input:checked')].map((r) => r.value), status: $('#user-status').value, password: $('#user-password').value };
    await api(mode === 'reset' ? `/api/v1/users/${encodeURIComponent(id)}/password` : id ? `/api/v1/users/${encodeURIComponent(id)}` : '/api/v1/users', { method: mode === 'reset' || !id ? 'POST' : 'PATCH', body: JSON.stringify(body) });
    e.target.reset(); modal('user').hide(); if (id === user.id) showLogin(); else await renderAccountView('users');
  }, 'user'); };
  $('#new-grant').onclick = () => openGrant().catch((e) => alert(e.message, 'danger'));
  $('#round-grant').onclick = () => openGrant(context().roundId).catch((e) => alert(e.message, 'danger'));
  $('#candidate-grant').onclick = () => openGrant(null, context().candidateId).catch((e) => alert(e.message, 'danger'));
  $('#grant-form').onsubmit = (e) => { e.preventDefault(); submit(e.target, async () => {
    const candidateIds = [...document.querySelectorAll('#grant-files input:checked')].map((i) => i.value);
    if (!candidateIds.length) throw new Error('请选择已完成文件');
    exported = await api('/api/v1/download-grants', { method: 'POST', body: JSON.stringify({ recipientId: $('#grant-recipient').value, candidateIds, expiresAt: new Date(Date.now() + Number($('#grant-days').value) * 86400000).toISOString(), maxTotalSessions: Number($('#grant-total').value), maxSessionsPerFile: Number($('#grant-per-file').value) }) });
    exported.items.forEach((i) => { i.downloadUrl = new URL(i.downloadUrl, window.location.origin).href; });
    $('#grant-links').innerHTML = exported.items.map((i) => `<div class="mb-2"><a href="${esc(i.downloadUrl)}" referrerpolicy="no-referrer">${esc(i.fileName)}</a><div class="small font-monospace text-break">SHA-256: ${esc(i.sha256)}</div></div>`).join('');
    modal('grant').hide(); modal('grant-export').show(); if (context().view === 'grants') await renderAccountView('grants');
  }, 'grant'); };
  $('#export-grant-json').onclick = () => saveExport('json'); $('#export-grant-text').onclick = () => saveExport('txt'); $('#redownload-grant-list').onclick = () => saveExport('txt');
  $('#grant-export-modal').addEventListener('hidden.bs.modal', () => { exported = null; $('#grant-links').replaceChildren(); });
  try { await acceptSession(await api('/api/v1/auth/me')); } catch { showLogin(); }
}
function openUser(id = '', mode = 'edit') {
  const form = $('#user-form'); form.reset(); form.dataset.id = id; form.dataset.mode = mode;
  const u = users.find((u) => u.id === id);
  $('#user-title').textContent = mode === 'reset' ? '重置密码' : id ? '编辑账号 / 解除锁定' : '创建账号';
  $('#user-name').value = u?.username ?? ''; $('#user-name').disabled = Boolean(id);
  $('#user-display').value = u?.displayName ?? ''; $('#user-display').disabled = mode === 'reset';
  $('#user-status').value = u?.status ?? 'ACTIVE'; $('#user-status').disabled = mode === 'reset';
  $('#user-password-field').classList.toggle('d-none', Boolean(id) && mode !== 'reset'); $('#user-password').required = !id || mode === 'reset';
  $('#user-roles').innerHTML = Object.entries(labels).map(([role, label]) => `<label class="form-check"><input class="form-check-input" type="checkbox" value="${role}" ${u?.roles.includes(role) ? 'checked' : ''} ${mode === 'reset' ? 'disabled' : ''}><span class="form-check-label">${esc(label)}</span></label>`).join('');
  $('#user-error').classList.add('d-none'); modal('user').show();
}
async function openGrant(roundId, candidateId) {
  const [people, files] = await Promise.all([api('/api/v1/validators'), candidateId ? api(`/api/v1/candidates/${encodeURIComponent(candidateId)}`).then((c) => ({ items: [c] })) : api(roundId ? `/api/v1/rounds/${encodeURIComponent(roundId)}/candidates` : '/api/v1/candidates?status=COMPLETED&limit=200')]);
  const completed = files.items.filter((c) => c.status === 'COMPLETED');
  if (!completed.length) throw new Error('没有可交付的已完成文件');
  $('#grant-recipient').innerHTML = people.items.map((p) => `<option value="${esc(p.id)}">${esc(p.displayName)} (${esc(p.username)})</option>`).join('');
  if (people.items.some((p) => p.id === user.id)) $('#grant-recipient').value = user.id;
  $('#grant-files').innerHTML = completed.map((c) => `<label class="form-check mb-2"><input class="form-check-input" type="checkbox" value="${esc(c.candidateId)}" checked><span class="form-check-label">${esc(c.fileName)} <small class="text-body-secondary">${esc(c.version)} / ${esc(c.architecture)}</small></span></label>`).join('');
  $('#grant-error').classList.add('d-none'); modal('grant').show();
}
function saveExport(type) {
  if (!exported) return;
  const text = type === 'json' ? JSON.stringify(exported, null, 2) : exported.items.map((i) => `${i.downloadUrl}\n# ${i.fileName} SHA-256=${i.sha256}`).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: type === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = `${exported.grantId}.${type}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function renderAccountView(view) {
  if (view !== 'grants') stopGrantDetailPolling();
  if (view === 'users') {
    if (!hasRole('EDGE_ADMIN', 'EDGE_AUDITOR')) throw new Error('没有账号管理权限');
    users = (await api('/api/v1/users')).items;
    $('#user-rows').innerHTML = users.map((u) => `<tr><td>${esc(u.username)}<div class="small">${esc(u.displayName)}</div></td><td>${u.roles.map((r) => esc(labels[r])).join('、')}</td><td>${u.status === 'ACTIVE' ? '启用' : '禁用'}${u.mustChangePassword ? ' / 待改密码' : ''}${u.lockedUntil > Date.now() ? ' / 锁定' : ''}</td><td>${hasRole('EDGE_ADMIN') ? `<button class="btn btn-outline-primary btn-sm me-2" data-edit-user="${esc(u.id)}"><i class="bi bi-pencil"></i> 编辑 / 解锁</button><button class="btn btn-outline-warning btn-sm" data-reset-user="${esc(u.id)}" ${u.id === user.id ? 'disabled title="请使用右上角修改密码"' : ''}>重置密码</button>` : '-'}</td></tr>`).join('');
    document.querySelectorAll('[data-edit-user]').forEach((b) => { b.onclick = () => openUser(b.dataset.editUser); });
    document.querySelectorAll('[data-reset-user]').forEach((b) => { b.onclick = () => openUser(b.dataset.resetUser, 'reset'); });
    $('#auth-events').innerHTML = eventTable((await api('/api/v1/auth-events')).items, true);
  }
  if (view === 'grants') {
    if (!hasRole('VALIDATOR', 'EDGE_AUDITOR')) throw new Error('没有下载授权权限');
    const grants = (await api('/api/v1/download-grants')).items;
    $('#grant-rows').innerHTML = grants.map((g) => `<tr><td class="small text-break">${esc(g.grantId)}<div>责任人：${esc(g.principalId)}</div></td><td>${g.items.length}</td><td>${g.usedTotalSessions} / ${g.maxTotalSessions}</td><td>${new Date(g.expiresAt).toLocaleString()}<div>${g.revokedAt ? '已撤销' : Date.parse(g.expiresAt) <= Date.now() ? '已到期' : '有效'}</div></td><td><button class="btn btn-outline-primary btn-sm me-2" data-grant-log="${esc(g.grantId)}"><i class="bi bi-eye"></i> 日志</button>${g.createdBy === user.id && !g.revokedAt && hasRole('VALIDATOR') ? `<button class="btn btn-outline-danger btn-sm" data-revoke-grant="${esc(g.grantId)}">撤销</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-body-secondary">暂无授权；创建后请及时导出清单。</td></tr>';
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
      $('#grant-detail').innerHTML = `<div class="d-flex justify-content-between align-items-center mb-2"><h5 class="mb-0">传输明细：${esc(g.grantId)}</h5><button type="button" class="btn btn-outline-secondary btn-sm" id="close-grant-detail">关闭</button></div><p class="small text-body-secondary">累计传输表示服务器已写入连接的字节数；文件进度表示已连续接收的文件前缀。统计不代表接收端已经落盘。</p>${sessions.length ? `<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>文件</th><th>状态</th><th>文件进度</th><th>累计传输</th><th>来源 / 更新时间</th></tr></thead><tbody>${sessions.map((s) => { const item = itemMap.get(s.candidate_id); const size = Number(item?.size ?? 0); const covered = Number(s.covered_bytes ?? 0); const percent = size > 0 ? Math.min(100, Math.round((covered / size) * 100)) : 0; return `<tr><td class="text-break">${esc(item?.fileName ?? s.candidate_id)}</td><td>${esc(sessionStatus(s.status))}</td><td style="min-width:180px"><div class="progress" role="progressbar" aria-label="文件接收进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar ${s.status === 'COMPLETED' ? 'bg-success' : ''}" style="width:${percent}%">${percent}%</div></div><div class="small text-body-secondary mt-1">${bytes(covered)} / ${bytes(size)}</div></td><td>${bytes(s.bytes_sent)}</td><td class="small text-break">${esc(s.source_address ?? '-')}<br>${esc(s.updated_at ?? '-')}</td></tr>`; }).join('')}</tbody></table></div>` : '<div class="alert alert-light border">暂无传输会话。HEAD 探测、被拒绝的并发连接和零字节中断不会计入次数。</div>'}<h6 class="mt-3">事件记录</h6>${eventTable(g.events)}`;
      $('#close-grant-detail').onclick = stopGrantDetailPolling;
    } catch (e) { if (selectedGrantId === grantId) alert(e.message, 'danger'); }
    finally { grantDetailLoading = false; }
  };
  await load();
  if (selectedGrantId === grantId) grantDetailTimer = window.setInterval(load, 2000);
}
function eventTable(events, auth = false) {
  return `<div class="table-responsive"><table class="table table-sm"><thead><tr><th>时间</th><th>事件</th><th>调用身份</th><th>${auth ? '来源' : '文件'}</th><th>详情</th></tr></thead><tbody>${events.map((e) => `<tr><td>${esc(e.created_at)}</td><td>${esc(e.event_type)}</td><td class="small text-break">${esc(e.principal_id)}</td><td>${esc(auth ? e.source_address : e.candidate_id)}</td><td class="small text-break">${esc(e.details_json)}</td></tr>`).join('')}</tbody></table></div>`;
}
