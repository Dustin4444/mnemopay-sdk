import { describe, it, expect } from "vitest";
import { compilePolicy, evaluateAction, InMemoryRateCounter } from "../src/governance/policy.js";
import { defaultEuAiActPolicy } from "../src/governance/policies/eu-ai-act.js";

const compiled = compilePolicy(defaultEuAiActPolicy());

describe("EU AI Act sample policy", () => {
  it("blocks Article 5(1)(a) subliminal/manipulative tool calls", () => {
    const v = evaluateAction(compiled, { kind: "tool_call", target: "manipulate.imagery" });
    expect(v.allowed).toBe(false);
  });

  it("blocks Article 5(1)(c) social scoring inside EU locales", () => {
    const v = evaluateAction(compiled, {
      kind: "tool_call",
      target: "social.score",
      locale: "DE",
    });
    expect(v.allowed).toBe(false);
  });

  it("allows social scoring outside the EU", () => {
    const v = evaluateAction(compiled, {
      kind: "tool_call",
      target: "social.score",
      locale: "US",
    });
    expect(v.allowed).toBe(true);
  });

  it("triggers Article 14 approval for payments > $10", () => {
    const v = evaluateAction(compiled, {
      kind: "payment",
      target: "stripe",
      estimated_usd: 15,
    });
    expect("needs_approval" in v && v.needs_approval).toBe(true);
  });

  it("hard-blocks payments > $1000 even pre-approval", () => {
    const v = evaluateAction(compiled, {
      kind: "payment",
      target: "stripe",
      estimated_usd: 5000,
    });
    expect(v.allowed).toBe(false);
  });

  it("rate-caps llm_call at 60/minute per target", () => {
    const counter = new InMemoryRateCounter();
    const baseTime = new Date("2026-05-14T12:00:00.000Z");

    let blocked = false;
    for (let i = 0; i < 61; i++) {
      const v = evaluateAction(
        compiled,
        {
          kind: "llm_call",
          target: "claude-opus-4-7",
          locale: "US",
          at: new Date(baseTime.getTime() + i * 100),
        },
        { rate_counter: counter },
      );
      if (!v.allowed) { blocked = true; break; }
    }
    expect(blocked).toBe(true);
  });
});
