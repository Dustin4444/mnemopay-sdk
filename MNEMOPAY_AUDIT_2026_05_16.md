# MnemoPay Audit — 2026-05-16

Read-only inventory of the MnemoPay surface against the **governed transaction OS
for AI-era commerce** thesis. Praetor is folded in as of 2026-05-16; governance,
charter logic, FiscalGate, Merkle audit and agent-control are native MnemoPay
primitives. Flat product hierarchy — one product, three orientations: ecosystem,
governance, control room.

Brand line: *Stripe moves money. MnemoPay governs how money, agents, and
business workflows move across rails.*

---

## 1) What's done

### SDK (`@mnemopay/sdk` v1.8.1, master)
- **Identity primitive (Phase 1, SHIPPED)** — Ed25519 `Wallet` (`identity/`),
  DID issuance, signature verification. Engine-side anchor auto-wire landed
  in 1.8.1 commit `5e9952a` (most recent) / anchor primitive itself in 1.8.0.
- **Recall** — pluggable engine (`recall/engine.ts`): score / vector / hybrid;
  local FNV-1a + bigram + trigram fallback embedder, OpenAI provider, BGE
  (`Xenova/bge-small-en-v1.5`) provider; FTS5 candidate preselection;
  observation-hoisting (Hindsight pattern); SQLite + Neon + Memory persistence
  adapters; HyDE rewrite, rerank, entity graph, summarizer.
- **Recall anchor primitive (`recall/anchor.ts`)** — content-hash + DID
  signature + monotonic sequence + 128-bit nonce + TTL + optional GridStamp
  envelope passthrough + `rollAnchorRoot()` Merkle batcher. `enableAnchoring()`
  on `MnemoPayLite` auto-mints on the `remember()` write path. **Tests: 22
  specs in `tests/anchor.test.ts` all green.**
- **Governance (native MnemoPay)** — `governance/audit.ts` (MerkleAudit
  chain), `audit-chain.ts`, `approval.ts` + `approval-queue.ts` (human-in-loop
  gates), `article12.ts` (EU AI Act Article 12 bundles), `charter.ts`,
  `policy.ts` + `policy-lint.ts`, `rate-counter.ts`, `runtime.ts`, `spatial.ts`
  (GridStamp spatial-evidence verifier + attach).
- **FiscalGate (budget gate)** — folded in via governance/policy + middleware
  shims. Live in `mnemopay-code` and `mnemopay-browser` scaffolds.
- **Commerce** — `commerce.ts` + `commerce/checkout/`, escrow/holds across
  rails, autonomous shopping primitives.
- **Rails** — Stripe, Paystack, Lightning, Google AP2, Mock; auto-detect via
  env vars.
- **Storage** — `storage/sqlite.ts`, approval-queue, webhooks.
- **Middleware** — OpenAI, Anthropic, LangGraph wrappers.
- **MCP server** — 40 tools, subpath-import safe.
- **NPM dist** — Apache-2.0, `@mnemopay/sdk@1.8.1` latest, root-import
  side-effect guard pending (subpath rule documented).

### Live infrastructure
- **`mcp-gateway-api.fly.dev`** (mnemopay-gateway, branch `main`, commit
  `db8e6f0`) — Hono + Supabase, RLS-at-table-creation migration applied,
  listings CRUD + manifest + install-event, 6/6 smoke checks green. Custom
  domain `api.mcp.mnemopay.com` still pending Cloudflare cert.
- **`mnemopay-landing.fly.dev`** (mnemopay-dashboard, branch `master`,
  `925596b`) — Apple SiwA, DELETE /account hardened, /agents/summary,
  /events/stream SSE.
- **`mnemopay.com`** (mnemopay-site, branch `feat/premium-redesign-2026-05-16`,
  `e6905e0`) — static + Vercel serverless, Stripe Buy Button (`00w9AMe27c9pgT6gxtbo409`)
  wired for Pro $49/mo, Stripe webhook live, Maileroo drip live.

### Scaffolds (PRIVATE, week-4 listings CRUD done)
- **`mnemopay-code`** v0.0.1 main `f43d381` — Commander CLI, FiscalGate +
  Merkle audit middleware shims, charter glob matcher. SDK pin: `^1.8.0-alpha.0`.
- **`mnemopay-browser`** v0.0.1 main `2ffbc35` — thin trust+state layer
  over Browserbase/Stagehand/Playwright with DID + FiscalGate + Article 12.
  SDK pin: `^1.8.0-alpha.0`.

### Native-shift checkpoint (3-month sequence)
1. **Identity — DONE** (v1.7.0 → 1.8.1 auto-wire)
2. **Recall + GridStamp anchor — IN PROGRESS** (envelope passthrough done;
   active push to GridStamp = Phase 2, this audit's Job 2)
3. MCP native — gateway live, native-binding work pending
4. Governance sub-second — primitives live, latency budget unmeasured
5. Browser thin — scaffold pinned to alpha SDK
6. Coding regulated-enterprise — scaffold pinned to alpha SDK

### Adjacent shipped surface
- `mnemopay-app` (Expo, EAS init done, SiwA wired, branch `feat/ai-integration-2026-05-16`)
- `mnemopay-mobile-sdk` main `8143d1a` — security hardening + stress harness
- `mnemopay-python` master `4315a60` — v1.0.0 Apache-2.0 cut
- `mnemopay-paperclip-plugin` master `cadf527` — 9 npm vulns closed
- `mnemopay-desktop` master `3a44e3a` — SHIP.md distribution checklist
- `mnemopay-toolkit` / `mnemopay-hermes` / `mnemopay-demo` — adjuncts

---

## 2) What's left

Gaps vs the governed-transaction-OS thesis + the native-shift sequence.

### Phase 2 — Recall + GridStamp anchor (this audit's Job 2)
- No active push of memory hashes into GridStamp's `remoteid` Merkle batch
  or spatial proof chain. Anchors currently *accept* a GridStamp envelope
  but don't *emit* one. Memory itself becomes auditable evidence only when
  the hash reaches a tamper-evident external root.
- No `RecallAnchorAdapter` interface — consumers can't swap GridStamp for
  any other content-addressed receipt store (S3 + KMS, on-chain via Ethereum
  L2, COSE Merkle proofs draft-18).
- Anchors mint inside `remember()` but the receipt isn't surfaced on the
  return value — caller must `getAnchor(id)` after the fact.

### Phase 3 — MCP native
- Gateway runs Hono + Supabase, but listings CRUD is the only writeable
  surface. No native MCP-side governance (FiscalGate enforcement per tool
  call, Article 12 bundle per session) on the gateway. Gateway should be
  the canonical place agents authorize against, not just a discovery layer.
- No registry of installed agents per developer.

### Phase 4 — Governance sub-second
- `governance/policy.ts` + `policy-lint.ts` exist; latency budget is not
  measured end-to-end in CI. Bench harness missing — claim "sub-second
  governance" cannot be cited.
- Approval queue is in-process; no Redis-backed adapter for cross-host.
- Charter system has glob matcher but no schema for inheritance / overrides.

### Phase 5 — Browser thin
- `mnemopay-browser` scaffold pins SDK alpha; not on 1.8.1. No production
  deploy. Browserbase wrapper is unproven end-to-end (no scripted demo).

### Phase 6 — Coding regulated-enterprise
- `mnemopay-code` is shim-only. No real diff governance, no per-repo
  charter, no signed PR audit, no IDE integration. $200-500/seat target
  needs vertical-specific demos (banks / healthcare / defense / fintech /
  insurance) before any pitch.

### Revenue plumbing
- mnemopay.com pricing wired to Pro $49/mo — single SKU. No Growth ($200+)
  or Enterprise ($500+/seat) tier. No annual prepay discount.
- No /thanks → API key auto-provision drip wired to Maileroo (per ROADMAP
  item #6 from 2026-05-09).
- No conversion-event analytics on /pricing (no UTM-to-checkout funnel).
- No public case study citing real numbers (one comp customer: Jorge
  Freeman, ends 2026-06-07).
- Gateway has no metered billing path — every install-event is a free
  signal but produces no revenue.

### Cross-cutting
- Root-import side-effect guard for `dist/mcp/server.js` (`if (require.main
  === module)` wrap) — promised next release.
- SDK pin alignment: `mnemopay-code` and `mnemopay-browser` still on
  `^1.8.0-alpha.0`. Re-pin to 1.8.1 stable for any production deploy.
- Custom domain `api.mcp.mnemopay.com` Cloudflare cert pending.
- No public proof of governance + audit working end-to-end on a real
  payment. Article 12 bundles exist as code, not as a downloadable
  artifact tied to a real transaction.

---

## 3) Recommendation — next 2 weeks, by leverage

Ordered so each item compounds the next, and revenue-shaped work lands first.

### Week 1
1. **(today, in this run) Phase 2 — `RecallAnchor` adapter + GridStamp push
   path.** Pure-module adapter interface, GridStamp implementation, 5 vitest
   specs. Branch `feat/recall-anchor-phase2`. No version bump, no publish.
   Unlocks: "memory itself is auditable evidence" — strongest concrete claim
   we can put on the governed-transaction-OS page.
2. **Revenue plumbing batch (ROADMAP #6).** Wire `/thanks` → auto-provision
   API key → Maileroo onboarding drip. 2 hr. Direct revenue lever per
   2026-05-08 hard directive. **Jorge Freeman comp ends 2026-06-07**; this
   needs to be live before the Growth tier conversion conversation.
3. **Add Growth tier ($200/mo) + annual prepay discount** to mnemopay.com
   /pricing. 1 hr. Lifts ARPU ceiling without new feature work.
4. **SDK 1.8.2 patch** — root-import guard + re-pin `mnemopay-code` and
   `mnemopay-browser` to 1.8.1 stable (after Phase 2 lands). Don't bump
   for the anchor adapter alone; bundle with the guard fix.

### Week 2
5. **Public Article 12 demo bundle.** Generate one signed audit bundle
   from a real Stripe transaction on a sandbox account, host the bundle
   + verify-script at `mnemopay.com/proof/article12-demo`. Single strongest
   piece of marketing the governance pillar can produce. Cite from
   /pricing.
6. **Phase 4 latency bench in CI.** Add `vitest.bench` for the policy
   eval + Merkle append hot paths. Publish p50/p95/p99 in the SDK README
   so "sub-second governance" stops being a marketing claim and becomes a
   tested invariant. Blocks Phase 6 sales conversations.
7. **Gateway: per-tool FiscalGate enforcement.** Wire SDK governance into
   the gateway's tool-invoke path. Charge-per-call billing rail becomes
   feasible. Folds Phases 3 + 4 together.

### Sequenced after (if time): Phase 5 + 6 production deploys
Browser + code are alpha scaffolds — without an Article 12 demo + latency
proof, no regulated-enterprise buyer will take a meeting. Land the proofs
first; then sell.

---

*Audit complete. See `feat/recall-anchor-phase2` branch for Job 2 starting
deliverable.*
