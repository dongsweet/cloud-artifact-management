export function mountArtifactCatalog(root, initialItems, {
  onPull = null,
  onDeliver = null,
  onHistory = null,
  statusOptions = [],
  statusFor = (item) => ({ key: 'DEFAULT', label: `${(item.files ?? []).filter((file) => file.stored).length} / ${(item.files ?? []).length} 个包已入库`, color: 'success' }),
  fileStatusFor = (file) => file.cached ? '本机已缓存' : file.stored ? 'Core 已入库' : '未缓存',
  showCacheColumns = false,
  allowLocalDelivery = true,
  pullLabelFor = () => '拉取',
  actionLabel = '包明细',
  emptyLabel = '暂无正式版本',
} = {}) {
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const date = (value) => { const parsed = new Date(value); return value && !Number.isNaN(parsed.getTime()) ? parsed.toLocaleString() : value ?? '-'; };
  const bytes = (value) => { let amount = Number(value); if (!Number.isFinite(amount) || amount < 0) return '-'; if (amount < 1024) return `${amount} B`; const units = ['KB', 'MB', 'GB', 'TB']; let unit = -1; do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1); return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`; };
  const cacheHeaders = showCacheColumns ? '<th>缓存文件</th><th>总大小</th><th>最近传输</th>' : '';
  let items = initialItems ?? [];
  root.innerHTML = `<div class="card-body pb-0"><div class="row g-2 align-items-end"><div class="col-md-4"><label class="form-label" for="catalog-filter-product">产品</label><select id="catalog-filter-product" class="form-select"><option value="">全部产品</option></select></div><div class="col-md-4"><label class="form-label" for="catalog-filter-version">版本</label><select id="catalog-filter-version" class="form-select"><option value="">全部版本</option></select></div><div class="col-md-3"><label class="form-label" for="catalog-filter-status">状态</label><select id="catalog-filter-status" class="form-select"><option value="">全部状态</option>${statusOptions.map((option) => `<option value="${esc(option.key)}">${esc(option.label)}</option>`).join('')}</select></div><div class="col-md-1"><button class="btn btn-outline-secondary w-100" type="button" data-catalog-reset>清除</button></div></div><div class="small text-body-secondary mt-3 mb-2" data-catalog-count></div></div><div class="card-body p-0 table-responsive"><table data-paginate class="table table-hover align-middle mb-0"><thead><tr><th>产品</th><th>版本</th><th>文件数</th>${cacheHeaders}<th>状态</th><th>接收时间</th><th class="text-end">操作</th></tr></thead><tbody data-catalog-rows></tbody></table></div><dialog class="cam-detail-modal" data-catalog-dialog><div class="cam-detail-dialog"><div class="card-header d-flex align-items-center justify-content-between"><div class="cam-detail-title-wrap"><div class="small text-body-secondary">正式版本包明细</div><h3 class="card-title mb-0" data-catalog-title></h3></div><div class="d-flex align-items-center gap-2"><span data-catalog-detail-status></span><button type="button" class="btn-close cam-modal-close" aria-label="关闭" data-catalog-close></button></div></div><div class="card-body"><div class="cam-artifact-detail-metadata mb-3" data-catalog-metadata></div><div class="table-responsive"><table data-paginate class="table table-sm table-hover align-middle mb-0"><thead><tr><th>包标识 / 来源</th><th>文件名</th><th>大小</th><th>SHA-256</th><th>状态</th></tr></thead><tbody data-catalog-files></tbody></table></div><div class="d-flex justify-content-end mt-3"><button class="btn btn-outline-secondary btn-sm d-none" type="button" data-catalog-history>查看审批记录</button></div></div></div></dialog>`;
  const $ = (selector) => root.querySelector(selector);
  const productSelect = $('[data-catalog-filter-product]') ?? $('#catalog-filter-product');
  const versionSelect = $('#catalog-filter-version');
  const statusSelect = $('#catalog-filter-status');
  const rowContainer = $('[data-catalog-rows]');
  const dialog = $('[data-catalog-dialog]');
  const setOptions = (select, values, placeholder, previous = '') => { select.innerHTML = `<option value="">${esc(placeholder)}</option>${values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('')}`; select.value = values.includes(previous) ? previous : ''; };
  function updateOptions() {
    const oldProduct = productSelect.value; const oldVersion = versionSelect.value;
    const products = [...new Set(items.map((item) => item.productName || '历史产品'))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    setOptions(productSelect, products, '全部产品', oldProduct);
    const versions = [...new Set(items.filter((item) => !productSelect.value || (item.productName || '历史产品') === productSelect.value).map((item) => item.displayVersion ?? item.version ?? '未知版本'))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    setOptions(versionSelect, versions, '全部版本', oldVersion);
  }
  function render() {
    const selectedProduct = productSelect.value; const selectedVersion = versionSelect.value; const selectedStatus = statusSelect.value;
    const filtered = items.filter((item) => (!selectedProduct || (item.productName || '历史产品') === selectedProduct)
      && (!selectedVersion || (item.displayVersion ?? item.version ?? '未知版本') === selectedVersion)
      && (!selectedStatus || statusFor(item).key === selectedStatus));
    $('[data-catalog-count]').textContent = `共 ${filtered.length} 个版本`;
    rowContainer.innerHTML = filtered.length ? filtered.map((item, index) => {
      const status = statusFor(item); const version = item.displayVersion ?? item.version ?? '未知版本';
      const operation = onPull ? `<button type="button" class="btn btn-outline-primary btn-sm" data-catalog-pull="${index}" ${status.disablePull ? 'disabled' : ''}><i class="bi bi-cloud-download me-1"></i>${esc(pullLabelFor(item, status))}</button>` : '';
      const localDelivery = typeof window !== 'undefined' && typeof window.CamAgentDeliveryOpen === 'function' && (item.files ?? []).length > 0 && (item.files ?? []).every((file) => file.cached);
      const delivery = onDeliver || (allowLocalDelivery && localDelivery) ? `<button type="button" class="btn btn-outline-success btn-sm" data-catalog-deliver="${index}" ${status.disableDeliver ? 'disabled' : ''}><i class="bi bi-box-arrow-up-right me-1"></i>交付</button>` : '';
      const files = item.files ?? []; const totalBytes = item.totalBytes ?? files.reduce((sum, file) => sum + Number(file.sizeBytes || 0), 0); const cachedFiles = item.cachedFileCount ?? files.filter((file) => file.cached).length; const cacheCells = showCacheColumns ? `<td>${esc(cachedFiles)} / ${esc(files.length)}</td><td class="text-nowrap">${esc(bytes(totalBytes))}</td><td>${esc(date(item.lastTransferAt))}</td>` : '';
      return `<tr><td><div class="fw-semibold">${esc(item.productName ?? '历史产品')}</div></td><td><span class="fw-semibold">${esc(version)}</span></td><td>${files.length}</td>${cacheCells}<td><span class="badge text-bg-${esc(status.color ?? 'secondary')}">${esc(status.label)}</span>${status.detail ? `<div class="small text-body-secondary mt-1">${esc(status.detail)}</div>` : ''}</td><td>${esc(date(item.receivedAt))}</td><td class="text-end"><div class="d-inline-flex gap-1"><button type="button" class="btn btn-outline-secondary btn-sm" data-catalog-detail="${index}"><i class="bi bi-eye me-1"></i>${esc(actionLabel)}</button>${operation}${delivery}</div></td></tr>`;
    }).join('') : `<tr><td colspan="${showCacheColumns ? 9 : 6}" class="text-center text-body-secondary py-4">${esc(filtered.length === 0 && items.length ? '没有符合筛选条件的正式版本' : emptyLabel)}</td></tr>`;
    root.querySelectorAll('[data-catalog-detail]').forEach((button) => button.addEventListener('click', () => showDetail(filtered[Number(button.dataset.catalogDetail)])));
    root.querySelectorAll('[data-catalog-pull]').forEach((button) => button.addEventListener('click', async () => { const item = filtered[Number(button.dataset.catalogPull)]; button.disabled = true; try { await onPull(item); } finally { button.disabled = false; } }));
    root.querySelectorAll('[data-catalog-deliver]').forEach((button) => button.addEventListener('click', async () => { const item = filtered[Number(button.dataset.catalogDeliver)]; button.disabled = true; try { if (onDeliver) await onDeliver(item); else await window.CamAgentDeliveryOpen(item); } finally { button.disabled = false; } }));
    window.CamTablePagination?.refresh(root);
  }
  function showDetail(item) {
    if (!item) return;
    const files = item.files ?? []; const state = statusFor(item);
    $('[data-catalog-title]').textContent = `${item.productName ?? '历史产品'} · ${item.displayVersion ?? item.version ?? '未知版本'}`;
    $('[data-catalog-detail-status]').innerHTML = `<span class="badge text-bg-${esc(state.color ?? 'secondary')}">${esc(state.label)}</span>`;
    const metadata = [['接收时间', date(item.receivedAt)], ['发布标识', item.releaseId ?? '-'], ['云管审批', item.cloudApprovalId ?? '-'], ['传输任务', item.transferTaskId ?? '-'], ['清单 SHA-256', item.manifestSha256 ?? '-']];
    $('[data-catalog-metadata]').innerHTML = metadata.map(([label, value]) => `<div class="cam-artifact-detail-field"><span>${esc(label)}</span><code>${esc(value)}</code></div>`).join('');
    $('[data-catalog-files]').innerHTML = files.length ? files.map((file) => { const fileStatus = fileStatusFor(file); return `<tr><td><div class="fw-semibold">${esc(file.packageKey)}</div><span class="badge text-bg-light border">${file.source === 'INHERITED' ? '复用已有文件' : '本版本文件'}</span></td><td>${esc(file.fileName)}</td><td class="text-nowrap">${esc(bytes(file.sizeBytes))}</td><td><code class="cam-artifact-digest" title="${esc(file.sha256)}">${esc(file.sha256)}</code></td><td><span class="badge text-bg-${file.cached ? 'success' : file.stored ? 'secondary' : 'secondary'}">${esc(fileStatus)}</span></td></tr>`; }).join('') : '<tr><td colspan="5" class="text-center text-body-secondary py-4">该版本未携带包清单</td></tr>';
    const history = $('[data-catalog-history]'); history.classList.toggle('d-none', typeof onHistory !== 'function'); history.onclick = () => { dialog.close(); onHistory(item); };
    dialog.showModal(); window.CamTablePagination?.refresh(dialog);
  }
  productSelect.addEventListener('change', () => { updateOptions(); render(); });
  versionSelect.addEventListener('change', render); statusSelect.addEventListener('change', render);
  $('[data-catalog-reset]').addEventListener('click', () => { productSelect.value = ''; versionSelect.value = ''; statusSelect.value = ''; updateOptions(); render(); });
  $('[data-catalog-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
  updateOptions(); render();
  return { update(nextItems) { items = nextItems ?? []; updateOptions(); render(); } };
}

if (typeof window !== 'undefined') window.CamArtifactCatalog = { mountArtifactCatalog };
