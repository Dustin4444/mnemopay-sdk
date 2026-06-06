# Action ledger (MnemoLedger)

Typed audit records for whole agent actions — intent, tools, memories, approvals, cost, and outcome — backed by a Merkle audit chain.

Import: `@mnemopay/sdk/governance/action-ledger`

---

## Why two audit layers?

| Module | Purpose |
|--------|---------|
| **`AuditChain`** | Low-level event stream — any `kind` + payload, Merkle root for Article 12 |
| **`ActionLedger`** | Opinionated agent-action records — answers “what did the agent do and why?” |

Every `ActionLedger` lifecycle transition emits `action.*` events onto the underlying chain, so the Merkle root still covers the full action.

---

## Action lifecycle

```
planned → executing → completed
                   → failed
                   → blocked
                   → rolled_back
        → awaiting_approval → (approved/rejected) → executing → ...
```

---

## Record shape

Each `AgentActionRecord` includes:

- `intent` — what the user asked for
- `plan` — agent’s stated plan (optional)
- `tools_used`, `memories_used`, `files_accessed`, `sites_visited`
- `approvals` — pending / approved / rejected with `decided_by`
- `cost_usd` — accumulated estimated cost
- `risk` — tier at begin time (optional)
- `rollback` — human note on reversibility
- `result` / `error` — outcome summary

---

## Basic usage

```ts
import { ActionLedger } from "@mnemopay/sdk/governance/action-ledger";

const ledger = new ActionLedger();

const action = ledger.begin({
  agent_id: "invoice-agent",
  intent: "Send payment reminder for ACME #1042",
  plan: "Draft email → generate pay link → queue send",
  risk: "medium",
});

ledger.update(action.id, {
  tools_used: ["crm.search"],
  memories_used: ["mem-acme-late-payer"],
  cost_usd: 0.02,
});

ledger.markExecuting(action.id);
ledger.complete(action.id, "Reminder drafted; send queued for approval");

// Merkle root covers every action.* event
const root = ledger.auditChain().rollMerkleRoot();
console.log({ root, actions: ledger.list("invoice-agent") });
```

---

## Approval integration

```ts
ledger.awaitApproval(action.id, "ap_abc123");
ledger.resolveApproval(action.id, "ap_abc123", "approved", "finance@co");
ledger.markExecuting(action.id);
ledger.complete(action.id, "Refund issued after approval");
```

Status becomes `awaiting_approval` until resolved.

---

## With MnemoSkills

`runSkill()` opens an action automatically and wires `ctx.act()` to update the ledger:

```ts
import { runSkill, type MnemoSkill } from "@mnemopay/sdk/skills";

const result = await runSkill(mySkill, input, { agent_id: "invoice-agent" });

const rec = result.ledger.get(result.action_id);
console.log(rec?.status, rec?.tools_used, rec?.approvals);

if (result.pending_approval_id) {
  // Human must decide before retrying
}
```

---

## Dashboard / export questions

The action ledger is designed to answer:

- What did the agent do?
- Why (intent + plan)?
- What data did it use (memories, files, sites)?
- Who approved it?
- How much did it cost?
- Can we undo it (`rollback` note)?

Export raw events via `ledger.events()` or Article 12 bundles via `ledger.auditChain()`.

---

## API reference

| Method | Description |
|--------|-------------|
| `begin(input)` | Start action in `planned` state |
| `update(id, patch)` | Append tools/memories/sites/cost (deduped) |
| `awaitApproval(id, approval_id)` | Set `awaiting_approval` |
| `resolveApproval(id, approval_id, status, decided_by?)` | Record decision |
| `markExecuting(id)` | Transition to `executing` |
| `complete(id, result?)` | Terminal success |
| `fail(id, error)` | Terminal error |
| `block(id, reason)` | Policy block |
| `rollBack(id, note?)` | Mark rolled back |
| `get(id)` / `list(agentId?)` | Query typed records |
| `auditChain()` | Underlying Merkle chain |
| `events()` | Raw `action.*` chain events |

---

## See also

- [permissions.md](./permissions.md) — policy and approval routing
- [AUDIT-BUNDLES.md](./AUDIT-BUNDLES.md) — EU AI Act export
- [examples/08-invoice-collector.ts](../examples/08-invoice-collector.ts) — end-to-end skill + ledger
