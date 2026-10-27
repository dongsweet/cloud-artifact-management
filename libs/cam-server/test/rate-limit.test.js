import assert from 'node:assert/strict';
import test from 'node:test';
import { createRateLimiter } from '../src/rate-limit.js';

test('process-local API limiter bounds a client window and resets it', () => {
  const limiter = createRateLimiter({ windowMs: 1_000, max: 2 });
  assert.equal(limiter.check('client', 10).allowed, true);
  assert.equal(limiter.check('client', 11).remaining, 0);
  const blocked = limiter.check('client', 12);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, 998);
  assert.equal(limiter.check('client', 1_010).allowed, true);
  limiter.clear();
  assert.equal(limiter.check('client', 1_011).allowed, true);
});
