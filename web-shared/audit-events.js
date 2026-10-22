const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));

export function auditEventsMarkup() {
  return `<div data-audit-events>
    <form data-audit-filter class="row g-2 align-items-end mb-3">
      <div class="col-md-3"><label class="form-label" for="audit-search">关键字</label><input id="audit-search" class="form-control" maxlength="200" placeholder="操作者、事件、来源或详情"></div>
      <div class="col-md-2"><label class="form-label" for="audit-event-type">事件类型</label><input id="audit-event-type" class="form-control" maxlength="128" placeholder="精确匹配"></div>
      <div class="col-md-2"><label class="form-label" for="audit-from">开始日期</label><input id="audit-from" class="form-control" type="date"></div>
      <div class="col-md-2"><label class="form-label" for="audit-to">结束日期</label><input id="audit-to" class="form-control" type="date"></div>
      <div class="col-md-3 d-flex gap-2"><button class="btn btn-primary" type="submit"><i class="bi bi-search me-1"></i>筛选</button><button class="btn btn-outline-secondary" type="reset">清除</button></div>
    </form>
    <div class="table-responsive"><table class="table table-hover align-middle"><thead><tr><th>时间</th><th>事件</th><th>操作者</th><th>来源地址</th><th>详情</th></tr></thead><tbody data-audit-rows></tbody></table></div>
    <div class="d-flex align-items-center justify-content-between gap-2 flex-wrap"><span class="small text-body-secondary" data-audit-status></span><div class="d-flex align-items-center gap-2"><label class="small text-body-secondary" for="audit-page-size">每页</label><select id="audit-page-size" class="form-select form-select-sm" style="width:auto"><option>25</option><option selected>50</option><option>100</option></select><button class="btn btn-outline-secondary btn-sm" type="button" data-audit-prev>上一页</button><button class="btn btn-outline-secondary btn-sm" type="button" data-audit-next>下一页</button></div></div>
  </div>`;
}

export function mountAuditEvents(root, api, onError = () => {}) {
  if (!root) return async () => {};
  const form = root.querySelector('[data-audit-filter]');
  const rows = root.querySelector('[data-audit-rows]');
  const status = root.querySelector('[data-audit-status]');
  const pageSize = root.querySelector('#audit-page-size');
  const previous = root.querySelector('[data-audit-prev]');
  const next = root.querySelector('[data-audit-next]');
  let offset = 0;
  const load = async () => {
    const params = new URLSearchParams({ limit: pageSize.value, offset: String(offset) });
    for (const [name, selector] of [['search', '#audit-search'], ['eventType', '#audit-event-type'], ['from', '#audit-from'], ['to', '#audit-to']]) {
      const value = root.querySelector(selector).value.trim();
      if (value) params.set(name, value);
    }
    try {
      const result = await api(`/api/v1/auth-events?${params}`);
      rows.innerHTML = result.items.map((event) => `<tr><td class="text-nowrap">${escapeHtml(event.created_at)}</td><td>${escapeHtml(event.event_type)}</td><td class="text-break">${escapeHtml(event.principal_id ?? '-')}</td><td>${escapeHtml(event.source_address ?? '-')}</td><td><pre class="mb-0 small text-break" style="white-space:pre-wrap">${escapeHtml(event.details_json)}</pre></td></tr>`).join('') || '<tr><td colspan="5" class="text-center text-body-secondary py-4">暂无审计记录</td></tr>';
      const start = result.total ? result.offset + 1 : 0;
      const end = Math.min(result.offset + result.items.length, result.total);
      status.textContent = `显示 ${start}–${end} 条，共 ${result.total} 条`;
      previous.disabled = result.offset <= 0;
      next.disabled = result.offset + result.items.length >= result.total;
    } catch (error) { onError(error); }
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); offset = 0; void load(); });
  form.addEventListener('reset', () => { queueMicrotask(() => { offset = 0; void load(); }); });
  pageSize.addEventListener('change', () => { offset = 0; void load(); });
  previous.addEventListener('click', () => { offset = Math.max(0, offset - Number(pageSize.value)); void load(); });
  next.addEventListener('click', () => { offset += Number(pageSize.value); void load(); });
  return load;
}
