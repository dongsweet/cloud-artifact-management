import { hasCorePermission, hasEdgePermission } from './cam-auth-roles.js?v=20261023-auditor-scope';

export { hasCorePermission, hasEdgePermission };

export const CORE_PAGE_PERMISSIONS = Object.freeze({
  requests: 'businessRead',
  artifacts: 'businessRead',
  distribution: 'businessRead',
  'transfer-monitor': 'businessRead',
  agents: 'configRead',
  'cloud-config': 'configRead',
  'aaa-config': 'aaaRead',
  'gate-config': 'configRead',
  users: 'userAdmin',
  audit: 'auditRead'
});

export const EDGE_PAGE_PERMISSIONS = Object.freeze({
  products: 'candidateRead',
  releases: 'candidateRead',
  rounds: 'candidateRead',
  candidates: 'candidateRead',
  'release-detail': 'candidateRead',
  'candidate-detail': 'candidateRead',
  'gate-config': 'configRead',
  'log-collections': 'configRead',
  users: 'userAdminRead',
  grants: 'validatorRead',
  audit: 'auditRead'
});

export function canCorePage(roles, page) {
  const permission = CORE_PAGE_PERMISSIONS[page];
  return Boolean(permission && hasCorePermission(roles, permission));
}

export function canEdgePage(roles, page) {
  const permission = EDGE_PAGE_PERMISSIONS[page];
  return Boolean(permission && hasEdgePermission(roles, permission));
}
