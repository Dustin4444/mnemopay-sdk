/**
 * Anthropic Audit-Only Middleware — pass-through wrapper that records
 * a signed audit-chain event per `messages.create` call WITHOUT mutating
 * the request (no memory injection, no system-prompt rewriting, no
 * conversation persistence).
 *
 * Sister to `AnthropicMiddleware.wrap` (memory-injecting) — this one is
 * for callers who need Article-12 export / audit chain integrity but
 * MUST NOT alter the request shape (e.g. chat widgets where brand voice
 * is curated by a system prompt the operator has manually tuned, or
 * compliance contexts where prompt mutation is itself a violation).
 *
 * Design invariants (called out for downstream auditors):
 *   1. Request body is forwarded unchanged. The audit event's
 *      `request_hash` is computed over the SHA-256 of the canonicalized
 *      params; when `opts.redact === true` (default) the `messages.content`
 *      and `system` fields are stripped before hashing so the audit log
 *      never carries raw user prompts — only the structural shape.
 *   2. Response is forwarded unchanged. `response_hash` is computed the
 *      same way; for `redact:true`, response text content is stripped.
 *   3. `opts.chain` is the persistence sink (an `AuditChain` instance
 *      from `@mnemopay/sdk/governance/audit-chain`). If absent, the
 *      wrapper degrades to a NO-OP audit and still forwards the call.
 *   4. Cost estimate uses the existing `MODEL_PRICING` table from
 *      `subagent-cost.ts`. Unknown models record `cost_estimate_usd: null`.
 *   5. Errors in the audit append are caught and `console.warn`'d, never
 *      propagated to the caller — the audit must not break the LLM call.
 */

import { createHash } from "node:crypto";
import type { AuditChain } from "../governance/audit-chain.js";
import { canonicalize } from "../governance/audit-chain.js";
import { computeSubagentCost, MODEL_PRICING } from "../subagent-cost.js";

export interface AnthropicAuditOptions {
  /** Persistence sink. If omitted, audit is a no-op. */
  chain?: AuditChain;
  /**
   * When true (default), strip prompt/response text from the hashes so the
   * audit log carries only structural fingerprints — no PII content.
   * Set false ONLY when the chain itself is encrypted-at-rest and the
   * raw prompt fingerprint is needed for replay verification.
   */
  redact?: boolean;
}

interface MessageParam {
  role: string;
  content: unknown;
  [key: string]: unknown;
}

interface CreateParams {
  model: string;
  max_tokens?: number;
  messages: MessageParam[];
  system?: unknown;
  [key: string]: unknown;
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Strip the `messages[].content` + `system` fields. Pure — does not
 * mutate the input. Used only for hashing, never to alter the request.
 */
function redactParams(params: CreateParams): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...params };
  if (Array.isArray(params.messages)) {
    cloned.messages = params.messages.map((m) => ({
      role: m.role,
      content: "[redacted]",
    }));
  }
  if (params.system !== undefined) cloned.system = "[redacted]";
  return cloned;
}

function redactResponse(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const r = response as Record<string, unknown>;
  const cloned: Record<string, unknown> = { ...r };
  if (Array.isArray(r.content)) {
    cloned.content = r.content.map((b: unknown) => {
      if (b && typeof b === "object" && (b as { type?: string }).type === "text") {
        return { type: "text", text: "[redacted]" };
      }
      return b;
    });
  }
  return cloned;
}

function estimateCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheWrite = 0,
): number | null {
  if (!MODEL_PRICING[modelId]) return null;
  try {
    const { totalCostUsd } = computeSubagentCost({
      modelId,
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      cacheWriteTtl: "5m",
    });
    return totalCostUsd;
  } catch {
    return null;
  }
}

export class AnthropicMiddleware {
  /**
   * Audit-only Anthropic wrapper. Returns a proxy with an identical API
   * that forwards every `messages.create` AND `messages.stream` call
   * unchanged, then appends a `llm.call` event to `opts.chain`.
   *
   * Streaming flows:
   *   - The returned stream object is API-compatible (still async-iterable;
   *     `.finalMessage()` / `.on()` / `.controller` etc. pass through).
   *   - The wrapper taps the underlying async iterator, accumulates
   *     `text_delta` chunks + tracks `message_start` / `message_delta` usage,
   *     and emits exactly one `llm.call` event at iterator close.
   *   - If the iterator throws or the consumer breaks out early (cancel),
   *     the event is emitted with `partial: true` and the tokens-so-far.
   *
   * Use this when you need provable LLM-call telemetry but cannot afford
   * the request mutation `AnthropicMiddleware.wrap` performs.
   */
  static audit<T extends {
    messages: {
      create: (...args: any[]) => Promise<any>;
      stream?: (...args: any[]) => any;
    };
  }>(
    client: T,
    opts: AnthropicAuditOptions = {},
  ): T {
    const redact = opts.redact ?? true;
    const chain = opts.chain;
    const originalCreate = client.messages.create.bind(client.messages);
    const originalStream = client.messages.stream
      ? client.messages.stream.bind(client.messages)
      : undefined;

    const wrappedCreate = async (params: CreateParams, ...rest: any[]) => {
      // 1. Forward request unchanged.
      const response = await originalCreate(params, ...rest);

      // 2. Append audit event — best-effort, never throws to the caller.
      if (chain) {
        try {
          const requestForHash = redact ? redactParams(params) : params;
          const responseForHash = redact ? redactResponse(response) : response;
          const requestHash = sha256Hex(canonicalize(requestForHash));
          const responseHash = sha256Hex(canonicalize(responseForHash as unknown));
          const usage: AnthropicUsage = (response?.usage ?? {}) as AnthropicUsage;
          const inputTokens = usage.input_tokens ?? 0;
          const outputTokens = usage.output_tokens ?? 0;
          const cacheRead = usage.cache_read_input_tokens ?? 0;
          const cacheWrite = usage.cache_creation_input_tokens ?? 0;
          const cost = estimateCostUsd(
            params.model,
            inputTokens,
            outputTokens,
            cacheRead,
            cacheWrite,
          );

          chain.emit("llm.call", {
            provider: "anthropic",
            model: params.model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
            cost_estimate_usd: cost,
            request_hash: requestHash,
            response_hash: responseHash,
            redacted: redact,
            ts: new Date().toISOString(),
          });
        } catch (err) {
          // Audit must never break the LLM call. Surface via warn for
          // ops visibility; downstream caller is unaffected.
          console.warn(
            "[mnemopay/middleware/anthropic-audit] audit append failed:",
            (err as Error).message,
          );
        }
      }

      return response;
    };

    /**
     * Wrap a returned stream so iteration is observed. The original object
     * is preserved as the underlying delegate — every property except the
     * async-iterator hook passes through unchanged via Proxy.
     */
    const wrapStream = (params: CreateParams, underlying: any) => {
      if (!chain || !underlying) return underlying;

      // State accumulated across the lifetime of one stream.
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheRead = 0;
      let cacheWrite = 0;
      let accumulatedText = "";
      let emitted = false;

      const emitAuditEvent = (partial: boolean, errMsg?: string) => {
        if (emitted) return;
        emitted = true;
        try {
          const requestForHash = redact ? redactParams(params) : params;
          const responseShape = redact
            ? { type: "message", role: "assistant", content: [{ type: "text", text: "[redacted]" }] }
            : { type: "message", role: "assistant", content: [{ type: "text", text: accumulatedText }] };
          const requestHash = sha256Hex(canonicalize(requestForHash));
          const responseHash = sha256Hex(canonicalize(responseShape as unknown));
          const cost = estimateCostUsd(
            params.model,
            inputTokens,
            outputTokens,
            cacheRead,
            cacheWrite,
          );
          chain.emit("llm.call", {
            provider: "anthropic",
            model: params.model,
            streaming: true,
            partial,
            ...(errMsg ? { error: errMsg } : {}),
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheWrite,
            cost_estimate_usd: cost,
            request_hash: requestHash,
            response_hash: responseHash,
            redacted: redact,
            ts: new Date().toISOString(),
          });
        } catch (err) {
          console.warn(
            "[mnemopay/middleware/anthropic-audit] stream audit append failed:",
            (err as Error).message,
          );
        }
      };

      const tapChunk = (chunk: any) => {
        if (!chunk || typeof chunk !== "object") return;
        const t = chunk.type;
        if (t === "message_start" && chunk.message?.usage) {
          const u = chunk.message.usage as AnthropicUsage;
          if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
          if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
          if (typeof u.cache_read_input_tokens === "number") cacheRead = u.cache_read_input_tokens;
          if (typeof u.cache_creation_input_tokens === "number") cacheWrite = u.cache_creation_input_tokens;
        } else if (t === "content_block_delta" && chunk.delta?.type === "text_delta") {
          accumulatedText += chunk.delta.text ?? "";
        } else if (t === "message_delta" && chunk.usage) {
          const u = chunk.usage as AnthropicUsage;
          if (typeof u.output_tokens === "number") outputTokens = u.output_tokens;
          if (typeof u.input_tokens === "number") inputTokens = u.input_tokens;
        }
      };

      // Build a tapped async iterator factory. The Proxy below routes
      // `[Symbol.asyncIterator]` here and forwards everything else to the
      // underlying stream object (so `.finalMessage()`, `.on(...)`,
      // `.controller.abort()`, etc. continue to work).
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
            // Consumer broke out of the loop — emit a partial.
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

    const wrappedStream = originalStream
      ? (params: CreateParams, ...rest: any[]) => {
          const stream = originalStream(params, ...rest);
          return wrapStream(params, stream);
        }
      : undefined;

    return new Proxy(client, {
      get(target, prop) {
        if (prop === "messages") {
          return new Proxy(target.messages, {
            get(msgTarget, msgProp) {
              if (msgProp === "create") return wrappedCreate;
              if (msgProp === "stream" && wrappedStream) return wrappedStream;
              return (msgTarget as any)[msgProp];
            },
          });
        }
        return (target as any)[prop];
      },
    }) as T;
  }
}
