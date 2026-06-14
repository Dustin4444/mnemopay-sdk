/**
 * Multi-tenant wallet routing tests.
 *
 * Verifies that the per-request acting-agent routing wired into the MCP server
 * (AgentRegistry + `X-MnemoPay-Agent` header / `_agentId` arg) physically
 * isolates each tenant's money and memory:
 *
 *   - tenant A's charge lands on A's ledger and NOT on B's
 *   - tenant B cannot recall A's remembered note
 *   - an invalid / `..`-containing agent id is rejected
 *   - no identity supplied => the boot agent is used (single-tenant unchanged)
 *   - two tenants keep independent balances
 *
 * Runs entirely on the default MockRail in metering mode (relaxed fraud) — NO
 * real money moves. Each test file gets a throwaway persist dir so per-tenant
 * `${agentId}.json` files never collide with a developer's real data.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Hermetic, mock-rail, relaxed-fraud config. Must be set BEFORE importing the
// server module because resolveAgentConfig() memoizes on first call.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-mt-"));
process.env.MNEMOPAY_MODE = "quick";
process.env.MNEMOPAY_PAYMENT_RAIL = "mock";
process.env.MNEMOPAY_METERING = "1"; // relax fraud: immediate settle, no velocity block
process.env.MNEMOPAY_PERSIST_DIR = TMP_DIR;
delete process.env.MNEMOPAY_AGENT_ID; // boot agent => default "mcp-agent"

// Import after env is set.
import {
  AgentRegistry,
  agentIdFromArgs,
  executeTool,
  isValidTenantAgentId,
} from "../src/mcp/server.js";
import { MnemoPay } from "../src/index.js";

// A boot agent identical to what createAgent() builds, but with a fixed id so
// the registry's boot-id short-circuit is deterministic.
const bootAgent = MnemoPay.quick("mcp-agent", { paymentRail: undefined });
const registry = new AgentRegistry(bootAgent);

/** Helper mirroring the server's per-request resolution from MCP args. */
function actingAgent(args: Record<string, any>) {
  return registry.resolve(agentIdFromArgs(args));
}

/** Settle every pending charge so it lands in the wallet balance. */
async function chargeAndSettle(args: Record<string, any>, amount: number, reason: string) {
  const ag = actingAgent(args);
  const charged = JSON.parse(await executeTool(ag, "charge", { ...args, amount, reason }));
  await executeTool(ag, "settle", { ...args, txId: charged.txId });
  return charged;
}

async function walletOf(args: Record<string, any>): Promise<number> {
  const ag = actingAgent(args);
  const bal = await executeTool(ag, "balance", args);
  // "Wallet: $X.XX | Reputation: ..."
  const m = bal.match(/Wallet: \$([0-9.]+)/);
  return m ? Number(m[1]) : NaN;
}

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("multi-tenant wallet routing", () => {
  it("validates tenant agent ids (rejects traversal / unsafe chars)", () => {
    expect(isValidTenantAgentId("tenant-a")).toBe(true);
    expect(isValidTenantAgentId("acme.corp_42:eu")).toBe(true);
    expect(isValidTenantAgentId("../etc/passwd")).toBe(false);
    expect(isValidTenantAgentId("a/b")).toBe(false);
    expect(isValidTenantAgentId("a b")).toBe(false);
    expect(isValidTenantAgentId("")).toBe(false);
  });

  it("rejects an invalid / `..`-containing agent id at resolve time", () => {
    expect(() => registry.resolve("../../evil")).toThrow(/Invalid/i);
    expect(() => registry.resolve("a/b/c")).toThrow(/Invalid/i);
  });

  it("extracts the acting agent id only from a non-empty _agentId arg", () => {
    expect(agentIdFromArgs({ _agentId: "tenant-x" })).toBe("tenant-x");
    expect(agentIdFromArgs({ _agentId: "  tenant-y  " })).toBe("tenant-y");
    expect(agentIdFromArgs({ _agentId: "" })).toBeUndefined();
    expect(agentIdFromArgs({})).toBeUndefined();
    expect(agentIdFromArgs(undefined)).toBeUndefined();
  });

  it("returns the boot agent when no identity is supplied", () => {
    expect(registry.resolve(undefined)).toBe(bootAgent);
    expect(registry.resolve("")).toBe(bootAgent);
    expect(registry.resolve("   ")).toBe(bootAgent);
    expect(actingAgent({})).toBe(bootAgent);
    // The boot agent's own id also resolves back to the boot agent.
    expect(registry.resolve("mcp-agent")).toBe(bootAgent);
  });

  it("gives each tenant a distinct, stable, isolated agent instance", () => {
    const a1 = registry.resolve("tenant-a");
    const a2 = registry.resolve("tenant-a");
    const b1 = registry.resolve("tenant-b");
    expect(a1).toBe(a2); // cached per tenant
    expect(a1).not.toBe(b1); // different tenants => different agents
    expect(a1).not.toBe(bootAgent);
    expect((a1 as any).agentId).toBe("tenant-a");
    expect((b1 as any).agentId).toBe("tenant-b");
  });

  it("lands tenant A's charge on A's ledger and NOT on B's", async () => {
    const A = { _agentId: "ledger-a" };
    const B = { _agentId: "ledger-b" };

    await chargeAndSettle(A, 7.5, "A-only service");

    const histA = await executeTool(actingAgent(A), "history", { ...A, limit: 50 });
    const histB = await executeTool(actingAgent(B), "history", { ...B, limit: 50 });

    expect(histA).toContain("A-only service");
    expect(histB).toBe("No transactions yet.");
  });

  it("keeps two tenants' wallet balances independent", async () => {
    const A = { _agentId: "bal-a" };
    const B = { _agentId: "bal-b" };

    await chargeAndSettle(A, 10, "A work");
    await chargeAndSettle(A, 5, "A work 2");
    await chargeAndSettle(B, 3, "B work");

    const balA = await walletOf(A);
    const balB = await walletOf(B);
    // Balances are independent and physically isolated. We assert structure,
    // not exact cents — the MockRail metering path still applies a small
    // platform fee, so A nets slightly under its $15 gross and B under $3.
    // What matters: A's two charges did NOT leak into B and vice-versa.
    expect(balA).toBeGreaterThan(balB); // 2 charges (~$15) > 1 charge (~$3)
    expect(balA).toBeGreaterThan(14); // ~$15 gross, minus a small fee
    expect(balA).toBeLessThanOrEqual(15);
    expect(balB).toBeGreaterThan(2.5); // ~$3 gross
    expect(balB).toBeLessThanOrEqual(3);
    // Boot agent untouched by tenant activity.
    expect(await walletOf({})).toBe(0);
  });

  it("prevents tenant B from recalling tenant A's remembered note", async () => {
    const A = { _agentId: "mem-a" };
    const B = { _agentId: "mem-b" };

    const secret = "A-SECRET: the launch code is hummingbird";
    await executeTool(actingAgent(A), "remember", { ...A, content: secret, importance: 0.9 });

    const recallA = await executeTool(actingAgent(A), "recall", { ...A, query: "launch code", limit: 10 });
    const recallB = await executeTool(actingAgent(B), "recall", { ...B, query: "launch code", limit: 10 });

    expect(recallA).toContain("hummingbird");
    expect(recallB).not.toContain("hummingbird");
  });

  it("routes an invalid _agentId arg to a thrown error (no silent boot fallback)", () => {
    // A present-but-invalid id must NOT silently fall back to boot — that would
    // let a traversal attempt quietly hit the boot wallet.
    expect(() => actingAgent({ _agentId: "../escape" })).toThrow(/Invalid/i);
  });
});
