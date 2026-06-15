/**
 * Tenant provisioning tests — the self-serve buy-path's authn layer.
 *
 * Covers the TenantKeyStore that backs the guarded `/tenant/provision` route:
 *   - mint returns a working mp_test_/mp_live_ key bound to a tenant agent id
 *   - lookup(key) authenticates AND resolves the tenant (the key is enough)
 *   - mint is IDEMPOTENT per agent id (webhook retries don't fork a 2nd key)
 *   - revoked keys stop authenticating
 *   - raw keys are NEVER stored (only salted SHA-256 hashes)
 *   - the store persists to disk and survives a reload
 *   - a minted key, routed through the registry, charges the RIGHT wallet and
 *     produces a real receipt (the closed loop, on the MockRail)
 *
 * Runs on the default MockRail in metering mode — NO real money moves.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-prov-"));
process.env.MNEMOPAY_MODE = "quick";
process.env.MNEMOPAY_PAYMENT_RAIL = "mock";
process.env.MNEMOPAY_METERING = "1";
process.env.MNEMOPAY_PERSIST_DIR = TMP_DIR;
delete process.env.MNEMOPAY_AGENT_ID;

import {
  AgentRegistry,
  TenantKeyStore,
  executeTool,
} from "../src/mcp/server.js";
import { MnemoPay } from "../src/index.js";

afterAll(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe("TenantKeyStore", () => {
  it("mints a working test-mode key bound to a tenant agent id", () => {
    const store = new TenantKeyStore(null); // in-memory
    const r = store.mint({ agentId: "tnt_starter_abcdef0123", plan: "starter", email: "a@b.co", mode: "test" });
    expect(r.created).toBe(true);
    expect(r.agentId).toBe("tnt_starter_abcdef0123");
    expect(r.apiKey).toMatch(/^mp_test_[a-f0-9]{64}$/);
    expect(store.size()).toBe(1);
  });

  it("mints a live-mode key with the mp_live_ prefix", () => {
    const store = new TenantKeyStore(null);
    const r = store.mint({ agentId: "tnt_pro_999", mode: "live" });
    expect(r.apiKey).toMatch(/^mp_live_[a-f0-9]{64}$/);
  });

  it("lookup authenticates a key and resolves its tenant", () => {
    const store = new TenantKeyStore(null);
    const { apiKey, agentId } = store.mint({ agentId: "tnt_x_1", mode: "test" });
    const rec = store.lookup(apiKey!);
    expect(rec).not.toBeNull();
    expect(rec!.agentId).toBe(agentId);
  });

  it("misses on an unknown / empty key", () => {
    const store = new TenantKeyStore(null);
    store.mint({ agentId: "tnt_x_2", mode: "test" });
    expect(store.lookup("mp_test_deadbeef")).toBeNull();
    expect(store.lookup("")).toBeNull();
  });

  it("is idempotent per agent id (webhook retries reuse the same tenant key)", () => {
    const store = new TenantKeyStore(null);
    const first = store.mint({ agentId: "tnt_idem_1", plan: "starter", mode: "test" });
    const second = store.mint({ agentId: "tnt_idem_1", plan: "starter", mode: "test" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.apiKey).toBeNull(); // raw key only knowable at first mint
    expect(store.size()).toBe(1); // no second key forked
    // The original key still authenticates.
    expect(store.lookup(first.apiKey!)!.agentId).toBe("tnt_idem_1");
  });

  it("rejects an invalid / traversal agent id at mint time", () => {
    const store = new TenantKeyStore(null);
    expect(() => store.mint({ agentId: "../escape", mode: "test" })).toThrow(/Invalid/i);
    expect(() => store.mint({ agentId: "a/b", mode: "test" })).toThrow(/Invalid/i);
  });

  it("stops authenticating a revoked key", () => {
    const store = new TenantKeyStore(null);
    const { apiKey } = store.mint({ agentId: "tnt_rev_1", mode: "test" });
    expect(store.lookup(apiKey!)).not.toBeNull();
    const n = store.revokeAgent("tnt_rev_1");
    expect(n).toBe(1);
    expect(store.lookup(apiKey!)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("never stores the raw key on disk — only a salted hash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-prov-disk-"));
    try {
      const store = new TenantKeyStore(dir);
      const { apiKey } = store.mint({ agentId: "tnt_disk_1", plan: "pro", mode: "live" });
      const raw = fs.readFileSync(path.join(dir, "tenant-keys.json"), "utf8");
      expect(raw).not.toContain(apiKey!); // raw key absent
      expect(raw).toContain("keyHash");
      expect(raw).toContain("salt");
      expect(raw).toContain("tnt_disk_1");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists keys across a reload (restart-safe)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-prov-reload-"));
    try {
      const store1 = new TenantKeyStore(dir);
      const { apiKey } = store1.mint({ agentId: "tnt_persist_1", mode: "test" });
      // Fresh instance reads the same file.
      const store2 = new TenantKeyStore(dir);
      const rec = store2.lookup(apiKey!);
      expect(rec).not.toBeNull();
      expect(rec!.agentId).toBe("tnt_persist_1");
      // And the reloaded store still refuses to fork a 2nd key for that tenant.
      expect(store2.mint({ agentId: "tnt_persist_1", mode: "test" }).created).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("provisioned key → real receipt (closed loop, MockRail)", () => {
  it("a minted key, routed by its pinned agent id, charges its OWN wallet", async () => {
    const store = new TenantKeyStore(null);
    const bootAgent = MnemoPay.quick("mcp-agent", { paymentRail: undefined });
    const registry = new AgentRegistry(bootAgent);

    // Provision two tenants exactly as /tenant/provision does.
    const t1 = store.mint({ agentId: "loop-tenant-a", plan: "starter", mode: "test" });
    const t2 = store.mint({ agentId: "loop-tenant-b", plan: "starter", mode: "test" });

    // Simulate the /api/charge auth path: lookup pins the agent id from the key.
    const rec1 = store.lookup(t1.apiKey!);
    expect(rec1!.agentId).toBe("loop-tenant-a");
    const agent1 = registry.resolve(rec1!.agentId);

    // First charge yields a real receipt (txId) on tenant A's ledger.
    const charged = JSON.parse(await executeTool(agent1, "charge", { amount: 0.49, reason: "first charge" }));
    expect(charged.txId).toBeTruthy();
    expect(charged.amount).toBeCloseTo(0.49, 5);
    await executeTool(agent1, "settle", { txId: charged.txId });

    // Tenant B (different minted key) sees NONE of A's activity.
    const rec2 = store.lookup(t2.apiKey!);
    const agent2 = registry.resolve(rec2!.agentId);
    const histA = await executeTool(agent1, "history", { limit: 50 });
    const histB = await executeTool(agent2, "history", { limit: 50 });
    expect(histA).toContain("first charge");
    expect(histB).toBe("No transactions yet.");
  });
});
