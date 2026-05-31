import { describe, it, expect } from "vitest";
import { ActionLedger } from "../src/governance/action-ledger.js";

describe("ActionLedger", () => {
  it("begins an action in planned state and lists it", () => {
    const ledger = new ActionLedger();
    const rec = ledger.begin({ agent_id: "a1", intent: "do a thing" });
    expect(rec.status).toBe("planned");
    expect(ledger.list("a1")).toHaveLength(1);
    expect(ledger.get(rec.id)?.intent).toBe("do a thing");
  });

  it("dedupes arrays and accumulates cost on update", () => {
    const ledger = new ActionLedger();
    const { id } = ledger.begin({ agent_id: "a1", intent: "x" });
    ledger.update(id, { tools_used: ["search"], cost_usd: 1.5 });
    ledger.update(id, { tools_used: ["search", "fetch"], cost_usd: 0.5 });
    const rec = ledger.get(id)!;
    expect(rec.tools_used).toEqual(["search", "fetch"]);
    expect(rec.cost_usd).toBe(2);
  });

  it("tracks the approval lifecycle", () => {
    const ledger = new ActionLedger();
    const { id } = ledger.begin({ agent_id: "a1", intent: "x" });
    ledger.awaitApproval(id, "ap_1");
    expect(ledger.get(id)?.status).toBe("awaiting_approval");
    ledger.resolveApproval(id, "ap_1", "approved", "human@co");
    const ap = ledger.get(id)!.approvals[0];
    expect(ap.status).toBe("approved");
    expect(ap.decided_by).toBe("human@co");
  });

  it("completes / fails / blocks and stamps ended_at", () => {
    const ledger = new ActionLedger();
    const a = ledger.begin({ agent_id: "a1", intent: "x" });
    ledger.complete(a.id, "done");
    expect(ledger.get(a.id)?.status).toBe("completed");
    expect(ledger.get(a.id)?.ended_at).toBeTruthy();

    const b = ledger.begin({ agent_id: "a1", intent: "y" });
    ledger.fail(b.id, "boom");
    expect(ledger.get(b.id)?.status).toBe("failed");
    expect(ledger.get(b.id)?.error).toBe("boom");
  });

  it("emits every lifecycle transition onto the audit chain", () => {
    const ledger = new ActionLedger();
    const { id } = ledger.begin({ agent_id: "a1", intent: "x" });
    ledger.markExecuting(id);
    ledger.complete(id, "ok");
    const kinds = ledger.events().map((e) => e.kind);
    expect(kinds).toContain("action.begin");
    expect(kinds).toContain("action.executing");
    expect(kinds).toContain("action.end");
    // Underlying chain still rolls a Merkle root covering the lifecycle.
    expect(ledger.auditChain().rollMerkleRoot()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws on unknown action id", () => {
    const ledger = new ActionLedger();
    expect(() => ledger.update("nope", { cost_usd: 1 })).toThrow();
  });
});
