import { describe, expect, it } from "vitest";
import { AuditChain, verifyBundle } from "../../src/governance/audit-chain.js";

describe("AuditChain JSON round-trip", () => {
  it("keeps bundles verifiable when event payloads contain optional undefined fields", () => {
    const chain = new AuditChain();
    chain.emit("action.begin", {
      intent: "research vendor",
      plan: undefined,
      nested: { value: "kept", omitted: undefined },
      list: ["kept", undefined],
    });

    const transported = JSON.parse(JSON.stringify(chain.toBundle()));
    expect(verifyBundle(transported)).toEqual({ ok: true });
  });
});
