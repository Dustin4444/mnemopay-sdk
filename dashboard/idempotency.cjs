/**
 * Idempotency log for webhook handlers.
 *
 * Stripe re-delivers webhooks on transient failure and may also re-send during
 * a replay attack. Each delivery carries a stable `event.id` (or, for non-Stripe
 * webhooks, the caller provides one). We persist seen ids and short-circuit
 * subsequent deliveries with the cached result.
 *
 * Storage is delegated: pass in {read, write} that hit whichever store the
 * server is using (in-memory Map for tests, JSON/SQLite/Postgres in prod).
 */

const DEFAULT_TTL_MS = 24 * 60 * 60_000;

function createIdempotencyLog({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();

  function get(id) {
    const entry = entries.get(id);
    if (!entry) return null;
    if (now() - entry.seenAt > ttlMs) {
      entries.delete(id);
      return null;
    }
    return entry;
  }

  function record(id, result) {
    entries.set(id, { id, seenAt: now(), result });
  }

  function size() {
    return entries.size;
  }

  function sweep() {
    const cutoff = now() - ttlMs;
    for (const [id, entry] of entries) if (entry.seenAt < cutoff) entries.delete(id);
  }

  function snapshot() {
    return Array.from(entries.values());
  }

  function load(rows = []) {
    for (const row of rows) {
      if (!row?.id) continue;
      entries.set(row.id, row);
    }
    sweep();
  }

  return { get, record, sweep, size, snapshot, load };
}

module.exports = { createIdempotencyLog };
