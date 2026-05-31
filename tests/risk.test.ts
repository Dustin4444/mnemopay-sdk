import { describe, it, expect } from "vitest";
import {
  RISK_ORDER,
  riskRank,
  classifyRisk,
  buildRiskPolicy,
} from "../src/governance/risk.js";
import { compilePolicy, evaluateAction } from "../src/governance/policy.js";

describe("risk taxonomy", () => {
  it("orders tiers low → critical", () => {
    expect(RISK_ORDER).toEqual(["low", "medium", "high", "critical"]);
    expect(riskRank("low")).toBeLessThan(riskRank("critical"));
  });

  it("uses kind baselines", () => {
    expect(classifyRisk({ kind: "llm_call", target: "gpt-4" }).level).toBe("low");
    expect(classifyRisk({ kind: "tool_call", target: "search" }).level).toBe("medium");
    expect(classifyRisk({ kind: "file_write", target: "/tmp/x" }).level).toBe("high");
  });

  it("escalates on destructive keywords to critical", () => {
    const r = classifyRisk({ kind: "tool_call", target: "wire_transfer" });
    expect(r.level).toBe("critical");
  });

  it("escalates on sensitive-upload keywords to high", () => {
    const r = classifyRisk({ kind: "http_request", target: "kyc_upload" });
    expect(r.level).toBe("high");
  });

  it("escalates on externally-visible send to medium", () => {
    const r = classifyRisk({ kind: "llm_call", target: "send_email", args_text: "send to bob" });
    expect(riskRank(r.level)).toBeGreaterThanOrEqual(riskRank("medium"));
  });

  it("is amount-aware — >$1000 is always critical", () => {
    const r = classifyRisk({ kind: "tool_call", target: "search", estimated_usd: 2000 });
    expect(r.level).toBe("critical");
  });

  it("never lowers a tier via amount", () => {
    const r = classifyRisk({ kind: "tool_call", target: "wire_money", estimated_usd: 1 });
    expect(r.level).toBe("critical");
  });
});

describe("buildRiskPolicy preset", () => {
  it("blocks targets outright", () => {
    const compiled = compilePolicy(buildRiskPolicy({ blockTargets: ["sign_contract"] }));
    const v = evaluateAction(compiled, { kind: "tool_call", target: "sign_contract" });
    expect(v.allowed).toBe(false);
  });

  it("requires approval above the spend threshold", () => {
    const compiled = compilePolicy(buildRiskPolicy({ approvalThresholdUsd: 50 }));
    const v = evaluateAction(compiled, { kind: "payment", target: "stripe", estimated_usd: 75 });
    expect("needs_approval" in v && v.needs_approval).toBe(true);
  });

  it("hard-caps spend above the ceiling", () => {
    const compiled = compilePolicy(buildRiskPolicy({ hardCapUsd: 5000 }));
    const v = evaluateAction(compiled, { kind: "payment", target: "stripe", estimated_usd: 6000 });
    expect(v.allowed).toBe(false);
  });

  it("auto-allows cheap actions", () => {
    const compiled = compilePolicy(buildRiskPolicy({ approvalThresholdUsd: 50 }));
    const v = evaluateAction(compiled, { kind: "tool_call", target: "search", estimated_usd: 1 });
    expect(v.allowed).toBe(true);
  });
});
