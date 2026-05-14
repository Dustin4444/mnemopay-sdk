/**
 * Portable identity bundle — the "agent reputation that travels across platforms"
 * unit. An IdentityBundle packages a DID, its public key, current FICO score,
 * a recall pointer, and a payment-history hash, then signs the whole thing
 * with the DID's private key. Verifiers anywhere on the planet can confirm
 * authenticity using only the bundle itself (no MnemoPay backend required).
 *
 * Design notes:
 *   - The bundle is canonicalised before signing (stable key order) so that two
 *     re-serialisations of the same payload always produce identical bytes.
 *   - Optional fields (fico, recall pointer, paymentHistoryHash) are omitted
 *     from the canonical form when undefined — keeps signatures stable across
 *     consumers that may or may not have those subsystems wired in v1.
 *   - The bundle never embeds raw payment history or memory contents — just
 *     a hash and a pointer. That keeps bundles compact (<1 KB typical) and
 *     keeps PII off the wire.
 */

import { createHash } from "node:crypto";

import {
  isDid,
  publicKeyMatchesDid,
  registerDid,
  resolveDid,
  sign,
  verify,
  type Did,
  type DidDocument,
} from "./did.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Payload of an identity bundle — the thing that gets signed. */
export interface IdentityBundlePayload {
  /** Bundle format version. v1 only. */
  version: 1;
  /** The DID this bundle belongs to. */
  did: Did;
  /** SPKI-DER Ed25519 public key, hex. Must self-certify against the DID. */
  publicKey: string;
  /** ISO timestamp when this bundle was exported. */
  issuedAt: string;
  /** Optional current FICO-style agent credit score (300-850, from reasoning/). */
  fico?: number;
  /**
   * Opaque pointer (URN/URL) to where the agent's memories live. Consumers
   * with permission can dereference; everyone else just treats it as a tag.
   */
  recallPointer?: string;
  /**
   * SHA-256 of the agent's payment history at export time (hex). Lets a
   * counterparty detect history rewrites without holding the actual ledger.
   */
  paymentHistoryHash?: string;
  /** Arbitrary additional claims — kept open for future primitives. */
  extras?: Record<string, string | number | boolean>;
}

/** A signed, portable identity bundle. */
export interface IdentityBundle {
  payload: IdentityBundlePayload;
  /** Base64 Ed25519 signature over the canonical payload bytes. */
  signature: string;
}

/** Optional inputs to `exportBundle()`. */
export interface ExportBundleOptions {
  fico?: number;
  recallPointer?: string;
  paymentHistoryHash?: string;
  extras?: Record<string, string | number | boolean>;
  /** Override `issuedAt` — useful for deterministic tests. */
  issuedAt?: string;
}

// ─── Canonicalisation ───────────────────────────────────────────────────────

/**
 * Stable JSON encoding for signing. Keys sorted alphabetically at every depth;
 * undefined fields dropped; arrays preserve order. Matches what
 * RFC 8785 (JCS) achieves for the value shapes we use, without pulling in
 * a dep for ~30 lines of code.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${parts.join(",")}}`;
}

/** Hex SHA-256 of a payment history JSON-able value. Helper for callers. */
export function hashPaymentHistory(history: unknown): string {
  const canon = canonicalize(history);
  return createHash("sha256").update(canon).digest("hex");
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build and sign a portable identity bundle for `did`. `privateKey` is the
 * matching Ed25519 PKCS#8 DER hex — never leaves this call. `publicKeyHex`
 * is required because the bundle must publish the verifier's key, and we
 * deliberately don't derive it from `privateKey` here (keeps the function
 * pure and lets callers pass keys they only hold as material).
 */
export function exportBundle(
  did: Did,
  privateKey: string,
  publicKey: string,
  options: ExportBundleOptions = {},
): IdentityBundle {
  if (!isDid(did)) throw new Error(`exportBundle: invalid DID: ${did}`);
  if (!publicKeyMatchesDid(did, publicKey)) {
    throw new Error("exportBundle: public key does not self-certify the DID");
  }

  const payload: IdentityBundlePayload = {
    version: 1,
    did,
    publicKey,
    issuedAt: options.issuedAt ?? new Date().toISOString(),
    fico: options.fico,
    recallPointer: options.recallPointer,
    paymentHistoryHash: options.paymentHistoryHash,
    extras: options.extras,
  };

  const canonical = canonicalize(payload);
  const signature = sign(did, privateKey, canonical);
  return { payload, signature };
}

/**
 * Verify and parse a signed identity bundle. Returns the DID plus a
 * `valid` flag — the DID is returned even on failure so callers can log
 * which identifier failed to import.
 *
 * Side effect: on success, the bundle's `(did, publicKey)` pair is registered
 * with the local DID resolver so subsequent `resolveDid()` calls succeed
 * without a round-trip to a registry.
 */
export function importBundle(blob: IdentityBundle | string): {
  did: Did;
  valid: boolean;
  payload?: IdentityBundlePayload;
} {
  let bundle: IdentityBundle;
  try {
    bundle = typeof blob === "string" ? (JSON.parse(blob) as IdentityBundle) : blob;
  } catch {
    return { did: "did:mp:00000000000000000000000000000000" as Did, valid: false };
  }

  const payload = bundle?.payload;
  const signature = bundle?.signature;

  if (!payload || typeof signature !== "string") {
    return { did: "did:mp:00000000000000000000000000000000" as Did, valid: false };
  }

  const did = payload.did;

  if (
    payload.version !== 1 ||
    !isDid(did) ||
    typeof payload.publicKey !== "string" ||
    !publicKeyMatchesDid(did, payload.publicKey)
  ) {
    return { did, valid: false, payload };
  }

  const canonical = canonicalize(payload);
  const valid = verify(did, signature, canonical, payload.publicKey);

  if (valid) {
    // Cache the resolved DID document so the consumer doesn't have to
    // re-register manually before using `resolveDid()`.
    if (!resolveDid(did)) {
      const doc: DidDocument = {
        id: did,
        createdAt: payload.issuedAt,
        verificationMethod: [
          {
            id: `${did}#keys-1`,
            type: "Ed25519VerificationKey2020",
            controller: did,
            publicKeyHex: payload.publicKey,
          },
        ],
      };
      registerDid(doc);
    }
  }

  return { did, valid, payload };
}
