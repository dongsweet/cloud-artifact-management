export const taskStateMeta = {
  SCHEDULED: ['已计划', 'info'],
  QUEUED: ['排队中', 'warning'],
  RUNNING: ['传输中', 'primary'],
  RETRY_WAIT: ['重试等待', 'danger'],
  CACHED: ['已完成', 'success'],
  COMPLETED: ['已完成', 'success'],
  NOT_CACHED: ['未拉取', 'secondary']
};

export function formatBytes(value) {
  let amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return '-';
  if (amount < 1024) return `${amount} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let unit = -1;
  do { amount /= 1024; unit += 1; } while (amount >= 1024 && unit < units.length - 1);
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function taskPercent(task) {
  const total = Number(task?.totalBytes ?? 0);
  return total > 0 ? Math.min(100, Math.round(Number(task.completedBytes ?? 0) * 100 / total)) : task?.status === 'COMPLETED' ? 100 : 0;
}

if (typeof window !== 'undefined') window.CamTaskTable = { taskStateMeta, formatBytes, taskPercent };
