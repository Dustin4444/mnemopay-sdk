# Architecture

How `@mnemopay/sdk` is layered — and where each module sits relative to your agent runtime and payment rails.

---

## Stack placement

```
┌─────────────────────────────────────────────────────────────┐
│  Your app / agent runtime                                    │
│  LangChain · CrewAI · Claude Agent SDK · custom loop         │
└────────────────────────────┬────────────────────────────────┘
                             │ tool calls, charges, memory I/O
┌────────────────────────────▼────────────────────────────────┐
│  MnemoPay SDK                                                │
│  Governance · Memory · Payments · Identity · Skills          │
├─────────────────────────────────────────────────────────────┤
│  MnemoSkills (runSkill)                                      │
│  governed side-effects → policy → approval → action ledger   │
├──────────┬──────────┬───────────┬───────────────────────────┤
│  Recall  │ Payments │ Identity  │  Reputation + behavioral  │
│  memory  │ FiscalGate│ KYA/DID  │  scoring + anomaly        │
├──────────┴──────────┴───────────┴───────────────────────────┤
│  Governance                                                  │
│  policy · risk · approval · audit-chain · action-ledger      │
│  charter · Article 12 export                                 │
├─────────────────────────────────────────────────────────────┤
│  Ledger + Merkle integrity                                   │
├─────────────────────────────────────────────────────────────┤
│  Rails (PaymentRail interface)                               │
│  Stripe · Paystack · Lightning · StripeMPP · x402 · AP2      │
└────────────────────────────┬────────────────────────────────┘
                             │ actual money movement
┌────────────────────────────▼────────────────────────────────┐
│  Third-party payment networks / facilitators                 │
└─────────────────────────────────────────────────────────────┘
```

MnemoPay **does not** replace Stripe, Paystack, or Lightning. It governs how agents use memory, money, and tools **across** those systems.

---

## Module map

| Concern | Import | Responsibility |
|---------|--------|----------------|
| Quick agent | `@mnemopay/sdk` | `MnemoPay.quick()` — in-memory dev agent |
| Memory | `@mnemopay/sdk/recall` | remember, recall, reinforce, forget |
| Policy | `@mnemopay/sdk/governance/policy` | `compilePolicy`, `evaluateAction` |
| Risk presets | `@mnemopay/sdk/governance/risk` | `classifyRisk`, `buildRiskPolicy` |
| Approvals | `@mnemopay/sdk/governance/approval` | HITL queue, `routeVerdict` |
| Audit chain | `@mnemopay/sdk/governance/audit-chain` | Merkle event stream, Article 12 export |
| Action ledger | `@mnemopay/sdk/governance/action-ledger` | Typed “what did the agent do?” records |
| Skills | `@mnemopay/sdk/skills` | `runSkill`, governed capability runner |
| Rails | `@mnemopay/sdk/rails` | Swappable `PaymentRail` implementations |
| Hosted client | `@mnemopay/sdk/client` | Gateway API with signed audit trail |
| MCP | `@mnemopay/sdk/mcp` | MnemoPay tools for MCP hosts |

Stability tier per module: [README § Module stability](../README.md#module-stability).

---

## Governance data flow

Every side-effect a skill performs should pass through this path:

```
Skill.run(ctx)
    → ctx.act({ kind, target, estimated_usd, ... })
        → classifyRisk(action)
        → evaluateAction(compiledPolicy, action)
        → routeVerdict(approvalStore, action, verdict)
            → allowed: mark executing, proceed
            → needs_approval: awaitApproval on ActionLedger
            → blocked: block action on ActionLedger
    → ActionLedger events → AuditChain → Merkle root
```

See [permissions.md](./permissions.md) and [action-ledger.md](./action-ledger.md).

---

## Trust boundaries

| Layer | Trust assumption |
|-------|------------------|
| **Policy engine** | Rules are compiled correctly; evaluation is synchronous and deterministic |
| **Runtime / host app** | The runtime does not bypass `ctx.act()` or forge ledger entries |
| **Rails** | Stripe/Paystack/etc. settle funds; MnemoPay records holds and receipts |
| **Operator** | Humans resolve `needs_approval` via your approval store (Slack, dashboard, etc.) |

MnemoPay produces **evidence** (Merkle chain, action ledger, Article 12 bundles). It cannot prevent a malicious runtime from lying — it makes misbehavior **detectable** after the fact.

---

## Subpath imports

Prefer subpaths when you only need one surface (smaller bundles, clearer boundaries):

```ts
import { evaluateAction, compilePolicy } from "@mnemopay/sdk/governance/policy";
import { ActionLedger } from "@mnemopay/sdk/governance/action-ledger";
import { runSkill } from "@mnemopay/sdk/skills";
import { StripeRail } from "@mnemopay/sdk/rails";
```

Full rule: [SUBPATH-IMPORT-RULE.md](./SUBPATH-IMPORT-RULE.md).

---

## Related repos

- **`mnemopay-gateway`** — hosted brain API, auth, console backend
- **`mnemopay-dashboard`** — operator UI prototype
- **`mnemopay-site`** — trust hub, docs, marketing

---
