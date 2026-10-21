/**
 * CAM 统一角色目录。
 *
 * Core 负责账号、状态和两端角色授权；Edge 只消费这里定义的 Edge 角色，
 * 不再维护本地账号或本地角色副本。
 */
export const CORE_ROLES = ['CORE_ADMIN'];
export const EDGE_ROLES = ['EDGE_ADMIN', 'CANDIDATE_RECEIVER', 'VALIDATOR', 'RELEASE_APPLICANT', 'EDGE_AUDITOR'];

export const CORE_ROLE_LABELS = Object.freeze({
  CORE_ADMIN: '内网发布审批管理员'
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
