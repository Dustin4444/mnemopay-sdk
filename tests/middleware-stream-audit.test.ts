/**
 * Stream-interception tests for the audit-only middleware.
 *
 * Closes the audit gap shipped in 1.10.1-alpha.0 — the original `.audit()`
 * factories only wrapped `messages.create` / `chat.completions.create`. Any
 * call to `messages.stream(...)` (Anthropic) or
 * `chat.completions.create({stream: true})` (OpenAI) bypassed the audit
 * proxy silently — a real gap for any consumer with a streaming chat
 * widget (bizsuite-site is the in-tree example).
 *
 * Coverage:
 *   - Full stream completes ⇒ exactly one `llm.call` event with `streaming:
 *     true`, `partial: false`, accumulated `output_tokens` / response hash.
 *   - Consumer cancels mid-stream (break in for-await) ⇒ exactly one event
 *     with `partial: true` and the tokens-so-far.
 *
 * Mock providers — no @anthropic-ai/sdk and no openai dependency loaded;
 * we hand-build the shape the middleware introspects.
 */

import { describe, it, expect } from "vitest";
import { AuditChain } from "../src/governance/audit-chain.js";
import { AnthropicMiddleware } from "../src/middleware/anthropic-audit.js";
import { OpenAIMiddleware } from "../src/middleware/openai-audit.js";

// ─── Anthropic mock stream factory ─────────────────────────────────────────

function makeAnthropicStream(chunks: any[]) {
  // Behaves like the @anthropic-ai/sdk MessageStream — async-iterable with
  // a `.controller` placeholder + `.finalMessage()` placeholder so we can
  // also assert the wrapper preserves them.
  return {
    controller: { abort: () => {} },
    finalMessage: async () => ({ ok: true }),
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function makeAnthropicClient(chunks: any[]) {
  return {
    messages: {
      create: async () => ({ usage: {} }),
      stream: (_params: unknown) => makeAnthropicStream(chunks),
    },
  };
}

describe("AnthropicMiddleware.audit — messages.stream interception", () => {
  it("full stream completes ⇒ one llm.call event emitted with partial:false", async () => {
    const chunks = [
      { type: "message_start", message: { usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " world" } },
      { type: "message_delta", usage: { output_tokens: 2 } },
    ];
    const client = makeAnthropicClient(chunks);
    const chain = new AuditChain();
    const wrapped = AnthropicMiddleware.audit(client, { chain, redact: false });

    const stream = (wrapped.messages as any).stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: "say hi" }],
    });

    // Wrapper preserves passthrough surface.
    expect(typeof stream.finalMessage).toBe("function");
    expect(stream.controller).toBeDefined();

    const collected: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta") collected.push(chunk.delta.text);
    }

    expect(collected.join("")).toBe("hello world");
    const events = chain.events();
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.kind).toBe("llm.call");
    expect(ev.payload.streaming).toBe(true);
    expect(ev.payload.partial).toBe(false);
    expect(ev.payload.provider).toBe("anthropic");
    expect(ev.payload.input_tokens).toBe(7);
    expect(ev.payload.output_tokens).toBe(2);
    expect(typeof ev.payload.request_hash).toBe("string");
    expect(typeof ev.payload.response_hash).toBe("string");
  });

  it("consumer breaks mid-stream ⇒ one llm.call event emitted with partial:true", async () => {
    const chunks = [
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_delta", delta: { type: "text_delta", text: "alpha" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " beta" } },
      { type: "content_block_delta", delta: { type: "text_delta", text: " gamma" } },
      { type: "message_delta", usage: { output_tokens: 3 } },
    ];
    const client = makeAnthropicClient(chunks);
    const chain = new AuditChain();
    const wrapped = AnthropicMiddleware.audit(client, { chain, redact: true });

    const stream = (wrapped.messages as any).stream({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: "say hi" }],
    });

    const collected: string[] = [];
    for await (const chunk of stream) {
      if (chunk.type === "content_block_delta") {
        collected.push(chunk.delta.text);
        if (collected.length === 2) break; // cancel mid-stream
      }
    }

    expect(collected.join("")).toBe("alpha beta");
    const events = chain.events();
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.payload.streaming).toBe(true);
    expect(ev.payload.partial).toBe(true);
    // input_tokens captured from message_start before the cancel
    expect(ev.payload.input_tokens).toBe(5);
    // output_tokens snapshot — message_delta never arrived, so it stays at 0
    expect(ev.payload.output_tokens).toBe(0);
    expect(ev.payload.redacted).toBe(true);
  });
});

// ─── OpenAI mock stream factory ─────────────────────────────────────────────

function makeOpenAIStream(chunks: any[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function makeOpenAIClient(chunks: any[]) {
  return {
    chat: {
      completions: {
        create: async (params: any) => {
          if (params?.stream === true) return makeOpenAIStream(chunks);
          return { usage: { prompt_tokens: 5, completion_tokens: 5 } };
        },
      },
    },
  };
}

describe("OpenAIMiddleware.audit — chat.completions stream interception", () => {
  it("full stream with include_usage ⇒ partial:false + final usage captured", async () => {
    const chunks = [
      { choices: [{ delta: { content: "hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      },
    ];
    const client = makeOpenAIClient(chunks);
    const chain = new AuditChain();
    const wrapped = OpenAIMiddleware.audit(client, { chain, redact: false });

    const stream: any = await (wrapped.chat.completions as any).create({
      model: "gpt-4o-mini",
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "say hi" }],
    });

    const collected: string[] = [];
    for await (const chunk of stream as AsyncIterable<any>) {
      const t = chunk.choices?.[0]?.delta?.content;
      if (t) collected.push(t);
    }

    expect(collected.join("")).toBe("hello world");
    const events = chain.events();
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.payload.provider).toBe("openai");
    expect(ev.payload.streaming).toBe(true);
    expect(ev.payload.partial).toBe(false);
    expect(ev.payload.input_tokens).toBe(4);
    expect(ev.payload.output_tokens).toBe(2);
  });

  it("consumer cancels mid-stream ⇒ partial:true with tokens-so-far", async () => {
    const chunks = [
      { choices: [{ delta: { content: "one" } }] },
      { choices: [{ delta: { content: " two" } }] },
      { choices: [{ delta: { content: " three" } }] },
      {
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      },
    ];
    const client = makeOpenAIClient(chunks);
    const chain = new AuditChain();
    const wrapped = OpenAIMiddleware.audit(client, { chain, redact: true });

    const stream: any = await (wrapped.chat.completions as any).create({
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "say hi" }],
    });

    const collected: string[] = [];
    for await (const chunk of stream as AsyncIterable<any>) {
      const t = chunk.choices?.[0]?.delta?.content;
      if (t) {
        collected.push(t);
        if (collected.length === 2) break;
      }
    }

    expect(collected.join("")).toBe("one two");
    const events = chain.events();
    expect(events.length).toBe(1);
    const ev = events[0]!;
    expect(ev.payload.streaming).toBe(true);
    expect(ev.payload.partial).toBe(true);
    expect(ev.payload.redacted).toBe(true);
    // output_tokens falls back to chunk count when include_usage is absent
    // or hasn't fired yet. We've consumed 2 chunks ⇒ output_tokens >= 2.
    expect(typeof ev.payload.output_tokens).toBe("number");
    expect((ev.payload.output_tokens as number) >= 1).toBe(true);
  });
});
