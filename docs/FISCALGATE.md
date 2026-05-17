# FISCALGATE — charter-driven budget enforcement

FiscalGate is the budget-side governance primitive. Every charter run **reserves the full budget up-front**, executes the agent loop, and only **settles the actual spend** at the end. Over-budget runs return `status: "halted"` with the budget released; errors return `status: "error"` with the budget released. Nothing leaks.

This is the layer above any payment rail — Stripe, Lightning, AP2 — that prevents an agent from spending past its declared cap, no matter how confused or compromised the model loop becomes.

---

## Charter — declarative scope

A charter is a JSON document. It declares the mission's goal, allowed tools, agents, and **budget cap**. FiscalGate refuses to run a mission whose charter doesn't validate.

```ts
import { validateCharter, type Charter } from "@mnemopay/sdk/governance";

const charter: Charter = {
  name: "weekly-research-digest",
  goal: "Summarize the week's AI agent news into a Slack-ready brief.",
  budget: {
    maxUsd: 5.00,             // hard ceiling
    approvalThresholdUsd: 2.00,
    perToolMaxUsd: 1.00,      // optional: per-tool sub-cap
  },
  agents: [
    { role: "research", model: "claude-sonnet-4-7" },
    { role: "developer", model: "gpt-4o" },
  ],
  outputs: ["digest.md"],
  compliance: {
    article12: true,                          // turn on Article 12 logging
    auditLogPath: "./audit/weekly-digest",
  },
};

const validated = validateCharter(charter); // throws on bad shape
```

Required fields: `name`, `goal`, `budget.maxUsd`, non-empty `agents[]`, `outputs[]`. Everything else is optional.

---

## runMission — the FiscalGate primitive

```ts
import { runMission, MerkleAudit } from "@mnemopay/sdk/governance";

const audit = new MerkleAudit();

const result = await runMission({
  charter: validated,
  payments: {
    // Reserve a $5 hold on whatever rail is wired.
    reserve: async (usd) => ({ holdId: await rail.createHold(usd) }),
    settle:  async (holdId, usd) => rail.capture(holdId, usd),
    release: async (holdId) => rail.release(holdId),
  },
  agents: {
    run: async (c, signal) => {
      // ... your agent loop. Return cumulative spend + outputs.
      const { spent, outputs } = await yourAgentLoop(c, signal);
      return { outputs, spentUsd: spent };
    },
  },
  audit: {
    record:   (event, data) => audit.record(event, data),
    finalize: () => audit.finalize(),
  },
});

console.log(result.status);     // "ok" | "halted" | "error"
console.log(result.spentUsd);   // actual settled spend
console.log(result.outputs);    // string[]
console.log(result.auditDigest); // Merkle root over the run's audit chain
```

What happens on each status:

| `status`  | Hold action | When                                            |
| --------- | ----------- | ----------------------------------------------- |
| `ok`      | `settle()`  | Agent finished within budget                    |
| `halted`  | `release()` | Agent's `spentUsd` exceeded `budget.maxUsd`     |
| `error`   | `release()` | Agent loop threw                                |

No matter the path, the hold is resolved — no leaked reservations. The Merkle audit chain records `mission.start`, `budget.reserved`, `mission.complete` or `budget.exceeded` or `mission.error`, plus whatever events your agent loop emits via `audit.record(...)`.

---

## Common patterns

### Per-tool sub-cap

```ts
const charter: Charter = {
  // …
  budget: {
    maxUsd: 10.00,
    approvalThresholdUsd: 5.00,
    perToolMaxUsd: 1.00,   // no single tool call > $1
  },
};
```

Enforce in your `agents.run` implementation by checking `policy.evaluateAction({ tool, amountUsd })` before each tool call — see [`src/governance/policy.ts`](../src/governance/policy.ts).

### Pre-flight policy evaluation (sub-millisecond)

```ts
import { evaluateAction, defaultEuAiActPolicy, compilePolicy } from "@mnemopay/sdk/governance";

const compiled = compilePolicy(defaultEuAiActPolicy());

const verdict = evaluateAction(compiled, {
  agentId: "agent-1",
  tool: "stripe.charge",
  amountUsd: 25,
  recipient: "acct_user42",
});
// verdict.allow: boolean
// verdict.reason: string
// verdict.requiresApproval: boolean
```

Benchmarked p50 **2.1 µs** / p95 **2.8 µs** / p99 **5.0 µs** — two orders of magnitude inside one millisecond. See [governance latency in the README](../README.md#governance-latency-sub-second-invariant).

### Approval routing

When `verdict.requiresApproval === true`, route the request to a human-in-the-loop store:

```ts
import { InMemoryApprovalStore, routeVerdict } from "@mnemopay/sdk/governance";

const approvals = new InMemoryApprovalStore();
const verdict = routeVerdict(compiled, action, approvals);
if (verdict.status === "pending") {
  // surface to human; resume when approved
}
```

---

## Where FiscalGate sits in the stack

```
[ LLM agent loop ] → calls tools, accrues spend
        ↓
[ FiscalGate runMission ] → reserves $X, runs loop, settles ≤ $X
        ↓
[ PaymentRail (Stripe / Lightning / AP2 / …) ] → moves money
        ↓
[ MerkleAudit chain ] → cryptographic record of every step
        ↓
[ Article 12 bundle ] → regulator-handable archive (see AUDIT-BUNDLES.md)
```

FiscalGate is **rail-agnostic** — the same charter runs against a Stripe rail in prod and a `MockPayments` adapter in tests with no code change.

---

## Related

- [`AUDIT-BUNDLES.md`](./AUDIT-BUNDLES.md) — turn a finished mission's audit chain into an EU AI Act Article 12 evidence bundle.
- [`src/governance/policies/eu-ai-act.ts`](../src/governance/policies/eu-ai-act.ts) — the default EU AI Act policy used by `defaultEuAiActPolicy()`.
- [`MockPayments`](../src/governance/payments.ts) — drop-in `PaymentsAdapter` for tests.
