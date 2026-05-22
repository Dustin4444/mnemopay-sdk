/**
 * OpenAI Audit-Only Middleware — pass-through wrapper that records a
 * signed audit-chain event per `chat.completions.create` call WITHOUT
 * mutating the request (no memory injection, no system-message rewriting,
 * no conversation persistence).
 *
 * Sister to `MnemoPayMiddleware.wrap` (memory-injecting) — this variant
 * exists for the same reasons as `anthropic-audit.ts`: callers who need
 * Article-12 telemetry but cannot afford prompt mutation.
 *
 * Pricing note: OpenAI model pricing is not present in `MODEL_PRICING`
 * yet (the table is Anthropic-only — see `subagent-cost.ts`). Until that
 * table is expanded, `cost_estimate_usd` returns null for OpenAI models.
 * The audit event still records the token counts so downstream cost
 * computation can be done off-line.
 */

import { createHash } from "node:crypto";
import type { AuditChain } from "../governance/audit-chain.js";
import { canonicalize } from "../governance/audit-chain.js";
import { MODEL_PRICING, computeSubagentCost } from "../subagent-cost.js";

export interface OpenAIAuditOptions {
  /** Persistence sink. If omitted, audit is a no-op. */
  chain?: AuditChain;
  /**
   * When true (default), strip prompt/response text from the hashes so
   * the audit log carries only structural fingerprints — no PII content.
   */
  redact?: boolean;
}

interface ChatMessage {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

interface CreateParams {
  model: string;
  messages: ChatMessage[];
  [key: string]: unknown;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAILike {
  chat: {
    completions: {
      create: (...args: any[]) => Promise<any>;
    };
  };
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function redactParams(params: CreateParams): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...params };
  if (Array.isArray(params.messages)) {
    cloned.messages = params.messages.map((m) => ({
      role: m.role,
      content: "[redacted]",
    }));
  }
  return cloned;
}

function redactResponse(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const r = response as Record<string, unknown>;
  const cloned: Record<string, unknown> = { ...r };
  if (Array.isArray(r.choices)) {
    cloned.choices = r.choices.map((c: unknown) => {
      if (!c || typeof c !== "object") return c;
      const ch = c as Record<string, unknown>;
      const msg = ch.message as Record<string, unknown> | undefined;
      return {
        ...ch,
        message: msg ? { role: msg.role, content: "[redacted]" } : msg,
      };
    });
  }
  return cloned;
}

function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
): number | null {
  if (!MODEL_PRICING[modelId]) return null;
  try {
    const { totalCostUsd } = computeSubagentCost({
      modelId,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTtl: "5m",
    });
    return totalCostUsd;
  } catch {
    return null;
  }
}

export class OpenAIMiddleware {
  /**
   * Audit-only OpenAI wrapper. Returns a proxy with an identical API
   * that forwards every `chat.completions.create` call unchanged, then
   * appends a `llm.call` event to `opts.chain` (if provided).
   *
   * Streaming flows (`params.stream === true`): the returned async-iterable
   * stream is wrapped so chunk deltas accumulate, and one `llm.call` event
   * is emitted at iterator close (full or partial). The streaming response
   * does not carry a final `usage` block by default — set
   * `params.stream_options = { include_usage: true }` to surface token
   * counts; otherwise output_tokens is recorded as the delta count.
   */
  static audit<T extends OpenAILike>(client: T, opts: OpenAIAuditOptions = {}): T {
    const redact = opts.redact ?? true;
    const chain = opts.chain;
    const originalCreate = client.chat.completions.create.bind(client.chat.completions);

    /** Wrap a streaming chat.completions response so iteration is observed. */
    const wrapChatStream = (params: CreateParams, underlying: any) => {
      if (!chain || !underlying) return underlying;

      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let accumulatedText = "";
      let chunkCount = 0;
      let emitted = false;

      const emitAuditEvent = (partial: boolean, errMsg?: string) => {
        if (emitted) return;
        emitted = true;
        try {
          const requestForHash = redact ? redactParams(params) : params;
          const responseShape = redact
            ? { choices: [{ message: { role: "assistant", content: "[redacted]" } }] }
            : { choices: [{ message: { role: "assistant", content: accumulatedText } }] };
          const requestHash = sha256Hex(canonicalize(requestForHash));
          const responseHash = sha256Hex(canonicalize(responseShape as unknown));
          const finalOutputTokens = outputTokens || chunkCount;
          const cost = estimateCostUsd(params.model, inputTokens, finalOutputTokens, cacheRead);
          chain.emit("llm.call", {
            provider: "openai",
            model: params.model,
            streaming: true,
            partial,
            ...(errMsg ? { error: errMsg } : {}),
            input_tokens: inputTokens,
            output_tokens: finalOutputTokens,
            cached_tokens: cacheRead,
            cost_estimate_usd: cost,
            request_hash: requestHash,
            response_hash: responseHash,
            redacted: redact,
            ts: new Date().toISOString(),
          });
        } catch (err) {
          console.warn(
            "[mnemopay/middleware/openai-audit] stream audit append failed:",
            (err as Error).message,
          );
        }
      };

      const tapChunk = (chunk: any) => {
        if (!chunk || typeof chunk !== "object") return;
        chunkCount++;
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === "string") accumulatedText += text;
        // include_usage option ⇒ final chunk carries .usage
        if (chunk.usage) {
          const u = chunk.usage as OpenAIUsage;
          if (typeof u.prompt_tokens === "number") inputTokens = u.prompt_tokens;
          if (typeof u.completion_tokens === "number") outputTokens = u.completion_tokens;
          if (typeof u.prompt_tokens_details?.cached_tokens === "number") {
            cacheRead = u.prompt_tokens_details.cached_tokens;
          }
        }
      };

      const tappedIterator = () => {
        const sourceIter = underlying[Symbol.asyncIterator]
          ? underlying[Symbol.asyncIterator]()
          : underlying;
        return {
          async next() {
            try {
              const r = await sourceIter.next();
              if (r.done) {
                emitAuditEvent(false);
              } else {
                tapChunk(r.value);
              }
              return r;
            } catch (err) {
              emitAuditEvent(true, (err as Error).message);
              throw err;
            }
          },
          async return(value?: unknown) {
            emitAuditEvent(true);
            if (typeof sourceIter.return === "function") {
              return sourceIter.return(value);
            }
            return { value, done: true };
          },
          async throw(err: unknown) {
            emitAuditEvent(true, (err as Error)?.message);
            if (typeof sourceIter.throw === "function") {
              return sourceIter.throw(err);
            }
            throw err;
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        };
      };

      return new Proxy(underlying, {
        get(target, prop, receiver) {
          if (prop === Symbol.asyncIterator) return tappedIterator;
          return Reflect.get(target, prop, receiver);
        },
      });
    };

    const wrappedCreate = async (params: CreateParams, ...rest: any[]) => {
      const response = await originalCreate(params, ...rest);

      // Streaming path: `params.stream === true` ⇒ response is an async iterable.
      if (params && (params as any).stream === true) {
        return wrapChatStream(params, response);
      }

      if (chain) {
        try {
          const requestForHash = redact ? redactParams(params) : params;
          const responseForHash = redact ? redactResponse(response) : response;
          const requestHash = sha256Hex(canonicalize(requestForHash));
          const responseHash = sha256Hex(canonicalize(responseForHash as unknown));
          const usage: OpenAIUsage = (response?.usage ?? {}) as OpenAIUsage;
          const inputTokens = usage.prompt_tokens ?? 0;
          const outputTokens = usage.completion_tokens ?? 0;
          const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? 0;
          const cost = estimateCostUsd(params.model, inputTokens, outputTokens, cacheRead);

          chain.emit("llm.call", {
            provider: "openai",
            model: params.model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cached_tokens: cacheRead,
            cost_estimate_usd: cost,
            request_hash: requestHash,
            response_hash: responseHash,
            redacted: redact,
            ts: new Date().toISOString(),
          });
        } catch (err) {
          console.warn(
            "[mnemopay/middleware/openai-audit] audit append failed:",
            (err as Error).message,
          );
        }
      }

      return response;
    };

    return new Proxy(client, {
      get(target, prop) {
        if (prop === "chat") {
          return new Proxy(target.chat, {
            get(chatTarget, chatProp) {
              if (chatProp === "completions") {
                return new Proxy(chatTarget.completions, {
                  get(compTarget, compProp) {
                    if (compProp === "create") return wrappedCreate;
                    return (compTarget as any)[compProp];
                  },
                });
              }
              return (chatTarget as any)[chatProp];
            },
          });
        }
        return (target as any)[prop];
      },
    }) as T;
  }
}
