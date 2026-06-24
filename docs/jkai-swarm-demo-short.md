# JKAI Short — MnemoPay Swarm Demo (60s)

**Title:** I shipped browse.sh's missing layer
**Channel:** JKAI (@atalldarkman)
**Length:** 55–65 seconds
**Publish:** After `@mnemopay/swarm` is on npm

---

## Hook (0–3s)

On-screen text: `4 agents. 1 budget. 1 audit trail.`
VO: "Browserbase shipped parallel browsers. Nobody shipped who pays, who gets blamed, and what got logged."

## Problem (3–12s)

Split screen: browse.sh / Browserbase homepage vs terminal error `budget exceeded — no audit id`
VO: "Swarms without economics are just expensive chaos."

## Demo (12–45s)

Terminal recording (pre-captured, sped 1.2x):

```bash
npx @mnemopay/swarm list --verified
npx @mnemopay/swarm demo
```

Cut to:
- `.mnemopay/swarm-demo.jsonl` tail (3 lines, redact paths)
- Receipt line: `settled tx swarm-demo-…`

On-screen callouts (pop sequentially):
1. `FiscalGate precheck`
2. `swarm.task → JSONL`
3. `ledger receipt`

VO: "Catalog, spawn four tasks, merge JSON, append every action to a Merkle audit chain, settle on the same ledger Stripe and Paystack already use."

## CTA (45–60s)

On-screen: `npx @mnemopay/swarm demo`
VO: "Open source. Apache 2. Link in description."
End card: mnemopay.com · github.com/mnemopay

---

## Description block

```
MnemoPay Swarm — budget-gated parallel agents with audit + ledger.
npx @mnemopay/swarm demo

SDK: https://github.com/mnemopay/mnemopay-sdk
Catalog: https://mcp.mnemopay.com/skills
```

## Tags

mnemopay, ai agents, mcp, browser automation, agent payments, swarm