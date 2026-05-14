import { describe, it, expect } from "vitest";
import {
  compilePolicy,
  evaluateAction,
  InMemoryRateCounter,
  type Policy,
} from "../src/governance/policy.js";

const basePolicy: Policy = {
  id: "test",
  version: 1,
  rules: [
    {
      id: "block-eu-rejects",
      applies_to: ["llm_call"],
      block_locales: ["DE", "FR", "IT"],
    },
    {
      id: "high-spend-approval",
      applies_to: ["payment"],
      approval_threshold_usd: 50,
      hard_cap_usd: 500,
    },
    {
      id: "block-dangerous-tool",
      applies_to: ["tool_call"],
      target_pattern: "^danger:.*",
      outright_block: true,
    },
    {
      id: "no-shell-eval",
      applies_to: ["tool_call"],
      target_in: ["shell.exec"],
      arg_pattern_blocks: "rm -rf|sudo",
    },
    {
      id: "rate-1-per-sec",
      applies_to: ["http_request"],
      target_pattern: "^https?://example\\.com/.*",
      rate_limit: { window: "second", max: 1 },
    },
  ],
};

describe("evaluateAction", () => {
  const compiled = compilePolicy(basePolicy);

  it("blocks EU locales on llm_call", () => {
    const v = evaluateAction(compiled, {
      kind: "llm_call",
      target: "claude-opus-4-7",
      locale: "DE",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed && "matched_rule" in v) expect(v.matched_rule).toBe("block-eu-rejects");
  });

  it("allows US locale on llm_call", () => {
    const v = evaluateAction(compiled, {
      kind: "llm_call",
      target: "claude-opus-4-7",
      locale: "US",
    });
    expect(v.allowed).toBe(true);
  });

  it("requests approval above threshold but under hard cap", () => {
    const v = evaluateAction(compiled, {
      kind: "payment",
      target: "stripe",
      estimated_usd: 100,
    });
    expect("needs_approval" in v && v.needs_approval).toBe(true);
  });

  it("hard-blocks above hard cap", () => {
    const v = evaluateAction(compiled, {
      kind: "payment",
      target: "stripe",
      estimated_usd: 1000,
    });
    expect(v.allowed).toBe(false);
  });

  it("outright-blocks dangerous tools by target pattern", () => {
    const v = evaluateAction(compiled, { kind: "tool_call", target: "danger:rm" });
    expect(v.allowed).toBe(false);
    if (!v.allowed && "matched_rule" in v) expect(v.matched_rule).toBe("block-dangerous-tool");
  });

  it("blocks shell.exec with dangerous args_text", () => {
    const v = evaluateAction(compiled, {
      kind: "tool_call",
      target: "shell.exec",
      args_text: "rm -rf /tmp/foo",
    });
    expect(v.allowed).toBe(false);
    if (!v.allowed && "matched_rule" in v) expect(v.matched_rule).toBe("no-shell-eval");
  });

  it("allows shell.exec with safe args_text", () => {
    const v = evaluateAction(compiled, {
      kind: "tool_call",
      target: "shell.exec",
      args_text: "ls -la /tmp",
    });
    expect(v.allowed).toBe(true);
  });

  it("enforces rate limit within window", () => {
    const counter = new InMemoryRateCounter();
    const t0 = new Date("2026-05-14T12:00:00.000Z");
    const v1 = evaluateAction(
      compiled,
      { kind: "http_request", target: "https://example.com/x", at: t0 },
      { rate_counter: counter },
    );
    expect(v1.allowed).toBe(true);

    const v2 = evaluateAction(
      compiled,
      { kind: "http_request", target: "https://example.com/x", at: new Date(t0.getTime() + 500) },
      { rate_counter: counter },
    );
    expect(v2.allowed).toBe(false);
    if (!v2.allowed && "reason" in v2) expect(v2.reason).toBe("rate_limit");
  });
});

describe("latency budget (smoke)", () => {
  it("evaluates 1000 actions under 200ms total wallclock", () => {
    const compiled = compilePolicy(basePolicy);
    const counter = new InMemoryRateCounter();

    const start = process.hrtime.bigint();
    for (let i = 0; i < 1000; i++) {
      evaluateAction(
        compiled,
        {
          kind: "tool_call",
          target: "shell.exec",
          args_text: "ls",
          locale: "US",
          estimated_usd: 0.01,
        },
        { rate_counter: counter },
      );
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;

    // Aggregate smoke — the precise SLA lives in policy-latency.test.ts
    // (P99 < 1ms). Relaxed because parallel test runners introduce noise
    // in aggregate-wallclock measurement.
    expect(elapsedMs).toBeLessThan(200);
  });
});
