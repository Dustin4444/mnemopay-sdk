/**
 * Example 12 — Swarm catalog demo
 *
 * catalog → Swarm (mock provider) → audit JSONL → ledger receipt
 *
 * Run:
 *   npx tsx examples/12-swarm-catalog-demo.ts
 *
 * Or via CLI:
 *   npx @mnemopay/swarm demo
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MnemoPay } from "../src/index.js";
import { AuditChain } from "../src/governance/audit-chain.js";
import { Swarm, type BrowserProvider } from "../src/swarm/index.js";

const CATALOG_URL =
  process.env.MNEMOPAY_CATALOG_URL ?? "https://mcp.mnemopay.com/api/v1/skills";

interface CatalogSkill {
  id: string;
  name: string;
  description: string;
  verified: boolean;
  status: string;
  example?: { prompt: string; swarm_strategy: string };
}

function mockProvider(): BrowserProvider {
  let n = 0;
  return {
    name: "mock",
    async open(opts) {
      n += 1;
      return {
        session_id: `mock-${n}`,
        did: opts.did,
        provider: "mock",
        opened_at: new Date().toISOString(),
        budget_usd: opts.budget_usd,
      };
    },
    async perform(_sessionId, action) {
      return {
        ok: true,
        note: `mock:${action.target}:${String(action.value ?? "").slice(0, 60)}`,
      };
    },
    async close() {},
  };
}

async function loadCatalog(): Promise<CatalogSkill[]> {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error(`catalog ${res.status}`);
  const data = (await res.json()) as { skills: CatalogSkill[] };
  return data.skills ?? [];
}

async function main() {
  const auditPath = resolve("./.mnemopay/swarm-demo.jsonl");
  mkdirSync(dirname(auditPath), { recursive: true });

  console.log("1. Fetch skill catalog…");
  const catalog = await loadCatalog();
  const picks =
    catalog.filter((s) => s.verified || s.status === "partner").slice(0, 3) ||
    catalog.slice(0, 2);
  console.log(`   ${catalog.length} skills, running ${picks.length} tasks`);

  const tasks = picks.map((s) => ({
    id: s.id.replace(/\//g, "-"),
    skillId: s.id,
    prompt: s.example?.prompt ?? s.description,
    budget: 0.05,
  }));

  console.log("2. Spawn Swarm…");
  const chain = new AuditChain({ path: auditPath });
  const audit = {
    append(ev: Record<string, unknown>) {
      const kind = typeof ev.kind === "string" ? ev.kind : "swarm.event";
      return chain.emit(kind, ev);
    },
  };
  const swarm = new Swarm({
    size: Math.min(3, tasks.length),
    provider: mockProvider(),
    did: "did:mp:swarm-demo",
    budget: { perAgent: 0.1, total: 0.25 },
    audit: { chain: audit },
  });

  const run = await swarm.spawn(tasks);
  const results = await swarm.gather(run);
  const merged = await swarm.recombine(results, "merge-json");

  console.log("3. Audit JSONL written →", auditPath);
  console.log("   Merkle root:", chain.rollMerkleRoot());

  const ok = results.filter((r) => r.ok).length;
  const spend = results.reduce((s, r) => s + r.spend, 0);

  console.log("4. Ledger receipt…");
  const agent = MnemoPay.quick("swarm-demo-agent", {
    fraud: { settlementHoldMinutes: 0 },
  });
  const tx = await agent.charge(
    Math.max(0.01, spend || 0.01),
    `swarm demo ${run.id} (${ok}/${results.length} ok)`,
  );
  await agent.settle(tx.id);

  console.log("\nDone.");
  console.log({ runId: run.id, receiptId: tx.id, ok, merged, auditPath });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});