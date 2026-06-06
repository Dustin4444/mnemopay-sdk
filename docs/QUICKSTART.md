# QUICKSTART — first agent payment in 60 seconds

A working `npm install` → `await agent.charge(...)` flow. No infra required.

---

## 1. Install

```bash
npm install @mnemopay/sdk
```

That's it. No API key, no signup, no infra. The SDK ships with an in-memory store so the first run works offline.

---

## 2. Run the 60-second snippet

```ts
// quickstart.ts
import MnemoPay from "@mnemopay/sdk";

const agent = MnemoPay.quick("hello-agent");

// 1. Store a memory
await agent.remember("User prefers monthly billing");

// 2. Recall it (semantic search across the agent's memory)
const memories = await agent.recall("billing", 5);
console.log(memories.map((m) => m.content));
// → ["User prefers monthly billing"]

// 3. Place a budget hold, then settle
const tx = await agent.charge(25, "Monthly API access");
await agent.settle(tx.id);

// 4. Inspect the agent's profile
const profile = await agent.profile();
console.log({ wallet: profile.wallet, reputation: profile.reputation });
```

```bash
npx tsx quickstart.ts
```

You just ran the full MnemoPay primitive set: memory write, semantic recall, escrow-style charge, settlement. No keys, no money moved — the default `MnemoPay.quick()` agent uses an in-memory payment rail so you can prototype freely.

---

## 3. Talk to the hosted gateway (optional)

When you're ready to issue real receipts that other agents can verify, point the universal client at the public MnemoPay gateway:

```ts
import { MnemoPayClient } from "@mnemopay/sdk/client";

const client = new MnemoPayClient({
  baseUrl: "https://mnemopay-landing.fly.dev",
  token: process.env.MNEMOPAY_TOKEN, // optional for read-only ops
});

await client.remember("User prefers monthly billing");
const memories = await client.recall("billing preferences");
const tx = await client.charge(25, "Monthly access");
await client.settle(tx.txId);
```

The hosted gateway is the same surface you've been calling locally — it just adds a signed audit trail and cross-agent identity (DID `did:mp:…`).

---

## Where to go next

- [`INTEGRATIONS.md`](./INTEGRATIONS.md) — drop into OpenAI / Anthropic / LangGraph / AutoGen with one import.
- [`architecture.md`](./architecture.md) — stack placement and module map.
- [`permissions.md`](./permissions.md) — MnemoGuard policy + approval gates.
- [`action-ledger.md`](./action-ledger.md) — provable agent action records.
- [`../examples/08-invoice-collector.ts`](../examples/08-invoice-collector.ts) — governed skill demo.
- [`RECALL.md`](./RECALL.md) — semantic memory primitive, reinforcement, and the 1-hour Claude cache helper.
- [`FISCALGATE.md`](./FISCALGATE.md) — charter-driven budget enforcement.
- [`AUDIT-BUNDLES.md`](./AUDIT-BUNDLES.md) — EU AI Act Article 12 signed evidence bundles.
- [`SUBPATH-IMPORT-RULE.md`](./SUBPATH-IMPORT-RULE.md) — when to import `@mnemopay/sdk/recall` instead of the package root.

The full SDK surface lives in [`../README.md`](../README.md). Apache 2.0 — production use is fine, attribution required.
