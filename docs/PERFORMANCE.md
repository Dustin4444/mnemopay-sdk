# MnemoPay Governance — Performance Contract

This document is the **published latency guarantee** for the MnemoPay SDK's
governance layer (FiscalGate + Merkle audit chain + policy enforcement).
It defines what callers can rely on, on what hardware, and the conditions
under which the guarantee holds.

Last revised: 2026-05-17 (Task #52).

## TL;DR

| Operation                       | p99 guarantee |
|---------------------------------|---------------|
| `FiscalGate.reserve()`          | ≤ 1 ms        |
| `FiscalGate.settle()`           | ≤ 1 ms        |
| `audit.record()` (single)       | ≤ 5 ms        |
| `audit.verify()` (100 entries)  | ≤ 50 ms       |
| `charter.match()` (100 rules)   | ≤ 5 ms        |
| End-to-end wrap (per LLM call)  | ≤ 10 ms       |

Measured numbers come in roughly 50–500x under these published bounds.
The bounds are sized to survive a noisy CI runner with a hot core lock,
not to advertise the actual best-case numbers — see the measured-numbers
table below for the real distribution.

## Measured numbers

Reproducible via `npx vitest bench --run src/governance/__tests__/latency.bench.ts`.

| Operation                                | p50      | p95      | p99      |
|------------------------------------------|----------|----------|----------|
| `FiscalGate.reserve` (MockPayments)      | 4.5 µs   | 6.1 µs   | 18.1 µs  |
| `FiscalGate.settle`  (MockPayments)      | 0.6 µs   | 1.7 µs   | 5.2 µs   |
| `audit.record` (single append)           | 15.0 µs  | 28.5 µs  | 60.0 µs  |
| `audit.verify(100)`                      | 794 µs   | 1,579 µs | 2,011 µs |
| `charter.match` (100-rule policy)        | 14.1 µs  | 25.2 µs  | 65.0 µs  |
| End-to-end wrap (reserve→evaluate→record→settle) | 22 µs | 50 µs | 113 µs |

## Measurement environment

These numbers were captured on the dev box this SDK ships from. They are
**not** server-class. Production deployments on shared-CPU Fly instances
or commodity cloud VMs run inside the same envelope, and on bare-metal /
modern desktop hardware run noticeably faster.

- **CPU:** Intel Core i5-1035G1 (4 cores / 8 threads, 1.00 GHz base).
- **RAM:** 8 GB (under load this box frequently has <1 GB free — these
  numbers are taken with mild memory pressure, not on an idle box).
- **OS:** Windows 11 Home 10.0.26200.
- **Node:** v25.9.0 (vitest 2.1.9).
- **JIT state:** each bench scenario warms up with ≥200 iterations before
  recording samples. **First call after module load is always slower**
  (~5–10x p50) because V8 is still inlining the regex / crypto path —
  see "Caveats" below.

The bench file lives at `src/governance/__tests__/latency.bench.ts`. The
companion CI-gating test (`tests/governance/latency-invariant.test.ts`)
runs a smaller version on every `npm test` and trips at ~10x regression.

## What's measured (and what isn't)

**Measured — the pure-CPU governance overhead:**
- The MnemoPay code path between "agent decides to call an LLM" and "LLM
  invocation begins" (`reserve` → `evaluate` → reservation hold).
- The MnemoPay code path between "LLM returns" and "next call ready"
  (`record` → `settle`).
- Tamper-detection re-hash over an in-memory chain.
- Policy compilation is amortized: it's done once per agent boot. The
  bench measures `evaluateAction` on the already-compiled policy, which
  is what runs on the hot path. Compile cost is documented separately
  in `docs/FISCALGATE.md`.

**NOT measured (intentionally out of scope):**
- The actual LLM round-trip (typically 800 ms – 2 s for GPT-4o / Claude
  Opus).
- Real Stripe / Paystack / Lightning rail latency (network-bound; SLO
  documented per-rail).
- Disk persistence of audit bundles (handled by `Article 12` writer,
  measured separately).
- Cross-process audit chain replication (caller-supplied; not part of
  the SDK's perf contract).

## Caveats

1. **First call after module load.** Node lazy-imports `node:crypto`,
   regex engines warm up over the first ~50 calls, V8 needs 50–200
   calls to inline the hot path. Reserve a 1–2 ms p99 slop for the
   FIRST call after any cold-start. Subsequent calls land in the table
   above.
2. **`audit.verify()` is O(n)** in the chain length. The 100-entry
   number is the published bound. Long chains scale linearly: a
   1,000-event chain verifies in ~20 ms p99 on the dev box. If you
   verify hourly chains of 100k+ events, run verify off the hot path.
3. **Storage round-trip is the caller's problem.** The MnemoPay SDK
   keeps the chain in memory. If the caller persists to disk / Postgres /
   S3, that I/O is NOT counted here.
4. **Rate-limit checks are O(n)** in the bucket size for the
   `InMemoryRateCounter`. The default policy prunes aggressively. If a
   caller installs a custom rate counter with unbounded buckets, the
   bound above stops holding — install a periodic prune or swap in a
   Redis adapter with O(1) sliding-window math.
5. **Listeners run synchronously.** Each `MerkleAudit.on()` listener
   is invoked inline during `record()`. A slow listener inflates
   record latency by exactly its own cost. The bench measures
   listener-free chains. Audit-bundle exporters / log forwarders
   should buffer + flush off the hot path.
6. **Hardware variability.** Numbers were captured on a 1 GHz ULV
   laptop CPU. A modern desktop / server CPU (3–4 GHz base, modern
   cache hierarchy) typically runs 2–4x faster. The published bound
   is set to survive the ULV envelope.

## Why these numbers (and not faster)

The bound on `audit.verify()` is dominated by SHA-256 throughput —
specifically the per-event hash + the 64-char hex digest conversion.
At 100 events, that's ~100 sha256(small string) operations plus the
chain walk. Node's `crypto.createHash('sha256')` on the dev box runs
at ~15–25 µs per hash for tiny inputs (most cost is allocating the
hash object, not hashing). 100 × 20 µs = 2 ms — which matches what
we measure.

If we ever need faster verify, the two next steps are:

1. **Caller-side cache.** Skip verify when the chain hasn't changed
   since the last successful verify. Most audit-bundle exports verify
   once per export; that's not a hot path.
2. **Switch to BLAKE3.** Wire-incompatible with existing chains, but
   would cut hash cost ~3–4x. We have NOT done this — see
   `BENCH-OPTIMIZED-2026-05-17.md` rationale.

`audit.record()` and `FiscalGate.reserve/settle` are far below the
bound and don't need further optimization at any forecasted scale.

## Contract stability

The numbers in this doc are stability contracts. A PR that regresses
any `p99` above by more than 2x trips the CI invariant test
(`tests/governance/latency-invariant.test.ts`) and blocks merge.
Updating the contract requires updating both this file AND the
invariant test in the same PR — there is no "silent loosening."

## Related files

- `src/governance/audit.ts` — `MerkleAudit` (chain hash + verify).
- `src/governance/audit-chain.ts` — `AuditChain` (tree-Merkle root +
  bundle export).
- `src/governance/policy.ts` — `compilePolicy` + `evaluateAction`.
- `src/governance/payments.ts` — `MockPayments` (in-process reserve /
  settle / release).
- `src/governance/__tests__/latency.bench.ts` — the bench harness this
  doc was sourced from.
- `tests/governance/latency-invariant.test.ts` — CI-enforced regression
  gate.
- `BENCH-BASELINE-2026-05-17.md` — pre-Task-#52 numbers.
- `BENCH-OPTIMIZED-2026-05-17.md` — post-Task-#52 numbers + diff.
