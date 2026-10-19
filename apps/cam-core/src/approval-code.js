export function maskApprovalCode(value, approvalCode) {
  if (typeof value !== 'string' || !approvalCode) return value;
  const pattern = approvalCode.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return value.replace(new RegExp(pattern, 'giu'), '[已隐藏]');
}
