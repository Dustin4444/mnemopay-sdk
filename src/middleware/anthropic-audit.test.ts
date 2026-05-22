import { describe, it, expect } from "vitest";
import { AnthropicMiddleware } from "./anthropic-audit.js";
import { AuditChain } from "../governance/audit-chain.js";

function makeFakeClient() {
  const calls: any[] = [];
  const client = {
    messages: {
      async create(params: any) {
        calls.push(params);
        return {
          id: "msg_test",
          content: [{ type: "text", text: "hello world" }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
      otherMethod: () => "untouched",
    },
  };
  return { client, calls };
}

describe("AnthropicMiddleware.audit", () => {
  it("forwards request UNCHANGED — no memory injection, no system mutation", async () => {
    const { client, calls } = makeFakeClient();
    const wrapped = AnthropicMiddleware.audit(client);

    const params = {
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      system: "You are a strict brand-voice copyeditor.",
      messages: [{ role: "user", content: "Test message" }],
    };
    await wrapped.messages.create(params);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(params);
    expect(calls[0].system).toBe("You are a strict brand-voice copyeditor.");
  });

  it("returns response unchanged", async () => {
    const { client } = makeFakeClient();
    const wrapped = AnthropicMiddleware.audit(client);

    const response = await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.id).toBe("msg_test");
    expect(response.content[0].text).toBe("hello world");
  });

  it("appends one llm.call event per request to the chain", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = AnthropicMiddleware.audit(client, { chain });

    await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    const events = chain.events();
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("llm.call");
    expect(events[0].payload.provider).toBe("anthropic");
    expect(events[0].payload.model).toBe("claude-sonnet-4-6");
    expect(events[0].payload.input_tokens).toBe(100);
    expect(events[0].payload.output_tokens).toBe(50);
    expect(events[0].payload.redacted).toBe(true);
  });

  it("computes cost_estimate_usd for known models", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = AnthropicMiddleware.audit(client, { chain });

    await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    const ev = chain.events()[0];
    // 100/1M * $3 + 50/1M * $15 = 0.0003 + 0.00075 = 0.00105
    expect(ev.payload.cost_estimate_usd).toBeCloseTo(0.00105, 5);
  });

  it("returns null cost_estimate_usd for unknown models", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = AnthropicMiddleware.audit(client, { chain });

    await wrapped.messages.create({
      model: "claude-future-9",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    const ev = chain.events()[0];
    expect(ev.payload.cost_estimate_usd).toBe(null);
  });

  it("produces stable request_hash + response_hash", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = AnthropicMiddleware.audit(client, { chain });

    await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });

    const ev = chain.events()[0];
    expect(ev.payload.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.payload.response_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redact:true strips message content from hash inputs", async () => {
    const { client } = makeFakeClient();
    const chainA = new AuditChain();
    const chainB = new AuditChain();
    const wrappedA = AnthropicMiddleware.audit(client, { chain: chainA });
    const wrappedB = AnthropicMiddleware.audit(client, { chain: chainB });

    await wrappedA.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "totally different prompt A" }],
    });
    await wrappedB.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "completely other prompt B" }],
    });

    // Same model + same shape → identical redacted request_hash even
    // though the prompts differ.
    expect(chainA.events()[0].payload.request_hash).toBe(
      chainB.events()[0].payload.request_hash,
    );
  });

  it("redact:false produces different hashes for different content", async () => {
    const { client } = makeFakeClient();
    const chainA = new AuditChain();
    const chainB = new AuditChain();
    const wrappedA = AnthropicMiddleware.audit(client, { chain: chainA, redact: false });
    const wrappedB = AnthropicMiddleware.audit(client, { chain: chainB, redact: false });

    await wrappedA.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "prompt A" }],
    });
    await wrappedB.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "prompt B" }],
    });

    expect(chainA.events()[0].payload.request_hash).not.toBe(
      chainB.events()[0].payload.request_hash,
    );
  });

  it("no chain → silent no-op (no crash, request still forwards)", async () => {
    const { client, calls } = makeFakeClient();
    const wrapped = AnthropicMiddleware.audit(client);

    const response = await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls.length).toBe(1);
    expect(response.id).toBe("msg_test");
  });

  it("audit-append errors do not break the LLM call", async () => {
    const { client } = makeFakeClient();
    const brokenChain = {
      emit: () => {
        throw new Error("chain disk full");
      },
    } as unknown as AuditChain;
    const wrapped = AnthropicMiddleware.audit(client, { chain: brokenChain });

    const response = await wrapped.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.id).toBe("msg_test");
  });

  it("preserves other properties on the messages object", async () => {
    const { client } = makeFakeClient();
    const wrapped = AnthropicMiddleware.audit(client);
    // @ts-expect-error — accessing the unwrapped sibling method via the proxy
    expect(wrapped.messages.otherMethod()).toBe("untouched");
  });
});
