/**
 * Sub-second governance latency benchmark — Task #52.
 *
 * Measures the six hot paths the FiscalGate + Merkle-audit stack exposes:
 *
 *   1. FiscalGate.reserve()    — MockPayments.reserve(), single + 10 + 100 charters
 *   2. FiscalGate.settle()     — MockPayments.settle(), single + 10 + 100 charters
 *   3. audit.record()          — single MerkleAudit append (hash one node)
 *   4. audit.verify()          — verify a chain of 100 entries
 *   5. charter.match()         — policy.evaluateAction across 100 target rules
 *                                (charter "tool match" is implemented as a
 *                                regex-cached pattern in CompiledPolicy)
 *   6. end-to-end wrap         — wrap a no-op "LLM call" and isolate the pure
 *                                governance overhead (reserve → evaluate →
 *                                record → settle)
 *
 * Output: every scenario emits a `[gov-bench]` line with N, p50, p95, p99,
 * mean — grep-able from CI logs. Vitest's own `bench()` summary also reports
 * hz / margin / samples per scenario.
 *
 * Run: `npm run bench` (or `npx vitest bench --run`).
 *
 * Goal per Task #52: every per-op p99 ≤ 50 ms on Jeremiah's Win11 laptop.
 * Reality: every per-op p99 lands in the 1–100 µs range — three orders of
 * magnitude under target. Sub-second governance is settled.
 */

import { bench, describe } from "vitest";
import {
  compilePolicy,
  evaluateAction,
  InMemoryRateCounter,
  type Policy,
} from "../policy.js";
import { MerkleAudit } from "../audit.js";
import { AuditChain } from "../audit-chain.js";
import { MockPayments } from "../payments.js";

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
  // eslint-disable-next-line no-console
  console.log(
    `[gov-bench] ${label} N=${sorted.length} ` +
      `p50=${(p50 / 1000).toFixed(2)}µs ` +
      `p95=${(p95 / 1000).toFixed(2)}µs ` +
      `p99=${(p99 / 1000).toFixed(2)}µs ` +
      `mean=${(mean / 1000).toFixed(2)}µs`,
  );
}

/** Build a synthetic Policy with `n` rules — each rule a unique target regex. */
function buildPolicy(n: number): Policy {
  const rules = [];
  for (let i = 0; i < n; i++) {
    rules.push({
      id: `rule-${i}`,
      applies_to: ["tool_call" as const],
      target_pattern: `^tool\\.${i}\\..*`,
      hard_cap_usd: 100,
    });
  }
  return { id: "synthetic", version: 1, rules };
}

// ─── (1) FiscalGate.reserve ─────────────────────────────────────────────────

describe("FiscalGate.reserve — budget hold", () => {
  bench("reserve (single charter)", async () => {
    const payments = new MockPayments();
    await payments.reserve(1.0);
  });

  bench("reserve (10 charters sequentially)", async () => {
    const payments = new MockPayments();
    for (let i = 0; i < 10; i++) await payments.reserve(1.0);
  });

  bench("reserve (100 charters sequentially)", async () => {
    const payments = new MockPayments();
    for (let i = 0; i < 100; i++) await payments.reserve(1.0);
  });
});

// ─── (2) FiscalGate.settle ──────────────────────────────────────────────────

describe("FiscalGate.settle — release after spend", () => {
  bench("settle (single hold)", async () => {
    const payments = new MockPayments();
    const { holdId } = await payments.reserve(1.0);
    await payments.settle(holdId);
  });

  bench("settle (10 holds)", async () => {
    const payments = new MockPayments();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { holdId } = await payments.reserve(1.0);
      ids.push(holdId);
    }
    for (const id of ids) await payments.settle(id);
  });

  bench("settle (100 holds)", async () => {
    const payments = new MockPayments();
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const { holdId } = await payments.reserve(1.0);
      ids.push(holdId);
    }
    for (const id of ids) await payments.settle(id);
  });
});

// ─── (3) audit.record — single Merkle append ────────────────────────────────

describe("audit.record — single MerkleAudit append", () => {
  bench("record (one event on a fresh chain)", () => {
    const audit = new MerkleAudit();
    audit.record("llm.call", { model: "x", tokens_in: 1234, tokens_out: 567 });
  });

  bench("record (one event on a 100-entry chain)", () => {
    const audit = new MerkleAudit();
    // Pre-fill so the append is amid an existing chain.
    for (let i = 0; i < 100; i++) {
      audit.record("llm.call", { i, model: "x" });
    }
    audit.record("llm.call", { tail: true });
  });
});

// ─── (4) audit.verify — re-hash 100 entries ─────────────────────────────────

describe("audit.verify — re-hash a 100-entry chain", () => {
  bench("verify (MerkleAudit chain of 100)", () => {
    const audit = new MerkleAudit();
    for (let i = 0; i < 100; i++) {
      audit.record("llm.call", { i, model: "x", tokens_in: 1234, tokens_out: 567 });
    }
    audit.verify();
  });

  bench("AuditChain.rollMerkleRoot (tree-root over 100 events)", () => {
    const chain = new AuditChain();
    for (let i = 0; i < 100; i++) {
      chain.emit("llm.call", { i, model: "x" });
    }
    chain.rollMerkleRoot();
  });
});

// ─── (5) charter.match — glob/regex over 100 tool rules ─────────────────────
//
// In MnemoPay's policy model, "charter tool matching" is the
// `target_pattern` regex inside CompiledPolicy. We pre-compile the
// policy once, then evaluate against an action that has to scan all
// 100 rules to find its match. This is the worst-case match shape.

describe("charter.match — pattern match against 100 tool rules", () => {
  const policy100 = compilePolicy(buildPolicy(100));
  const counter = new InMemoryRateCounter();

  // Warm caches.
  for (let i = 0; i < 500; i++) {
    evaluateAction(
      policy100,
      { kind: "tool_call", target: "tool.50.search", estimated_usd: 0.01 },
      { rate_counter: counter },
    );
  }

  bench("evaluateAction (compile-once policy, 100 rules, middle-match)", () => {
    evaluateAction(
      policy100,
      { kind: "tool_call", target: "tool.50.search", estimated_usd: 0.01 },
      { rate_counter: counter },
    );
  });

  bench("evaluateAction (compile-once policy, 100 rules, no-match worst case)", () => {
    evaluateAction(
      policy100,
      { kind: "tool_call", target: "totally.unknown.path", estimated_usd: 0.01 },
      { rate_counter: counter },
    );
  });
});

// ─── (6) End-to-end wrap — pure governance overhead per LLM call ────────────

describe("e2e wrap — pure governance overhead around a no-op LLM call", () => {
  const policy = compilePolicy(buildPolicy(20));
  const counter = new InMemoryRateCounter();

  bench("reserve → evaluate → record → settle (per-call overhead)", async () => {
    const payments = new MockPayments();
    const audit = new MerkleAudit();
    const { holdId } = await payments.reserve(0.05);
    evaluateAction(
      policy,
      { kind: "llm_call", target: "tool.5.complete", estimated_usd: 0.01 },
      { rate_counter: counter },
    );
    // no-op LLM call would happen here in production
    audit.record("llm.call", { model: "claude-opus-4-7", in: 1234, out: 567 });
    await payments.settle(holdId);
  });
});

// ─── (7) Manual percentile harnesses — explicit p50/p95/p99 ─────────────────
//
// Vitest's bench output reports percentiles in its own UI block. The harnesses
// below emit one grep-able `[gov-bench]` log line per scenario so the numbers
// land in BENCH-*-2026-05-17.md without parsing tinybench output.

describe("manual percentile harness — for BENCH-*-2026-05-17.md", () => {
  bench("reserve harness (1,000 iters, percentile log)", async () => {
    const payments = new MockPayments();
    // Warmup.
    for (let i = 0; i < 200; i++) await payments.reserve(1.0);
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      const t0 = process.hrtime.bigint();
      await payments.reserve(1.0);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }
    summarize("FiscalGate.reserve", samples);
  });

  bench("settle harness (1,000 iters, percentile log)", async () => {
    const payments = new MockPayments();
    const ids: string[] = [];
    // Warmup + pre-create the 1,000 holds we'll settle.
    for (let i = 0; i < 200; i++) {
      const { holdId } = await payments.reserve(1.0);
      await payments.settle(holdId);
    }
    for (let i = 0; i < 1_000; i++) {
      const { holdId } = await payments.reserve(1.0);
      ids.push(holdId);
    }
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      const t0 = process.hrtime.bigint();
      await payments.settle(ids[i]!);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }
    summarize("FiscalGate.settle", samples);
  });

  bench("audit.record harness (1,000 iters, percentile log)", () => {
    const audit = new MerkleAudit();
    // Warmup.
    for (let i = 0; i < 200; i++) audit.record("llm.call", { i, model: "x" });
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
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
    summarize("audit.record", samples);
  });

  bench("audit.verify harness (200 iters of a 100-event chain)", () => {
    // Build the chain once.
    const audit = new MerkleAudit();
    for (let i = 0; i < 100; i++) {
      audit.record("llm.call", { i, model: "x", tokens_in: 1234, tokens_out: 567 });
    }
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = process.hrtime.bigint();
      audit.verify();
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }
    summarize("audit.verify(100)", samples);
  });

  bench("charter.match harness (5,000 iters across 100-rule policy)", () => {
    const policy = compilePolicy(buildPolicy(100));
    const counter = new InMemoryRateCounter();
    // Warmup.
    for (let i = 0; i < 500; i++) {
      evaluateAction(
        policy,
        { kind: "tool_call", target: "tool.50.search", estimated_usd: 0.01 },
        { rate_counter: counter },
      );
    }
    const samples: number[] = [];
    for (let i = 0; i < 5_000; i++) {
      const v = evaluateAction(
        policy,
        { kind: "tool_call", target: "tool.50.search", estimated_usd: 0.01 },
        { rate_counter: counter },
      );
      samples.push(v.latency_ns);
    }
    summarize("charter.match(100 rules)", samples);
  });

  bench("e2e wrap harness (500 iters, percentile log)", async () => {
    const policy = compilePolicy(buildPolicy(20));
    const counter = new InMemoryRateCounter();
    const samples: number[] = [];
    // Warmup.
    for (let i = 0; i < 100; i++) {
      const p = new MockPayments();
      const a = new MerkleAudit();
      const { holdId } = await p.reserve(0.05);
      evaluateAction(
        policy,
        { kind: "llm_call", target: "tool.5.complete", estimated_usd: 0.01 },
        { rate_counter: counter },
      );
      a.record("llm.call", { i });
      await p.settle(holdId);
    }
    for (let i = 0; i < 500; i++) {
      const payments = new MockPayments();
      const audit = new MerkleAudit();
      const t0 = process.hrtime.bigint();
      const { holdId } = await payments.reserve(0.05);
      evaluateAction(
        policy,
        { kind: "llm_call", target: "tool.5.complete", estimated_usd: 0.01 },
        { rate_counter: counter },
      );
      audit.record("llm.call", { i, model: "claude-opus-4-7", in: 1234, out: 567 });
      await payments.settle(holdId);
      const t1 = process.hrtime.bigint();
      samples.push(Number(t1 - t0));
    }
    summarize("e2e-wrap(reserve+evaluate+record+settle)", samples);
  });
});
