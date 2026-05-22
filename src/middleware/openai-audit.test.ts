import { describe, it, expect } from "vitest";
import { OpenAIMiddleware } from "./openai-audit.js";
import { AuditChain } from "../governance/audit-chain.js";

function makeFakeClient() {
  const calls: any[] = [];
  const client = {
    chat: {
      completions: {
        async create(params: any) {
          calls.push(params);
          return {
            id: "chatcmpl_test",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi back" },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 80,
              completion_tokens: 20,
              total_tokens: 100,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

describe("OpenAIMiddleware.audit", () => {
  it("forwards request UNCHANGED — no system-message injection", async () => {
    const { client, calls } = makeFakeClient();
    const wrapped = OpenAIMiddleware.audit(client);

    const params = {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "You are a strict brand-voice copyeditor." },
        { role: "user", content: "Test message" },
      ],
    };
    await wrapped.chat.completions.create(params);

    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual(params);
    expect(calls[0].messages.length).toBe(2);
    expect(calls[0].messages[0].content).toBe(
      "You are a strict brand-voice copyeditor.",
    );
  });

  it("returns response unchanged", async () => {
    const { client } = makeFakeClient();
    const wrapped = OpenAIMiddleware.audit(client);

    const response = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.id).toBe("chatcmpl_test");
    expect(response.choices[0].message.content).toBe("hi back");
  });

  it("appends one llm.call event per request to the chain", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = OpenAIMiddleware.audit(client, { chain });

    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    const events = chain.events();
    expect(events.length).toBe(1);
    expect(events[0].kind).toBe("llm.call");
    expect(events[0].payload.provider).toBe("openai");
    expect(events[0].payload.model).toBe("gpt-4o-mini");
    expect(events[0].payload.input_tokens).toBe(80);
    expect(events[0].payload.output_tokens).toBe(20);
    expect(events[0].payload.redacted).toBe(true);
  });

  it("returns null cost_estimate_usd for OpenAI models (not in pricing table)", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = OpenAIMiddleware.audit(client, { chain });

    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    const ev = chain.events()[0];
    expect(ev.payload.cost_estimate_usd).toBe(null);
  });

  it("produces stable hash format", async () => {
    const { client } = makeFakeClient();
    const chain = new AuditChain();
    const wrapped = OpenAIMiddleware.audit(client, { chain });

    await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });

    const ev = chain.events()[0];
    expect(ev.payload.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.payload.response_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("redact:true → identical hashes for different prompts of same shape", async () => {
    const { client } = makeFakeClient();
    const chainA = new AuditChain();
    const chainB = new AuditChain();

    const wrappedA = OpenAIMiddleware.audit(client, { chain: chainA });
    const wrappedB = OpenAIMiddleware.audit(client, { chain: chainB });

    await wrappedA.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "prompt A" }],
    });
    await wrappedB.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "totally different prompt B" }],
    });

    expect(chainA.events()[0].payload.request_hash).toBe(
      chainB.events()[0].payload.request_hash,
    );
  });

  it("redact:false → different hashes for different content", async () => {
    const { client } = makeFakeClient();
    const chainA = new AuditChain();
    const chainB = new AuditChain();

    const wrappedA = OpenAIMiddleware.audit(client, { chain: chainA, redact: false });
    const wrappedB = OpenAIMiddleware.audit(client, { chain: chainB, redact: false });

    await wrappedA.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "prompt A" }],
    });
    await wrappedB.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "prompt B" }],
    });

    expect(chainA.events()[0].payload.request_hash).not.toBe(
      chainB.events()[0].payload.request_hash,
    );
  });

  it("no chain → silent no-op", async () => {
    const { client, calls } = makeFakeClient();
    const wrapped = OpenAIMiddleware.audit(client);

    const response = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(calls.length).toBe(1);
    expect(response.id).toBe("chatcmpl_test");
  });

  it("audit append errors do not break the LLM call", async () => {
    const { client } = makeFakeClient();
    const brokenChain = {
      emit: () => {
        throw new Error("chain disk full");
      },
    } as unknown as AuditChain;
    const wrapped = OpenAIMiddleware.audit(client, { chain: brokenChain });

    const response = await wrapped.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(response.id).toBe("chatcmpl_test");
  });
});
