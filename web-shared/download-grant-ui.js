(function (global) {
  'use strict';

  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));

  function bytes(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '-';
    if (number < 1024) return `${number} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = number;
    let index = -1;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index += 1;
    }
    return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${units[index]}`;
  }

  function sessionStatus(status) {
    return { ACTIVE: '传输中', INTERRUPTED: '已中断', COMPLETED: '已完成', FAILED: '失败' }[status] ?? status;
  }

  function responsibleLabel(grant) {
    const person = grant?.responsiblePerson ?? {};
    return person.displayName && person.username
      ? `${person.displayName}（${person.username}）`
      : person.displayName || person.username || '未知账号';
  }

  function absoluteUrl(url, origin = global.location?.origin) {
    return new URL(url, origin).href;
  }

  function exportLinks(grant, container, { hashField = 'sha256' } = {}) {
    if (!container) return;
    container.innerHTML = (grant.items ?? []).map((item) => {
      const digest = item[hashField] ?? item.sha256 ?? item.fileSha256 ?? '-';
      return `<div class="mb-2"><a href="${escapeHtml(absoluteUrl(item.downloadUrl))}" referrerpolicy="no-referrer">${escapeHtml(item.fileName)}</a><div class="small font-monospace text-break">SHA-256: ${escapeHtml(digest)}</div></div>`;
    }).join('');
  }

  function saveExport(grant, type, { hashField = 'sha256', filePrefix = grant?.grantId } = {}) {
    if (!grant) return;
    const items = (grant.items ?? []).map((item) => ({ ...item, downloadUrl: absoluteUrl(item.downloadUrl) }));
    const text = type === 'json'
      ? JSON.stringify({ ...grant, items }, null, 2)
      : items.map((item) => `${item.downloadUrl}\n# ${item.fileName} SHA-256=${item[hashField] ?? item.sha256 ?? item.fileSha256 ?? '-'}`).join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: type === 'json' ? 'application/json' : 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filePrefix}.${type}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function detailBody(grant, {
    sessionItemKey = 'candidate_id',
    itemKey = 'candidateId',
    itemSizeKey = 'size',
    itemNameKey = 'fileName',
    emptyMessage = '暂无传输会话。HEAD 探测、被拒绝的连接和零字节中断不会计入次数。'
  } = {}) {
    const items = new Map((grant.items ?? []).map((item) => [item[itemKey], item]));
    const sessions = grant.sessions ?? [];
    const responsible = responsibleLabel(grant);
    const rows = sessions.map((session) => {
      const item = items.get(session[sessionItemKey]);
      const size = Number(item?.[itemSizeKey] ?? 0);
      const covered = Number(session.covered_bytes ?? 0);
      const percent = size > 0 ? Math.min(100, Math.round((covered / size) * 100)) : 0;
      const downloader = session.downloadedBy?.type === 'TOKEN'
        ? `Token 持有者（责任人：${responsible}）`
        : session.downloadedBy?.label || '未知账号';
      return `<tr><td class="text-break">${escapeHtml(item?.[itemNameKey] ?? session[sessionItemKey])}</td><td>${escapeHtml(sessionStatus(session.status))}</td><td style="min-width:180px"><div class="progress" role="progressbar" aria-label="文件接收进度" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar ${session.status === 'COMPLETED' ? 'bg-success' : ''}" style="width:${percent}%">${percent}%</div></div><div class="small text-body-secondary mt-1">${bytes(covered)} / ${bytes(size)}</div></td><td>${bytes(session.bytes_sent)}</td><td class="small text-break">${escapeHtml(downloader)}</td><td class="small text-break">${escapeHtml(session.source_address ?? '-')}<br>开始：${escapeHtml(session.started_at ?? '-')}<br>更新：${escapeHtml(session.updated_at ?? '-')}${session.completed_at ? `<br>结束：${escapeHtml(session.completed_at)}` : ''}${session.error_message ? `<br><span class="text-danger">${escapeHtml(session.error_message)}</span>` : ''}</td></tr>`;
    }).join('');
    return `<p class="small text-body-secondary">累计传输表示服务器已写入连接的字节数；文件进度表示已连续接收的文件前缀。Token 下载无法识别实际操作者，下载人显示为 Token 持有者，并同时标明授权责任人。</p>${sessions.length ? `<div class="table-responsive"><table class="table table-sm align-middle"><thead><tr><th>文件</th><th>状态</th><th>文件进度</th><th>累计传输</th><th>下载人</th><th>来源 / 更新时间</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="alert alert-light border">${emptyMessage}</div>`}`;
  }

  global.CamDownloadGrantUI = Object.freeze({ bytes, sessionStatus, responsibleLabel, exportLinks, saveExport, detailBody });
}(window));
