# RECALL — the memory primitive

MnemoPay's `recall` surface is the agent-side equivalent of a query layer on top of vector + scalar memory. Three things make it different from "RAG on a Pinecone index":

1. **Compounding scores.** Memories have an `importance` × `recency` × `frequency` score that gets adjusted automatically as the agent references them. Useful memories drift up. Stale ones decay.
2. **Reinforcement loop.** `rlFeedback(ids, reward)` lets the agent signal *which* recalled memories were actually useful — that adjusts the score so the next recall returns better candidates.
3. **DID-signed anchors.** Optional. Every `remember()` can mint a portable, signed receipt (a `MemoryAnchor`) so the memory is verifiable by any third party without trusting MnemoPay.

This page covers all three.

---

## remember()

```ts
import MnemoPay from "@mnemopay/sdk";

const agent = MnemoPay.quick("agent-1");

// Simple
const id = await agent.remember("User prefers monthly billing");

// With metadata
await agent.remember("User churned on $99 tier", {
  importance: 0.9,           // 0-1, higher = surfaces more often
  factType: "experience",    // "world" | "experience" | "opinion" | "observation"
  tags: ["billing", "churn"],
  entityIds: ["user:42"],
});

// Opinion (drives confidence updates when reinforced)
await agent.remember("Stripe is the best rail for SaaS", {
  factType: "opinion",
  confidence: 0.75,
});
```

| `factType`    | When to use                                                                 |
| ------------- | --------------------------------------------------------------------------- |
| `world`       | Objective facts. Default. ("Paris is in France.")                           |
| `experience`  | First-person events. ("Agent paid $49 for Pro last Tuesday.")               |
| `opinion`     | Subjective stances. Drives confidence reinforcement on overlap.             |
| `observation` | Agent-generated summaries. Emitted by the observation pipeline, not callers.|

### Receipt mode

For audit-grade workflows, ask `remember()` for the receipt instead of just the id:

```ts
const { id, anchor } = await agent.remember("Charged $25 for May invoice", {
  returnReceipt: true,
});

if (anchor) {
  // anchor.proofValue is a base58btc Multibase Ed25519 signature
  // anchor.payload is the canonical JSON that was signed
  console.log(anchor.signerDid); // "did:mp:..."
}
```

`anchor` is only minted when the instance has anchoring enabled (`agent.enableAnchoring(wallet)`) or when `opts.anchor === true` is passed and a wallet is attached.

---

## recall()

```ts
// Top-K by score (no query)
const latest = await agent.recall(5);

// Semantic search
const billing = await agent.recall("billing preferences", 5);

// Format for the Anthropic 1-hour prompt cache (single call)
const cacheBlock = await agent.recall("user context", 10, {
  formatForClaudeCache: true,
});
// → { type: "text", text: "...", cache_control: { type: "ephemeral", ttl: 3600 } }
```

`Memory` returned by `recall()`:

```ts
interface Memory {
  id: string;
  content: string;
  importance: number;       // 0-1
  score: number;            // ranked score at recall time
  createdAt: Date;
  lastAccessed: Date;
  accessCount: number;
  tags: string[];
  factType?: "world" | "experience" | "opinion" | "observation";
  confidence?: number;      // opinions only
  entityIds?: string[];
  anchor?: MemoryAnchor;    // present iff anchoring was on at write time
}
```

---

## Reinforcement (the part most teams skip)

After the agent acts on recalled memories, tell MnemoPay which ones were useful. This is the loop that compounds:

```ts
const memories = await agent.recall("billing", 5);
const answer = await yourLLM({ memories });
const usefulIds = memories.filter(m => answer.cited(m.id)).map(m => m.id);

// +1 = useful, -1 = misleading. EWMA-weighted update on importance.
await agent.rlFeedback(usefulIds, +1.0);
```

Forgetting (when an old memory contradicts a new one):

```ts
await agent.forget(oldMemoryId);
```

Consolidation (auto-prune low-importance memories at scale):

```ts
const pruned = await agent.consolidate();
console.log(pruned.removed, pruned.kept);
```

---

## Hosted vs local

Two ways to talk to the recall surface:

| Mode    | Class                                  | Storage             | Identity                |
| ------- | -------------------------------------- | ------------------- | ----------------------- |
| Local   | `MnemoPay.quick(id)` → `MnemoPayLite`  | In-memory or SQLite | Optional `did:mp:…`     |
| Hosted  | `new MnemoPayClient({ baseUrl, token })` | Postgres / pgvector | Server-issued, signed   |

Local mode is the fastest path for prototyping and dogfooding. Hosted mode is what you want when memories must be portable across processes or verifiable by counter-parties.

```ts
// Hosted
import { MnemoPayClient } from "@mnemopay/sdk/client";
const client = new MnemoPayClient({
  baseUrl: "https://mnemopay-landing.fly.dev",
  token: process.env.MNEMOPAY_TOKEN,
});
await client.remember("User prefers monthly billing");
const memories = await client.recall("billing");
```

---

## Performance

`MnemoPayLite.remember()` end-to-end (including Ed25519 anchor mint) measures p50 **1.0 ms** / p95 **1.7 ms** / p99 **2.5 ms** on an Intel i5-1035G1 dev box — see the [governance latency table in the README](../README.md#governance-latency-sub-second-invariant). The path is intentionally cheap so it can sit inside the LLM's tool-call loop without budget anxiety.

Reproduce: `npm run bench:governance`.
