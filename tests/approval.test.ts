import { describe, it, expect } from "vitest";
import { InMemoryApprovalStore, routeVerdict } from "../src/governance/approval.js";
import { compilePolicy, evaluateAction } from "../src/governance/policy.js";
import { defaultEuAiActPolicy } from "../src/governance/policies/eu-ai-act.js";

describe("InMemoryApprovalStore", () => {
  it("opens, lists, decides, and rejects double-decide", () => {
    const store = new InMemoryApprovalStore();
    const req = store.open({
      reason: "approval_threshold_usd",
      matched_rule: "art14-human-oversight",
      action: { kind: "payment", target: "stripe", estimated_usd: 50 },
    });
    expect(req.status).toBe("pending");
    expect(store.pending()).toHaveLength(1);

    const decided = store.decide(req.id, "approve", "jeremiah@getbizsuite.com", "looks fine");
    expect(decided.status).toBe("approved");
    expect(store.pending()).toHaveLength(0);

    expect(() => store.decide(req.id, "reject", "x")).toThrow();
  });

  it("expire() flips status to expired", () => {
    const store = new InMemoryApprovalStore();
    const req = store.open({
      reason: "x",
      matched_rule: "y",
      action: { kind: "tool_call", target: "x" },
    });
    expect(store.expire(req.id).status).toBe("expired");
  });
});

describe("routeVerdict", () => {
  const compiled = compilePolicy(defaultEuAiActPolicy());

  it("returns allowed:true for clean verdicts", () => {
    const store = new InMemoryApprovalStore();
    const v = evaluateAction(compiled, { kind: "tool_call", target: "search", locale: "US" });
    const r = routeVerdict(store, { kind: "tool_call", target: "search" }, v);
    expect(r.allowed).toBe(true);
  });

  it("opens approval for needs_approval verdicts and returns blocker:pending", () => {
    const store = new InMemoryApprovalStore();
    const action = { kind: "payment" as const, target: "stripe", estimated_usd: 50 };
    const v = evaluateAction(compiled, action);
    const r = routeVerdict(store, action, v);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.blocker).toBe("pending");
      expect(r.approval_id).toBeDefined();
    }
    expect(store.pending()).toHaveLength(1);
  });

  it("returns blocker:blocked for hard denials with reason", () => {
    const store = new InMemoryApprovalStore();
    const action = { kind: "payment" as const, target: "stripe", estimated_usd: 5000 };
    const v = evaluateAction(compiled, action);
    const r = routeVerdict(store, action, v);
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.blocker).toBe("blocked");
  });
});
