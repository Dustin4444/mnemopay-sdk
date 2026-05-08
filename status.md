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

## In progress
- (none — alpha.1 ship cycle closed)

## Blocked
- **`@mnemopay/sdk@1.6.0` (latest)** — gated on real-world alpha.1 feedback. Promote `alpha` → `latest` once external integrators have run x402/AP2 against live facilitators / merchant endpoints.
- **Visa IC, Mastercard Agent Suite rails** — pending acquirer access (no engineering work).

## Next session
- Decide on a **Python parity expansion plan**: at minimum port `PaystackRail` + `LightningRail` to match TS feature surface, then evaluate StripeMPP / x402 / AP2 in Python.
- **Console v0.2** — auth, live data wiring (currently mock), real charter editor.
- Explore **promoting `alpha` → `latest`** once external integrators confirm x402/AP2 work end-to-end against live counterparties.
- **SOC 2 Type II** ops process (Q3 2026 Vanta start, Q1 2027 audit) — separate workstream.
