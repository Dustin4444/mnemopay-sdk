# Examples

Runnable snippets for `@mnemopay/sdk`. All examples use `npx tsx` from the repo root.

| # | File | What it shows |
|---|------|----------------|
| 01 | [01-quick-start.ts](./01-quick-start.ts) | Memory + charge + settle in 5 lines |
| 02 | [02-openai-middleware.ts](./02-openai-middleware.ts) | OpenAI client with auto-recall |
| 03 | [03-anthropic-middleware.ts](./03-anthropic-middleware.ts) | Anthropic client with auto-recall |
| 04 | [04-langgraph-agent.ts](./04-langgraph-agent.ts) | LangGraph tools |
| 05 | [05-agents-hiring-agents.ts](./05-agents-hiring-agents.ts) | Multi-agent payments |
| 06 | [06-production.ts](./06-production.ts) | Production-shaped setup |
| 07 | [07-recall-anchor.ts](./07-recall-anchor.ts) | Ed25519 memory anchoring |
| **08** | **[08-invoice-collector.ts](./08-invoice-collector.ts)** | **Governed skill + approvals + action ledger** |

## Invoice Collector (recommended for trust stack demo)

```bash
npx tsx examples/08-invoice-collector.ts
```

Shows MnemoSkills permissions, policy approval gates, and Merkle-backed action ledger — the pattern for any agent that touches money.

See also: [docs/permissions.md](../docs/permissions.md) · [docs/action-ledger.md](../docs/action-ledger.md)
