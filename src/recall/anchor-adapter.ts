/**
 * @mnemopay/sdk — RecallAnchor adapter.
 *
 * Phase 2 of the native-AI shift: every `recall.remember()` payload that gets
 * anchored can now ALSO produce a content-addressed receipt and (optionally)
 * push that receipt to an external evidence sink — GridStamp's `remoteid`
 * Merkle batch, an S3+KMS object lock, an EVM L2 anchor, etc.
 *
 * This is what turns memory itself into auditable evidence — the governed-
 * transaction-OS thesis demands an external commitment, not just a self-
 * signed envelope.
 *
 * Pure module — no I/O, no SDK side-effects. Consumers wire it into the
 * `remember()` write path (see `enableAnchoring({adapter})` in
 * MnemoPayLite) and persist the returned `AnchorReceipt` alongside the
 * memory row.
 *
 * ADDITIVE ONLY — does not change `anchorMemory()`, `verifyAnchor()`, or
 * any v1.8.1 surface. The anchor primitive remains the source of truth;
 * an adapter is a *consumer* of it.
 */

import { createHash } from "node:crypto";
import type { MemoryAnchor } from "./anchor.js";

// ─── Receipt types ───────────────────────────────────────────────────────

/**
 * Sink-agnostic envelope for the receipt MnemoPay hands back to callers.
 *
 * `content_id` is the deterministic, sink-independent address (SHA-256 of
 * the canonical anchor payload, hex). `sink_id` + `sink_receipt` are
 * sink-specific — opaque to MnemoPay, treated as bytes.
 */
export interface AnchorReceipt {
  /** Receipt format version. */
  version: 1;
  /** Memory id this receipt binds to. */
  memory_id: string;
  /** Deterministic content address — SHA-256 of the canonical anchor (hex).
   *  Stable across sinks; identical receipts always produce identical ids. */
  content_id: string;
  /** Adapter identifier (e.g. "gridstamp", "noop", "s3-kms"). */
  sink_id: string;
  /** Sink-native receipt payload — opaque to MnemoPay. Persist as-is. */
  sink_receipt: Record<string, unknown> | null;
  /** ISO timestamp the receipt was produced. */
  receipted_at: string;
}

// ─── Adapter interface ───────────────────────────────────────────────────

/**
 * A RecallAnchorAdapter takes a freshly minted {@link MemoryAnchor} and its
 * original content, computes a content-addressed receipt, and optionally
 * forwards that receipt to an external sink.
 *
 * Adapters MUST be deterministic in the content_id they produce for the
 * same input. The sink_receipt MAY be non-deterministic (e.g. a Merkle-tree
 * inclusion proof emitted by GridStamp at batch flush time).
 *
 * Adapters MUST NOT throw on transient sink failure — return a receipt with
 * `sink_receipt: null` and a sink-specific error in metadata so the caller
 * decides whether to retry. Failing closed on the write path would break
 * `remember()`, which is unacceptable for a memory primitive.
 */
export interface RecallAnchorAdapter {
  /** Stable identifier for this adapter (used as `receipt.sink_id`). */
  readonly id: string;
  /**
   * Produce a receipt for an anchor. Pure-deterministic on `content_id`;
   * sink-receipt forwarding is best-effort.
   */
  receipt(input: {
    anchor: MemoryAnchor;
    content: string;
  }): Promise<AnchorReceipt>;
}

// ─── Canonical content-id ─────────────────────────────────────────────────

/**
 * Stable JSON canonicalisation matching `anchor.ts`'s `buildSignedPayload`
 * shape. Kept private to this module so the receipt id is independent of
 * any future change to the signed-payload formatter; receipts hash the
 * full anchor (including signature) so they bind tamper-detection in.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

/**
 * Deterministic content id for an anchor — SHA-256 over the canonicalised
 * anchor JSON. Two adapters given the same anchor MUST agree on this id.
 *
 * Exported so consumers can pre-compute the id without instantiating an
 * adapter (e.g. for de-duplication in a batch processor).
 */
export function computeAnchorContentId(anchor: MemoryAnchor): string {
  return createHash("sha256").update(canonicalize(anchor)).digest("hex");
}

// ─── NoopAnchorAdapter ────────────────────────────────────────────────────

/**
 * Default adapter — computes the receipt but never forwards it anywhere.
 * Useful as a baseline, for tests, and as the safe default when no sink
 * is configured.
 */
export class NoopAnchorAdapter implements RecallAnchorAdapter {
  readonly id = "noop";

  async receipt({
    anchor,
  }: {
    anchor: MemoryAnchor;
    content: string;
  }): Promise<AnchorReceipt> {
    return {
      version: 1,
      memory_id: anchor.memory_id,
      content_id: computeAnchorContentId(anchor),
      sink_id: this.id,
      sink_receipt: null,
      receipted_at: new Date().toISOString(),
    };
  }
}

// ─── InMemoryAnchorAdapter ────────────────────────────────────────────────

/**
 * Test-friendly adapter that records every receipt in an in-process Merkle
 * batch. The batch's running root is included in every sink_receipt, so
 * later receipts in the same batch carry an increasingly strong commitment
 * to earlier ones.
 *
 * This is the reference implementation of the "memory as evidence" pattern:
 * a content-addressed log that any verifier can re-derive given the raw
 * anchors. Production sinks (GridStamp, S3+KMS, EVM L2) follow the same
 * shape; only the persistence + signature mechanism differs.
 */
export class InMemoryAnchorAdapter implements RecallAnchorAdapter {
  readonly id: string;
  private readonly hashes: string[] = [];

  constructor(opts: { id?: string } = {}) {
    this.id = opts.id ?? "in-memory";
  }

  /** Snapshot the current batch hashes (defensive copy). */
  batchHashes(): readonly string[] {
    return this.hashes.slice();
  }

  /** Reset the batch — useful in tests. */
  reset(): void {
    this.hashes.length = 0;
  }

  /** Current Merkle root over all receipted anchors. Empty string for empty batch. */
  currentRoot(): string {
    if (this.hashes.length === 0) return "";
    let layer = this.hashes.slice();
    while (layer.length > 1) {
      const next: string[] = [];
      for (let i = 0; i < layer.length; i += 2) {
        const a = layer[i]!;
        const b = layer[i + 1] ?? a;
        next.push(createHash("sha256").update(a + b).digest("hex"));
      }
      layer = next;
    }
    return layer[0] ?? "";
  }

  async receipt({
    anchor,
  }: {
    anchor: MemoryAnchor;
    content: string;
  }): Promise<AnchorReceipt> {
    const contentId = computeAnchorContentId(anchor);
    this.hashes.push(contentId);
    return {
      version: 1,
      memory_id: anchor.memory_id,
      content_id: contentId,
      sink_id: this.id,
      sink_receipt: {
        batch_index: this.hashes.length - 1,
        batch_size: this.hashes.length,
        running_root: this.currentRoot(),
      },
      receipted_at: new Date().toISOString(),
    };
  }
}

// ─── GridStampAnchorAdapter ───────────────────────────────────────────────

/**
 * Sink contract MnemoPay expects when the caller wants to push receipts to
 * a real GridStamp `remoteid` Merkle batch. We keep the dependency loose
 * (no direct `gridstamp` import) so the SDK stays free of optional peer
 * deps — caller wires the actual GridStamp `remoteid.sign + batchRoot` API
 * into the methods below.
 *
 * Reference shape (from gridstamp/src/remoteid):
 *
 *   sign(log, key) → SignedLog
 *   batchRoot([log, ...]) → { root, inclusionProofs }
 *
 * The adapter signs a `mnemopay_recall_anchor_v1` log per anchor and
 * batches them to a root on demand. The returned sink_receipt carries the
 * SignedLog ref + (when available) the inclusion proof.
 */
export interface GridStampRemoteIdSink {
  /** Sign one MnemoPay recall-anchor log. Returns the SignedLog ref. */
  signRecallAnchor(input: {
    memory_id: string;
    content_id: string;
    anchor: MemoryAnchor;
  }): Promise<{ log_id: string; signature: string; raw?: unknown }>;
  /** Optional: batch existing SignedLogs to a Merkle root + inclusion proofs. */
  batchRoot?(log_ids: readonly string[]): Promise<{
    root: string;
    proofs: Record<string, unknown>;
  }>;
}

/**
 * Adapter that forwards receipts to a GridStamp `remoteid` sink. The sink
 * is the only external dependency — pass any object satisfying
 * {@link GridStampRemoteIdSink} (real gridstamp, a fake for tests, an
 * HTTPS shim, etc.).
 *
 * Fail-soft: any sink error returns a receipt with `sink_receipt: null`
 * and `sink_error` set, never throws. The memory write path stays
 * uninterrupted.
 */
export class GridStampAnchorAdapter implements RecallAnchorAdapter {
  readonly id: string;
  private readonly sink: GridStampRemoteIdSink;

  constructor(opts: { sink: GridStampRemoteIdSink; id?: string }) {
    if (!opts.sink) throw new Error("GridStampAnchorAdapter: sink required");
    this.sink = opts.sink;
    this.id = opts.id ?? "gridstamp";
  }

  async receipt({
    anchor,
  }: {
    anchor: MemoryAnchor;
    content: string;
  }): Promise<AnchorReceipt> {
    const contentId = computeAnchorContentId(anchor);
    const base: AnchorReceipt = {
      version: 1,
      memory_id: anchor.memory_id,
      content_id: contentId,
      sink_id: this.id,
      sink_receipt: null,
      receipted_at: new Date().toISOString(),
    };

    try {
      const signed = await this.sink.signRecallAnchor({
        memory_id: anchor.memory_id,
        content_id: contentId,
        anchor,
      });
      return {
        ...base,
        sink_receipt: {
          log_id: signed.log_id,
          signature: signed.signature,
          raw: signed.raw ?? null,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...base,
        sink_receipt: { sink_error: message },
      };
    }
  }
}
