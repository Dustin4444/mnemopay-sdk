# INTEGRATIONS — drop MnemoPay into the framework you already use

MnemoPay is framework-agnostic, but ships first-party adapters for the four AI runtimes that ~95% of agent code already runs on: OpenAI, Anthropic, LangGraph, and AutoGen. Every adapter is loaded from a **subpath import** (see [`SUBPATH-IMPORT-RULE.md`](./SUBPATH-IMPORT-RULE.md)) so you only pay for the runtime you actually wire up.

All four adapters share one rule: **you bring the agent, MnemoPay handles memory and money.** Recall is injected, charges are escrowed, settlements close out — your existing tool/loop code stays unchanged.

---

## OpenAI — `chat.completions` proxy

```ts
import OpenAI from "openai";
import MnemoPay from "@mnemopay/sdk";
import { OpenAIMiddleware } from "@mnemopay/sdk/middleware/openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const agent = MnemoPay.quick("openai-agent");

// Wrap the OpenAI client — same .chat.completions.create API, but every call
// now auto-recalls the top-5 memories and writes the exchange back.
const wrapped = OpenAIMiddleware.wrap(openai, agent, { recallLimit: 5 });

const response = await wrapped.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "What plan is the user on?" }],
});

console.log(response.choices[0].message.content);
// Memory is invisible — answers improve as the agent remembers more.
```

**What happens under the hood:** before the call MnemoPay calls `agent.recall(...)` and prepends a `system` message with the top-K memories. After the call, the user/assistant exchange is stored via `agent.remember(...)`. Your `chat.completions.create` callers don't know a thing.

---

## Anthropic — `messages.create` proxy + 1-hour prompt cache

```ts
import Anthropic from "@anthropic-ai/sdk";
import MnemoPay from "@mnemopay/sdk";
import { AnthropicMiddleware } from "@mnemopay/sdk/middleware/anthropic";

const anthropic = new Anthropic();
const agent = MnemoPay.quick("claude-agent");

const wrapped = AnthropicMiddleware.wrap(anthropic, agent, { recallLimit: 5 });

const response = await wrapped.messages.create({
  model: "claude-opus-4-7",
  max_tokens: 1024,
  system: "You are a helpful assistant.",
  messages: [{ role: "user", content: "What plan is the user on?" }],
});
```

For multi-turn Claude Agent SDK workflows where the same recall payload is reused, use the lower-level `formatForClaudeCache()` helper to write the recall into Anthropic's 1-hour ephemeral cache. See [`agent-sdk-guide.md`](./agent-sdk-guide.md) for the full pattern.

---

## LangGraph — tools for `createReactAgent`

```ts
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import MnemoPay from "@mnemopay/sdk";
import { mnemoTools, agentPayTools } from "@mnemopay/sdk/langgraph";

const agent = MnemoPay.quick("langgraph-agent");

const graph = createReactAgent({
  llm: new ChatAnthropic({ model: "claude-sonnet-4-7" }),
  tools: [
    ...mnemoTools(agent),    // recall_memories, store_memory, reinforce_memory
    ...agentPayTools(agent), // charge, settle, refund, get_balance
  ],
});

await graph.invoke({
  messages: [{ role: "user", content: "Bill the user $25 for this month." }],
});
```

The LangGraph model can now call `store_memory`, `recall_memories`, and `charge` directly as ReAct tools. Charter constraints, fraud detection, and Agent Credit Score still apply — invalid tool calls fail closed.

---

## AutoGen — tool functions for `AssistantAgent`

AutoGen doesn't have a first-party adapter yet (planned for v1.10) but its [function-calling registration](https://microsoft.github.io/autogen/0.2/docs/Use-Cases/agent_chat/) takes plain JS functions, so wiring MnemoPay is three lines:

```ts
import MnemoPay from "@mnemopay/sdk";
// AutoGen 0.4 uses the @autogen npm package; substitute your version's import.
import { AssistantAgent, register_function } from "@autogen/core";

const agent = MnemoPay.quick("autogen-agent");

const assistant = new AssistantAgent({
  name: "billing-bot",
  llm_config: { model: "gpt-4o" },
});

register_function(
  async ({ amount, reason }: { amount: number; reason: string }) => {
    const tx = await agent.charge(amount, reason);
    if (tx.status !== "completed") return { error: tx.status };
    await agent.settle(tx.id);
    return { txId: tx.id, status: "settled" };
  },
  {
    caller: assistant,
    name: "bill_user",
    description: "Charge the user and settle. Returns txId.",
  },
);

register_function(
  async ({ content }: { content: string }) => agent.remember(content),
  { caller: assistant, name: "remember", description: "Store a memory." },
);
```

Same pattern fits **CrewAI**, **Microsoft Semantic Kernel**, **Vercel AI SDK**, **AWS Bedrock Agents**, and any other framework that accepts a plain callable as a tool. The MnemoPay agent stays in scope; you bridge into the framework's tool surface.

---

## Bring-your-own loop (no framework)

If you wrote your own agent loop, just call MnemoPay directly:

```ts
import MnemoPay from "@mnemopay/sdk";

const agent = MnemoPay.quick("custom-agent");

async function turn(userMessage: string) {
  const memories = await agent.recall(userMessage, 5);
  const llmResponse = await callYourLLM({ memories, userMessage });
  await agent.remember(`User: ${userMessage}\nAssistant: ${llmResponse}`);
  return llmResponse;
}
```

No middleware required. Memory and payments are independent surfaces — use what you need.
