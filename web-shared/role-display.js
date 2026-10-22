const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderRoleGroups(groups = []) {
  return `<div class="cam-role-list">${groups.map(({ scope, roles = [], emptyLabel = '无' }) => {
    const values = roles.length
      ? roles.map((role) => `<span class="cam-role-chip">${escapeHtml(role)}</span>`).join('')
      : `<span class="cam-role-empty">${escapeHtml(emptyLabel)}</span>`;
    return `<div class="cam-role-row"><span class="cam-role-scope">${escapeHtml(scope)}</span><span class="cam-role-values">${values}</span></div>`;
  }).join('')}</div>`;
}
