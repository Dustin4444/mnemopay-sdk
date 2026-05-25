# MnemoPay SDK — Session Log

Records significant SDK / ecosystem activity per session. Append-only.

---

## 2026-05-23 — Campaign launch + ops infra + cross-billing fix

### SDK / Gateway

- **mnemopay-gateway v0.0.2 LIVE** on `mcp-gateway-api.fly.dev` + `api.mcp.mnemopay.com`. DB-first skills route with seed fallback. 95/95 tests. Committed at `1ee608b`, pushed to `mnemopay/mnemopay-gateway` main branch.
- **@mnemopay/sdk** master pushed: 2 prior commits caught up (`fb46524` BENCHMARKS addendum, `43f1e83` README surface). Memory had incorrectly claimed both already pushed.
- **mnemopay@1.1.0 PyPI** source tree committed + pushed (Paystack + Lightning rails at TS parity, 435/435 tests). Source was behind the live PyPI tag.
- **mnemopay-mobile-sdk** 1 unpushed commit `6118864` (security hardening) pushed to origin.
- **mnemopay-paperclip-plugin** dist/ untracked + .gitignore patched, committed `79312d3`.

### Cross-billing fix (CRITICAL for future sessions)

Built `bizsuite-site/marketing/systems/x-creds.js`. **All X-touching scripts MUST import `getTwitterCreds(handle)` instead of reading raw `TWITTER_API_KEY/SECRET` from env.** The generic env keys map to the BizSuite X project, so any operation against @Mnemopay handle using them was charging BizSuite's credit pool.

Already-refactored scripts:
- `marketing/systems/publish-x-thread.js`
- `marketing/systems/delete-mnemopay-tweets.mjs`
- `marketing/systems/post-quote-tweet.mjs` (new, for QT + standalone tweets)

NOT yet refactored (do these next session):
- Any older script in `marketing/systems/` that still reads `process.env.TWITTER_API_KEY` directly.

### Ecosystem visibility audit findings (`Desktop/Search-AI-Visibility-Audit-2026-05-23.md`)

- **mnemopay brand**: Google #1 is `earezki.com` (third-party republish), mnemopay.com not in top 10 for its own brand.
- **Category keywords**: zero presence in top 50 for "ai agent payment sdk", "agent fico score", "article 12 audit chain", "audit chain for AI agents". Stripe/Google/AWS/Crossmint/Scalekit own the SERP.
- **Real package signals**: `@mnemopay/sdk` 1,022 weekly npm downloads, 3,523/month. `@mnemopay/react-native` 410/week. 5 GitHub stars on SDK repo. **MCP registry listing IS live** (`com.mnemopay/sdk` v1.11.0) — best working discovery channel today.
- **Backlinks: 2** (earezki + own Dev.to). Zero on Reddit, HN, Crunchbase, tech press.
- **3-month realistic goal**: own #1 for `mnemopay` brand (currently borrowed), top-10 for niche terms like `agent fico score` and `article 12 audit chain`, 5k weekly downloads, 50 GitHub stars. Top-10 for `ai agent payment sdk` is unrealistic vs entrenched giants.
- **Fastest needle-movers**: HN Show post, r/LocalLLaMA submission, JavaScript Weekly / Node Weekly outreach.

### Campaign

3 of the 7 X posts shipped today targeted @mnemopay specifically:
- M1 (mcp-gateway v0.0.2): `x.com/i/web/status/2058325695558725912`
- M2 (Article 12 audit chain): `x.com/i/web/status/2058325829248025041`
- M3 (SDK npm/PyPI agent-money angle): `x.com/i/web/status/2058325964044599795`

### Maileroo webhook

`mnemopay-site/api/maileroo-webhook.js` LIVE. HMAC-SHA256 verified via `MAILEROO_WEBHOOK_SECRET=43524c55...74dd`. Receives delivered/deferred/failed/rejected/complained/opened/clicked events. Persists to JSONL audit + forwards to dashboard via existing `MNEMOPAY_WEBHOOK_INGEST_SECRET` pattern. Awaiting Maileroo dashboard endpoint registration by user.

### Stripe webhook routing extended

`mnemopay-site/api/stripe-webhook.js` TEMPLATES + `planTierForPrice` now route the 3 new BizSuite Clipping products (Starter `prod_UZPenyL2CI33y0` $299 → `bizsuite_clipping_starter`, Pro `prod_UZPeqR2w2LfdXI` $599 → `bizsuite_clipping_pro`, Enterprise `prod_UZPev8b4zqCeaf` $999 → `bizsuite_clipping_enterprise`). Each fires intake-form email instead of API-key email. Template signature now takes `(_key, ctx)` so non-API products can receive context like `intakeUrl`.

### MRR dashboard

`https://mnemopay.com/admin/mrr.html` + `/api/admin/mrr.js` LIVE. Reads Stripe live data. Auth via `MNEMOPAY_ADMIN_KEY=dbbb995cbd39e4fd0d9956293815cdd6b8f8f6f40a6ed3d3a0aadee279f83ec7` in browser localStorage. Currently shows $0 MRR / 0 subs (accurate). Updates the moment first Stripe checkout completes.

### Token health

All 5 social tokens verified healthy via `bizsuite-site/marketing/systems/check-social-tokens.mjs`:
- Threads `@bizsuite_`: expires 2026-07-11 (48 days)
- IG Display (legacy): expires 2026-07-11
- IG Graph (NEW from re-OAuth tonight): non-expiring page token
- FB Page (Bizsuite): non-expiring page token
- TikTok: refresh chain 350 days

### Site canary

`bizsuite-site/marketing/systems/site-canary.mjs` covers 25 critical routes including all mnemopay.com production routes + mcp-gateway endpoints + brain.mnemopay.com/health. All 25 currently 200.

---

## Earlier sessions

See global memory at `C:\Users\bizsu\.claude\projects\C--WINDOWS-system32\memory\MEMORY.md` for the chronological session list. Recent index entries:

- 2026-05-23 full EOD (this session)
- 2026-05-23 fix pass (P0 mnemopay.com Vercel regression)
- 2026-05-22 full EOD (post-crash autopilot)
- 2026-05-22 autopilot
- 2026-05-21 strategy synthesis
- 2026-05-18 mnemopay punch list
