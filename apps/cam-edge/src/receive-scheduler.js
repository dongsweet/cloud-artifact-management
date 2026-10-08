export function createReceiveScheduler({ store, receiver, concurrency = Number(process.env.CAM_RECEIVE_CONCURRENCY ?? 2) }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('CAM_RECEIVE_CONCURRENCY must be between 1 and 16');
  const active = new Map();
  const pausing = new Set();
  let pumping = false;
  let started = false;

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (const candidateId of store.nextReceiveJobs(concurrency - active.size)) {
        if (!store.claimReceiveJob(candidateId)) continue;
        const job = Promise.resolve().then(() => receiver.receive(candidateId)).then(() => {
          const status = pausing.has(candidateId) ? 'PAUSED' : 'COMPLETED';
          store.updateReceiveJob(candidateId, status);
        }).catch((error) => {
          const status = pausing.has(candidateId) ? 'PAUSED' : 'FAILED';
          store.updateReceiveJob(candidateId, status, status === 'FAILED' ? error.message : null);
        }).finally(() => {
          active.delete(candidateId);
          pausing.delete(candidateId);
          queueMicrotask(pump);
        });
        active.set(candidateId, job);
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue(candidateIds) {
    const uniqueIds = [...new Set(candidateIds)];
    const jobs = uniqueIds.map((candidateId) => store.enqueueReceive(candidateId));
    pump();
    return jobs;
  }

  function pause(candidateId) {
    const job = store.getReceiveJob(candidateId);
    if (!job) return null;
    if (job.status === 'QUEUED') return store.updateReceiveJob(candidateId, 'PAUSED');
    if (job.status === 'RUNNING') {
      pausing.add(candidateId);
      receiver.cancel(candidateId);
      return job;
    }
    return job;
  }

  function resume(candidateId) {
    const job = store.enqueueReceive(candidateId);
    pump();
    return job;
  }

  function start() {
    if (started) return;
    started = true;
    store.recoverReceiveQueue();
    pump();
  }

  return {
    enqueue,
    pause,
    resume,
    start,
    list: () => store.listReceiveQueue(),
    active,
    concurrency
  };
}
