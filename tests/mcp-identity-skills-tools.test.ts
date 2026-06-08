import { describe, expect, it } from "vitest";
import { executeTool } from "../src/mcp/server.js";

const agent = {} as any;
const suffix = Math.random().toString(16).slice(2);

describe("MCP identity and governed-skills tools", () => {
  it("issues scoped capabilities and enforces the kill switch", async () => {
    const agentId = `cap-agent-${suffix}`;
    const identity = JSON.parse(await executeTool(agent, "identity_create", {
      agentId,
      ownerId: "owner-1",
      ownerEmail: "owner@example.com",
      ownerType: "organization",
      capabilities: ["charge", "recall"],
    }));
    expect(identity.agentId).toBe(agentId);
    expect(identity.privateKey).toBeUndefined();

    const token = JSON.parse(await executeTool(agent, "capability_issue", {
      agentId,
      permissions: ["charge"],
      maxAmount: 100,
      maxTotalSpend: 200,
      expiresInMinutes: 30,
    }));
    const valid = JSON.parse(await executeTool(agent, "capability_validate", {
      tokenId: token.id,
      action: "charge",
      amount: 50,
    }));
    expect(valid.valid).toBe(true);

    const overLimit = JSON.parse(await executeTool(agent, "capability_validate", {
      tokenId: token.id,
      action: "charge",
      amount: 150,
    }));
    expect(overLimit.valid).toBe(false);

    const halted = JSON.parse(await executeTool(agent, "identity_killswitch", {
      agentId,
      reason: "operator emergency stop",
    }));
    expect(halted.revokedTokens).toBe(1);
    const after = JSON.parse(await executeTool(agent, "capability_validate", {
      tokenId: token.id,
      action: "charge",
      amount: 1,
    }));
    expect(after.valid).toBe(false);
  });

  it("previews and runs declarative governed-skill action plans", async () => {
    const permissions = {
      allowed_tools: ["crm.search", "email.draft", "payments.refund"],
      approval_above_usd: 50,
      spend_limit_usd: 500,
    };
    const policy = JSON.parse(await executeTool(agent, "skill_policy_preview", {
      skillId: "invoice-collector-test",
      permissions,
    }));
    expect(policy.id).toBe("skill:invoice-collector-test");

    const result = JSON.parse(await executeTool(agent, "skill_run_plan", {
      skillId: "invoice-collector-test",
      purpose: "collect an overdue invoice",
      permissions,
      actions: [
        { kind: "tool_call", target: "crm.search", estimated_usd: 0.01 },
        { kind: "tool_call", target: "email.draft", estimated_usd: 0.05 },
        { kind: "payment", target: "payments.refund", estimated_usd: 75 },
      ],
    }));
    expect(result.ok).toBe(false);
    expect(result.pending_approval_id).toBeTruthy();
    expect(result.action.status).toBe("awaiting_approval");
  });
});
