# MnemoPay product surface — unified messaging (2026-05-21)

Three "browser/code" products exist, with overlapping names. Public messaging
must keep them distinct so prospects don't mistake one for another.

## The three products

| Product | Repo | Form factor | Buyer | Status |
|---|---|---|---|---|
| **@mnemopay/sdk** | `mnemopay-sdk` (public) | npm package | any AI engineer | Apache-2.0, npm latest 1.9.0 |
| **@mnemopay/coding-agent** | `mnemopay-code` (private) | CLI + middleware | regulated-enterprise eng leads (banks, healthcare, defense) | private, $200-500/seat/mo |
| **mnemopay-browser** | `mnemopay-browser` (private) | SDK wrapper | agent builders needing trusted browser sessions | private, thin trust+state layer over Browserbase/Stagehand/Playwright |
| **mnemopay-native-browser** | `mnemopay-native-browser` (private) | desktop binary (Tauri 2 + Rust) | end users wanting an AI-native browser with trust built in | private alpha, v0.0.1 uses OS WebView, v1.0 path is embedded CEF |

## The one-sentence positioning

- **@mnemopay/sdk**: "The substrate SDK for any AI system that needs memory, payments, identity, governance, and cryptographic receipts."
- **@mnemopay/coding-agent**: "FiscalGate + Merkle audit + charter glob matcher as native primitives — for the agents your compliance team won't approve Cursor for."
- **mnemopay-browser**: "DID + FiscalGate + Article-12 audit, wrapping the browser session your agent already drives."
- **mnemopay-native-browser**: "A real desktop browser binary, with MnemoPay trust + state baked in at the engine level."

## What never to say

- Do NOT say "MnemoPay Browser" without qualifier — collapses two products into one
- Do NOT say "MnemoPay Code" — the npm/public name is `@mnemopay/coding-agent`
- Do NOT say "Substrate OS" — Inworld pivoted away from "OS" terminology; we use "substrate"
- Do NOT promote the SDK as "Praetor" or "agent banking" only — both are subsets, not the whole

## Where each lives

- SDK: `https://github.com/mnemopay/mnemopay-sdk` · `npm @mnemopay/sdk` · docs at `mnemopay.com`
- Coding agent: private repo · CLI install via private npm token · pilot-only
- Browser (SDK wrapper): private repo · ships as `@mnemopay/browser` peer dep of SDK
- Native browser: private repo · Tauri desktop installer · alpha access via request

## Public landing-page mapping

- `mnemopay.com` → SDK first, sub-products in nav
- `mcp.mnemopay.com` → MCP Gateway directory (lists all 4 + 3rd-party MCP servers)
- `dashboard.mnemopay.com` → operator dashboard (uses SDK under the hood)
- `api.mcp.mnemopay.com` → gateway API (Fly-hosted)
