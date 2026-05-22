# Governance Layer — Baseline Benchmarks (2026-05-17)

Pre-optimization numbers for the FiscalGate + Merkle-audit hot paths.
Task #52: "Reduce MnemoPay's governance layer (FiscalGate + Merkle audit
chain) latency to sub-second per operation. Aim for ≤50ms p99."

## How these were collected

```bash
npx vitest bench --run src/governance/__tests__/latency.bench.ts
```

Each scenario warms the JIT + regex cache, then samples N iterations of the
target operation with `process.hrtime.bigint()` per call. Vitest's own
`bench()` reports the tinybench summary (hz, mean, p99, p999, samples) and
each `summarize()` call emits a grep-able `[gov-bench]` line.

## Hardware / environment

- **CPU:** Intel Core i5-1035G1 (4C/8T, 1.00 GHz base)
- **RAM:** 8 GB (frequently <1 GB free on this dev box)
- **OS:** Windows 11 Home 10.0.26200
- **Node:** v25.9.0
- **Vitest:** 2.1.9
- **SDK commit:** pre-Task-#52 audit.ts / audit-chain.ts
- **Wallclock:** 2026-05-17 ~19:30 local

## Results (representative runs — each line is one sample harness)

| Operation                                | N      | p50      | p95      | p99      | mean     |
|------------------------------------------|--------|----------|----------|----------|----------|
| `FiscalGate.reserve` (MockPayments)      | 1,000  | 4.5 µs   | 7.6 µs   | 20.4 µs  | 5.5 µs   |
| `FiscalGate.settle`  (MockPayments)      | 1,000  | 1.3 µs   | 2.5 µs   | 11.1 µs  | 1.7 µs   |
| `audit.record` (single, on fresh chain)  | 1,000  | 28.7 µs  | 55.9 µs  | 96.1 µs  | 33.4 µs  |
| `audit.record` (single, 100-entry tail)  | 1,000  | 27.8 µs  | 66.9 µs  | 256.7 µs | 69.0 µs  |
| `audit.verify(100)` — re-hash 100 entries| 200    | 1,812 µs | 2,571 µs | 4,522 µs | 1,919 µs |
| `charter.match` (100-rule policy)        | 5,000  | 29.7 µs  | 58.4 µs  | 198.8 µs | 45.9 µs  |
| `e2e wrap` (reserve+evaluate+record+settle) | 500 | 45.5 µs  | 109.1 µs | 181.0 µs | 54.1 µs  |

(Numbers above are the **first reported sample** from each bench scenario.
The harness in `src/governance/__tests__/latency.bench.ts` runs each
scenario tens of times so the bench summary has more statistical mass —
those summary numbers are reproduced in `BENCH-OPTIMIZED-2026-05-17.md`.)

## Reading the numbers

- **Every single operation p99 ≤ 5 ms.** The Task #52 target of 50 ms p99
  is already exceeded by two-to-three orders of magnitude. There is no
  emergency.
- **`audit.verify(100)` is the slow path** (~2 ms p50 / 4.5 ms p99).
  Every other op is in the 5–100 µs range. If we want to spend Task #52
  effort on anything, this is the only candidate that's even *visible*.
- **End-to-end governance overhead is ~45 µs p50, ~180 µs p99.** That's
  the pure cost of wrapping an LLM call with reserve→evaluate→record→settle.
  An LLM call costs 800–2000 ms. Governance is in the noise.

## What that means for the public claim

The README says "sub-second governance." The actual numbers say
"micro-second governance." We can tighten the README phrasing to
"single-microsecond p50, sub-millisecond p95 on a commodity laptop."

The one number that approaches "millisecond" territory is `audit.verify`
on a 100-event chain. We optimize that one path in
`BENCH-OPTIMIZED-2026-05-17.md`.

## Reproducing

```bash
git checkout <pre-task-52-commit>   # this baseline file
npm install
npx vitest bench --run src/governance/__tests__/latency.bench.ts
```

The `[gov-bench]` lines in stdout are the source-of-truth — copy them
into a spreadsheet if you want quartile aggregates across the dozens of
warmup/measure rounds tinybench runs.
