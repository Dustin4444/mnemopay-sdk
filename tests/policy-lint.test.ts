import { describe, it, expect } from "vitest";
import { lintPolicy } from "../src/governance/policy-lint.js";
import { defaultEuAiActPolicy } from "../src/governance/policies/eu-ai-act.js";
import type { Policy } from "../src/governance/policy.js";

describe("lintPolicy", () => {
  it("the shipped EU AI Act sample policy lints clean", () => {
    const report = lintPolicy(defaultEuAiActPolicy());
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toHaveLength(0);
  });

  it("flags duplicate rule ids", () => {
    const p: Policy = {
      id: "p", version: 1,
      rules: [
        { id: "dupe", outright_block: true },
        { id: "dupe", outright_block: true },
      ],
    };
    const r = lintPolicy(p);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes("duplicate"))).toBe(true);
  });

  it("flags invalid regex", () => {
    const p: Policy = {
      id: "p", version: 1,
      rules: [{ id: "bad", target_pattern: "(" }],
    };
    const r = lintPolicy(p);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === "target_pattern")).toBe(true);
  });

  it("flags unreachable hard cap", () => {
    const p: Policy = {
      id: "p", version: 1,
      rules: [{ id: "unreachable", approval_threshold_usd: 100, hard_cap_usd: 50 }],
    };
    const r = lintPolicy(p);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === "hard_cap_usd")).toBe(true);
  });

  it("flags locale lists that contradict", () => {
    const p: Policy = {
      id: "p", version: 1,
      rules: [{
        id: "contradict",
        block_locales: ["DE", "FR"],
        allow_only_locales: ["DE", "US"],
      }],
    };
    const r = lintPolicy(p);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.message.includes("both"))).toBe(true);
  });

  it("warns on rules with no constraints", () => {
    const p: Policy = { id: "p", version: 1, rules: [{ id: "empty" }] };
    const r = lintPolicy(p);
    expect(r.ok).toBe(true);   // warning, not error
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
  });

  it("flags rate_limit.max <= 0", () => {
    const p: Policy = {
      id: "p", version: 1,
      rules: [{ id: "zero-rate", rate_limit: { window: "minute", max: 0 } }],
    };
    const r = lintPolicy(p);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.field === "rate_limit.max")).toBe(true);
  });
});
