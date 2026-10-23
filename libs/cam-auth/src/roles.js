/**
 * CAM 统一角色目录。
 *
 * Core 负责账号、状态和两端角色授权；Edge 只消费这里定义的 Edge 角色，
 * 不再维护本地账号或本地角色副本。
 */
export const CORE_ROLES = ['CORE_SYSTEM_ADMIN', 'CORE_SECURITY_ADMIN', 'CORE_OPERATOR', 'CORE_AUDITOR'];
export const EDGE_ROLES = ['EDGE_SYSTEM_ADMIN', 'EDGE_SECURITY_ADMIN', 'EDGE_OPERATOR', 'EDGE_AUDITOR'];
export const AGENT_ROLES = ['AGENT_SYSTEM_ADMIN', 'AGENT_SECURITY_ADMIN', 'AGENT_OPERATOR', 'AGENT_AUDITOR'];

export const CORE_ROLE_LABELS = Object.freeze({
  CORE_SYSTEM_ADMIN: '系统管理员',
  CORE_SECURITY_ADMIN: '安全管理员',
  CORE_OPERATOR: '操作员',
  CORE_AUDITOR: '审计管理员'
});

export const EDGE_ROLE_LABELS = Object.freeze({
  EDGE_SYSTEM_ADMIN: '系统管理员',
  EDGE_SECURITY_ADMIN: '安全管理员',
  EDGE_OPERATOR: '操作员',
  EDGE_AUDITOR: '审计管理员'
});
export const AGENT_ROLE_LABELS = Object.freeze({
  AGENT_SYSTEM_ADMIN: '系统管理员',
  AGENT_SECURITY_ADMIN: '安全管理员',
  AGENT_OPERATOR: '操作员',
  AGENT_AUDITOR: '审计管理员'
});

export const AGENT_PERMISSION_ROLES = Object.freeze({
  businessRead: ['AGENT_OPERATOR', 'AGENT_AUDITOR'],
  businessWrite: ['AGENT_OPERATOR'],
  configRead: ['AGENT_SYSTEM_ADMIN'],
  configWrite: ['AGENT_SYSTEM_ADMIN'],
  deliveryRead: ['AGENT_OPERATOR', 'AGENT_AUDITOR'],
  deliveryWrite: ['AGENT_OPERATOR'],
  auditRead: ['AGENT_AUDITOR'],
  userAdmin: ['AGENT_SECURITY_ADMIN']
});

// Core 与 Edge 共用同一套职责边界：业务由操作员维护，系统管理员负责平台配置，
// 安全管理员管理账号，审计管理员只读查看审计记录。
export const CORE_PERMISSION_ROLES = Object.freeze({
  businessRead: ['CORE_OPERATOR'],
  businessWrite: ['CORE_OPERATOR'],
  configRead: ['CORE_SYSTEM_ADMIN'],
  configWrite: ['CORE_SYSTEM_ADMIN'],
  aaaRead: ['CORE_SYSTEM_ADMIN'],
  aaaWrite: ['CORE_SYSTEM_ADMIN'],
  userAdmin: ['CORE_SECURITY_ADMIN'],
  auditRead: ['CORE_AUDITOR']
});

// Edge 账号由 Core 统一维护；Edge 只提供安全管理员的只读账号清单。
export const EDGE_PERMISSION_ROLES = Object.freeze({
  candidateWrite: ['EDGE_OPERATOR'],
  candidateRead: ['EDGE_OPERATOR'],
  validatorWrite: ['EDGE_OPERATOR'],
  validatorRead: ['EDGE_OPERATOR'],
  releaseDecision: ['EDGE_OPERATOR'],
  configWrite: ['EDGE_SYSTEM_ADMIN'],
  configRead: ['EDGE_SYSTEM_ADMIN'],
  userAdminWrite: ['EDGE_SECURITY_ADMIN'],
  userAdminRead: ['EDGE_SECURITY_ADMIN'],
  auditRead: ['EDGE_AUDITOR']
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

export function hasEdgePermission(roles, permission) {
  if (!Array.isArray(roles)) return false;
  const normalized = normalizeEdgeRoles(roles);
  return (EDGE_PERMISSION_ROLES[permission] ?? []).some((role) => normalized.includes(role));
}

export function hasAgentPermission(roles, permission) {
  if (!Array.isArray(roles)) return false;
  return (AGENT_PERMISSION_ROLES[permission] ?? []).some((role) => roles.includes(role));
}
