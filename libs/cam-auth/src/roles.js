/**
 * CAM 统一角色目录。
 *
 * Core 负责账号、状态和两端角色授权；Edge 只消费这里定义的 Edge 角色，
 * 不再维护本地账号或本地角色副本。
 */
export const CORE_ROLES = ['CORE_SYSTEM_ADMIN', 'CORE_SECURITY_ADMIN', 'CORE_OPERATOR', 'CORE_AUDITOR'];
export const EDGE_ROLES = ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN', 'EDGE_OPERATOR', 'EDGE_AUDITOR'];

export const CORE_ROLE_LABELS = Object.freeze({
  CORE_SYSTEM_ADMIN: '系统管理员',
  CORE_SECURITY_ADMIN: '安全管理员',
  CORE_OPERATOR: '操作员',
  CORE_AUDITOR: '审计员'
});

export const EDGE_ROLE_LABELS = Object.freeze({
  EDGE_SYSTEM_ADMIN: '系统管理员',
  EDGE_SECURITY_ADMIN: '安全管理员',
  EDGE_OPERATOR: '操作员',
  EDGE_AUDITOR: '审计员'
});

// 业务路由使用的最小权限集合。页面可以据此隐藏入口，服务端仍必须逐请求校验。
export const EDGE_PERMISSION_ROLES = Object.freeze({
  candidateWrite: ['EDGE_OPERATOR'],
  candidateRead: ['EDGE_SYSTEM_ADMIN', 'EDGE_OPERATOR', 'EDGE_SECURITY_ADMIN', 'EDGE_AUDITOR'],
  validatorWrite: ['EDGE_OPERATOR'],
  validatorRead: ['EDGE_SYSTEM_ADMIN', 'EDGE_OPERATOR', 'EDGE_SECURITY_ADMIN', 'EDGE_AUDITOR'],
  releaseDecision: ['EDGE_OPERATOR'],
  configWrite: ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN'],
  configRead: ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN', 'EDGE_AUDITOR'],
  userAdminWrite: ['EDGE_SECURITY_ADMIN'],
  userAdminRead: ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN', 'EDGE_AUDITOR']
});

// 系统管理员负责平台运行和技术配置；账号与角色管理始终只属于安全管理员。
export const CORE_PERMISSION_ROLES = Object.freeze({
  businessRead: ['CORE_SYSTEM_ADMIN', 'CORE_OPERATOR', 'CORE_AUDITOR'],
  businessWrite: ['CORE_SYSTEM_ADMIN', 'CORE_OPERATOR'],
  configRead: ['CORE_SYSTEM_ADMIN', 'CORE_SECURITY_ADMIN', 'CORE_AUDITOR'],
  configWrite: ['CORE_SYSTEM_ADMIN', 'CORE_SECURITY_ADMIN'],
  userAdmin: ['CORE_SECURITY_ADMIN']
});

export function normalizeCoreRoles(roles) {
  if (!Array.isArray(roles)) return roles;
  return [...new Set(roles)];
}

export function normalizeEdgeRoles(roles) {
  if (!Array.isArray(roles)) return roles;
  return [...new Set(roles)];
}

export function hasCorePermission(roles, permission) {
  if (!Array.isArray(roles)) return false;
  const normalized = normalizeCoreRoles(roles);
  return (CORE_PERMISSION_ROLES[permission] ?? []).some((role) => normalized.includes(role));
}
