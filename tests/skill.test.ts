import { describe, it, expect } from "vitest";
import { runSkill, policyForSkill, type MnemoSkill } from "../src/skills/skill.js";

function skill(overrides: Partial<MnemoSkill> = {}): MnemoSkill {
  return {
    id: "test-skill",
    name: "Test Skill",
    purpose: "exercise the governed runner",
    version: "1.0.0",
    owner: "test@co",
    permissions: {},
    run: () => "ok",
    ...overrides,
  } as MnemoSkill;
}

describe("policyForSkill", () => {
  it("derives a compiled policy from declared permissions", () => {
    const compiled = policyForSkill(
      skill({ permissions: { disallowed: ["sign_contract"], spend_limit_usd: 1000 } }),
    );
    expect(compiled.rules.length).toBeGreaterThan(0);
  });
});

describe("runSkill", () => {
  it("allows a cheap in-policy action and completes", async () => {
    const s = skill({
      permissions: { allowed_tools: ["search"], approval_above_usd: 50 },
      run: (ctx) => {
        const grant = ctx.act({ kind: "tool_call", target: "search", estimated_usd: 1 });
        return grant.allowed ? "searched" : "blocked";
      },
    });
    const res = await runSkill(s, {});
    expect(res.ok).toBe(true);
    expect(res.output).toBe("searched");
    expect(res.ledger.get(res.action_id)?.status).toBe("completed");
  });

  it("blocks a tool not on the allow-list", async () => {
    const s = skill({
      permissions: { allowed_tools: ["search"] },
      run: (ctx) => {
        const grant = ctx.act({ kind: "tool_call", target: "danger_tool" });
        return grant.allowed ? "ran" : (grant as { reason?: string }).reason ?? "blocked";
      },
    });
    const res = await runSkill(s, {});
    expect(res.output).toBe("tool_not_allowed");
    expect(res.ledger.get(res.action_id)?.status).toBe("blocked");
  });

  it("halts on a pending approval above the threshold", async () => {
    const s = skill({
      permissions: { approval_above_usd: 50 },
      run: (ctx) => {
        const grant = ctx.act({ kind: "payment", target: "stripe", estimated_usd: 200 });
        return grant.allowed ? "paid" : "halted";
      },
    });
    const res = await runSkill(s, {});
    expect(res.ok).toBe(false);
    expect(res.pending_approval_id).toBeTruthy();
    expect(res.ledger.get(res.action_id)?.status).toBe("awaiting_approval");
  });

  it("rejects input that fails validation", async () => {
    const s = skill({
      validateInput: (i): i is unknown => typeof i === "number",
      run: () => "ok",
    });
    const res = await runSkill(s, "not-a-number");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/validation/);
  });

  it("records tool usage and notes memory on the ledger", async () => {
    const s = skill({
      permissions: { allowed_tools: ["search"] },
      run: (ctx) => {
        ctx.noteMemory("mem-42");
        ctx.act({ kind: "tool_call", target: "search", estimated_usd: 2 });
        return "done";
      },
    });
    const res = await runSkill(s, {});
    const rec = res.ledger.get(res.action_id)!;
    expect(rec.tools_used).toContain("search");
    expect(rec.memories_used).toContain("mem-42");
    expect(rec.cost_usd).toBe(2);
  });

  it("surfaces a thrown skill body as a failed run", async () => {
    const s = skill({ run: () => { throw new Error("kaboom"); } });
    const res = await runSkill(s, {});
    expect(res.ok).toBe(false);
    expect(res.error).toBe("kaboom");
    expect(res.ledger.get(res.action_id)?.status).toBe("failed");
  });
});
