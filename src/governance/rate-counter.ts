/**
 * Rate-counter interface — used by `evaluateAction()` for sliding-window
 * rate limits. The in-memory impl ships with the SDK; production
 * deployments swap in a Redis-backed adapter without touching the
 * evaluator hot path.
 *
 * The interface is intentionally narrow (observe + countWithin + prune)
 * so adapters stay small. No async — the policy evaluator is sync by
 * design (sub-second budget). Adapters that need network round-trips
 * should ship an LRU cache in front of the network counter or accept
 * the latency hit.
 */

export interface RateCounter {
  observe(key: string, atMs: number): void;
  countWithin(key: string, windowMs: number, atMs: number): number;
  prune(beforeMs: number): void;
}

/**
 * Redis-backed adapter SHAPE. Real implementation lives outside the SDK
 * (consumer wires their own Redis client). The signature here is the
 * contract the SDK validates.
 *
 * Suggested impl per key:
 *   - On observe: ZADD key atMs atMs
 *   - On countWithin: ZRANGEBYSCORE key (atMs - windowMs) +inf, return count
 *   - On prune: ZREMRANGEBYSCORE key -inf beforeMs
 *
 * This shape is sync — production callers wrap a Redis client + LRU
 * to keep latency sub-millisecond.
 */
export interface RateCounterAdapter extends RateCounter {
  readonly name: string;
}

/** Re-export the in-memory impl from policy.ts for callers who don't need Redis. */
export { InMemoryRateCounter } from "./policy.js";
