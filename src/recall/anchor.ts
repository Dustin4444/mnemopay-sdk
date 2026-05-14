/**
 * @mnemopay/sdk — Recall + GridStamp anchor.
 *
 * Each `remember()` call can now produce a portable **anchor**: a content
 * hash, an Ed25519 signature over that hash by the owning Wallet's DID,
 * a monotonic sequence number, and an optional GridStamp spatial-proof
 * envelope. Anchors are the verifiable receipt that a memory came from a
 * specific agent at a specific time — the substrate-level moat vs Mem0/Zep.
 *
 * Pure module — no I/O, no DB dependency. Consumers wire it into the
 * `remember()` write path (forthcoming v1.8) and persist the returned
 * `MemoryAnchor` alongside the row.
 */

import { createHash, randomBytes } from "node:crypto";
import type { Wallet } from "../identity/wallet.js";
import type { GridStampSpatialProof } from "../governance/spatial.js";

export interface MemoryAnchor {
  /** Anchor format version. */
  version: 1;
  /** Memory id this anchor binds to. */
  memory_id: string;
  /** DID of the wallet that signed. */
  did: string;
  /** SHA-256 of the canonical content bytes (hex). */
  content_sha256: string;
  /** Monotonic per-wallet sequence number. Enables replay protection. */
  sequence: number;
  /** Random nonce — additional replay-attack defense. 16 bytes hex. */
  nonce: string;
  /** ISO timestamp the anchor was minted. */
  anchored_at: string;
  /** Anchor expiry — ISO timestamp after which verifyAnchor will reject. */
  expires_at: string;
  /** Ed25519 signature over the canonical anchor payload (hex). */
  signature: string;
  /** Optional GridStamp spatial-proof envelope. */
  gridstamp?: GridStampSpatialProof;
}

export interface AnchorInput {
  memory_id: string;
  content: string;
  wallet: Wallet;
  sequence: number;
  /** Anchor TTL in milliseconds. Default 30 days. */
  ttl_ms?: number;
  /** Provided nonce — defaults to crypto.randomBytes(16). */
  nonce?: string;
  gridstamp?: GridStampSpatialProof;
  now?: Date;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Stable JSON canonicalisation: sorted keys, no whitespace. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
}

function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Build the canonical bytes that get signed. NEVER include the signature
 * itself in the signed payload. Order is fixed by `canonicalize()`.
 */
function buildSignedPayload(anchor: Omit<MemoryAnchor, "signature">): string {
  return canonicalize({
    version: anchor.version,
    memory_id: anchor.memory_id,
    did: anchor.did,
    content_sha256: anchor.content_sha256,
    sequence: anchor.sequence,
    nonce: anchor.nonce,
    anchored_at: anchor.anchored_at,
    expires_at: anchor.expires_at,
    gridstamp: anchor.gridstamp ?? null,
  });
}

/**
 * Mint a MemoryAnchor for a memory. Pure — the wallet does the signing,
 * we hash the content and assemble the envelope. Consumer is responsible
 * for incrementing `sequence` per-wallet and persisting the result.
 *
 * Replay defenses:
 *   - sequence: monotonic per-wallet counter (caller-supplied + tracked)
 *   - nonce: 128-bit random; caller's `seenNonces()` rejects duplicates
 *   - expires_at: anchor TTL; verifyAnchor returns `expired` past it
 */
export function anchorMemory(input: AnchorInput): MemoryAnchor {
  if (!input.memory_id) throw new Error("anchorMemory: memory_id required");
  if (input.sequence < 0 || !Number.isInteger(input.sequence)) {
    throw new Error("anchorMemory: sequence must be non-negative integer");
  }

  const now = input.now ?? new Date();
  const ttl = input.ttl_ms ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(now.getTime() + ttl);
  const nonce = input.nonce ?? randomBytes(16).toString("hex");

  const draft: Omit<MemoryAnchor, "signature"> = {
    version: 1,
    memory_id: input.memory_id,
    did: input.wallet.did,
    content_sha256: sha256Hex(input.content),
    sequence: input.sequence,
    nonce,
    anchored_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    ...(input.gridstamp ? { gridstamp: input.gridstamp } : {}),
  };

  const signature = input.wallet.sign(buildSignedPayload(draft));
  return { ...draft, signature };
}

export interface VerifyAnchorInput {
  anchor: MemoryAnchor;
  content: string;
  publicKey: string;
  verify: (did: string, signature: string, payload: string, publicKey: string) => boolean;
  /** Wallclock at verify time. Defaults to `new Date()`. */
  now?: Date;
  /** Optional nonce store for replay-attack rejection. */
  seen_nonces?: NonceStore;
}

export type VerifyAnchorResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "content_mismatch"
        | "bad_signature"
        | "version_unsupported"
        | "expired"
        | "nonce_replay";
    };

/**
 * Verify an anchor against the original content. Caller injects a `verify()`
 * function (typically `Wallet.prototype.verify` or `identity.verify`) so this
 * module stays free of identity-module imports beyond types.
 */
export function verifyAnchor(input: VerifyAnchorInput): VerifyAnchorResult {
  if (input.anchor.version !== 1) return { ok: false, reason: "version_unsupported" };

  const now = (input.now ?? new Date()).getTime();
  const expires = new Date(input.anchor.expires_at).getTime();
  if (Number.isFinite(expires) && now > expires) {
    return { ok: false, reason: "expired" };
  }

  const expectedHash = sha256Hex(input.content);
  if (expectedHash !== input.anchor.content_sha256) {
    return { ok: false, reason: "content_mismatch" };
  }

  if (input.seen_nonces && input.seen_nonces.has(input.anchor.nonce)) {
    return { ok: false, reason: "nonce_replay" };
  }

  const { signature, ...rest } = input.anchor;
  const payload = buildSignedPayload(rest);
  const ok = input.verify(input.anchor.did, signature, payload, input.publicKey);
  if (!ok) return { ok: false, reason: "bad_signature" };

  // Record nonce only after successful verification.
  if (input.seen_nonces) input.seen_nonces.add(input.anchor.nonce);
  return { ok: true };
}

// ─── Nonce store ────────────────────────────────────────────────────────────

export interface NonceStore {
  has(nonce: string): boolean;
  add(nonce: string): void;
  prune(beforeMs: number): void;
}

/**
 * In-memory nonce store with optional TTL. Production deployments swap
 * in a Redis-backed adapter (SETNX + EXPIRE) with the same interface.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  has(nonce: string): boolean { return this.seen.has(nonce); }
  add(nonce: string): void { this.seen.set(nonce, Date.now()); }

  prune(beforeMs: number): void {
    for (const [n, t] of this.seen) {
      if (t < beforeMs) this.seen.delete(n);
    }
  }

  size(): number { return this.seen.size; }
}

/**
 * Roll an array of anchors into a Merkle root. Useful for batching anchors
 * into a single on-chain checkpoint without paying gas per anchor.
 */
export function rollAnchorRoot(anchors: readonly MemoryAnchor[]): string {
  if (anchors.length === 0) return "";
  let layer = anchors.map((a) => sha256Hex(canonicalize(a)));
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
