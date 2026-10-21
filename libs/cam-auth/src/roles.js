/**
 * CAM 统一角色目录。
 *
 * Core 负责账号、状态和两端角色授权；Edge 只消费这里定义的 Edge 角色，
 * 不再维护本地账号或本地角色副本。
 */
export const CORE_ROLES = ['CORE_ADMIN', 'CORE_OPERATOR', 'CORE_SECURITY_ADMIN', 'CORE_AUDITOR'];
// These names were used by the first Core RBAC release. They remain accepted
// while existing databases are normalized to CORE_SECURITY_ADMIN.
export const LEGACY_CORE_ROLES = ['CORE_CONFIG_ADMIN', 'CORE_USER_ADMIN'];
export const EDGE_ROLES = ['EDGE_ADMIN', 'CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'];

export const CORE_ROLE_LABELS = Object.freeze({
  CORE_ADMIN: '全量管理员（应急兼容）',
  CORE_OPERATOR: '操作员',
  CORE_SECURITY_ADMIN: '安全员',
  CORE_AUDITOR: '审计员'
});

export const EDGE_ROLE_LABELS = Object.freeze({
  EDGE_ADMIN: '外部交换区配置管理员',
  CANDIDATE_RECEIVER: '候选制品接收人员',
  VALIDATOR: '制品验证人员',
  RELEASE_APPLICANT: '发布申请人员',
  EDGE_AUDITOR: '外部交换区审计人员'
});

// 业务路由使用的最小权限集合。页面可以据此隐藏入口，服务端仍必须逐请求校验。
export const EDGE_PERMISSION_ROLES = Object.freeze({
  candidateWrite: ['CANDIDATE_RECEIVER'],
  candidateRead: ['CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'],
  validatorWrite: ['VALIDATOR'],
  validatorRead: ['VALIDATOR', 'EDGE_AUDITOR'],
  releaseDecision: ['RELEASE_APPLICANT'],
  adminWrite: ['EDGE_ADMIN'],
  adminRead: ['EDGE_ADMIN', 'EDGE_AUDITOR']
});

// Core 页面按业务职责分组。CORE_ADMIN 是保留的全量管理员角色，
// 其他角色只获得对应页面和接口的最小权限。
export const CORE_PERMISSION_ROLES = Object.freeze({
  businessRead: ['CORE_OPERATOR', 'CORE_AUDITOR'],
  businessWrite: ['CORE_OPERATOR'],
  configRead: ['CORE_SECURITY_ADMIN'],
  configWrite: ['CORE_SECURITY_ADMIN'],
  userAdmin: ['CORE_SECURITY_ADMIN']
});

export const CORE_ROLE_ALIASES = Object.freeze({
  CORE_CONFIG_ADMIN: 'CORE_SECURITY_ADMIN',
  CORE_USER_ADMIN: 'CORE_SECURITY_ADMIN'
});

export function normalizeCoreRoles(roles) {
  if (!Array.isArray(roles)) return roles;
  return [...new Set(roles.map((role) => CORE_ROLE_ALIASES[role] ?? role))];
}

export function hasCorePermission(roles, permission) {
  if (!Array.isArray(roles)) return false;
  const normalized = normalizeCoreRoles(roles);
  if (normalized.includes('CORE_ADMIN')) return true;
  return (CORE_PERMISSION_ROLES[permission] ?? []).some((role) => normalized.includes(role));
}
