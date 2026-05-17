/**
 * Governance latency invariant — CI-enforced bound on the "sub-second
 * governance" claim.
 *
 * This is a degraded-mode replay of `tests/bench/governance-latency.bench.ts`:
 *  - smaller sample size (cheap enough to run on every `npm test`)
 *  - generous thresholds (sized to catch ~10x regressions, NOT 1.2x jitter)
 *
 * The full numbers shipped in README come from `npm run bench:governance`.
 * This spec just guards against the published numbers silently drifting
 * by an order of magnitude on a regression. If this test fails, run the
 * full bench and either fix the regression or — if intentional — update
 * the README table AND these thresholds in the same PR.
 */
import { describe, it, expect } from "vitest";
import {
  compilePolicy,
  evaluateAction,
  InMemoryRateCounter,
} from "../../src/governance/policy.js";
import { defaultEuAiActPolicy } from "../../src/governance/policies/eu-ai-act.js";
import { MerkleAudit } from "../../src/governance/audit.js";

function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return 0;
  const idx = Math.min(sortedNs.length - 1, Math.floor(p * sortedNs.length));
  return sortedNs[idx]!;
}

function summarize(samplesNs: number[]) {
  const sorted = [...samplesNs].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    n: sorted.length,
  };
}

// Generous bounds. Reference numbers on the dev machine (Intel i5-1035G1,
// Node 25.9, Windows 11) are:
//   policy.evaluateAction  p95 ≈ 2.8µs       (this bound is ~350x slack)
//   MerkleAudit.record     p95 ≈ 45µs        (this bound is  ~110x slack)
// A 10x slowdown — the kind we actually want to catch — still trips the
// gate. A noisy CI runner with a hot core lock should NOT.
const POLICY_EVAL_P95_BOUND_NS = 1_000_000; // 1 ms
const MERKLE_RECORD_P95_BOUND_NS = 5_000_000; // 5 ms

describe("governance latency invariant (degraded-mode bench replay)", () => {
  it("policy.evaluateAction p95 stays under 1 ms on a representative tool_call", () => {
    const compiled = compilePolicy(defaultEuAiActPolicy());
    const counter = new InMemoryRateCounter();

    // Warmup: prime the regex cache + JIT.
    for (let i = 0; i < 200; i++) {
      evaluateAction(
        compiled,
        { kind: "tool_call", target: "search", locale: "US" },
        { rate_counter: counter },
      );
    }

    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      const v = evaluateAction(
        compiled,
        {
          kind: "tool_call",
          target: "search",
          locale: "US",
          estimated_usd: 0.01,
        },
        { rate_counter: counter },
      );
      samples.push(v.latency_ns);
    }

    const { p50, p95, p99, n } = summarize(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[gov-invariant] policy.evaluateAction N=${n} p50=${(p50 / 1000).toFixed(1)}µs ` +
        `p95=${(p95 / 1000).toFixed(1)}µs p99=${(p99 / 1000).toFixed(1)}µs`,
    );

    expect(p95).toBeLessThan(POLICY_EVAL_P95_BOUND_NS);
  });

  it("MerkleAudit.record p95 stays under 5 ms per single-event append", () => {
    // Warmup chain — JIT path + crypto module is lazy on first call.
    const warm = new MerkleAudit();
    for (let i = 0; i < 200; i++) {
      warm.record("llm.call", { i, model: "x" });
    }

    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const audit = new MerkleAudit();
      const t0 = process.hrtime.bigint();
      audit.record("llm.call", {
        i,
        model: "claude-opus-4-7",
        tokens_in: 1234,
        tokens_out: 567,
      });
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }

    const { p50, p95, p99, n } = summarize(samples);
    // eslint-disable-next-line no-console
    console.log(
      `[gov-invariant] MerkleAudit.record N=${n} p50=${(p50 / 1000).toFixed(1)}µs ` +
        `p95=${(p95 / 1000).toFixed(1)}µs p99=${(p99 / 1000).toFixed(1)}µs`,
    );

    expect(p95).toBeLessThan(MERKLE_RECORD_P95_BOUND_NS);
  });
});
