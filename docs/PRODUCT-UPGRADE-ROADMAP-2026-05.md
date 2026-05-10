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

## Python SDK parity

Minimum parity sequence:

1. Recall client: hosted brain API client, namespace write/query/delete.
2. Rails: Paystack and Lightning after current Stripe parity.
3. Governance: charters, spend caps, HITL approvals.
4. Audit: receipt verification and Merkle proof verification.
5. Examples: LangChain, CrewAI, FastAPI service, MCP bridge.

Python should not try to mirror every internal TypeScript primitive first. It should mirror the production cloud API first, then add offline/local advanced primitives where demand appears.

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
