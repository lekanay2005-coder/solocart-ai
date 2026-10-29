/**
 * Fixed-window rate limits, used on every `/api/` route: one budget per IP
 * and one per signed-in account. Counters live in memory on purpose — they
 * are protection, not data, and losing them on restart is harmless.
 */
import { clientIp } from './http.mjs';

export class RateLimiter {
  /**
   * @param {{ limit: number, windowMs: number, maxKeys?: number }} options
   */
  constructor({ limit, windowMs, maxKeys = 5000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    /** @type {Map<string, { count: number, start: number }>} */
    this.windows = new Map();
  }

  /** Whether `key` may proceed; counts the attempt when it may. */
  allow(key, now = Date.now()) {
    let state = this.windows.get(key);
    if (!state || now - state.start >= this.windowMs) {
      if (this.windows.size >= this.maxKeys) this.prune(now);
      state = { count: 0, start: now };
      this.windows.set(key, state);
    }
    state.count += 1;
    return state.count <= this.limit;
  }

  /** Drops windows that have run out, plus the oldest overflow if needed. */
  prune(now = Date.now()) {
    for (const [key, state] of this.windows) {
      if (now - state.start >= this.windowMs) this.windows.delete(key);
    }
    if (this.windows.size < this.maxKeys) return;
    // Still full: forget the oldest half so a flood can't grow memory forever.
    const oldest = [...this.windows.entries()].sort((a, b) => a[1].start - b[1].start);
    for (const [key] of oldest.slice(0, Math.floor(this.maxKeys / 2))) this.windows.delete(key);
  }

  reset() {
    this.windows.clear();
  }
}

/** Budgets for normal desk use. Auth has its own, stricter budget. */
export const apiLimiter = new RateLimiter({ limit: 600, windowMs: 60_000 });
export const authLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });
export const loginLimiter = new RateLimiter({ limit: 10, windowMs: 10 * 60_000 });

/** Per-IP budget, applied to every `/api/` request before any work happens. */
export function limitByIp(request) {
  return apiLimiter.allow(`ip:${clientIp(request)}`);
}

/** Per-account budget, applied once the request's identity is known. */
export function limitByUser(userId) {
  return authLimiter.allow(`user:${userId}`);
}
