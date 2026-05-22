import { describe, it, expect } from "vitest";
import { GeminiMiddleware } from "../../src/middleware/gemini.js";
import type { Memory } from "../../src/index.js";

/**
 * Minimal agent stub matching the `MnemoPayLite | MnemoPay` surface the
 * middleware actually touches: `recall(limit)` + `remember(content)`.
 * Records every call so tests can assert recall + remember behavior
 * without standing up the full SDK.
 */
function makeFakeAgent(seedMemories: Memory[] = []) {
  const recallCalls: number[] = [];
  const rememberCalls: string[] = [];
  const agent = {
    recall: async (limit: number) => {
      recallCalls.push(limit);
      return seedMemories.slice(0, limit);
    },
    remember: async (content: string) => {
      rememberCalls.push(content);
      return { id: "mem_" + rememberCalls.length, content } as any;
    },
  } as any;
  return { agent, recallCalls, rememberCalls };
}

/**
 * Mock `GoogleGenerativeAI` client. `getGenerativeModel(opts)` returns a
 * model whose `generateContent` records every call and returns a canned
 * response shaped like the real SDK output (response.response.text()).
 */
function makeFakeGenAI(opts?: { reject?: boolean }) {
  const generateCalls: any[] = [];
  const chatSendCalls: any[] = [];
  const modelInits: any[] = [];

  const client = {
    getGenerativeModel(modelOpts: any) {
      modelInits.push(modelOpts);
      return {
        async generateContent(arg: any) {
          generateCalls.push(arg);
          if (opts?.reject) {
            throw new Error("charter-denied: tool not permitted");
          }
          return {
            response: {
              text: () => "hello from gemini",
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "hello from gemini" }],
                  },
                  finishReason: "STOP",
                },
              ],
            },
          };
        },
        startChat(chatOpts?: any) {
          return {
            async sendMessage(arg: any) {
              chatSendCalls.push(arg);
              return {
                response: {
                  text: () => "chat reply",
                  candidates: [
                    {
                      content: {
                        role: "model",
                        parts: [{ text: "chat reply" }],
                      },
                    },
                  ],
                },
              };
            },
            _chatOpts: chatOpts,
          };
        },
      };
    },
  };

  return { client, generateCalls, chatSendCalls, modelInits };
}

describe("GeminiMiddleware.wrap", () => {
  it("returns a wrapped client that preserves the getGenerativeModel API", async () => {
    const { client } = makeFakeGenAI();
    const { agent } = makeFakeAgent();

    const wrapped = GeminiMiddleware.wrap(client, agent);

    expect(typeof wrapped.getGenerativeModel).toBe("function");
    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    expect(typeof model.generateContent).toBe("function");
    expect(typeof model.startChat).toBe("function");
    // Expose the agent for downstream introspection (parity with
    // OpenAI/Anthropic middlewares).
    expect((wrapped as any).memories).toBe(agent);
  });

  it("calls agent.recall() before generateContent (memory recall hook)", async () => {
    const { client } = makeFakeGenAI();
    const { agent, recallCalls } = makeFakeAgent();
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    await model.generateContent("Plan my Tuesday.");

    expect(recallCalls.length).toBe(1);
    expect(recallCalls[0]).toBe(5); // default recall limit
  });

  it("honors a custom recallLimit option", async () => {
    const { client } = makeFakeGenAI();
    const { agent, recallCalls } = makeFakeAgent();
    const wrapped = GeminiMiddleware.wrap(client, agent, { recallLimit: 12 });

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    await model.generateContent("hi");

    expect(recallCalls[0]).toBe(12);
  });

  it("injects recalled memories into systemInstruction (Recall context injection)", async () => {
    const seed: Memory[] = [
      { id: "m1", content: "user prefers terse replies", score: 0.91 } as any,
      { id: "m2", content: "user lives in Melissa TX", score: 0.83 } as any,
    ];
    const { client, generateCalls } = makeFakeGenAI();
    const { agent } = makeFakeAgent(seed);
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    await model.generateContent("Plan my Tuesday.");

    expect(generateCalls.length).toBe(1);
    const arg = generateCalls[0];
    // String input gets normalized to { contents, systemInstruction }.
    expect(typeof arg).toBe("object");
    expect(arg.systemInstruction).toBeDefined();
    const sysText =
      typeof arg.systemInstruction === "string"
        ? arg.systemInstruction
        : JSON.stringify(arg.systemInstruction);
    expect(sysText).toContain("user prefers terse replies");
    expect(sysText).toContain("user lives in Melissa TX");
    expect(sysText).toContain("Agent Memory");
  });

  it("preserves a caller-supplied systemInstruction and appends memory context", async () => {
    const seed: Memory[] = [
      { id: "m1", content: "audit-mode on", score: 0.7 } as any,
    ];
    const { client, generateCalls } = makeFakeGenAI();
    const { agent } = makeFakeAgent(seed);
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    await model.generateContent({
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      systemInstruction: "You are a strict brand-voice copyeditor.",
    });

    const arg = generateCalls[0];
    expect(typeof arg.systemInstruction).toBe("string");
    expect(arg.systemInstruction).toContain(
      "You are a strict brand-voice copyeditor.",
    );
    expect(arg.systemInstruction).toContain("audit-mode on");
  });

  it("stores the exchange via agent.remember() on success (receipt-style memory write)", async () => {
    const { client } = makeFakeGenAI();
    const { agent, rememberCalls } = makeFakeAgent();
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    await model.generateContent("What is the weather?");

    expect(rememberCalls.length).toBe(1);
    expect(rememberCalls[0]).toContain("User: What is the weather?");
    expect(rememberCalls[0]).toContain("Assistant: hello from gemini");
  });

  it("propagates provider errors (charter-style rejection short-circuits the call)", async () => {
    const { client } = makeFakeGenAI({ reject: true });
    const { agent, rememberCalls } = makeFakeAgent();
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    await expect(model.generateContent("denied tool call")).rejects.toThrow(
      /charter-denied/,
    );
    // Failed call ⇒ no exchange stored (remember is only called on success).
    expect(rememberCalls.length).toBe(0);
  });

  it("returns the raw provider response unchanged", async () => {
    const { client } = makeFakeGenAI();
    const { agent } = makeFakeAgent();
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    const response = await model.generateContent("hi");

    expect(typeof response.response.text).toBe("function");
    expect(response.response.text()).toBe("hello from gemini");
    expect(response.response.candidates[0].finishReason).toBe("STOP");
  });

  it("non-blocking: remember() failures do NOT break the response", async () => {
    const { client } = makeFakeGenAI();
    const brokenAgent = {
      recall: async () => [],
      remember: async () => {
        throw new Error("storage offline");
      },
    } as any;
    const wrapped = GeminiMiddleware.wrap(client, brokenAgent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    const response = await model.generateContent("hi");
    expect(response.response.text()).toBe("hello from gemini");
  });

  it("startChat().sendMessage also injects memory and stores the exchange", async () => {
    const seed: Memory[] = [
      { id: "m1", content: "prefers bullet points", score: 0.65 } as any,
    ];
    const { client, chatSendCalls } = makeFakeGenAI();
    const { agent, recallCalls, rememberCalls } = makeFakeAgent(seed);
    const wrapped = GeminiMiddleware.wrap(client, agent);

    const model = wrapped.getGenerativeModel({ model: "gemini-1.5-flash" });
    const chat = model.startChat({ history: [] });
    await chat.sendMessage("First turn.");

    expect(recallCalls.length).toBe(1);
    expect(chatSendCalls.length).toBe(1);
    // Memory context is prepended to the user message in chat sessions
    // (sendMessage doesn't expose systemInstruction per-message).
    const sent = chatSendCalls[0];
    expect(typeof sent).toBe("string");
    expect(sent).toContain("prefers bullet points");
    expect(sent).toContain("First turn.");
    expect(rememberCalls.length).toBe(1);
    expect(rememberCalls[0]).toContain("User: First turn.");
    expect(rememberCalls[0]).toContain("Assistant: chat reply");
  });
});
