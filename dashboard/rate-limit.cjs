/**
 * In-memory token-bucket rate limiter for the MnemoPay dashboard.
 *
 * Single-process design: each Fly machine has its own buckets. If the dashboard
 * scales to >1 machine, swap this for a Redis-backed limiter.
 *
 * Usage:
 *   const limiter = createRateLimiter({ capacity: 30, refillPerSec: 0.5 });
 *   const result = limiter.consume(key);
 *   if (!result.ok) return 429 with result.retryAfterSec.
 *
 * Buckets self-evict after 1h of inactivity to bound memory.
 */

const DEFAULT_SWEEP_MS = 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;

function createRateLimiter({
  capacity = 60,
  refillPerSec = 1,
  ttlMs = DEFAULT_TTL_MS,
  sweepMs = DEFAULT_SWEEP_MS,
  now = () => Date.now(),
} = {}) {
  const buckets = new Map();

  function bucket(key) {
    const existing = buckets.get(key);
    const t = now();
    if (existing) {
      const elapsed = Math.max(0, (t - existing.lastRefill) / 1000);
      existing.tokens = Math.min(capacity, existing.tokens + elapsed * refillPerSec);
      existing.lastRefill = t;
      existing.lastSeen = t;
      return existing;
    }
    const fresh = { tokens: capacity, lastRefill: t, lastSeen: t };
    buckets.set(key, fresh);
    return fresh;
  }

  function consume(key, cost = 1) {
    const b = bucket(key);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    const deficit = cost - b.tokens;
    const retryAfterSec = Math.ceil(deficit / refillPerSec);
    return { ok: false, remaining: 0, retryAfterSec };
  }

  function peek(key) {
    const b = bucket(key);
    return { remaining: Math.floor(b.tokens) };
  }

  const sweepTimer = setInterval(() => {
    const cutoff = now() - ttlMs;
    for (const [key, b] of buckets) {
      if (b.lastSeen < cutoff) buckets.delete(key);
    }
  }, sweepMs);
  sweepTimer.unref?.();

  return { consume, peek, _buckets: buckets, _sweepTimer: sweepTimer };
}

function clientKeyForRequest(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  if (fwd) return fwd.split(',')[0].trim();
  const fly = String(req.headers['fly-client-ip'] || '').trim();
  if (fly) return fly;
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = { createRateLimiter, clientKeyForRequest };
