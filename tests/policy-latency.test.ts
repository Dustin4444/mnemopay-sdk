import { describe, it, expect } from "vitest";
import { compilePolicy, evaluateAction, InMemoryRateCounter } from "../src/governance/policy.js";
import { defaultEuAiActPolicy } from "../src/governance/policies/eu-ai-act.js";

/**
 * P50/P95/P99 latency assertions — the sub-second policy claim only holds
 * if the tail is bounded. Aggregate wallclock means little if P99 spikes.
 *
 * Budget: P50 < 50µs, P95 < 200µs, P99 < 1ms on a typical machine. Generous
 * upper bounds — real impl typically halves these. Failure here means the
 * sub-second EU AI Act timer claim is suspect; investigate before merging.
 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx]!;
}

describe("evaluateAction latency distribution", () => {
  it("P50 < 50µs, P95 < 200µs, P99 < 1ms over 5,000 evaluations", () => {
    const compiled = compilePolicy(defaultEuAiActPolicy());
    const counter = new InMemoryRateCounter();
    const samples: number[] = [];

    // Warmup — JIT, regex caching.
    for (let i = 0; i < 500; i++) {
      evaluateAction(compiled, { kind: "tool_call", target: "search", locale: "US" }, { rate_counter: counter });
    }

    const N = 5_000;
    for (let i = 0; i < N; i++) {
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
      // verdict carries its own latency_ns
      samples.push(v.latency_ns);
    }
    samples.sort((a, b) => a - b);

    const p50_us = percentile(samples, 0.50) / 1000;
    const p95_us = percentile(samples, 0.95) / 1000;
    const p99_us = percentile(samples, 0.99) / 1000;
    const p999_us = percentile(samples, 0.999) / 1000;

    // Log so regression PRs surface trend.
    console.log(
      `[policy-latency] P50=${p50_us.toFixed(1)}µs P95=${p95_us.toFixed(1)}µs P99=${p99_us.toFixed(1)}µs P99.9=${p999_us.toFixed(1)}µs over ${N}`,
    );

    expect(p50_us).toBeLessThan(50);
    expect(p95_us).toBeLessThan(200);
    expect(p99_us).toBeLessThan(1000);   // 1ms
  });
});
