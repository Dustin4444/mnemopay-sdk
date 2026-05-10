# MnemoPay product upgrade roadmap

Date: 2026-05-09

## Positioning decision

Use this as the public product frame:

> MnemoPay is the brain, wallet, and audit trail for AI agents that handle money.

This is stronger than "agent payments" because the product is no longer just rails. The durable wedge is the bundle:

- Brain: persistent recall, entity graph, HyDE retrieval, rerank, summarization, reasoning post-processing.
- Wallet: Stripe, Paystack, Lightning, x402, AP2, escrow, holds, settlement, refunds.
- Audit trail: Merkle integrity, receipts, approvals, governance policy, Article 12-ready logs.
- Identity: Agent Credit Score, KYA identity, reputation history.

Do not reposition as a generic "agent OS" until the hosted console and brain API prove the claim. "Brain, wallet, and audit trail" is concrete, sellable, and defensible now.

## Console/app experience

The current `dashboard/` is a live SDK demo. The proper MnemoPay app should become a buyer/operator console with these sections:

1. Overview: agents, wallet balance, risk flags, monthly usage, recent receipts.
2. Brain: memory namespaces, recall queries, graph/entity view, retention/delete controls.
3. Wallet: rails, holds, captures, refunds, payment method status, settlement timeline.
4. Governance: charters, spend caps, HITL approval thresholds, policy violations.
5. Audit: Merkle proofs, receipt exports, Article 12 bundles, webhook logs.
6. Developers: API keys, SDK quickstarts, MCP registration, webhooks, usage metering.
7. Billing: plan, usage, invoices, upgrade flow, onboarding tasks.

Near-term implementation path:

- Keep dashboard/server.js as the prototype host.
- Add production API contracts under `/api/v1/*`.
- Split the single HTML into a real app only after the API contracts settle.
- Use PWA first. Native mobile can come later if push approvals/alerts become central.

2026-05-10 console progress:

- The dashboard now has visible app panels for overview, hosted brain, developer API keys, billing/onboarding, and control audit.
- The hosted brain panel can store memories, query namespaces, export namespaces, download export JSON, and delete a namespace with confirmation.
- Namespace export and deletion are account-scoped and record audit events.
- Smoke validation passed on a temporary console store: dashboard HTML served, controls were present, API key creation returned a one-time secret, namespace export returned one memory, delete removed it, inspect returned zero memories, and audit contained `brain.namespace.deleted`.

## Hosted brain API

Goal: turn local recall into a production service other apps can call.

Minimum v1 API:

- `POST /api/v1/brain/memories`
  - body: `{ "namespace": "agent-or-persona-id", "content": "...", "tags": [], "importance": 0.8 }`
  - returns: `{ "ok": true, "id": "mem_..." }`
- `POST /api/v1/brain/query`
  - body: `{ "namespace": "...", "query": "...", "limit": 8, "mode": "hybrid" }`
  - returns: `{ "ok": true, "results": [...], "summary": "..." }`
- `GET /api/v1/brain/namespaces/:id`
  - returns memory count, last write, last query, retention status.
- `DELETE /api/v1/brain/namespaces/:id`
  - hard-delete for GDPR/player consent flows.

Production requirements:

- Auth: API key scoped to account and namespace.
- Storage: Neon/pgvector adapter for production, local memory only for dev.
- Rate limits: per API key, per namespace, and per plan.
- Privacy: namespace deletion, export, retention policy, consent text.
- Observability: query latency, token cost, cache hit rate, recall quality feedback.

2026-05-10 auth/session progress:

- Added signed browser console sessions alongside Bearer API key auth.
- Endpoints: `GET /api/v1/auth/session`, `POST /api/v1/auth/login`, `POST /api/v1/auth/logout`.
- Session cookies are HMAC-signed with `MNEMOPAY_SESSION_SECRET` or `MNEMOPAY_SECRET`, HttpOnly, SameSite=Lax, and persisted in JSON/SQLite stores until expiry.
- Account resolution order is now Bearer API key, signed browser session, then `X-MnemoPay-Account` dev fallback.
- Dashboard now has a Session tab for signing into/switching an account, plus visible session state in the Console panel.
- Added lightweight account members: first signed email becomes owner, owners/admins can add admin/member/viewer records through `GET/POST /api/v1/auth/members`.
- Dashboard Session tab now shows account members and can add a member while signed in.
- Added passwordless console auth challenge endpoints: `POST /api/v1/auth/challenge` and `POST /api/v1/auth/verify`.
- Auth challenges persist in JSON/SQLite/Postgres stores, expire after 10 minutes by default, hash codes with the session secret, enforce attempt limits, and record audit events.
- Dashboard Session tab now requests and verifies short-lived login codes. Non-production/dev can return the code inline for local testing.
- This is now a production-shaped passwordless auth foundation. The hosted product still needs email delivery wiring and optional OAuth/SSO.

2026-05-10 hosted Brain graph progress:

- Added persisted hosted brain entities and edges to JSON/SQLite console stores.
- Memory writes now run deterministic entity extraction and create namespace-scoped canonical entity nodes plus `co_occurs_with` edges.
- Added `GET /api/v1/brain/namespaces/:id/graph` for entity/edge graph export.
- Added `POST /api/v1/brain/namespaces/:id/enrich` to rebuild a namespace graph from stored memories.
- Console overview now reports brain entity and edge counts.
- Dashboard Brain tab now has Load Graph/Rebuild Graph controls and an entity/edge preview.
- This is the deterministic graph foundation. The next Brain layer is LLM-enriched typed edges, summaries, and reasoning traces.

2026-05-10 persistence progress:

- Added an optional SQLite console store behind `MNEMOPAY_CONSOLE_STORE_DRIVER=sqlite` or `MNEMOPAY_CONSOLE_SQLITE=/path/to/console-store.sqlite`.
- JSON remains the default local-dev store via `MNEMOPAY_CONSOLE_STORE`.
- SQLite tables now persist API keys, hosted brain memories, audit events, and usage counters as typed rows with JSON payload copies.
- This is not the final hosted DB. It is the production-shaped adapter step before Neon/Postgres: the server now has a real database mode, typed tables, restart durability, and a cleaner migration path.

## Billing, onboarding, metering

Billing must provision the product, not only collect payment.

Checkout success should:

1. Create or update account plan.
2. Provision default agent namespace.
3. Create first API key or queue a one-time reveal.
4. Start onboarding checklist.
5. Send welcome email with SDK/MCP commands.
6. Fire Pixel/GTM purchase event.
7. Record audit event.

2026-05-10 provisioning progress:

- Added `POST /api/v1/billing/provision` and alias `POST /api/v1/billing/checkout/success`.
- The endpoint accepts `plan`, `interval`, or canonical lookup keys such as `mnemopay_pro_monthly`, `mnemopay_team_yearly`, `praetor_pro_monthly`, and `praetor_team_yearly`.
- Provisioning now persists account plan state, seeds the default hosted brain namespace with a system onboarding memory, creates a first API key when requested, and records `billing.account.provisioned`.
- Dashboard Billing tab now has operator controls to provision Free, Pro, Team, or Enterprise accounts and reveal the first API key secret once.
- Added `POST /api/v1/billing/stripe/webhook` for Stripe-compatible checkout/subscription events.
- Webhook verification uses `STRIPE_WEBHOOK_SECRET` and Stripe's `t=...,v1=...` HMAC scheme. Without the secret, local dev accepts unsigned events and marks them `unsigned-dev`.
- Handled events: `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
- Stripe metadata should include `accountId` and either `priceLookupKey` or `plan`/`interval`. The handler calls the same provisioner and records `billing.stripe.webhook.handled`.
- Added live Stripe session endpoints: `POST /api/v1/billing/checkout/session` and `POST /api/v1/billing/portal/session`.
- Checkout uses canonical lookup keys such as `mnemopay_pro_monthly`, resolves them through env price IDs or Stripe Price lookup keys, and returns a Stripe Checkout URL.
- The customer portal endpoint opens Stripe Billing Portal for accounts with a known Stripe customer id.
- Next step: deploy behind HTTPS, set the Stripe endpoint URL, and attach real user auth.

Usage metering:

- Brain writes.
- Brain recall queries.
- Summarization/reasoning calls.
- Payment rail holds/captures.
- Webhook deliveries.
- API keys created/revoked.

Plan gates should map to product value:

- Free: local/dev testing, small memory cap, mock rail.
- Pro: hosted brain, live Stripe/x402, API keys, basic audit export.
- Team: seats, higher limits, webhooks, namespace management, private support.
- Enterprise: SLA, on-prem/region controls, retention contracts, compliance pack.

2026-05-10 metering progress:

- Added `GET /api/v1/usage/report` for account-scoped plan, limit, and usage inspection.
- Added `GET /api/v1/usage/export` for exportable usage plus recent audit events. Export records `usage.report.exported`.
- Added mission gates for `brain.write`, `brain.query`, and `rail.charge`. Free is capped at 5 missions, Pro at 100, Team unlimited, Enterprise custom.
- Over-limit mission calls return HTTP 402 with action, plan, used, and limit details.
- Dashboard Billing tab now shows usage meter, mission progress, LLM cap, seats, plan-gate state, and usage export preview.
- Provisioning system seed memory does not count against customer mission usage.

## Python SDK parity

Minimum parity sequence:

1. Recall client: hosted brain API client, namespace write/query/delete.
2. Rails: Paystack and Lightning after current Stripe parity.
3. Governance: charters, spend caps, HITL approvals.
4. Audit: receipt verification and Merkle proof verification.
5. Examples: LangChain, CrewAI, FastAPI service, MCP bridge.

Python should not try to mirror every internal TypeScript primitive first. It should mirror the production cloud API first, then add offline/local advanced primitives where demand appears.

2026-05-10 Python parity progress:

- Added `integrations/python-hosted`, a dependency-free Python client for the hosted MnemoPay API.
- The client supports hosted Brain memory write/query, namespace inspect/export/delete, graph export/rebuild, usage report/export, audit events, and current dashboard rail charge/settle calls.
- The package is designed for Python agent frameworks, Forge NPC services, and backend jobs that need the hosted Brain without going through MCP.

2026-05-10 reasoning trace progress:

- Added a deterministic hosted Brain reasoning layer at `POST /api/v1/brain/reason`.
- The endpoint runs recall, attaches entity/edge graph context, and returns evidence memories, matched entities, supporting edges, confidence, and step-by-step trace metadata.
- Dashboard Brain tab now has a Reason action and trace card.
- Python hosted client now exposes `client.reason(...)`.

2026-05-10 Postgres console-store progress:

- Added `dashboard/console-postgres-store.cjs` as the production DB bridge for the hosted console.
- The adapter bootstraps typed Postgres tables for API keys, hosted Brain memories/entities/edges, audit events, usage counters, account plans, sessions, and members, while preserving JSONB payload copies for replay/debugging.
- Added mock-pool coverage in `dashboard/console-postgres-store.test.cjs`.
- Wired the live dashboard to `MNEMOPAY_CONSOLE_STORE_DRIVER=postgres` with `MNEMOPAY_CONSOLE_POSTGRES_URL`, `NEON_URL`, or `DATABASE_URL`.
- JSON and SQLite remain the defaults for local/dev use. Postgres saves are serialized asynchronously after mutations.

## SOC 2/compliance path

Start now with lightweight evidence collection. Do not wait until enterprise asks.

Policies to create first:

- Access control.
- Change management.
- Incident response.
- Data retention and deletion.
- Vendor management.
- Key/secrets management.
- Backup and disaster recovery.
- Secure development lifecycle.

Technical controls to implement first:

- SSO/MFA for production admin systems.
- Least-privilege production credentials.
- Audit logs for admin and API key actions.
- Dependency scanning and vulnerability triage.
- Encrypted storage for hosted brain data.
- Retention/deletion workflow for namespaces.
- Status page and incident log.

Vanta/Drata can come later. The first win is having the artifacts and operational habit.

## Execution order

1. Console information architecture and `/api/v1` contract. Started 2026-05-09.
2. Hosted brain API prototype in dashboard server. Started 2026-05-09.
3. Billing provisioning and onboarding checklist. Started 2026-05-09.
4. Usage metering records and plan gates.
5. Python hosted-client parity.
6. SOC 2 policy pack and evidence folder.
7. Public site positioning update after API and console are visible.

## 2026-05-10 progress

- Added JSON-backed console store at `MNEMOPAY_CONSOLE_STORE` with default `.mnemopay-console/console-store.json`.
- API keys are now persisted as SHA-256 hashes with public prefixes only. Raw secrets are returned once and are not written to the store.
- Console, hosted brain, API keys, onboarding, and usage counters are scoped by account id. A valid Bearer API key resolves the account; otherwise `X-MnemoPay-Account` or `MNEMOPAY_ACCOUNT_ID` is used.
- Hosted brain memories and per-account usage counters now survive dashboard server restarts.
- Smoke test verified restart persistence, Bearer account resolution, recall query, and no raw secret in the store.
- Added account-scoped audit events for API key create/revoke, brain memory write, brain query, namespace export/delete, and rail charge/settle.
- Added API key revoke endpoint: `POST /api/v1/developer/api-keys/:id/revoke`.
- Added namespace export endpoint: `GET /api/v1/brain/namespaces/:id/export`.
- Added audit event endpoint: `GET /api/v1/audit/events?limit=50`.
- Control-layer smoke verified namespace export, revoke, revoked-bearer fallback, audit event persistence after restart, and export/revoke audit events.
- Started dashboard UI panels over `/api/v1`: Console, Hosted Brain, API Keys, Billing, and Control Audit.
- UI smoke verified dashboard HTML serves, Console panel is present, overview endpoint works, API key creation works, and audit feed records the key-created event.
