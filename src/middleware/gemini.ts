/**
 * Gemini Middleware — wraps any `@google/generative-ai` client so memory
 * becomes invisible.
 *
 * Every `generateContent` (and `startChat().sendMessage`) call automatically:
 * 1. Recalls the top 5 memories and injects them as `systemInstruction`
 * 2. Calls Gemini with the enriched request
 * 3. Stores the conversation exchange as a new memory
 * 4. Returns the response exactly as `@google/generative-ai` would
 *
 * Sister to `MnemoPayMiddleware.wrap` (OpenAI) and
 * `AnthropicMiddleware.wrap` (Anthropic) — same API shape, same hooks,
 * different provider SDK. Mounted under `@mnemopay/sdk/middleware/gemini`.
 *
 * Why hook at `getGenerativeModel`: the Google Gen AI SDK shape is
 *   `genAI.getGenerativeModel({ model, systemInstruction }).generateContent(...)`
 * — i.e. the systemInstruction can be supplied at MODEL construction OR per
 * call. We Proxy the top-level `genAI` so every model returned from
 * `getGenerativeModel` is itself proxied, letting us tap both surfaces
 * (`generateContent` + `startChat().sendMessage`) without forcing callers to
 * restructure how they construct models.
 */

import type { MnemoPayLite, MnemoPay, Memory } from "../index.js";

type Agent = MnemoPayLite | MnemoPay;

/** A Gemini-style content part — `{text}` is the common case. */
interface ContentPart {
  text?: string;
  [key: string]: unknown;
}

/** A Gemini-style content turn — `role` + ordered `parts`. */
interface Content {
  role?: string;
  parts: ContentPart[];
}

/**
 * Argument shape accepted by `model.generateContent(...)`. The Google SDK
 * accepts either a bare string, a flat `parts` array, or a full
 * `GenerateContentRequest` object with `contents` + optional
 * `systemInstruction`. We normalize to the request-object form so we can
 * uniformly inject systemInstruction.
 */
type GenerateContentArg =
  | string
  | ContentPart[]
  | {
      contents?: Content[] | string;
      systemInstruction?: string | Content | { parts: ContentPart[] };
      [key: string]: unknown;
    };

interface GenerativeModelLike {
  generateContent: (arg: GenerateContentArg, ...rest: any[]) => Promise<any>;
  startChat?: (opts?: any) => ChatSessionLike;
  [key: string]: unknown;
}

interface ChatSessionLike {
  sendMessage: (arg: string | ContentPart[], ...rest: any[]) => Promise<any>;
  [key: string]: unknown;
}

interface GoogleGenAILike {
  getGenerativeModel: (opts: any, ...rest: any[]) => GenerativeModelLike;
  [key: string]: unknown;
}

function formatMemoriesAsContext(memories: Memory[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map(
    (m, i) => `[Memory ${i + 1}] ${m.content} (relevance: ${m.score.toFixed(2)})`,
  );
  return (
    "\n\n--- Agent Memory (auto-injected by MnemoPay) ---\n" +
    lines.join("\n") +
    "\n--- End Memory ---\n"
  );
}

type SystemInstruction = string | { role?: string; parts: ContentPart[] };

/**
 * Normalize the various forms `systemInstruction` can take in the Gemini
 * SDK (string | Content | { parts }) into a single string we can append
 * memory context to. Returns the merged value in the SDK-accepted shape.
 */
function mergeSystemInstruction(
  existing: unknown,
  memoryContext: string,
): SystemInstruction {
  if (existing == null) {
    return `You are a helpful assistant with persistent memory.${memoryContext}`;
  }
  if (typeof existing === "string") {
    return existing + memoryContext;
  }
  // Object form { role?, parts: [{text}] } — append a text part.
  const obj = existing as { role?: string; parts?: ContentPart[] };
  if (Array.isArray(obj.parts)) {
    return {
      ...obj,
      parts: [...obj.parts, { text: memoryContext }],
    };
  }
  // Unknown shape — fall back to wrapping with a sane default.
  return `You are a helpful assistant with persistent memory.${memoryContext}`;
}

/**
 * Extract the user-side text from whatever `generateContent` was called
 * with. Falls back to "[no user message]" if no text part is found.
 */
function extractUserText(arg: GenerateContentArg): string {
  if (typeof arg === "string") return arg;
  if (Array.isArray(arg)) {
    const parts = arg as ContentPart[];
    const text = parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
    return text || "[no user message]";
  }
  const obj = arg as { contents?: Content[] | string };
  if (typeof obj?.contents === "string") return obj.contents;
  if (Array.isArray(obj?.contents)) {
    // Last user turn wins.
    const lastUser = [...obj.contents]
      .reverse()
      .find((c) => (c?.role ?? "user") === "user");
    if (lastUser?.parts) {
      const text = lastUser.parts
        .map((p) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return "[no user message]";
}

/** Pull assistant text out of a Gemini `generateContent` response. */
function extractAssistantText(response: any): string {
  try {
    // Modern SDK: response.response.text() is a function.
    const inner = response?.response;
    if (inner && typeof inner.text === "function") {
      const t = inner.text();
      if (typeof t === "string" && t.length) return t;
    }
    // Direct candidates → parts → text walk.
    const candidates = inner?.candidates ?? response?.candidates;
    if (Array.isArray(candidates) && candidates.length) {
      const parts: ContentPart[] | undefined = candidates[0]?.content?.parts;
      if (Array.isArray(parts)) {
        const text = parts
          .map((p) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n");
        if (text) return text;
      }
    }
  } catch {
    // fall through
  }
  return "[no response]";
}

/**
 * Inject memory into a `generateContent` argument. Returns a
 * GenerateContentRequest-shaped object regardless of input shape — the
 * Google SDK accepts the object form universally, so we normalize for
 * simplicity. When `memoryContext` is empty, the original argument is
 * returned unchanged.
 */
function injectMemoryIntoGenerateArg(
  arg: GenerateContentArg,
  memoryContext: string,
): GenerateContentArg {
  if (!memoryContext) return arg;
  if (typeof arg === "string") {
    const out: {
      contents: Content[];
      systemInstruction: SystemInstruction;
    } = {
      contents: [{ role: "user", parts: [{ text: arg }] }],
      systemInstruction: mergeSystemInstruction(undefined, memoryContext),
    };
    return out;
  }
  if (Array.isArray(arg)) {
    const out: {
      contents: Content[];
      systemInstruction: SystemInstruction;
    } = {
      contents: [{ role: "user", parts: arg }],
      systemInstruction: mergeSystemInstruction(undefined, memoryContext),
    };
    return out;
  }
  return {
    ...arg,
    systemInstruction: mergeSystemInstruction(arg.systemInstruction, memoryContext),
  };
}

export class GeminiMiddleware {
  /**
   * Wrap a `GoogleGenerativeAI` instance. Returns a proxy with an
   * identical API, but every model returned from `getGenerativeModel`
   * has its `generateContent` (and chat-session `sendMessage`)
   * auto-injecting + storing memories.
   *
   * @example
   *   import { GoogleGenerativeAI } from "@google/generative-ai";
   *   import { GeminiMiddleware } from "@mnemopay/sdk/middleware/gemini";
   *
   *   const raw = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
   *   const genAI = GeminiMiddleware.wrap(raw, agent);
   *   const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
   *   const r = await model.generateContent("Plan my Tuesday.");
   */
  static wrap<T extends GoogleGenAILike>(
    client: T,
    agent: Agent,
    opts?: { recallLimit?: number },
  ): T & { memories: Agent } {
    const recallLimit = opts?.recallLimit ?? 5;

    const wrapModel = (model: GenerativeModelLike): GenerativeModelLike => {
      const originalGenerate = model.generateContent.bind(model);
      const originalStartChat = model.startChat
        ? model.startChat.bind(model)
        : undefined;

      const wrappedGenerate = async (
        arg: GenerateContentArg,
        ...rest: any[]
      ) => {
        // 1. Recall memories.
        const memories = await agent.recall(recallLimit);
        const memoryContext = formatMemoriesAsContext(memories);

        // 2. Inject into systemInstruction.
        const enrichedArg = injectMemoryIntoGenerateArg(arg, memoryContext);

        // 3. Call Gemini.
        const response = await originalGenerate(enrichedArg, ...rest);

        // 4. Store the exchange as a memory (non-blocking).
        try {
          const userText = extractUserText(arg).slice(0, 300);
          const assistantText = extractAssistantText(response).slice(0, 300);
          await agent.remember(`User: ${userText}\nAssistant: ${assistantText}`);
        } catch {
          // Non-blocking: don't fail the response if memory store fails.
        }

        return response;
      };

      const wrappedStartChat = originalStartChat
        ? (chatOpts: any = {}) => {
            // Memory-augment the chat session's systemInstruction at
            // session-start time. Each sendMessage call re-injects the
            // CURRENT top-5 memories so long-running chat sessions still
            // see fresh recall context.
            const session = originalStartChat(chatOpts);
            const originalSend = session.sendMessage.bind(session);
            const wrappedSend = async (
              arg: string | ContentPart[],
              ...rest: any[]
            ) => {
              const memories = await agent.recall(recallLimit);
              const memoryContext = formatMemoriesAsContext(memories);
              // Chat session sendMessage doesn't expose systemInstruction
              // per-message — prepend memory context to the user message
              // itself when present.
              let effectiveArg: string | ContentPart[] = arg;
              if (memoryContext) {
                if (typeof arg === "string") {
                  effectiveArg = memoryContext + "\n\n" + arg;
                } else if (Array.isArray(arg)) {
                  effectiveArg = [{ text: memoryContext }, ...arg];
                }
              }
              const response = await originalSend(effectiveArg, ...rest);
              try {
                const userText =
                  (typeof arg === "string"
                    ? arg
                    : Array.isArray(arg)
                      ? arg
                          .map((p) => (typeof p?.text === "string" ? p.text : ""))
                          .filter(Boolean)
                          .join("\n")
                      : "[no user message]"
                  ).slice(0, 300);
                const assistantText = extractAssistantText(response).slice(0, 300);
                await agent.remember(
                  `User: ${userText}\nAssistant: ${assistantText}`,
                );
              } catch {
                // non-blocking
              }
              return response;
            };

            return new Proxy(session, {
              get(target, prop) {
                if (prop === "sendMessage") return wrappedSend;
                return (target as any)[prop];
              },
            });
          }
        : undefined;

      return new Proxy(model, {
        get(target, prop) {
          if (prop === "generateContent") return wrappedGenerate;
          if (prop === "startChat" && wrappedStartChat) return wrappedStartChat;
          return (target as any)[prop];
        },
      });
    };

    const proxy = new Proxy(client, {
      get(target, prop) {
        if (prop === "memories") return agent;
        if (prop === "getGenerativeModel") {
          return (...args: any[]) => {
            const model = (target.getGenerativeModel as any).apply(target, args);
            return wrapModel(model);
          };
        }
        return (target as any)[prop];
      },
    });

    return proxy as T & { memories: Agent };
  }
}
