# mnemopay-sdk status — 2026-05-08

## Shipped today

### Packages

- **`@mnemopay/sdk@1.6.0-alpha.1` PUBLISHED to npm under `alpha` dist-tag.** `latest` still `1.5.0` — stable users see no change. Tag `v1.6.0-alpha.1` pushed to origin (commit `3863163`).
  - **`X402Rail`** — Coinbase x402 protocol (HTTP 402 Payment Required revival). USDC on Base L2 via EIP-3009 `transferWithAuthorization`. Pluggable `X402Signer` (bring-your-own viem/ethers/noble). Hold = signed authorization (not broadcast); capture = facilitator HTTP submit; reverse pre-capture = `reversed`, post-capture = `irreversible`. **38/38 tests.**
  - **`GoogleAP2Rail`** — Google Agent Payment Protocol (FIDO Alliance, AP2 v0.2 Human-Not-Present). Mandate VC + Intent VC + HTTP settlement. Pre-flight policy enforcement (caps, expiry, currency match, allowed-recipients) **before any signature is produced** — defense-in-depth. **41/41 tests.**
  - Conflict resolution on master merge: kept both rail re-export blocks in `src/rails/index.ts` and `src/index.ts` (independent rails).

- **`mnemopay@1.0.0b4` PUBLISHED to PyPI** ([pypi.org/project/mnemopay/1.0.0b4](https://pypi.org/project/mnemopay/1.0.0b4/)). Python rail port — mirrors the TypeScript `PaymentRail` interface. Sync API.
  - `mnemopay.rails`: `PaymentRail` Protocol, `PaymentRailResult`, `HoldOptions`, `MockRail`, `StripeRail`
  - `StripeRail`: lazy `import stripe` peer-dep, `from_client()` for tests, threading.Lock-based capture race-protection, idempotency-key forwarding, `create_customer` + `create_setup_intent` helpers
  - 29 new rail tests; full suite 422/422 green
  - `[stripe]` optional dependency group added to `pyproject.toml`

### Documentation + site

- **mnemopay-sdk README** rewritten: governance pivot frame ("the governance layer for AI agents that handle money"), v1.6.0-alpha rails table, "What MnemoPay is NOT" callout, 6-rail Payment Rails section (3 stable + 3 alpha), updated architecture diagram with governance + spatial rows.
- **mnemopay-python README** rewritten: governance pivot, payment rails section with code examples, TS-vs-Python compatibility matrix.
- **mnemopay.com** — Today/Roadmap chip block reorganized into 3 tiers: Stable (`latest` v1.5.0), Preview (`alpha` v1.6.0-alpha.1, all 3 alpha rails marked `· shipped`), Roadmap (Visa IC + Mastercard pending acquirer). Meta description updated. Deployed to Vercel prod (alias `mnemopay.com` confirmed live).

### Test posture
- TypeScript suite: **1019/1020** (1 unrelated stress-test perf flake — p99 605ms vs 500ms target, Windows-load sensitive)
- Python suite: **422/422**

### Site + chat infrastructure (PM session 2026-05-08)

- **mnemopay.com & getbizsuite.com chatbots LIVE.** Both stream through OpenRouter (`anthropic/claude-haiku-4-5`) with single shared API key.
  - mnemopay: new Vercel Edge Function `api/chat.js` + `chat-widget.js` floating drawer, wired into all 6 pages
  - bizsuite: existing `server.js` upgraded — OpenRouter primary → Anthropic fallback → local canned reply; widget cloned with gold palette, wired into 7 pages
  - OpenRouter balance ~$10 — sufficient for current volume; both chats fall to canned replies if it hits zero
- **ASCII fish-pond hero (v3, "graceful + subtle")** replaces v2 cursor-tracking governed-field. Three "less bold" iterations dialed it to font-weight 350, opacity 0.55, no drop-shadow, head 0.55, tail 0.42. Same fish on both sites with palette swap.
- **Pricing alignment.** MnemoPay Enterprise $299/mo → Custom (Contact sales — $299 + 99.95% SLA was unfundable, page was lying). BizSuite committed numbers: Sprint $9,500, Systems $4,950, Plugin Licensing $997/$1,997/$2,497, Fractional Ops $3,500/mo. Orphan $299 refs purged from `pricing.html` CTA, `terms.html` Section 3, `llms.txt`.
- **BizSuite cleanup**: removed `$ whoami`, BIZSUITE block-letter ASCII, 3 floating panels, identity layer, hero-signature, cta-canvas spheres + dead JS/CSS (~150KB transfer saved).
- **Subtitle visibility fix** on mnemopay homepage: removed `.reveal` (was stuck at opacity:0 waiting for fragile GSAP ScrollTrigger), brightened color, bolded Charter/FiscalGate/Article 12.
- Full record: `~/.claude/projects/C--WINDOWS-system32/memory/project_session_2026_05_08_chat_pricing_design.md`

## In progress
- (none — chat + pricing landing closed)

## Blocked
- **`@mnemopay/sdk@1.6.0` (latest)** — gated on real-world alpha.1 feedback. Promote `alpha` → `latest` once external integrators have run x402/AP2 against live facilitators / merchant endpoints.
- **Visa IC, Mastercard Agent Suite rails** — pending acquirer access (no engineering work).

## Next session
- **Jeremiah's queued actions** (gating chat + ad campaign):
  - Archive Stripe Buy Button `9B63co8HNehxcCQ5SPbo40a` ($299 Enterprise — orphan)
  - Replace `__META_PIXEL_ID__` + `GTM-XXXXXXX` placeholders (~18 occurrences across both sites) with real Meta + GTM IDs
  - Configure 3 Stripe Buy Button success URLs → `/thanks?tier=...&session_id={CHECKOUT_SESSION_ID}`
  - Top up OpenRouter when ~$10 balance runs low
- Decide on a **Python parity expansion plan**: at minimum port `PaystackRail` + `LightningRail` to match TS feature surface, then evaluate StripeMPP / x402 / AP2 in Python.
- **Console v0.2** — auth, live data wiring (currently mock), real charter editor.
- Explore **promoting `alpha` → `latest`** once external integrators confirm x402/AP2 work end-to-end against live counterparties.
- **SOC 2 Type II** ops process (Q3 2026 Vanta start, Q1 2027 audit) — separate workstream.
