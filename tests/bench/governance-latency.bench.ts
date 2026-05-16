/**
 * Governance latency benchmark — bounds the "sub-second governance" claim.
 *
 * Three hot paths:
 *   (a) policy.evaluateAction()   — per-tool-call enforcement gate
 *   (b) MerkleAudit.record()      — per-event audit append + chain hash
 *   (c) e2e remember() + anchor   — full memory-write path with auto-anchor
 *
 * Vitest's native `bench()` reports hz, mean, min, max, p50/p75/p95/p99
 * in the bench summary. We also emit a one-line `[gov-bench]` log per
 * scenario so CI grep can extract the numbers without parsing the
 * Vitest UI.
 *
 * Run: `npm run bench`
 */
import { bench, describe } from "vitest";
import { compilePolicy, evaluateAction, InMemoryRateCounter } from "../../src/governance/policy.js";
import { defaultEuAiActPolicy } from "../../src/governance/policies/eu-ai-act.js";
import { MerkleAudit } from "../../src/governance/audit.js";
import { AuditChain } from "../../src/governance/audit-chain.js";
import { MnemoPay } from "../../src/index.js";
import { Wallet } from "../../src/identity/wallet.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function percentile(sortedNs: number[], p: number): number {
  if (sortedNs.length === 0) return 0;
  const idx = Math.min(sortedNs.length - 1, Math.floor(p * sortedNs.length));
  return sortedNs[idx]!;
}

function summarize(label: string, samplesNs: number[]): void {
  const sorted = [...samplesNs].sort((a, b) => a - b);
  const p50 = percentile(sorted, 0.5);
  const p95 = percentile(sorted, 0.95);
  const p99 = percentile(sorted, 0.99);
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  // Use console.log so CI can grep on the [gov-bench] prefix.
  // eslint-disable-next-line no-console
  console.log(
    `[gov-bench] ${label} N=${sorted.length} ` +
      `p50=${(p50 / 1000).toFixed(1)}µs ` +
      `p95=${(p95 / 1000).toFixed(1)}µs ` +
      `p99=${(p99 / 1000).toFixed(1)}µs ` +
      `mean=${(mean / 1000).toFixed(1)}µs`,
  );
}

// ─── (a) policy.evaluateAction ──────────────────────────────────────────────

describe("policy.evaluateAction — per-tool-call enforcement", () => {
  const compiled = compilePolicy(defaultEuAiActPolicy());
  const counter = new InMemoryRateCounter();

  // Warmup (JIT + regex caches).
  for (let i = 0; i < 500; i++) {
    evaluateAction(compiled, { kind: "tool_call", target: "search", locale: "US" }, { rate_counter: counter });
  }

  bench("evaluateAction (representative tool_call on EU AI Act policy)", () => {
    evaluateAction(
      compiled,
      { kind: "tool_call", target: "search", locale: "US", estimated_usd: 0.01 },
      { rate_counter: counter },
    );
  });
});

// ─── (b) MerkleAudit.record — 1k append ─────────────────────────────────────

describe("MerkleAudit.record — per-event chain append", () => {
  bench("record (single append on a fresh chain)", () => {
    const audit = new MerkleAudit();
    audit.record("llm.call", { model: "claude-opus-4-7", tokens_in: 1234, tokens_out: 567 });
  });

  bench("record (1,000 sequential appends; per-iter wall covers the full batch)", () => {
    const audit = new MerkleAudit();
    for (let i = 0; i < 1000; i++) {
      audit.record("llm.call", { i, model: "claude-opus-4-7", tokens_in: 1234, tokens_out: 567 });
    }
  });

  bench("AuditChain.emit + rollMerkleRoot (100 events → tree root)", () => {
    const chain = new AuditChain();
    for (let i = 0; i < 100; i++) {
      chain.emit("llm.call", { i, model: "claude-opus-4-7" });
    }
    chain.rollMerkleRoot();
  });
});

// ─── (c) End-to-end: remember() with auto-anchor ───────────────────────────

describe("MnemoPayLite.remember() — e2e write with auto-anchor + governance", () => {
  bench("remember (anchoring off — baseline)", async () => {
    const agent = MnemoPay.quick("bench-no-anchor");
    await agent.remember("a benchmark observation that fits in one line");
  });

  bench("remember (anchoring on, auto-mint Ed25519 + sequence)", async () => {
    const agent = MnemoPay.quick("bench-with-anchor");
    agent.enableAnchoring(Wallet.create());
    await agent.remember("a benchmark observation that fits in one line");
  });
});

// ─── (d) Manual sample harness so we have explicit p50/p95/p99 numbers ─────
//
// Vitest's bench output already includes percentiles, but they live in the
// Vitest UI / summary block. This explicit sampler emits a single grep-able
// line per scenario so the bench numbers can be copied into the report
// without parsing tinybench output.

describe("manual percentile harness (informational)", () => {
  bench("evaluateAction sample harness (5,000 iters, percentile log)", () => {
    const compiled = compilePolicy(defaultEuAiActPolicy());
    const counter = new InMemoryRateCounter();
    const samples: number[] = [];
    // Warmup.
    for (let i = 0; i < 500; i++) {
      evaluateAction(compiled, { kind: "tool_call", target: "search", locale: "US" }, { rate_counter: counter });
    }
    for (let i = 0; i < 5_000; i++) {
      const v = evaluateAction(
        compiled,
        { kind: "tool_call", target: "search", locale: "US", estimated_usd: 0.01 },
        { rate_counter: counter },
      );
      samples.push(v.latency_ns);
    }
    summarize("policy.evaluateAction", samples);
  });

  bench("MerkleAudit.record sample harness (1,000 iters)", () => {
    const audit = new MerkleAudit();
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      const t0 = process.hrtime.bigint();
      audit.record("llm.call", { i, model: "x", tokens_in: 1234, tokens_out: 567 });
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }
    summarize("MerkleAudit.record", samples);
  });

  bench("remember+anchor sample harness (200 iters)", async () => {
    const agent = MnemoPay.quick("bench-harness");
    agent.enableAnchoring(Wallet.create());
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = process.hrtime.bigint();
      await agent.remember(`observation ${i} for the bench harness`);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }
    summarize("MnemoPayLite.remember+anchor", samples);
  });
});
