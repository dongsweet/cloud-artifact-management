// Browser counterpart of libs/cam-transfer/src/task-state.js. Keep protocol
// values intact and use this vocabulary only for cross-direction display.
export const DISPLAY_TRANSFER_STATES = Object.freeze({ SCHEDULED: 'SCHEDULED', QUEUED: 'QUEUED', TRANSFERRING: 'TRANSFERRING', VERIFYING: 'VERIFYING', WAITING_CONFIRMATION: 'WAITING_CONFIRMATION', RETRY_WAIT: 'RETRY_WAIT', FAILED: 'FAILED', COMPLETED: 'COMPLETED', PARTIAL: 'PARTIAL', PAUSE_REQUESTED: 'PAUSE_REQUESTED', PAUSED: 'PAUSED', CANCEL_REQUESTED: 'CANCEL_REQUESTED', CANCELLED: 'CANCELLED', WAITING_AUTHORIZATION: 'WAITING_AUTHORIZATION', WAITING_EDGE: 'WAITING_EDGE' });
export function displayTransferState(status, { controlState = null, retryAt = null, hasError = false } = {}) {
  const value = String(status ?? '').toUpperCase();
  if (controlState === 'PAUSE_REQUESTED') return 'PAUSE_REQUESTED';
  if (controlState === 'CANCEL_REQUESTED') return 'CANCEL_REQUESTED';
  if (value === 'SCHEDULED') return 'SCHEDULED';
  if (value === 'QUEUED') return hasError && retryAt ? 'RETRY_WAIT' : 'QUEUED';
  if (['STARTED', 'RECEIVING', 'RUNNING', 'SENDING', 'EDGE_STARTED'].includes(value)) return 'TRANSFERRING';
  if (['ASSEMBLY_PENDING', 'ASSEMBLING', 'VERIFYING'].includes(value)) return 'VERIFYING';
  if (['WAITING_RECEIPT', 'WAITING_CONFIRMATION'].includes(value)) return 'WAITING_CONFIRMATION';
  if (['RETRY_WAIT', 'NOTIFICATION_RETRY_WAIT'].includes(value)) return 'RETRY_WAIT';
  if (['FAILED', 'VERIFY_FAILED', 'NOTIFICATION_FAILED'].includes(value)) return 'FAILED';
  if (['RECEIVED', 'COMPLETED', 'CACHED'].includes(value)) return 'COMPLETED';
  if (value === 'PAUSED') return 'PAUSED';
  if (value === 'CANCELLED') return 'CANCELLED';
  if (value === 'WAITING_AUTHORIZATION') return 'WAITING_AUTHORIZATION';
  if (value === 'WAITING_EDGE') return 'WAITING_EDGE';
  if (value === 'PARTIAL') return 'PARTIAL';
  if (['IDLE', 'READY', 'NOT_SCHEDULED', 'NOT_CACHED'].includes(value)) return 'WAITING_AUTHORIZATION';
  return value || 'QUEUED';
}
