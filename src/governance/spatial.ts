/**
 * Spatial evidence governance — for embodied agents (drones, robots, AGVs,
 * field-service hardware) where the audit chain needs to co-sign with
 * cryptographic proof-of-presence.
 *
 * Loose coupling: this module does NOT depend on `gridstamp` (the
 * companion package that produces SpatialProofs and SPZ-4 evidence
 * envelopes). It defines the structural shape MnemoPay expects to
 * receive and a verifier that re-derives the SHA-256 fingerprint.
 *
 * Usage:
 *   import { GridStampAgent } from "gridstamp";
 *   import { attachSpatialEvidence, MerkleAudit } from "@mnemopay/sdk";
 *
 *   const audit = new MerkleAudit();
 *   const proof = await stamp.verifySpatial(...);  // gridstamp side
 *   attachSpatialEvidence(audit, proof);
 *
 * The MerkleAudit chain now contains a `spatial.evidence` event that
 * commits to the proof's content hash. The Article 12 bundle includes
 * it in its events / chain / CSV exports automatically.
 *
 * For the new SPZ-4 splat envelope (ingested via gridstamp's
 * parseSpz on 2026-05-08), the same attach path works — the kind
 * field discriminates the envelope type.
 */

import { createHash } from "node:crypto";
import type { MerkleAudit } from "./audit.js";

// ─── Evidence shapes (mirrored from gridstamp; not imported) ──────────────

/**
 * SpatialProof envelope produced by `gridstamp`'s
 * `verifySpatial()` / `createSettlement()` / cell-based capture flows.
 * The cryptographic core: an HMAC-signed comparison of rendered vs
 * captured frames at a known pose.
 */
export interface GridStampSpatialProof {
  kind: "spatial_proof_v1";
  proofId: string;
  /** Hex-encoded HMAC-SHA256 over the proof payload. */
  signature: string;
  /** ISO-8601 timestamp recorded by the capture device. */
  timestamp: string;
  /** Pose claimed by the agent at capture (lat/lng/alt + orientation). */
  pose: {
    lat: number;
    lng: number;
    alt?: number;
    yaw?: number;
    pitch?: number;
    roll?: number;
  };
  /** SSIM / LPIPS verification score against the reference frame. */
  scores: { ssim?: number; lpips?: number };
  /** Optional: agent identity or fleet identifier. */
  agentId?: string;
}

/**
 * SPZ-4 splat envelope produced by gridstamp's `parseSpz()` (the
 * 2026-05-08 evidence/splat.ts adapter). Embeds a SHA-256 fingerprint
 * over the SPZ blob; the original splat lives outside the chain.
 */
export interface GridStampSplatEvidence {
  kind: "splat_v1";
  format: "spz";
  version: number;
  pointCount: number;
  shDegree: number;
  fractionalBits: number;
  flags: number;
  streamCount: number;
  byteSize: number;
  /** Hex-encoded SHA-256 of the full SPZ blob. */
  sha256: string;
  capturedAt?: string;
}

/** Discriminated union of all spatial-evidence shapes MnemoPay accepts. */
export type SpatialEvidence = GridStampSpatialProof | GridStampSplatEvidence;

export type SpatialEvidenceVerifyResult =
  | { ok: true }
  | { ok: false; reason: SpatialEvidenceRejectReason };

export type SpatialEvidenceRejectReason =
  | "missing-kind"
  | "unknown-kind"
  | "missing-fingerprint"
  | "fingerprint-not-hex-sha256"
  | "missing-signature"
  | "signature-not-hex"
  | "missing-timestamp"
  | "timestamp-invalid"
  | "missing-pose";

// ─── Verification ────────────────────────────────────────────────────────

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const HEX_BYTES = /^[0-9a-f]+$/;

/**
 * Validate a spatial evidence envelope.
 *
 * MnemoPay can't re-derive the cryptographic root without the underlying
 * raw frames or splat bytes (those live outside the chain by design —
 * they're too big and often privacy-sensitive). What we CAN verify is
 * structural integrity: required fields, fingerprint format, signature
 * format, ISO timestamp parseability.
 *
 * Full cryptographic re-verification requires the gridstamp package and
 * the original blob; callers run that out-of-band when they need it.
 */
export function verifySpatialEvidence(
  evidence: unknown,
): SpatialEvidenceVerifyResult {
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, reason: "missing-kind" };
  }
  const e = evidence as Record<string, unknown>;
  if (typeof e.kind !== "string") return { ok: false, reason: "missing-kind" };

  if (e.kind === "spatial_proof_v1") {
    if (typeof e.signature !== "string") return { ok: false, reason: "missing-signature" };
    if (!HEX_BYTES.test(e.signature)) return { ok: false, reason: "signature-not-hex" };
    if (typeof e.timestamp !== "string") return { ok: false, reason: "missing-timestamp" };
    if (Number.isNaN(Date.parse(e.timestamp))) return { ok: false, reason: "timestamp-invalid" };
    if (!e.pose || typeof e.pose !== "object") return { ok: false, reason: "missing-pose" };
    return { ok: true };
  }

  if (e.kind === "splat_v1") {
    if (typeof e.sha256 !== "string") return { ok: false, reason: "missing-fingerprint" };
    if (!HEX_SHA256.test(e.sha256)) return { ok: false, reason: "fingerprint-not-hex-sha256" };
    return { ok: true };
  }

  return { ok: false, reason: "unknown-kind" };
}

// ─── Attachment ──────────────────────────────────────────────────────────

/**
 * Compute a deterministic content fingerprint for a spatial evidence
 * envelope. Used as the audit-event payload so the MerkleAudit chain
 * commits to the evidence (without storing the whole envelope inline).
 */
export function fingerprintSpatialEvidence(evidence: SpatialEvidence): string {
  // Canonical JSON: keys sorted via the JSON.stringify replacer arg
  // (which both filters AND orders), so the digest is independent of
  // the caller's insertion order.
  const keys = Object.keys(evidence as unknown as Record<string, unknown>).sort();
  const canonical = JSON.stringify(evidence, keys);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Record a `spatial.evidence` event in the MerkleAudit chain. The
 * event commits to the evidence's structural fields plus a content
 * fingerprint, so the chain can be later cross-checked against the
 * raw evidence bundle without bloating the audit log itself.
 *
 * Throws if the evidence doesn't pass `verifySpatialEvidence` — fail
 * closed so a malformed proof can't slip into a regulator-shaped bundle.
 */
export function attachSpatialEvidence(
  audit: MerkleAudit,
  evidence: SpatialEvidence,
): { fingerprint: string } {
  const v = verifySpatialEvidence(evidence);
  if (!v.ok) {
    throw new Error(`attachSpatialEvidence: rejected — ${v.reason}`);
  }

  const fingerprint = fingerprintSpatialEvidence(evidence);

  // Record a compact event. The full envelope is not stored inline
  // (callers persist it separately and reference by fingerprint), but
  // the discriminator + fingerprint commit to the evidence.
  audit.record("spatial.evidence", {
    kind: evidence.kind,
    fingerprint,
    // Surface a small set of high-value fields for human-readable audit:
    ...(evidence.kind === "spatial_proof_v1"
      ? {
          proofId: evidence.proofId,
          timestamp: evidence.timestamp,
          agentId: evidence.agentId,
          pose: evidence.pose,
        }
      : {
          format: evidence.format,
          version: evidence.version,
          byteSize: evidence.byteSize,
          capturedAt: evidence.capturedAt,
        }),
  });

  return { fingerprint };
}
