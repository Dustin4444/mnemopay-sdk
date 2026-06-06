# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.12.x  | Yes — current stable |
| 1.11.x  | Yes — critical fixes |
| 1.10.x  | Critical fixes only |
| < 1.10  | No |

Preview/experimental modules (x402/AP2/StripeMPP rails, Swarm) may change in minor releases — pin exact versions in production. See [VERSIONING.md](VERSIONING.md) and [README § Module stability](README.md#module-stability).

## Reporting a vulnerability

**Do not open a public GitHub issue.**

Email: **info@getbizsuite.com** with subject line `[security] mnemopay-sdk: <short description>`.

Please include:

- Affected version(s) and the import path / subpath where the issue surfaces (e.g. `@mnemopay/sdk/governance`).
- Reproduction steps or minimum failing example.
- Whether the issue has been disclosed elsewhere.
- Whether you would like to be credited in the fix release notes.

## Response timeline

- Acknowledgement within 48 hours.
- Initial triage within 5 business days.
- Coordinated disclosure: critical issues get a patched release within 7 days of triage; high within 14 days; medium within 30 days.

## Out of scope

- Issues that require a malicious agent runtime (e.g. "if the runtime lies about charter scope, the SDK accepts it"). The trust boundary is the runtime; we publish the audit chain so misbehavior is detectable, not preventable from inside the runtime.
- Theoretical timing attacks on local-only code paths with no network surface.
- Anything in `examples/` or `playground/` that is not imported by published code.

## Secure deployment

When self-hosting agents with MnemoPay governance:

- Compile policies once; enforce `ctx.act()` / `evaluateAction` on every side-effect
- Swap `InMemoryApprovalStore` for a durable store in production
- Never commit API keys, rail secrets, or `.env` files — use a secrets manager
- Restrict agent spend with `hard_cap_usd` and `approval_threshold_usd`
- Export and retain Merkle audit bundles for regulated workloads — see [docs/AUDIT-BUNDLES.md](docs/AUDIT-BUNDLES.md)

## Hall of fame

Researchers who responsibly disclose accepted vulnerabilities will be credited here unless they prefer anonymity.

_(none yet)_
