# Permissions & policy (MnemoGuard)

How MnemoPay classifies agent actions, enforces spend limits, and routes human approvals.

---

## Two layers

1. **Risk taxonomy** (`@mnemopay/sdk/governance/risk`) — default danger tier per action kind + keyword escalation.
2. **Policy engine** (`@mnemopay/sdk/governance/policy`) — your rules: caps, allowlists, rate limits, approval thresholds.

Skills combine both via `policyForSkill()` — declared skill permissions become compiled rules automatically.

---

## Default risk ladder

| Action | Default tier | Examples |
|--------|--------------|----------|
| `llm_call` | Low | Summarize email, draft reply |
| `tool_call` | Medium | Search CRM, list invoices |
| `http_request` | Medium | Fetch vendor page |
| `file_write` | High | Write export, upload attachment |
| `payment` | High | Charge, refund, disburse |

Keyword matches in `target` or `args_text` can escalate to **critical** (wire transfer, sign contract, delete data, close account). See `ESCALATIONS` in `src/governance/risk.ts`.

---

## Policy verdicts

`evaluateAction(compiledPolicy, action)` returns one of:

| Verdict | Meaning |
|---------|---------|
| `{ allowed: true }` | Proceed |
| `{ allowed: false, reason }` | Hard block |
| `{ needs_approval: true, reason }` | Open approval; do not execute until decided |

Evaluation is **sync, no I/O, no LLM** — designed for sub-millisecond hot paths on every tool call.

---

## Example policy

```ts
import { compilePolicy, evaluateAction } from "@mnemopay/sdk/governance/policy";

const policy = compilePolicy({
  id: "invoice-agent",
  version: 1,
  rules: [
    {
      id: "cap-single-payment",
      applies_to: ["payment"],
      hard_cap_usd: 500,
    },
    {
      id: "approve-large-refunds",
      applies_to: ["payment"],
      approval_threshold_usd: 50,
      arg_pattern_blocks: "refund",
    },
    {
      id: "block-contract-sign",
      applies_to: ["tool_call", "file_write"],
      target_pattern: "sign_contract",
      outright_block: true,
    },
  ],
});

const verdict = evaluateAction(policy, {
  kind: "payment",
  target: "stripe",
  estimated_usd: 75,
  args_text: "refund invoice #1042",
});

if ("needs_approval" in verdict) {
  // route to human — see approval store below
}
```

---

## Skill-level permissions

When using MnemoSkills, declare permissions on the skill — they compile into policy rules:

```ts
const permissions = {
  allowed_tools: ["crm.search", "email.draft", "payments.link"],
  disallowed: ["payments.refund", "email.send"],
  spend_limit_usd: 500,
  approval_above_usd: 50,
};
```

| Field | Effect |
|-------|--------|
| `allowed_tools` | Deny any `tool_call` / `http_request` not in list |
| `disallowed` | Always block these targets |
| `spend_limit_usd` | Hard cap per action (`hard_cap_usd` rule) |
| `approval_above_usd` | `needs_approval` when `estimated_usd` exceeds threshold |
| `allowed_locales` | Geo allowlist (EU AI Act–friendly deployments) |

Every side-effect must go through `ctx.act()` inside `skill.run()` — see [examples/08-invoice-collector.ts](../examples/08-invoice-collector.ts).

---

## Human approvals

When policy returns `needs_approval`, `routeVerdict()` opens a request in your `ApprovalStore`:

```ts
import { InMemoryApprovalStore } from "@mnemopay/sdk/governance/approval";

const store = new InMemoryApprovalStore();
// ... runSkill(..., { approvalStore: store })

const pending = store.pending();
const req = store.decide(pending[0].id, "approve", "owner@company.com");
```

Production: swap `InMemoryApprovalStore` for Postgres, Redis, Slack, or pager — interface stays the same.

---

## Operational checklist

- Compile policies once at startup; reuse `CompiledPolicy` on the hot path
- Set `estimated_usd` honestly on every `act()` — caps and approvals depend on it
- Never grant `payment` or `file_write` without passing through `evaluateAction`
- Log `matched_rule` on blocks for operator debugging
- Export Article 12 bundles from the underlying `AuditChain` for regulated deployments — [AUDIT-BUNDLES.md](./AUDIT-BUNDLES.md)

---

## See also

- [action-ledger.md](./action-ledger.md) — provable record of what the agent did
- [architecture.md](./architecture.md) — full stack diagram
- [FISCALGATE.md](./FISCALGATE.md) — budget holds and charter scope
