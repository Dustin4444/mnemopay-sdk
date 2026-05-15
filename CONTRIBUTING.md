# Contributing to MnemoPay SDK

Thanks for your interest. MnemoPay is the trust + reputation substrate for AI agents that handle money — every PR touches code that real agents will use to authorize real payments, so the bar is high.

## Quick rules

- **Open an issue first** for any change > 20 lines of behavior. Drive-by refactors of working code will be closed.
- **Tests are mandatory.** The SDK ships with > 500 specs. New behavior = new specs. Bug fix = regression spec proving the bug.
- **No new dependencies** without a comment in the PR explaining why and what the alternative cost was. Bundle size and supply-chain risk matter.
- **No breaking changes** to public API surface without a major version bump discussion. Adapters, middleware, and rails are public surface.

## Contributor License Agreement (CLA)

By submitting a contribution, you agree that:

1. Your contribution is your original work, or you have the right to submit it.
2. Your contribution is licensed under the Apache License 2.0, the same license as the project.
3. You grant the project maintainer (Jeremiah Omiagbo) a perpetual, worldwide, royalty-free copyright + patent license consistent with Apache 2.0 Sections 2 and 3.
4. You understand the project may be relicensed in future releases at the maintainer's sole discretion. Your already-merged contribution remains under Apache 2.0 in perpetuity.

There is no separate CLA form. Submitting a PR == agreement to the above.

## Local development

```bash
git clone https://github.com/mnemopay/mnemopay-sdk
cd mnemopay-sdk
npm install
npm run lint          # tsc --noEmit
npm test              # vitest
npm run build         # emits dist/
```

## Commit style

Conventional commits. Examples from real history:

```
feat(identity): ship @mnemopay/sdk/identity — DID + Wallet primitive
fix(dashboard): relax CSP so React + Tailwind + Babel CDN scripts load
test(dashboard): cover retrieveCheckoutSession + drip-queue
docs(env): MNEMOPAY_BRAIN_PATH + Maileroo onboarding drip
chore(release): @mnemopay/sdk 1.7.0
```

## What we will NOT merge

- Code that calls out to undisclosed third-party services.
- "AI-improved" docs that change voice without changing facts.
- Changes that weaken the Merkle audit chain, FiscalGate enforcement, or charter checks.
- Anything that imports the SDK root in a process that hosts its own stdio MCP server (see issue history — root import auto-starts the bundled MCP and collides). Use the subpath imports (`/recall`, `/identity`, `/governance`, etc.).

## Security

Do not file public issues for security vulnerabilities. See [SECURITY.md](./SECURITY.md).

## Maintainer

Jeremiah Omiagbo — info@getbizsuite.com
