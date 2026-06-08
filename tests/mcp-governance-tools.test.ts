import { describe, expect, it } from "vitest";
import { executeTool } from "../src/mcp/server.js";

const agent = {} as any;

describe("MCP governance tools", () => {
  it("validates charters and classifies action risk", async () => {
    const charter = JSON.parse(await executeTool(agent, "charter_validate", {
      charter: {
        name: "invoice collector",
        goal: "collect approved invoices",
        budget: { maxUsd: 100, approvalThresholdUsd: 25 },
        agents: [{ role: "auditor" }],
        outputs: ["receipts"],
      },
    }));
    expect(charter.valid).toBe(true);

    const risk = JSON.parse(await executeTool(agent, "risk_classify", {
      kind: "payment",
      target: "wire_transfer",
      estimatedUsd: 1500,
    }));
    expect(risk.risk.level).toBe("critical");
  });

  it("sets and evaluates a policy", async () => {
    await executeTool(agent, "policy_set", {
      approvalThresholdUsd: 50,
      hardCapUsd: 500,
      blockTargets: ["delete_account"],
    });

    const approval = JSON.parse(await executeTool(agent, "policy_evaluate", {
      kind: "payment",
      target: "vendor_payment",
      estimatedUsd: 75,
    }));
    expect(approval.verdict.needs_approval).toBe(true);

    const blocked = JSON.parse(await executeTool(agent, "policy_evaluate", {
      kind: "tool_call",
      target: "delete_account",
    }));
    expect(blocked.verdict.allowed).toBe(false);
  });

  it("records an action lifecycle and verifies its audit bundle", async () => {
    const begun = JSON.parse(await executeTool(agent, "action_begin", {
      agentId: "test-agent",
      intent: "research vendor",
      plan: "browse and summarize",
    }));
    await executeTool(agent, "action_update", {
      actionId: begun.id,
      toolsUsed: ["browser.open"],
      sitesVisited: ["https://example.com"],
      costUsd: 0.02,
      executing: true,
    });
    const ended = JSON.parse(await executeTool(agent, "action_end", {
      actionId: begun.id,
      status: "completed",
      result: "vendor researched",
    }));
    expect(ended.status).toBe("completed");
    expect(ended.cost_usd).toBe(0.02);

    const bundle = JSON.parse(await executeTool(agent, "audit_bundle_export", {
      meta: { purpose: "test" },
    }));
    const verified = JSON.parse(await executeTool(agent, "audit_bundle_verify", { bundle }));
    expect(verified.ok).toBe(true);
  });
});
