import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { createRateLimiter, registerApiRateLimit } from '../src/rate-limit.js';

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

test('artifact chunk requests use their own bounded transfer bucket', async () => {
  const app = Fastify();
  registerApiRateLimit(app, { windowMs: 60_000, max: 1, transferMax: 2 });
  app.get('/api/v1/normal', async () => ({ ok: true }));
  app.get('/api/v1/agent/tasks/T/files/S/parts/0', async () => ({ ok: true }));
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/normal' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/normal' })).statusCode, 429);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agent/tasks/T/files/S/parts/0' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agent/tasks/T/files/S/parts/0' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/agent/tasks/T/files/S/parts/0' })).statusCode, 429);
  } finally {
    await app.close();
  }
});
