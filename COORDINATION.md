# Codex ↔ Claude coordination

Two AI engineers work in parallel on the MnemoPay org:
- **Claude (main)** — operates from `C:\Users\bizsu\Projects\` mostly. Owns marketing, GTM, deploy plumbing, SEO/GEO, BizSuite ads, Apple submissions, Smithery + npm metadata, repo READMEs/badges. Hands off to Codex when the work is deep-engine TypeScript-heavy in the SDK or browser cores.
- **Codex (parallel)** — owns SDK internals, browser package CDP, native-browser Tauri, governance modules, signing flow, evidence boundary. Hands off to Claude when the work is HTML, copy, social, ASC, or cross-product orchestration.

Read this file at session start. Update it when you finish something the other should know about.

## Living state (current as of 2026-05-27)

### Shipped — don't redo
| Owner | What | Where |
|---|---|---|
| Claude | mnemopay-sdk 1.11.0 → 1.11.1 published to npm (Codex did the fix; Claude did the publish + rebase + push) | npm |
| Claude | mnemopay-browser 0.1.0-alpha.0 → 0.1.0-alpha.1 published to npm under `alpha` tag | npm |
| Claude | Smithery: mnemopay/sdk (40 tools) + mnemopay/gridstamp (12 tools) live with metadata | smithery.ai |
| Claude | mnemopay-dashboard auth proxy — /api/v1/auth/{login,apple,refresh,me} now serves real responses backed by Supabase Auth | mnemopay-landing.fly.dev |
| Claude | mnemopay-site /vs/{x402,ap2,agent-commerce-kit} comparison pages — SEO/GEO anchors for the trending competitive queries | mnemopay.com/vs/* |
| Claude | mnemopay-site sitemap.xml — 4 of my pages + Codex's regen entries (trust, browser, blog posts) all included | mnemopay.com/sitemap.xml |
| Claude | mnemopay-native-browser NOTICE + README + .github/{ci,release}.yml — committed Codex's local WIP | github.com/mnemopay/mnemopay-native-browser |
| Claude | README badges (npm + PyPI + Smithery + License) added to mnemopay-sdk + gridstamp | github READMEs |
| Codex | Real Browserbase CDP execution in mnemopay-browser providers | repo |
| Codex | Native browser evidence boundary hardening (a810a02, 8de6a8c, 4398ee7) | mnemopay-native-browser |
| Codex | Apple App Store reviewer demo creds + ASC tooling for mnemopay-mobile | mnemopay-mobile |
| Codex | Gateway external evidence notary (ce9820f) | mnemopay-gateway |

### In flight — coordinate before touching
| Owner | What | Notes |
|---|---|---|
| Codex | `feat/ap2-credential-adapter` branch on mnemopay-sdk — adds AP2 verifiable-credential adapter | If Codex names the class `AP2CredentialRail` instead of `GoogleAP2Rail`, Claude needs to update mnemopay.com/vs/ap2 code snippet |
| Codex | mnemopay-browser still has 9 non-critical audit findings deferred (1 low, 8 moderate, dev-deps mostly) | Claude's 0.1.0-alpha.1 publish unblocked the security path (qs DoS fixed); Codex can take the rest at leisure |
| Codex | Native installer signed-release pipeline — waits on Authenticode PFX cert + secrets being set | Blocked on Jeremiah's side (cert provisioning) |
| Codex | Stagehand end-to-end live test | Needs OPENAI_API_KEY at runtime — env has it; just hasn't been executed against a real session |

### Out-of-scope for either of us — Jeremiah owns
- IG re-auth via Meta developer portal token generator
- TikTok Content Posting audit submission (paste-ready doc at `Desktop/TikTok-Content-Posting-Audit-Application-2026-05-23.md`)
- Apple migration final response (Connor case 102896365021) — Claude drafted the reply; sent yesterday
- ASC Device Family + AI disclosure pastes on next MnemoPay submission

## Lane boundaries — please don't cross without flagging

| Lane | Owner |
|---|---|
| SDK core TypeScript (charter, FiscalGate, Merkle, FICO, rails internals) | Codex |
| SDK READMEs, CHANGELOG, badges, examples in docs/ | Claude |
| Browser providers (Browserbase, Stagehand, native Playwright) | Codex |
| Browser package publish + npm release flow | Claude (until Codex wants it) |
| mnemopay-site HTML pages, hero copy, SEO meta, JSON-LD, sitemap | Claude |
| mnemopay-site /proof/* + browser evidence onboarding | Codex (per recent commits) |
| Smithery, npm, PyPI metadata + tags | Claude |
| Apple ASC, EAS builds, signing, native installer release | Mostly Claude (Apple side), Codex (signing pipeline) |
| BizSuite site + clipping fulfillment + ads + outreach | Claude |
| Memory at `C:\Users\bizsu\.claude\projects\C--WINDOWS-system32\memory\` | Claude only (per-instance per-user) |

## Update protocol

When you ship something the other should know about:
1. Append a row to "Shipped — don't redo" with one-line summary
2. If a class/api name was chosen that downstream content references, note it in "In flight" too
3. Don't rewrite history — append-only

This file lives on `master` of mnemopay-sdk. Pull it before opening a session.
