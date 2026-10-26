const defaultEscape = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

export function renderTransferFileTable(files = [], {
  escapeHtml = defaultEscape,
  formatBytes = (value) => `${Number(value ?? 0)} B`,
  statusFor = () => ({ label: '未知', color: 'secondary' }),
  progressFor = () => '',
  emptyLabel = '暂无文件清单'
} = {}) {
  const rows = files.map((file) => {
    const status = statusFor(file) ?? {};
    const progress = progressFor(file);
    const fileMeta = [file.packageKey, file.reused ? '本机已有缓存，可复用' : null].filter(Boolean).join(' · ');
    return `<tr><td><div class="fw-semibold cam-transfer-file-name">${escapeHtml(file.fileName ?? file.sha256 ?? '-')}</div>${fileMeta ? `<div class="small text-body-secondary">${escapeHtml(fileMeta)}</div>` : ''}</td><td>${escapeHtml(formatBytes(file.sizeBytes))}</td><td><span class="badge text-bg-${escapeHtml(status.color ?? 'secondary')}">${escapeHtml(status.label ?? '-')}</span>${progress ? `<div class="small text-body-secondary mt-1">${progress}</div>` : ''}${file.lastError ? `<div class="small text-danger mt-1">${escapeHtml(file.lastError)}</div>` : ''}</td><td><code class="small cam-break-anywhere">${escapeHtml(file.sha256 ?? '-')}</code></td></tr>`;
  }).join('');
  return `<div class="table-responsive cam-transfer-file-table-wrap"><table class="table table-sm table-hover align-middle cam-transfer-file-table"><thead><tr><th>文件</th><th>大小</th><th>状态 / 分块进度</th><th>SHA-256</th></tr></thead><tbody>${rows || `<tr><td colspan="4" class="text-center text-body-secondary py-3">${escapeHtml(emptyLabel)}</td></tr>`}</tbody></table></div>`;
}

if (typeof window !== 'undefined') window.CamTransferFileTable = { renderTransferFileTable };
