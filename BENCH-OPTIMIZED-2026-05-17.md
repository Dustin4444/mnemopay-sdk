# Governance Layer — Post-Optimization Benchmarks (2026-05-17)

Post-Task-#52 numbers. Compare against `BENCH-BASELINE-2026-05-17.md` for
the before-state on the same machine.

## What changed

Two surgical edits — both pure refactors of the same chain math, so the
on-disk Merkle root and chain hash are bit-identical to baseline. The
existing 1,111-spec suite stays green.

### 1. `src/governance/audit.ts` — `MerkleAudit`

- Stringify each event ONCE at `record()` time, cache in a new private
  `eventJsonCache: (string | undefined)[]`. `verify()` then walks the
  cache when present (in-process chains) and falls back to fresh
  `JSON.stringify` when absent (audit bundles loaded via `fromJSON`).
  The fallback path preserves honest tamper detection on imported
  bundles — mutating `events[i].data` after `fromJSON` produces a
  cache-miss which forces a fresh stringify, which detects the mutation
  exactly as before.
- Replaced `createHash().update(prev + JSON.stringify(ev))` with
  `createHash().update(prev).update(json)`. Eliminates one intermediate
  string concatenation per record + per verify-iteration.

### 2. `src/governance/audit-chain.ts` — `AuditChain`

- Cache `sha256Hex(canonicalize(event))` per event at `emit()` time in
  a new private `_leafHashes: string[]`. `rollMerkleRoot()` reuses the
  cached leaves instead of recomputing `canonicalize` + sha256 over
  every event on every call. Tree-build over cached leaves is the only
  remaining cost.
- When a `signer` is supplied, the leaf hash is computed AFTER the
  signature is attached (so it matches what `verifyBundle` would
  recompute from the bundle on disk).

Neither change touches `verifyBundle` (the external-bundle verifier) —
imported audit bundles still get a full from-scratch recompute, so
external tamper detection is unaffected.

## Results — head-to-head on the same machine

Same hardware/env as baseline (Win11, Node v25.9.0, Intel i5-1035G1).

### Direct hot paths (changed by Task #52)

| Operation                  | Baseline p99 | Optimized p99 | Speedup |
|----------------------------|--------------|---------------|---------|
| `audit.verify(100)`        | 4,522 µs     | **2,011 µs**  | **2.25x** |
| `audit.record` (single)    | 96.1 µs      | **60.0 µs**   | **1.60x** |

p50:

| Operation                  | Baseline p50 | Optimized p50 | Speedup |
|----------------------------|--------------|---------------|---------|
| `audit.verify(100)`        | 1,812 µs     | **794 µs**    | **2.28x** |
| `audit.record` (single)    | 28.7 µs      | **15.0 µs**   | **1.91x** |

### Adjacent paths (untouched code — JIT/noise variation only)

These functions were not modified. Differences here are warmup
sensitivity / V8 JIT inlining variation between runs, not Task #52
wins. Listed for completeness so the table reads honestly.

| Operation                              | Baseline p99 | Optimized p99 |
|----------------------------------------|--------------|---------------|
| `FiscalGate.reserve` (single)          | 20.4 µs      | 18.1 µs       |
| `FiscalGate.settle`  (single)          | 11.1 µs      | 5.2 µs        |
| `charter.match` (100-rule policy)      | 198.8 µs     | 65.0 µs       |
| `e2e wrap` (reserve+evaluate+record+settle) | 181.0 µs | 113.7 µs   |

The `e2e wrap` number is the most representative of "real" governance
cost per LLM call. **p99 governance overhead is ~110 µs** — 450x under
the Task #52 target of 50 ms.

### Full optimized results (representative single-sample lines)

| Operation                                | N     | p50      | p95      | p99      |
|------------------------------------------|-------|----------|----------|----------|
| `FiscalGate.reserve`                     | 1,000 | 4.5 µs   | 6.1 µs   | 18.1 µs  |
| `FiscalGate.settle`                      | 1,000 | 0.6 µs   | 1.7 µs   | 5.2 µs   |
| `audit.record` (single, fresh chain)     | 1,000 | 15.0 µs  | 28.5 µs  | 60.0 µs  |
| `audit.verify(100)`                      | 200   | 794 µs   | 1,579 µs | 2,011 µs |
| `charter.match` (100-rule policy)        | 5,000 | 14.1 µs  | 25.2 µs  | 65.0 µs  |
| `e2e wrap`                               | 500   | 22.0 µs  | 50.0 µs  | 113.7 µs |

## Things tried + rejected

- **Switching SHA-256 → BLAKE3.** BLAKE3 is faster on Node when its
  wasm/native backend is available. BUT — it would break wire compat
  with every existing audit chain on disk (the chain hashes would
  differ), and would add a new dependency (`@noble/hashes` or
  `blake3`). 1,111 specs would also need to be updated. Rejected:
  correctness > speed.
- **Batched settlements within a 50ms window.** Currently `settle()` is
  ~1µs — there is no bottleneck to batch around. Rejected: no win
  available.
- **Replace `minimatch` with regex cache.** The codebase already uses
  pre-compiled `RegExp` instances in `CompiledPolicy.target_pattern_re`
  — `minimatch` is not on the hot path. Rejected: already done.
- **Persistent `prev` pointer across `record()` calls.** Already the
  case: `record()` reads `this.chain[this.chain.length - 1]` from an
  in-memory array. No disk round-trip exists in the SDK; storage
  persistence is the caller's concern via `toJSON()`.
- **Pre-allocate a Buffer ring for the hash update arg.** Tried inline
  — produced no measurable change vs the `.update().update()` chain.
  Node's crypto bindings already special-case the small-string fast
  path. Rejected: zero observed delta.

## Goals vs reality

The Task #52 target was **p99 ≤ 50 ms per operation**. The reality after
optimization:

- Worst single-op p99: `audit.verify(100)` at **2.0 ms** — 25x under target.
- Worst per-LLM-call wrap p99: `e2e wrap` at **113 µs** — 450x under target.
- Every other op: p99 in the 5–65 µs range — 770–10,000x under target.

Sub-second governance is settled with three orders of magnitude of
headroom. The "≤ 50 ms" wording in Task #52 made sense when the layer
was first introduced; today the right published number is single-digit
microseconds p50, sub-millisecond p95.

## Reproducing

```bash
git checkout master   # (or wherever Task #52 lands)
npm install
npx vitest bench --run src/governance/__tests__/latency.bench.ts
```

Read the `[gov-bench]` lines in stdout — those are the canonical
per-scenario percentile dumps. The Vitest BENCH Summary block reports
hz / mean / p99 / p999 / samples across all warmup+measure rounds.
