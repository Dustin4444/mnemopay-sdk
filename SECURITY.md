# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.7.x   | Yes — current stable |
| 1.8.x-alpha | Yes — preview channel |
| 1.6.x   | Critical fixes only |
| < 1.6   | No |

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

## Hall of fame

Researchers who responsibly disclose accepted vulnerabilities will be credited here unless they prefer anonymity.

_(none yet)_
