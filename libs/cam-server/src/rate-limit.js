/**
 * Small dependency-free, process-local API limiter.
 *
 * CAM services are intentionally deployed as single instances. Keeping the
 * limiter local avoids introducing Redis or another shared runtime service;
 * a future horizontally scaled deployment must move this state to the edge
 * proxy or a shared store.
 */
export function createRateLimiter({ windowMs = 60_000, max = 600, maxEntries = 10_000 } = {}) {
  const buckets = new Map();
  let operations = 0;
  const boundedWindow = Number.isSafeInteger(windowMs) && windowMs >= 1_000 && windowMs <= 3_600_000 ? windowMs : 60_000;
  const boundedMax = Number.isSafeInteger(max) && max >= 1 && max <= 100_000 ? max : 600;
  const boundedEntries = Number.isSafeInteger(maxEntries) && maxEntries >= 100 ? maxEntries : 10_000;

  function prune(now) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
    if (buckets.size <= boundedEntries) return;
    const oldest = [...buckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    for (const [key] of oldest.slice(0, buckets.size - boundedEntries)) buckets.delete(key);
  }

  return {
    check(key, now = Date.now()) {
      const identity = String(key || 'unknown');
      if ((operations += 1) % 256 === 0) prune(now);
      let bucket = buckets.get(identity);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + boundedWindow };
        buckets.set(identity, bucket);
      }
      bucket.count += 1;
      const allowed = bucket.count <= boundedMax;
      return { allowed, remaining: Math.max(0, boundedMax - bucket.count), retryAfterMs: Math.max(0, bucket.resetAt - now) };
    },
    clear() { buckets.clear(); }
  };
}

export function registerApiRateLimit(app, { windowMs = process.env.CAM_RATE_LIMIT_WINDOW_MS, max = process.env.CAM_RATE_LIMIT_MAX } = {}) {
  const limiter = createRateLimiter({
    windowMs: Number(windowMs || 60_000),
    max: Number(max || 600)
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.split('?')[0].startsWith('/api/')) return;
    const result = limiter.check(request.ip);
    reply.header('X-RateLimit-Limit', String(Number(max || 600)));
    reply.header('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return;
    reply.header('Retry-After', String(Math.ceil(result.retryAfterMs / 1000)));
    return reply.code(429).send({ error: { code: 'rate_limited', message: '请求过于频繁，请稍后重试' } });
  });
  app.addHook('onClose', async () => limiter.clear());
  return limiter;
}
