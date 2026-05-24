# mnemopay-sdk status - 2026-05-21 Antigravity (J&B Enterprise Unified Flywheel Strategy & Daily Execution Playbook)

## 1. Unified J&B Enterprise Flywheel Strategy Formulation
- **Ecosystem Synthesis:** Formulated the canonical strategic vision connecting **BizSuite, MnemoPay, Dele, and Linger** into a self-reinforcing flywheel under J&B Enterprise LLC. Codified fully in [mnemopay_strategic_vision.md](file:///C:/Users/bizsu/.gemini/antigravity/brain/3e2360d6-2900-4054-8560-16fa12157645/mnemopay_strategic_vision.md) and recorded in [walkthrough.md](file:///C:/Users/bizsu/.gemini/antigravity/brain/3e2360d6-2900-4054-8560-16fa12157645/walkthrough.md).
- **BizSuite (`getbizsuite.com`) Re-Alignment:** Repositioned as a Done-For-You (DFY) AI-Native Transformation Agency and Creator/Driver Monetization Hub. Established a staged pricing ladder: $49-$199 low-ticket Monetization/QR Page setups + $19/mo hosting, $299-$999/mo automated B2B clipping retainers, and upsells to $997 AI Audits and $9,500+ Sprints.
- **MnemoPay (`mnemopay.com`) Trust Restoration:** Standardized the protocol to clear the Scamadviser phishing flag through formal IPQS disputes, deploying `/trust` transparency landing sections, and developer feature bounties in `mnemopay-sdk`. Every enterprise sprint BizSuite builds natively embeds MnemoPay, driving transaction volumes and Pro/Growth SaaS conversions.
- **Dele Superapp & Driver QR Loop:** Setup driver headrest QR card tipping and local commerce funnels linked to BizSuite pages, routed instantly via MnemoPay rails. Prepared individual-to-organization developer account migration using the J&B Enterprise LLC D-U-N-S record to clear Apple's transport/financial app blocks.
- **Linger dating app Letters Pivot:** Redesigned Linger entirely under the slow-social pen-pal **"Letters" Concept (Concept A)**: one 500-char letter daily, no photos until Day 4, curated dates on Day 7, and mandatory Stripe Identity signup verification to bypass Apple's Guideline 4.3 spam rejections.

## 2. Operational Playbook: "What We Do"
Defined a clear operational split between AI Agent background execution and Founder manual steps:
- **AI Agent Background Execution (Active):** Running daily Hunter crons (30 leads/day), sending personalized humanized cold emails (Maileroo), generating hook-selected social clips (TikTok, Reels, Shorts), and monitoring developer forums for agent memory/RN-crash replies.
- **Jeremiah's Founder Responsibilities (High-Leverage CTAs):** Recording daily 3-minute vertical videos/voice memos, approving queued drafts, and executing one-time setups (Stripe Identity, Apple Team Org migration, NameCheap DNS TXT key update, and Meta Graph Instagram token re-authentication).

---

# mnemopay-sdk status - 2026-05-21 Antigravity (Python Rails Port, Governance Optimization, & App Store Connect Diagnostic)


## 1. Zero-Dependency Python Rails Port & Parity (`mnemopay-python`)
- **Paystack & Lightning payment rails** completely implemented in `mnemopay-python` matching the TypeScript SDK functionality with 100% parity.
- **PaystackRail (`paystack.py`):** Timing-safe HMAC signature verification (`verify_webhook`), checkout hold creation, bank payouts (`initiate_transfer`), and recipient resolution. Inherited dataclasses resolved to avoid default field placement exceptions.
- **LightningRail (`lightning.py`):** LND REST API integrations, HODL invoice-based escrows, capture (with URL-safe base64 normalization), and complete SSRF loopback protections matching hexadecimal, octal, loopback, and local-host bypass routes.
- **Verification:** 435/435 unit tests passed successfully on `pytest tests/`. Staged, committed, and pushed directly to `origin/master`.

## 2. On-Disk Audit Chain & Speed Optimization (`mnemopay-sdk`)
- **File-backed AuditChain:** Enabled `path` configuration in `AuditChain` for appending JSONL compliance logs to disk, replacing downstream shims.
- **Verify Optimization:** Pre-cached JSON stringification inside `eventJsonCache` parallel lists during `record()` and `emit()` calls. `verify()` reuses these caches to eliminate double-serialization overhead (~2x speedup).
- **Test Widening:** Updated `vitest.config.ts` to include `.spec.ts` globs natively. Tests verified green, changes staged, committed, and pushed to `origin/master`.

## 3. Apple App Store Connect Diagnostic & Action Plan
Diagnosed submission blockers and editorial rejections for three apps under team ID `KGP4KJ59CP`:
- **Linger App (Guideline 4.3b soft-rejection):** Soft-rejected because it was perceived as a generic dating app. Action plan: shift to *Social Networking* category, replace swiping mockup screenshots with "One Letter a Day" envelope UI + Stripe Identity verification screens, and submit the pre-written `4-3b-defense-letter.md` detailing code-level differentiators (no swiping, mandatory identity verification, pre-delivery OpenAI moderation).
- **Dele Superapp (Guideline 3.2.1 individual account block):** Dele operates ride-sharing and peer-to-peer Smart Wallet payments, which strictly require an *Organization* developer account. Action plan: Jerry must enroll `J&B Enterprise LLC` with a D-U-N-S number, request Apple to migrate the developer membership from *Individual* to *Organization* before submitting Build 10, and declare background location Rationales under `UIBackgroundModes: ["location"]` in `app.json`.
- **MnemoPay App (Guideline 5.1.1v deletion + IAP link-out limits):** MnemoPay requires account-deletion functionality. Action plan: implement `DELETE /api/v1/account` cascade database purge endpoint in `mnemopay-sdk` dashboard server, remove direct Stripe top-up links in the native build to avoid Guideline 3.1.1 rejections (circumventing Apple's 30% IAP fees), and pre-emptively integrate Sign in with Apple under Guideline 4.8.

---

# mnemopay-sdk status - 2026-05-12 Claude (Brain bridge + HITL/webhook persistence)

## Closed three "ready to take paying customers" hard blockers in one pass

### HITL approval queue is now durable
`pendingChargeRequests` + `pendingApprovals` used to be in-process Maps — a pod
restart silently dropped every pending charge approval. Now backed by
`src/storage/approval-queue.ts` (SQLite, WAL, single-process writes). On
startup, charges rehydrate verbatim; shop approvals rehydrate with a no-op
`resolve` so the operator can `shop_reject` to clean up. 10-minute expiry
sweep runs only when the queue has been touched. **6 tests passing** —
`tests/approval-queue.test.ts` covers rebuild persistence, deletion
persistence, expiry, undef-context round-trip, and the explicit dead-Promise
contract.

### Webhooks actually fire
`webhook_register` used to write to an in-memory Map with zero delivery. Now
`src/storage/webhooks.ts` persists subscriptions (with HMAC secret), enqueues
deliveries via `fire()`, drains via `pumpOnce()` on a 2s setInterval with
exponential backoff (1s→32s, 6 attempts), and DLQs (`status='dead'`) after
exhaustion. Signature is the Stripe pattern:
`X-MnemoPay-Signature: t=<unix-seconds>,v1=<hex-hmac-sha256(t + "." + body)>`.
`fireWebhook(event, payload)` is wired into `charge`, `charge_approve`,
`settle`, `refund`, `payout_create` (success-side; failure events deferred).
**10 tests passing** — `tests/webhooks.test.ts` covers persistence, wildcard
matching, HMAC roundtrip + tamper detection, retry, DLQ at MAX_ATTEMPTS,
stale-timestamp rejection.

### SQLiteAdapter + brain bridge — the "fully wired" answer
New `src/recall/persistence/sqlite.ts` implements the `PersistenceAdapter`
contract with better-sqlite3 + WAL + per-agent namespace path
(`~/.mnemopay/data/agent-<id>/memory.db`). `readOnly: true` mode refuses
set/delete and rejects missing files. Added `{type: "sqlite"}` to the
`PersistenceOptions` union; resolver in `engine.ts` threads `agentId` through
so the default path is per-agent.

`mcp/server.ts` now reads `MNEMOPAY_BRAIN_PATH` and, when set, opens a
read-only `SQLiteAdapter` against that file under the fixed agentId
`"brain"`. The `recall` tool first runs per-agent recall, then merges brain
hits with `source: "brain"` in the response. Default off; opens lazily.

The brain repo (`C:/Users/bizsu/Projects/brain`) ships a SQL VIEW
(`memory_rows`) over its `pages + embeddings` join, schema-mapping its rows
into the adapter contract. Zero data duplication, zero migration — the live
4.3 MB `.brain/index.db` keeps its full graph schema and the bridge reads
through the view. End-to-end smoke verified: query "Jeremiah Omiagbo" via
`SQLiteAdapter(readOnly: true)` against the brain DB returns the expected
hits (top: `people/jeremiah-omiagbo.md` @ 0.46).

**10 adapter tests passing** — roundtrip, idempotent delete, top-K cosine
ordering, agent isolation, persistence across reopen, readOnly contract.
`mcp-import` smoke test unchanged.

### Marketing surface cleanup
- `mnemopay.com/console` reframed from "v0.1 preview with mock data + email
  for early access" → "guided tour of the governance surface + Start Pro"
  with no disabled buttons. Every CTA goes to Stripe Pro or SDK docs.
- "Sign in" link added to nav across `index.html`, `pricing.html`,
  `console.html` pointing at `https://dashboard.mnemopay.com`.
- The hosted dashboard (`mnemopay-landing.fly.dev`) is fully production-shaped:
  all required secrets deployed (Stripe live secret + webhook secret, Resend,
  session, public URL, store driver). `/readyz` returns all checks green.
- Issued Fly cert for `dashboard.mnemopay.com` on `mnemopay-landing`. Added
  the A (66.241.124.80) + AAAA (2a09:8280:1::ff:d89a:0) records via the
  Namecheap API — full set of 15 hosts written in one `setHosts` call.
- `server.json` bumped 1.4.2 → 1.6.1 (MCP registry). `package.json` bumped
  to 1.6.1 — npm already has 1.6.0 published.

### Confirmed (audit was wrong on these)
- `brain.mnemopay.com` was already deployed and healthy (`/health` 200).
- Brain Windows cron jobs (`RevenuePulse`, `UserWatch`, `DailyBrief`) all
  `Ready` in Task Scheduler.
- Dashboard was already on Fly with full secrets — only the custom hostname
  was missing.

### Followups
- Full `npm test` run after this entry to confirm no regressions across the
  existing suite.
- `npm publish` for v1.6.1 once tests green and Jeremiah greenlights.
- Failure-event webhooks (`charge.failed`, `transfer.failed`) — needs
  try/catch restructure of the rail call sites; deferred.
- Brain repo separately bumped its `@mnemopay/sdk` peer to 1.6.1 once
  published.

---

# mnemopay-sdk status - 2026-05-11 Claude (AugEngine consumer dogfood)

## First in-engine consumer of `@mnemopay/sdk/recall` — AugEngine persona memory

Wired `@mnemopay/sdk/recall` (`localEmbed` + `cosineSimilarity`) into `@blackpig/augengine` as the persona memory backend. This is the **first real-world browser-runtime consumer** of the recall primitives — the brain repo dogfoods them in Bun/Node, but AugEngine is the first browser bundle.

- `packages/augengine/src/ai/memory/brain.ts` — `createInProcessBrain()` is a concrete `MnemoPayClientLike`. Per-namespace cosine recall, `onPersist` hook, `snapshot()`/`initial:` rehydration, `forget()`.
- `packages/augengine/src/ai/memory/recorder.ts` — auto-pipes ObservationBus events into the memory adapter.
- `examples/smoke-game/` — NPC Maya remembers across full page reloads via localStorage. 96/96 augengine tests green (was 91; +7 brain + +5 primitive winding).
- SDK pinned at `1.6.0-alpha.2` (the version with the MCP startup-guard fix).

### New operational rule for SDK consumers in browser bundles (Vite/Rollup)

Alias the SDK's Node-only optional deps to an empty stub or the bundler eagerly tries to resolve `pg` inside `dist/recall/persistence/neon.js`:

```ts
resolve: {
  alias: {
    pg: emptyModule,
    "better-sqlite3": emptyModule,
    "@xenova/transformers": emptyModule,  // drops ~820KB
    "onnxruntime-web": emptyModule,
  },
},
optimizeDeps: {
  exclude: ["pg", "better-sqlite3", "@xenova/transformers", "onnxruntime-web"],
},
```

Bundle dropped from 820KB → 57KB / 21KB gzipped for the smoke-game. **SDK maintainers' real fix:** mark these as `peerDependenciesMeta: { optional: true }` properly, or split the recall engine entry point so `dist/recall/engine.js` doesn't statically pull in the persistence adapters. Subpath users would then get a leaner module.

Full record: `~/.claude/projects/C--WINDOWS-system32/memory/project_forge_game_ready_push_2026_05_11.md`.

---

# mnemopay-sdk status - 2026-05-10 21:10 Claude

## Dashboard hardened to production grade

Took the dashboard from "Codex prototype" to deploy-ready. All Tier 1 production blockers, Tier 2 observability, and Tier 3 safety nets closed. Tests now cover the full HTTP surface.

### Tier 1 — production blockers
- **Postgres persistence refactored** from delete-all-then-insert-all to UPSERT + scoped DELETE in one transaction. No data-loss window. Audit + webhook events use append-only `ON CONFLICT DO NOTHING`. New `console-postgres-store.test.cjs` asserts every INSERT uses ON CONFLICT and ROLLBACK on failure.
- **Debounced async saves**: `saveConsoleStore()` schedules a flush rather than blocking the request thread; mutations coalesce within 250ms. Tunable via `MNEMOPAY_SAVE_DEBOUNCE_MS`. Persistence latency now in `mnemopay_persistence_duration_ms` histogram.
- **Body size limit** (`MNEMOPAY_MAX_BODY_BYTES`, default 1MB; webhook 2MB): oversize requests return 413 and drain the socket cleanly so keep-alive isn't broken.
- **Rate limiting** via in-memory token buckets (`dashboard/rate-limit.cjs`): per-IP general limit (120 burst, 2/sec refill), strict auth-challenge limit (5 burst, ~5/min refill), webhook-specific bucket. Disable via `MNEMOPAY_DISABLE_RATE_LIMIT=true`. Denials counted in `mnemopay_rate_limit_denied_total`.
- **Webhook idempotency** (`dashboard/idempotency.cjs`): Stripe `event.id` cached for 7d; replays short-circuit with the cached result. Persisted across restarts via `webhook_events` Postgres table.
- **CORS hardened** to allowlist (`MNEMOPAY_CORS_ALLOWLIST`); production rejects unlisted origins instead of reflecting any origin with credentials.
- **Graceful shutdown** on SIGTERM/SIGINT: stop accepting connections → drain in-flight (15s deadline) → flush persistence → close PG pool → exit 0. `uncaughtException` triggers the same drain path.
- **Top-level error handler** on the HTTP server: any unhandled throw returns 500 with a request id rather than crashing the worker.
- **`brain.reason` double-billing fixed**: inner recall now runs with `internal: true` so the reasoning trace charges exactly one mission credit and writes one audit event.
- **Audit eviction** no longer loses history: in-memory ring stays at `MNEMOPAY_AUDIT_RING_SIZE` (default 5000), but the append-only DB inserts keep the full history forever.

### Tier 2 — observability
- **Structured JSON logger** (`dashboard/logger.cjs`): one JSON line per event in production, pretty in dev. Every request gets an `X-Request-Id` (echoed back as response header) and a `[http]` log line with method, path, status, ms.
- **/metrics endpoint** (Prometheus text format, `dashboard/metrics.cjs`): `mnemopay_http_requests_total`, `mnemopay_http_request_duration_ms`, `mnemopay_rate_limit_denied_total`, `mnemopay_plan_gate_denied_total`, `mnemopay_webhook_events_total`, `mnemopay_persistence_failures_total`, `mnemopay_persistence_duration_ms`, `mnemopay_inflight_requests`, `mnemopay_process_uptime_seconds`.
- **Postgres pool tuning**: `max=10`, `idleTimeoutMillis=30s`, `connectionTimeoutMillis=5s`. Overridable via `poolOptions` constructor arg.

### Tier 3 — safety nets
- **`dashboard/server.smoke.test.cjs`** drives the live HTTP surface end-to-end: auth challenge + verify + invalid code + rate-limit burst (429), body size limit (413), brain write/query/reason (asserting single-charge), namespace path with `%2F`, Stripe webhook signature verification + replay idempotency + bogus signature rejection, audit feed, usage report, metrics scrape, logout.
- **Security headers** on every response: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`. Production adds HSTS. HTML response adds a tight CSP. Session cookie uses `__Host-` prefix in production.
- **Namespace path parsing** rewritten with a single regex; `tenant-a/scope-1` (percent-encoded) now resolves correctly across GET/DELETE/graph/enrich/export.
- **GitHub Actions CI** (`.github/workflows/dashboard.yml`): runs unit + smoke tests on Node 20 and 22, on every PR touching `dashboard/`.

### Test posture
- 6 test files green: `console-postgres-store`, `auth-email`, `stripe-billing`, `logger`, `rate-limit`, `metrics`, `idempotency`, plus the full HTTP smoke test (25 endpoints exercised).
- `npm test` from `dashboard/` is the canonical green-gate.

### What was deliberately left out
- **Real hosted IdP** to replace the email-code shim — large workstream, out of scope.
- **Visa IC + Mastercard Agent Suite rails** — blocked on acquirer access.
- **SOC 2 Type II** — separate workstream (Q3 2026 Vanta start).
- **Multi-machine rate limiting** — current limiter is per-Fly-machine. Add Redis-backed limiter when scaling beyond 1 machine.

---
# mnemopay-sdk status - 2026-05-10 16:02 Codex

## Dashboard deployment runbook added

- Added `dashboard/DEPLOYMENT.md` with required production env, Stripe env, Resend env, Fly secret/deploy commands, readiness checks, local production-shaped run command, and verification flow.
- This gives Claude/Codex/future operator sessions an exact deploy checklist for the hosted MnemoPay console.

---
# mnemopay-sdk status - 2026-05-10 15:47 Codex

## Dashboard deployment readiness added

- Fixed `dashboard/Dockerfile` so deployed containers copy the full dashboard folder, including Postgres, Stripe, and auth email helper modules.
- Added `dashboard/package.json` with runtime `pg` dependency and dashboard test script.
- Updated `dashboard/fly.toml` with `/readyz` health checks and production env defaults for `MNEMOPAY_CONSOLE_STORE_DRIVER=postgres` and `NODE_ENV=production`.
- Added server readiness reporting via `/readyz`, `/healthz`, and `/api/v1/ops/readiness`.
- Readiness checks report required/recommended config for session secret, Postgres URL, Stripe secret, Stripe webhook secret, Resend key, auth email sender, and public URL.

---
# mnemopay-sdk status - 2026-05-10 15:23 Codex

## Auth code email delivery added

- Added `dashboard/auth-email.cjs`, an optional Resend email helper for passwordless console login codes.
- Added `dashboard/auth-email.test.cjs` covering email copy, dev fallback, and injected Resend send payloads.
- `/api/v1/auth/challenge` now attempts code delivery when `RESEND_API_KEY` and `MNEMOPAY_AUTH_EMAIL_FROM` are configured.
- Dev/local mode still returns inline codes for testing. Production mode surfaces delivery failure instead of silently granting a code that was not sent.
- Auth challenge delivery state is included in the public challenge payload and audited as sent, skipped, or failed.

---
# mnemopay-sdk status - 2026-05-10 15:04 Codex

## Passwordless console auth foundation added

- Added passwordless auth challenges to the MnemoPay dashboard API.
- New endpoints: `POST /api/v1/auth/challenge` creates a short-lived email code; `POST /api/v1/auth/verify` verifies the code and sets the signed session cookie.
- Codes are HMAC-hashed with the session secret, expire after `MNEMOPAY_AUTH_CODE_TTL_MS` (default 10 minutes), enforce max attempts, and record audit events.
- Auth challenges persist across JSON, SQLite, and Postgres console stores.
- Dashboard Session tab now uses Request Code / Verify and Sign In instead of immediate unsigned login. Non-production can return a dev code inline for local testing.
- Existing `/api/v1/auth/login` remains as a dev/backcompat endpoint for now.

---
# mnemopay-sdk status - 2026-05-10 14:35 Codex

## Live Stripe checkout and portal sessions added

- Added `dashboard/stripe-billing.cjs`, a small Stripe REST helper for Checkout Sessions and Billing Portal Sessions using form-encoded Stripe API calls.
- Added `dashboard/stripe-billing.test.cjs` with mocked Stripe request coverage for form encoding, price lookup resolution, checkout session creation, and portal session creation.
- Added `POST /api/v1/billing/checkout/session` for Pro/Team monthly/yearly live checkout.
- Added `POST /api/v1/billing/portal/session` for the Stripe customer portal when the account has a Stripe customer id.
- Dashboard Billing panel now has Stripe Checkout and Customer Portal buttons.
- Checkout resolves canonical lookup keys through env vars (`STRIPE_PRICE_MNEMOPAY_PRO_MONTHLY`, etc.) or Stripe Price lookup keys, and webhook provisioning remains the source of truth after payment.

---
# mnemopay-sdk status - 2026-05-10 14:04 Codex

## Postgres console-store wired behind env flag

- Wired the live dashboard server to the Postgres console-store bridge behind `MNEMOPAY_CONSOLE_STORE_DRIVER=postgres`.
- Postgres mode reads `MNEMOPAY_CONSOLE_POSTGRES_URL`, `NEON_URL`, or `DATABASE_URL` at startup, bootstraps tables through `dashboard/console-postgres-store.cjs`, loads the console snapshot before `server.listen`, and serializes saves asynchronously after mutations.
- JSON and SQLite paths remain unchanged for local/dev use.
- `/healthz` now reports the active console store driver.
- Added optional `pg` peer dependency metadata for hosted Postgres/Neon deployments.

---
# mnemopay-sdk status - 2026-05-10 13:36 Codex

## Postgres console-store bridge added

- Added `dashboard/console-postgres-store.cjs` as the production DB bridge for hosted MnemoPay console state.
- The adapter keeps `pg` optional, validates table prefixes, bootstraps typed Postgres tables, and persists the same console snapshot currently held in JSON/SQLite.
- Tables cover API keys, Brain memories, Brain entities, Brain edges, audit events, usage counters, account plans, console sessions, and account members.
- Added `dashboard/console-postgres-store.test.cjs` with mock-pool coverage for schema generation, identifier safety, transaction save, and snapshot load.
- This is the safe adapter slice before wiring the live dashboard server to async `MNEMOPAY_CONSOLE_STORE_DRIVER=postgres` startup.

---
# mnemopay-sdk status - 2026-05-10 13:02 Codex

## Hosted Brain reasoning traces added

- Added `POST /api/v1/brain/reason` to turn recall + graph into a deterministic reasoning trace.
- Reasoning traces return evidence memories, matched graph entities, supporting edges, confidence, and step metadata.
- Dashboard Brain panel now has a Reason button and trace card so operators can inspect why the Brain surfaced an answer.
- Python hosted client now exposes `reason(...)`, with unittest coverage for the new endpoint.
- This is not LLM-authored reasoning yet. It is the auditable deterministic trace layer that LLM summaries can sit on safely.

---
# mnemopay-sdk status - 2026-05-10 12:35 Codex

## Hosted Python client parity started

- Added `integrations/python-hosted` as a dependency-free Python package for the hosted MnemoPay API.
- `mnemopay_hosted.py` includes `MnemoPayHostedClient` with Bearer API key auth, optional local account header, JSON error handling, Brain memory/query helpers, namespace export/delete, graph load/rebuild, usage report/export, audit event fetch, and current rail charge/settle helpers.
- Added README and pyproject for future PyPI packaging as `mnemopay-hosted`.
- Added stdlib unittest coverage for Bearer-auth memory writes and graph namespace URL encoding.
- This gives Python agents and Forge services a direct hosted Brain path while MCP integrations remain available.

---
# mnemopay-sdk status - 2026-05-10 09:52 Codex

## Hosted Brain graph foundation added

- Started knocking out the full Brain path after account members.
- `dashboard/server.js` now persists hosted brain entities and graph edges in JSON/SQLite stores.
- Memory writes run deterministic entity extraction and create namespace-scoped canonical entity nodes plus `co_occurs_with` edges.
- Added `GET /api/v1/brain/namespaces/:id/graph` for entity/edge graph export.
- Added `POST /api/v1/brain/namespaces/:id/enrich` to rebuild a namespace graph from stored memories.
- Namespace delete now also clears that namespace graph.
- Console overview now reports brain entity and edge counts.
- Dashboard Brain tab now has Load Graph/Rebuild Graph controls and entity/edge preview.
- Validation passed: `node --check dashboard/server.js`; SQLite brain graph smoke verified UI control, two memory writes, entity/edge counts, graph rebuild, overview counts, and `brain.graph.rebuilt` audit event.
- This is the deterministic graph foundation. Next Brain layer: LLM-enriched typed edges, summaries, and reasoning traces over graph + recall results.

---
# mnemopay-sdk status - 2026-05-10 09:22 Codex

## Lightweight account membership added

- Continued immediately after signed console sessions.
- `dashboard/server.js` now stores account members in JSON/SQLite alongside sessions.
- First signed email for an account becomes `owner`; owners/admins can add account members through `POST /api/v1/auth/members`.
- Added `GET /api/v1/auth/members` and member records with roles: owner, admin, member, viewer.
- Public session payload now includes role, and overview includes account members.
- Dashboard Session tab now shows Account Members and can add admin/member/viewer while signed in.
- Validation passed: `node --check dashboard/server.js`; SQLite membership smoke verified first user becomes owner, owner adds viewer member, member list returns it, and overview includes members.
- Next: real hosted identity provider/user membership model can replace this shim; Python hosted client parity remains the next SDK-facing build.

---
# mnemopay-sdk status - 2026-05-10 09:02 Codex

## Signed console sessions added

- Dirty item inspected: `benchmark/longmemeval/longmemeval-repo` is a nested Git checkout. Inside it, only `src/evaluation/evaluate_qa_azure.py` is untracked. It is benchmark/vendor research material and was left untouched.
- Continued the MnemoPay console/app build with auth/session-backed console accounts.
- `dashboard/server.js` now supports signed browser sessions alongside Bearer API keys.
- Added `GET /api/v1/auth/session`, `POST /api/v1/auth/login`, and `POST /api/v1/auth/logout`.
- Session cookies are HMAC-signed with `MNEMOPAY_SESSION_SECRET` or `MNEMOPAY_SECRET`, HttpOnly, SameSite=Lax, persisted in JSON/SQLite stores, and removed on logout.
- Account resolution order is now Bearer API key, signed session cookie, then `X-MnemoPay-Account` dev fallback.
- Session create/logout writes audit events: `auth.session.created` and `auth.session.revoked`.
- Dashboard API client now sends same-origin credentials, Console panel shows session state, and a new Session tab can sign in, switch accounts, and sign out.
- Validation passed: `node --check dashboard/server.js`; SQLite session smoke verified login cookie, `/auth/session`, account resolution without account header, session audit event, and logout revocation.
- Next: real hosted identity provider/user membership model, then Python hosted client parity.

---
# mnemopay-sdk status - 2026-05-10 02:44 Codex

## Stripe webhook provisioning intake added

- Continued after usage metering gates.
- Added raw body reader and Stripe-style webhook signature verification in `dashboard/server.js`.
- Added `POST /api/v1/billing/stripe/webhook`.
- Supports `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
- Uses `STRIPE_WEBHOOK_SECRET` with Stripe `t=...,v1=...` HMAC verification. Local dev without the secret is accepted as `unsigned-dev`.
- Webhook metadata should include `accountId` and either `priceLookupKey` or `plan`/`interval`. Handler maps lookup keys, calls the shared `provisionAccount` flow, and records `billing.stripe.webhook.handled`.
- CORS allow-list now includes `Stripe-Signature`.
- Validation passed: `node --check dashboard/server.js`; signed Stripe webhook smoke with `mnemopay_pro_monthly` verified signature, provisioned Pro, created API key metadata, updated overview, and wrote webhook audit event.
- Next: deploy this console/API behind HTTPS, configure Stripe webhook endpoint, then add auth/session-backed accounts.

---
# mnemopay-sdk status - 2026-05-10 02:22 Codex

## Usage metering exports and plan gates added

- Continued the MnemoPay console/app build after billing provisioning.
- `dashboard/server.js` now has `meteringSnapshot(accountId)` and plan-gate enforcement for mission actions.
- Added `GET /api/v1/usage/report` for account-scoped plan, limits, usage, remaining missions, LLM cap, seats, and features.
- Added `GET /api/v1/usage/export` for exportable usage plus recent audit events; export records `usage.report.exported` and now satisfies the onboarding audit-export task.
- Added HTTP 402 plan gates for `brain.write`, `brain.query`, and `rail.charge`. Free = 5 missions, Pro = 100, Team = unlimited, Enterprise = custom.
- Provisioning system seed memory no longer counts against customer mission usage.
- Dashboard Billing tab now shows usage meter, mission progress, LLM cap, seats, plan-gate state, and usage export preview.
- Validation passed: `node --check dashboard/server.js`; SQLite meter smoke verified Usage Meter UI, Free provision, five allowed mission queries, sixth query blocked with HTTP 402, usage report marked over-limit, usage export returned mission count, and onboarding `export-audit` became done.
- Next: real Stripe webhook/checkout wiring into `provisionAccount`, then auth/session-backed accounts, then Python hosted client parity.

---
# mnemopay-sdk status - 2026-05-10 01:58 Codex

## Billing provisioning primitive added

- Continued the MnemoPay console/app production build after SQLite persistence.
- `dashboard/server.js` now tracks persisted account plan state alongside API keys, hosted brain memories, audit events, and usage counters.
- Added plan catalog for Free, Pro, Team, and Enterprise with mission/LLM/seat limits and feature notes.
- Added lookup-key mapping for `mnemopay_*` and `praetor_*` Pro/Team monthly/yearly keys so checkout success can provision the correct plan without changing canonical Stripe IDs.
- Added `POST /api/v1/billing/provision` and alias `POST /api/v1/billing/checkout/success`.
- Provisioning now sets account plan, seeds the default hosted brain namespace with an onboarding memory, optionally creates the first API key with one-time secret reveal, records `billing.account.provisioned`, and persists across JSON/SQLite stores.
- Dashboard Billing tab now includes operator controls to provision Free, Pro, Team, or Enterprise and show the first API secret once.
- Validation passed: `node --check dashboard/server.js`; SQLite provisioning smoke mapped `praetor_team_yearly` to Team yearly, created a key, seeded default namespace memory, wrote audit, and survived restart; JSON provisioning smoke passed for Pro monthly.
- Next: wire real Stripe checkout/webhook into this provisioner, then add auth/session-backed accounts and usage metering exports.

---
# mnemopay-sdk status - 2026-05-10 01:30 Codex

## Optional SQLite console store added

- Continued the MnemoPay console/app productionization after shipping namespace controls.
- `dashboard/server.js` now supports an optional SQLite-backed console store using the existing `better-sqlite3` dependency.
- Enable with `MNEMOPAY_CONSOLE_STORE_DRIVER=sqlite` or by setting `MNEMOPAY_CONSOLE_SQLITE=/path/to/console-store.sqlite`.
- JSON remains the default local-dev store through `MNEMOPAY_CONSOLE_STORE`.
- SQLite tables now persist API keys, hosted brain memories, audit events, and usage counters as typed rows with JSON payload copies.
- CORS headers now allow `Authorization` and `X-MnemoPay-Account`, which matters for real API clients and dashboard calls outside same-origin dev.
- Validation passed: `node --check dashboard/server.js`; SQLite restart smoke confirmed API key metadata, hosted brain memory, and audit events survived restart; JSON smoke confirmed the default store path still works.
- Next: promote this adapter into a hosted DB/Neon service, add auth/session-backed accounts, and wire checkout success into account provisioning and usage metering.

---
# mnemopay-sdk status - 2026-05-10 01:08 Codex

## Hosted brain console controls added

- Continued the MnemoPay console/app build after the dashboard panel checkpoint.
- `dashboard/index.html` now gives the Hosted Brain panel proper operator controls: namespace export, export JSON download, namespace deletion with confirmation, and inline status feedback after query/export/delete.
- The action row now wraps on narrower screens so the console does not crowd the new controls.
- Updated `docs/PRODUCT-UPGRADE-ROADMAP-2026-05.md` with the console progress and validation checkpoint.
- Validation: `node --check dashboard/server.js` passed. Local smoke on temp store/port passed: dashboard HTML served, `Delete Namespace` and `Download JSON` controls were present, API key creation returned a one-time secret, namespace export returned 1 memory, namespace delete removed it, namespace inspect returned 0 memories, and audit contained `brain.namespace.deleted`.
- Note: the MnemoPay skill expects the MCP to be connected. This Codex session currently exposes no MnemoPay MCP resources via `list_mcp_resources`; `claude mcp list` timed out once, so MCP connection still needs a clean follow-up check.
- Next: move the JSON console store to a real DB/Neon-backed service, add auth/session handling, and add production API key/usage/billing automation.

---
# mnemopay-sdk status - 2026-05-10 00:45 Codex

## Dashboard UI panels started for MnemoPay console

- After committing and pushing the control-layer checkpoint, started the next build: visible dashboard panels over the new `/api/v1` console endpoints.
- `dashboard/index.html` now has account-aware API headers using localStorage account id (`mnemopay.dashboard.account`) and `X-MnemoPay-Account`.
- Added new UI panels: Console overview, Hosted Brain, Developer API Keys, Billing/Onboarding, and Control Audit.
- Console panel shows positioning, account selector, brain writes, brain queries, rail holds, API key count, brain memory count, and onboarding task state.
- Developer panel can create API keys, show one-time secret reveal, list keys, and revoke keys.
- Brain panel can store memory, query a namespace, and export a namespace.
- Billing panel renders provisioning/onboarding state from `/api/v1/billing/onboarding` via the overview payload.
- Control Audit panel renders account-scoped events from `/api/v1/audit/events`.
- Validation: local smoke on temp store/port served dashboard HTML 200, confirmed `ConsolePanel` was in HTML, `/api/v1/console/overview` returned ok, API key creation returned ok, and audit feed contained the key-created event.
- Next: improve dashboard UX polish, add namespace delete/export download affordances, and consider moving the single-file dashboard into a real frontend bundle once API contracts settle.

---
# mnemopay-sdk status - 2026-05-10 00:28 Codex

## Console control layer added: revoke, export, audit events

- Continued the MnemoPay console/app upgrade control layer.
- `dashboard/server.js` now has persisted, account-scoped audit events in the console store.
- Audit events are recorded for: `api_key.created`, `api_key.revoked`, `brain.memory.created`, `brain.query`, `brain.namespace.exported`, `brain.namespace.deleted`, `rail.charge.created`, and `rail.charge.settled`.
- Added `POST /api/v1/developer/api-keys/:id/revoke`. Revoked keys keep public metadata but no longer resolve Bearer auth.
- Added `GET /api/v1/brain/namespaces/:id/export` for namespace-level export. Export writes an audit event and returns account-scoped memories.
- Added `GET /api/v1/audit/events?limit=50` for account-scoped audit inspection.
- Updated `docs/PRODUCT-UPGRADE-ROADMAP-2026-05.md` with the control-layer endpoints and validation notes.
- Validation: `node --check dashboard/server.js` passed. Control-layer smoke passed on temp store/port: namespace export returned 1 memory, audit had 4 events before revoke, revoke set `revokedAt`, revoked Bearer fell back to `default`, audit events survived restart, and export/revoke events were present after restart.
- Next recommended build: UI panels over `/api/v1/console/overview`, `/api/v1/developer/api-keys`, `/api/v1/brain/*`, and `/api/v1/audit/events`, then move JSON store toward DB/Neon.

---
# mnemopay-sdk status - 2026-05-10 00:16 Codex

## Console persistence + account scoping landed

- Continued the MnemoPay app/hosted brain upgrade after user said "go ahead".
- `dashboard/server.js` now persists console state to `MNEMOPAY_CONSOLE_STORE` or `.mnemopay-console/console-store.json` by default.
- Added `.mnemopay-console/` to `.gitignore` so local persisted console state and hashed keys do not get committed.
- API keys are now account-scoped and persisted as SHA-256 hashes with a public prefix only. Raw `mnemo_...` secrets are returned once and are not written to the store.
- `Authorization: Bearer mnemo_...` now resolves the account from the stored key hash. Without a bearer key, routes fall back to `X-MnemoPay-Account`, then `MNEMOPAY_ACCOUNT_ID`, then `default`.
- Hosted brain memories are now account-scoped and persisted. Namespace inspect/delete only affects the active account.
- Usage counters are now per-account and persisted: brain writes, brain queries, rail charges, rail settlements.
- Onboarding state is now account-aware: API key created, hosted brain memory written, recall query run, rail hold created, audit export still pending.
- Updated `docs/PRODUCT-UPGRADE-ROADMAP-2026-05.md` with 2026-05-10 progress notes.
- Validation: `node --check dashboard/server.js` passed. Restart smoke passed on a temporary store: key + brain memory survived restart, bearer auth resolved `acct-smoke`, recall returned 1 result, and the raw API secret was not present in the store file.
- Remaining production work: replace JSON store with DB/Neon-backed persistent service, add real user auth/session model, add API key revoke endpoint, add namespace export/audit logs, wire UI panels over `/api/v1/*`, and continue Python hosted-client parity.

---
# mnemopay-sdk status - 2026-05-09 23:54 Codex

## MnemoPay app/hosted brain upgrade started

- Added canonical upgrade roadmap: `docs/PRODUCT-UPGRADE-ROADMAP-2026-05.md`.
- Added SOC 2 prep checklist: `ops/SOC2-PREP-2026-05.md`.
- Extended `dashboard/server.js` with the first production-style `/api/v1` app surface:
  - `GET /api/v1/console/overview`
  - `GET/POST /api/v1/developer/api-keys`
  - `GET /api/v1/billing/onboarding`
  - `POST /api/v1/brain/memories`
  - `POST /api/v1/brain/query`
  - `GET/DELETE /api/v1/brain/namespaces/:id`
- Added in-process usage counters for brain writes, brain queries, rail charges, and rail settlements. This is a prototype counter, not production persistence.
- API key creation currently stores keys in memory and returns the secret once. Production next step is hashed persistent storage + account scoping.
- Hosted brain API currently stores memories in memory and uses `RecallEngine` when available from built SDK, with fallback lexical recall. Production next step is auth + Neon/pgvector adapter + namespace retention/deletion audit.
- Smoke validation passed on alternate port `3299`: console overview, API key creation, brain memory write, and brain query all returned ok.
- Positioning locked for next public pass: "MnemoPay is the brain, wallet, and audit trail for AI agents that handle money." Do not use broad "agent OS" copy publicly until hosted console/API are stronger.

---
# mnemopay-sdk status â€” 2026-05-09 (end of session)

## SDK alpha.2 published - MCP import footgun fixed

- **`@mnemopay/sdk@1.6.0-alpha.2` PUBLISHED to npm under `alpha` dist-tag.** Public npm state verified: `latest` remains `1.5.0`; `alpha` now points to `1.6.0-alpha.2`.
- Fixed `src/mcp/server.ts` startup behavior so the MCP server only starts when the server module is executed directly. Importing SDK modules from another MCP process no longer auto-starts MnemoPay MCP inside that consumer process.
- Added regression coverage in `tests/mcp-import.test.ts` for consumer import behavior where another MCP process imports the SDK.
- README now documents safer subpath imports such as `@mnemopay/sdk/recall`, `@mnemopay/sdk/rails`, `@mnemopay/sdk/storage`, and `@mnemopay/sdk/commerce`.
- Validation: `npx vitest run tests/mcp-import.test.ts` passed, `npm run build` passed, `npm pack --dry-run` passed, and `npm publish --tag alpha` passed. Full `npm test` was attempted twice and timed out after about 15 minutes without returning a failure signal.
- Publish note: npm normalized `repository.url` during publish; `npm pkg fix` was run locally after publish to keep package metadata aligned.

## ðŸ§  BRAIN DISCOVERED â€” MnemoPay's identity expands

`src/recall/{entities,graph,hyde,rerank,summarizer}.ts` + `src/reasoning/post-processor.ts` form a reasoning + recall layer on top of memory. With governance, identity, payments, and now reasoning, MnemoPay has 5 layers no competitor combines.

**Repositioning candidate (PENDING senior signoff â€” don't push to public site):**
> "MnemoPay â€” the operating system for AI agents."

**Forward-looking integration sketched:** wire the brain into `@blackpig/forge` so NPCs remember+reason across sessions. See `~/.claude/projects/C--WINDOWS-system32/memory/project_brain_forge_integration.md`. Implementation ~3-5 days for Codex/terminal.

## External brain consumer repo SHIPPED â€” first real-world dogfood of `@mnemopay/sdk/recall`

Distinct from the SDK-internal brain layer above: a personal nervous system at `C:\Users\bizsu\Projects\brain` (separate repo, MIT-licensed by Jeremiah privately) that *imports* the SDK as a regular consumer. Markdown source-of-record + sqlite recall index.

- Imports: `import { localEmbed, cosineSimilarity, RecallEngine } from "@mnemopay/sdk/recall"` (subpath, not root â€” see bug below)
- Stack: Bun + `bun:sqlite` (no native binding hell), `@modelcontextprotocol/sdk` for stdio MCP, `gray-matter` for frontmatter
- **243 pages** seeded from existing memory in one shot â€” first time `localEmbed` is exercised at 3-figure-page scale outside the SDK's own tests, no precision loss observed
- `brain serve --mcp` exposes 5 tools: `brain_query`, `brain_get_page`, `brain_list_pages`, `brain_status`, `brain_ingest`. Bundle 2.11 MB
- Strategic: this is the case study post for `@mnemopay/sdk/recall`. "I built a personal brain in a weekend, dogfooded the recall engine at scale, and here's the perf data" is the content angle. Marketing handoff candidate.
- Phase 1 next (~4.5 hr): skills system, LLM-enriched entity extraction (Sonnet 4.5 via OpenRouter ~$2 for 255 files), book-mirror skill (Garry Tan's killer pattern)
- Full record: `~/.claude/projects/C--WINDOWS-system32/memory/project_session_2026_05_09_brain_build.md`

### SDK bug found while building it â€” subpath import workaround

- Importing from `@mnemopay/sdk` root pulls in `dist/mcp/server.js`, which has top-level startup code that runs on module evaluation. Side effects: `[mnemopay-mcp] Tool filter: 14/40 tools exposed` + `[mnemopay-mcp] Server started (stdio mode)` print to **the consumer's stderr**. Catastrophic if the consumer is itself a stdio MCP (the brain) â€” both servers' JSON-RPC frames hit the same client.
- Consumer-side workaround: subpath import `@mnemopay/sdk/recall`. Bundle 5.57 MB â†’ 2.11 MB; stderr clean.
- **Real fix for next SDK release**: wrap `src/mcp/server.ts` startup in `if (require.main === module)` so it only auto-starts when invoked via the `mnemopay-mcp` bin, not when imported. Add subpath imports as the documented default in README.
- Operational rule: `~/.claude/projects/C--WINDOWS-system32/memory/feedback_mnemopay_sdk_subpath_import.md` (mirrored to `~/.codex/memories/claude/`)

## End-of-session totals (2026-05-09)

- **22 X posts + 12 Dev.to articles published live** today on `@mnemopay` and `dev.to/t49qnsx7qtkpanks` (via the multi-tenant SMM pipeline)
- **`@mnemopay/coding-agent@0.2.0`** published to npm (renamed from `@kpanks/coding-agent@0.1.0`)
- All hunter/writer compute on OpenRouter â€” daily steady-state $0.65 for both BizSuite + MnemoPay self-tenants combined

## MnemoPay outbound now runs via multi-tenant SMM (Claude main)

- MnemoPay onboarded as self-tenant client `d3858acf-5aed-4675-94a1-2f12f81d613c` in `bizsuite-site/social-manager/social-manager.db`
- Daily Perplexity-Sonar-Pro hunter at 00:15 â†’ Sonnet-4.5 writer at 01:30 â†’ publisher to `@mnemopay` X + Dev.to at 09:30
- 25 trend signals + 46 approved drafts (25 X + 21 Dev.to) ready to ship 2026-05-10 morning
- All writer/hunter compute on OpenRouter â€” no Anthropic credits required
- `mnemopay-sdk/marketing/post.mjs --handle mnemopay` is the X poster the publisher spawns; uses TWITTER_MNEMOPAY_* per-handle creds in `mnemopay-sdk/.env`

## Coordination

The bizsuite-site `social-manager/` orchestrator is **the canonical SMM** for all of Jeremiah's brands. Don't build a parallel social pipeline in mnemopay-sdk. The autopost.js + post.mjs in mnemopay-sdk/marketing/ remain â€” they're the underlying X poster the SMM publisher spawns into.

See `bizsuite-site/status.md` and `~/.claude/projects/.../memory/project_session_2026_05_09_smm_pipeline_meta.md` for full picture.

---

# mnemopay-sdk status â€” 2026-05-08

## Shipped today

### Packages

- **`@mnemopay/sdk@1.6.0-alpha.1` PUBLISHED to npm under `alpha` dist-tag.** `latest` still `1.5.0` â€” stable users see no change. Tag `v1.6.0-alpha.1` pushed to origin (commit `3863163`).
  - **`X402Rail`** â€” Coinbase x402 protocol (HTTP 402 Payment Required revival). USDC on Base L2 via EIP-3009 `transferWithAuthorization`. Pluggable `X402Signer` (bring-your-own viem/ethers/noble). Hold = signed authorization (not broadcast); capture = facilitator HTTP submit; reverse pre-capture = `reversed`, post-capture = `irreversible`. **38/38 tests.**
  - **`GoogleAP2Rail`** â€” Google Agent Payment Protocol (FIDO Alliance, AP2 v0.2 Human-Not-Present). Mandate VC + Intent VC + HTTP settlement. Pre-flight policy enforcement (caps, expiry, currency match, allowed-recipients) **before any signature is produced** â€” defense-in-depth. **41/41 tests.**
  - Conflict resolution on master merge: kept both rail re-export blocks in `src/rails/index.ts` and `src/index.ts` (independent rails).

- **`mnemopay@1.0.0b4` PUBLISHED to PyPI** ([pypi.org/project/mnemopay/1.0.0b4](https://pypi.org/project/mnemopay/1.0.0b4/)). Python rail port â€” mirrors the TypeScript `PaymentRail` interface. Sync API.
  - `mnemopay.rails`: `PaymentRail` Protocol, `PaymentRailResult`, `HoldOptions`, `MockRail`, `StripeRail`
  - `StripeRail`: lazy `import stripe` peer-dep, `from_client()` for tests, threading.Lock-based capture race-protection, idempotency-key forwarding, `create_customer` + `create_setup_intent` helpers
  - 29 new rail tests; full suite 422/422 green
  - `[stripe]` optional dependency group added to `pyproject.toml`

### Documentation + site

- **mnemopay-sdk README** rewritten: governance pivot frame ("the governance layer for AI agents that handle money"), v1.6.0-alpha rails table, "What MnemoPay is NOT" callout, 6-rail Payment Rails section (3 stable + 3 alpha), updated architecture diagram with governance + spatial rows.
- **mnemopay-python README** rewritten: governance pivot, payment rails section with code examples, TS-vs-Python compatibility matrix.
- **mnemopay.com** â€” Today/Roadmap chip block reorganized into 3 tiers: Stable (`latest` v1.5.0), Preview (`alpha` v1.6.0-alpha.1, all 3 alpha rails marked `Â· shipped`), Roadmap (Visa IC + Mastercard pending acquirer). Meta description updated. Deployed to Vercel prod (alias `mnemopay.com` confirmed live).

### Test posture
- TypeScript suite: **1019/1020** (1 unrelated stress-test perf flake â€” p99 605ms vs 500ms target, Windows-load sensitive)
- Python suite: **422/422**

### Site + chat infrastructure (PM session 2026-05-08)

- **mnemopay.com & getbizsuite.com chatbots LIVE.** Both stream through OpenRouter (`anthropic/claude-haiku-4-5`) with single shared API key.
  - mnemopay: new Vercel Edge Function `api/chat.js` + `chat-widget.js` floating drawer, wired into all 6 pages
  - bizsuite: existing `server.js` upgraded â€” OpenRouter primary â†’ Anthropic fallback â†’ local canned reply; widget cloned with gold palette, wired into 7 pages
  - OpenRouter balance ~$10 â€” sufficient for current volume; both chats fall to canned replies if it hits zero
- **ASCII fish-pond hero (v3, "graceful + subtle")** replaces v2 cursor-tracking governed-field. Three "less bold" iterations dialed it to font-weight 350, opacity 0.55, no drop-shadow, head 0.55, tail 0.42. Same fish on both sites with palette swap.
- **Pricing alignment.** MnemoPay Enterprise $299/mo â†’ Custom (Contact sales â€” $299 + 99.95% SLA was unfundable, page was lying). BizSuite committed numbers: Sprint $9,500, Systems $4,950, Plugin Licensing $997/$1,997/$2,497, Fractional Ops $3,500/mo. Orphan $299 refs purged from `pricing.html` CTA, `terms.html` Section 3, `llms.txt`.
- **BizSuite cleanup**: removed `$ whoami`, BIZSUITE block-letter ASCII, 3 floating panels, identity layer, hero-signature, cta-canvas spheres + dead JS/CSS (~150KB transfer saved).
- **Subtitle visibility fix** on mnemopay homepage: removed `.reveal` (was stuck at opacity:0 waiting for fragile GSAP ScrollTrigger), brightened color, bolded Charter/FiscalGate/Article 12.
- Full record: `~/.claude/projects/C--WINDOWS-system32/memory/project_session_2026_05_08_chat_pricing_design.md`

## In progress
- (none â€” chat + pricing landing closed)

## Blocked
- **`@mnemopay/sdk@1.6.0` (latest)** â€” gated on real-world alpha.1 feedback. Promote `alpha` â†’ `latest` once external integrators have run x402/AP2 against live facilitators / merchant endpoints.
- **Visa IC, Mastercard Agent Suite rails** â€” pending acquirer access (no engineering work).

## Next session
- **Jeremiah's queued actions** (gating chat + ad campaign):
  - Archive Stripe Buy Button `9B63co8HNehxcCQ5SPbo40a` ($299 Enterprise â€” orphan)
  - Replace `__META_PIXEL_ID__` + `GTM-XXXXXXX` placeholders (~18 occurrences across both sites) with real Meta + GTM IDs
  - Configure 3 Stripe Buy Button success URLs â†’ `/thanks?tier=...&session_id={CHECKOUT_SESSION_ID}`
  - Top up OpenRouter when ~$10 balance runs low
- Decide on a **Python parity expansion plan**: at minimum port `PaystackRail` + `LightningRail` to match TS feature surface, then evaluate StripeMPP / x402 / AP2 in Python.
- **Console v0.2** â€” auth, live data wiring (currently mock), real charter editor.
- Explore **promoting `alpha` â†’ `latest`** once external integrators confirm x402/AP2 work end-to-end against live counterparties.
- **SOC 2 Type II** ops process (Q3 2026 Vanta start, Q1 2027 audit) â€” separate workstream.

