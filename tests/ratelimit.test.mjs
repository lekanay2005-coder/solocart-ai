import test from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, limitByIp, limitByUser, apiLimiter, authLimiter, loginLimiter } from '../server/ratelimit.mjs';

test('allows up to the limit inside one window', () => {
  const limiter = new RateLimiter({ limit: 3, windowMs: 1000 });
  const now = 1000;
  assert.equal(limiter.allow('ip', now), true);
  assert.equal(limiter.allow('ip', now), true);
  assert.equal(limiter.allow('ip', now), true);
  assert.equal(limiter.allow('ip', now), false);
});

test('keys are independent', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('a', 0), true);
  assert.equal(limiter.allow('a', 0), false);
  assert.equal(limiter.allow('b', 0), true);
});

test('the window resets once it elapses', () => {
  const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('ip', 0), true);
  assert.equal(limiter.allow('ip', 500), false);
  assert.equal(limiter.allow('ip', 1000), true);
});

test('memory stays bounded under a flood of unique keys', () => {
  const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, maxKeys: 100 });
  for (let i = 0; i < 1000; i += 1) limiter.allow(`key-${i}`, i);
  assert.ok(limiter.windows.size <= 100, `expected bounded memory, got ${limiter.windows.size}`);
});

test('the shared API limiter distinguishes IP from account budgets', () => {
  const req = { socket: { remoteAddress: '10.1.2.3' } };
  apiLimiter.reset();
  authLimiter.reset();
  assert.equal(limitByIp(req), true);
  assert.equal(limitByUser('user-1'), true);
  assert.equal(limitByUser('user-2'), true); // another account is unaffected
});

test('login attempts share one small per-IP budget', () => {
  loginLimiter.reset();
  const key = 'login:198.51.100.9';
  let allowed = 0;
  for (let i = 0; i < 40; i += 1) {
    if (loginLimiter.allow(key)) allowed += 1;
  }
  assert.equal(allowed, 10);
});
