import { describe, expect, it } from "vitest";
import { executeTool } from "../src/mcp/server.js";

const agent = {} as any;
const evidence = {
  kind: "spatial_proof_v1",
  proofId: "proof-mcp-1",
  signature: "ab".repeat(32),
  timestamp: new Date().toISOString(),
  pose: { lat: 6.5244, lng: 3.3792, alt: 100 },
  scores: { ssim: 0.98 },
  agentId: "drone-1",
};

describe("MCP spatial evidence tools", () => {
  it("validates, attaches, and exports spatial evidence", async () => {
    const verified = JSON.parse(await executeTool(agent, "spatial_evidence_verify", { evidence }));
    expect(verified.verification.ok).toBe(true);
    expect(verified.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const attached = JSON.parse(await executeTool(agent, "spatial_evidence_attach", { evidence }));
    expect(attached.attached).toBe(true);
    expect(attached.eventCount).toBeGreaterThan(0);

    const audit = JSON.parse(await executeTool(agent, "spatial_audit_export", {}));
    expect(audit.verified).toBe(true);
    expect(audit.events.some((event: any) => event.type === "spatial.evidence")).toBe(true);
  });

  it("fails closed on malformed evidence", async () => {
    await expect(executeTool(agent, "spatial_evidence_attach", {
      evidence: { kind: "spatial_proof_v1", signature: "not-hex" },
    })).rejects.toThrow(/rejected/);
  });
});
