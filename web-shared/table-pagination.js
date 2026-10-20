const controllers = new WeakMap();

function paginationMarkup() {
  const footer = document.createElement('div');
  footer.className = 'cam-table-pagination d-flex flex-wrap align-items-center justify-content-between gap-2 px-3 py-2 border-top';
  footer.innerHTML = '<div class="small text-body-secondary" data-page-info></div><div class="d-flex align-items-center gap-2"><label class="small text-body-secondary" data-page-size-label>每页</label><select class="form-select form-select-sm" data-page-size style="width:auto"><option value="10">10</option><option value="25">25</option><option value="50">50</option></select><nav aria-label="表格分页"><ul class="pagination pagination-sm mb-0" data-page-buttons></ul></nav></div>';
  return footer;
}

function pageButton(label, page, { disabled = false, active = false, labelText = label } = {}) {
  const item = document.createElement('li');
  item.className = `page-item${disabled ? ' disabled' : ''}${active ? ' active' : ''}`;
  const button = document.createElement('button');
  button.className = 'page-link';
  button.type = 'button';
  button.textContent = label;
  button.setAttribute('aria-label', labelText);
  if (active) button.setAttribute('aria-current', 'page');
  button.disabled = disabled;
  if (!disabled && !active) button.dataset.page = String(page);
  item.append(button);
  return item;
}

function update(controller) {
  const { table, body, footer } = controller;
  const rows = [...body.rows];
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / controller.pageSize));
  controller.page = Math.min(Math.max(1, controller.page), pageCount);
  const start = (controller.page - 1) * controller.pageSize;
  rows.forEach((row, index) => { row.hidden = index < start || index >= start + controller.pageSize; });

  const info = footer.querySelector('[data-page-info]');
  info.textContent = total ? `显示第 ${start + 1}–${Math.min(start + controller.pageSize, total)} 条，共 ${total} 条` : '共 0 条';
  const sizeSelect = footer.querySelector('[data-page-size]');
  sizeSelect.value = String(controller.pageSize);
  const buttons = footer.querySelector('[data-page-buttons]');
  buttons.replaceChildren();
  buttons.append(pageButton('‹', controller.page - 1, { disabled: controller.page <= 1, labelText: '上一页' }));
  const first = Math.max(1, Math.min(controller.page - 2, pageCount - 4));
  const last = Math.min(pageCount, first + 4);
  if (first > 1) {
    buttons.append(pageButton('1', 1, { active: controller.page === 1 }));
    if (first > 2) { const gap = document.createElement('li'); gap.className = 'page-item disabled'; gap.innerHTML = '<span class="page-link">…</span>'; buttons.append(gap); }
  }
  for (let page = first; page <= last; page++) buttons.append(pageButton(String(page), page, { active: controller.page === page }));
  if (last < pageCount) {
    if (last < pageCount - 1) { const gap = document.createElement('li'); gap.className = 'page-item disabled'; gap.innerHTML = '<span class="page-link">…</span>'; buttons.append(gap); }
    buttons.append(pageButton(String(pageCount), pageCount, { active: controller.page === pageCount }));
  }
  buttons.append(pageButton('›', controller.page + 1, { disabled: controller.page >= pageCount, labelText: '下一页' }));
  footer.hidden = total <= 10;
  table.setAttribute('aria-rowcount', String(total));
}

function attach(table) {
  if (controllers.has(table)) return controllers.get(table);
  const body = table.tBodies[0];
  if (!body) return null;
  const footer = paginationMarkup();
  const responsive = table.closest('.table-responsive');
  (responsive ?? table).insertAdjacentElement('afterend', footer);
  const controller = { table, body, footer, page: 1, pageSize: Number(table.dataset.pageSize) || 10 };
  footer.querySelector('[data-page-size]').addEventListener('change', (event) => {
    controller.pageSize = Number(event.currentTarget.value) || 10;
    controller.page = 1;
    update(controller);
  });
  footer.querySelector('[data-page-buttons]').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-page]');
    if (!button) return;
    controller.page = Number(button.dataset.page);
    update(controller);
  });
  controllers.set(table, controller);
  update(controller);
  return controller;
}

export function refreshPaginatedTables(root = document) {
  const tables = [];
  const marked = [];
  if (root.matches?.('table[data-paginate], tbody[data-paginate]')) marked.push(root);
  marked.push(...(root.querySelectorAll?.('table[data-paginate], tbody[data-paginate]') ?? []));
  for (const element of marked) tables.push(element.matches('tbody') ? element.closest('table') : element);
  for (const table of tables) {
    const controller = attach(table);
    if (controller) update(controller);
  }
}

if (typeof window !== 'undefined') window.CamTablePagination = { refresh: refreshPaginatedTables };

if (typeof document !== 'undefined') {
  const start = () => {
    refreshPaginatedTables(document);
    new MutationObserver((records) => {
      for (const record of records) {
        if (record.target.closest?.('tbody[data-paginate]')) {
          const table = record.target.closest('table');
          const controller = controllers.get(table);
          if (controller) update(controller);
        }
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) refreshPaginatedTables(node);
      }
    }).observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
