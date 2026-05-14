/**
 * @mnemopay/sdk — shared event-stream + Merkle-root audit chain.
 *
 * Sister module to `audit.ts`'s `MerkleAudit` (which uses a chained-hash
 * design — each event commits to the previous chain hash). `AuditChain`
 * uses a per-event UUID + parent pointer + tree-Merkle root, which is the
 * shape downstream consumers (mnemopay-code, mnemopay-browser, and the
 * MCP gateway) need for Article 12 bundles where each event has a stable
 * id and event-level signatures.
 *
 * Both are valid audit primitives; this one is optimized for **bundle
 * export** (audit-12 bundles, signed PDFs, per-event signature surface),
 * while `MerkleAudit` is optimized for **streaming verification** (append
 * one, verify the chain).
 *
 * Pure module — only node:crypto.
 */

import { createHash, randomUUID } from "node:crypto";

export interface ChainEvent {
  /** UUIDv4. */
  id: string;
  /** Monotonic stream id — useful for log replay + ordering. */
  sequence: number;
  /** ISO-8601 wallclock of emission. */
  occurred_at: string;
  /** Event kind — caller-defined (e.g. `llm.call.start`). */
  kind: string;
  /** Payload — arbitrary JSON-able structure. */
  payload: Record<string, unknown>;
  /** Optional parent — caller-supplied for span correlation. */
  parent_id?: string;
  /** Optional signature over the canonical event bytes (hex/base64). */
  signature?: string;
}

export interface ChainSinkOptions {
  /** Optional signer — called with the canonical event payload before emit. */
  signer?: (payload: string) => string;
  /** Optional fixed sequence start — defaults to 0. */
  sequence_start?: number;
}

export class AuditChain {
  private readonly _events: ChainEvent[] = [];
  private readonly opts: ChainSinkOptions;
  private nextSequence: number;

  constructor(opts: ChainSinkOptions = {}) {
    this.opts = opts;
    this.nextSequence = opts.sequence_start ?? 0;
  }

  emit(kind: string, payload: Record<string, unknown>, parent_id?: string): ChainEvent {
    const draft: ChainEvent = {
      id: randomUUID(),
      sequence: this.nextSequence++,
      occurred_at: new Date().toISOString(),
      kind,
      payload,
      ...(parent_id ? { parent_id } : {}),
    };
    if (this.opts.signer) {
      draft.signature = this.opts.signer(canonicalize(draft));
    }
    this._events.push(draft);
    return draft;
  }

  events(): readonly ChainEvent[] {
    return this._events;
  }

  /** Roll a tree-Merkle root over emitted events. Empty stream → "". */
  rollMerkleRoot(): string {
    if (this._events.length === 0) return "";
    let layer = this._events.map((e) => sha256Hex(canonicalize(e)));
    while (layer.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const a = layer[i]!;
        const b = layer[i + 1] ?? a;
        next.push(sha256Hex(a + b));
      }
      layer = next;
    }
    return layer[0] ?? "";
  }

  /** Materialize the canonical bundle object (consumed by Article 12 zip writer). */
  toBundle<TMeta extends Record<string, unknown> = Record<string, unknown>>(
    meta: TMeta = {} as TMeta,
  ): ChainBundle<TMeta> {
    return {
      version: 1,
      built_at: new Date().toISOString(),
      meta,
      events: this._events.slice(),
      merkle_root: this.rollMerkleRoot(),
    };
  }
}

export interface ChainBundle<TMeta extends Record<string, unknown> = Record<string, unknown>> {
  version: 1;
  built_at: string;
  meta: TMeta;
  events: readonly ChainEvent[];
  merkle_root: string;
}

/** Stable JSON canonicalisation: sorted keys, no whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Verify an external chain bundle.
 *   1. Recompute the Merkle root over the events.
 *   2. Optionally re-verify each per-event signature.
 */
export interface VerifyBundleOptions {
  verifyEventSignature?: (event: ChainEvent) => boolean;
}

export function verifyBundle(
  bundle: ChainBundle,
  options: VerifyBundleOptions = {},
): { ok: true } | { ok: false; reason: "root_mismatch" | "bad_event_signature"; index?: number } {
  if (bundle.events.length === 0) {
    return bundle.merkle_root === "" ? { ok: true } : { ok: false, reason: "root_mismatch" };
  }
  let layer = bundle.events.map((e) => sha256Hex(canonicalize(e)));
  while (layer.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      const a = layer[i]!;
      const b = layer[i + 1] ?? a;
      next.push(sha256Hex(a + b));
    }
    layer = next;
  }
  if (layer[0] !== bundle.merkle_root) return { ok: false, reason: "root_mismatch" };

  if (options.verifyEventSignature) {
    for (let i = 0; i < bundle.events.length; i++) {
      const ev = bundle.events[i]!;
      if (ev.signature && !options.verifyEventSignature(ev)) {
        return { ok: false, reason: "bad_event_signature", index: i };
      }
    }
  }
  return { ok: true };
}
