/**
 * Spatial-evidence governance tests.
 *
 * Verifies that GridStamp-shaped evidence (SpatialProof + SpzEvidence)
 * attaches cleanly to a MerkleAudit chain, that fingerprints are
 * deterministic, and that malformed evidence is rejected fail-closed.
 *
 * No dependency on `gridstamp` — we construct envelopes that match
 * the published shape and verify the loose-coupled adapter handles them.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  MerkleAudit,
  attachSpatialEvidence,
  verifySpatialEvidence,
  fingerprintSpatialEvidence,
  type GridStampSpatialProof,
  type GridStampSplatEvidence,
  type SpatialEvidence,
  buildArticle12Bundle,
  type Charter,
  type MissionResult,
} from "../src/governance/index.js";

function validProof(): GridStampSpatialProof {
  return {
    kind: "spatial_proof_v1",
    proofId: "sp_3f8c2a",
    signature: "deadbeef".repeat(8),
    timestamp: "2026-05-08T17:30:00Z",
    pose: { lat: 32.7767, lng: -96.7970, alt: 142.5, yaw: 87 },
    scores: { ssim: 0.94, lpips: 0.06 },
    agentId: "drone-042",
  };
}

function validSplat(): GridStampSplatEvidence {
  return {
    kind: "splat_v1",
    format: "spz",
    version: 4,
    pointCount: 9001,
    shDegree: 3,
    fractionalBits: 12,
    flags: 1,
    streamCount: 5,
    byteSize: 4096,
    sha256: "a".repeat(64),
    capturedAt: "2026-05-08T17:30:05Z",
  };
}

describe("verifySpatialEvidence", () => {
  it("accepts a well-formed SpatialProof envelope", () => {
    expect(verifySpatialEvidence(validProof())).toEqual({ ok: true });
  });

  it("accepts a well-formed splat envelope", () => {
    expect(verifySpatialEvidence(validSplat())).toEqual({ ok: true });
  });

  it("rejects null/undefined", () => {
    expect(verifySpatialEvidence(null)).toEqual({ ok: false, reason: "missing-kind" });
    expect(verifySpatialEvidence(undefined)).toEqual({ ok: false, reason: "missing-kind" });
  });

  it("rejects unknown kind", () => {
    expect(verifySpatialEvidence({ kind: "totally_made_up" })).toEqual({
      ok: false,
      reason: "unknown-kind",
    });
  });

  it("rejects SpatialProof with missing signature", () => {
    const p: any = validProof();
    delete p.signature;
    expect(verifySpatialEvidence(p)).toEqual({ ok: false, reason: "missing-signature" });
  });

  it("rejects SpatialProof with non-hex signature", () => {
    const p = { ...validProof(), signature: "ZZZZ-not-hex" };
    expect(verifySpatialEvidence(p)).toEqual({ ok: false, reason: "signature-not-hex" });
  });

  it("rejects SpatialProof with invalid timestamp", () => {
    const p = { ...validProof(), timestamp: "yesterday afternoon" };
    expect(verifySpatialEvidence(p)).toEqual({ ok: false, reason: "timestamp-invalid" });
  });

  it("rejects SpatialProof with missing pose", () => {
    const p: any = validProof();
    delete p.pose;
    expect(verifySpatialEvidence(p)).toEqual({ ok: false, reason: "missing-pose" });
  });

  it("rejects splat with missing sha256", () => {
    const s: any = validSplat();
    delete s.sha256;
    expect(verifySpatialEvidence(s)).toEqual({ ok: false, reason: "missing-fingerprint" });
  });

  it("rejects splat with malformed sha256", () => {
    const s = { ...validSplat(), sha256: "tooshort" };
    expect(verifySpatialEvidence(s)).toEqual({ ok: false, reason: "fingerprint-not-hex-sha256" });
  });
});

describe("fingerprintSpatialEvidence", () => {
  it("produces a 64-char hex sha256", () => {
    const fp = fingerprintSpatialEvidence(validSplat());
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic across calls", () => {
    const e = validSplat();
    expect(fingerprintSpatialEvidence(e)).toBe(fingerprintSpatialEvidence(e));
  });

  it("differs for different envelopes", () => {
    const a = validSplat();
    const b = { ...a, pointCount: 7777 };
    expect(fingerprintSpatialEvidence(a)).not.toBe(fingerprintSpatialEvidence(b));
  });

  it("ignores key insertion order (canonical JSON)", () => {
    const a: SpatialEvidence = validSplat();
    const b: SpatialEvidence = {
      sha256: a.sha256,
      capturedAt: a.capturedAt,
      version: a.version,
      streamCount: a.streamCount,
      flags: a.flags,
      fractionalBits: a.fractionalBits,
      shDegree: a.shDegree,
      pointCount: a.pointCount,
      byteSize: a.byteSize,
      format: a.format,
      kind: a.kind,
    };
    expect(fingerprintSpatialEvidence(a)).toBe(fingerprintSpatialEvidence(b));
  });
});

describe("attachSpatialEvidence", () => {
  it("records a spatial.evidence event for a SpatialProof", () => {
    const audit = new MerkleAudit();
    const result = attachSpatialEvidence(audit, validProof());

    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(audit.getEvents().length).toBe(1);
    const ev = audit.getEvents()[0];
    expect(ev.type).toBe("spatial.evidence");
    expect(ev.data.kind).toBe("spatial_proof_v1");
    expect(ev.data.fingerprint).toBe(result.fingerprint);
    expect(ev.data.proofId).toBe("sp_3f8c2a");
    expect(ev.data.agentId).toBe("drone-042");
    expect(audit.verify()).toBe(true);
  });

  it("records a spatial.evidence event for a splat", () => {
    const audit = new MerkleAudit();
    const result = attachSpatialEvidence(audit, validSplat());

    expect(audit.getEvents().length).toBe(1);
    const ev = audit.getEvents()[0];
    expect(ev.data.kind).toBe("splat_v1");
    expect(ev.data.fingerprint).toBe(result.fingerprint);
    expect(ev.data.format).toBe("spz");
    expect(ev.data.version).toBe(4);
    expect(ev.data.byteSize).toBe(4096);
    // Splat bytes themselves are NOT inlined — only the fingerprint.
    expect((ev.data as Record<string, unknown>).sha256).toBeUndefined();
    expect(audit.verify()).toBe(true);
  });

  it("throws fail-closed on invalid evidence", () => {
    const audit = new MerkleAudit();
    expect(() => attachSpatialEvidence(audit, { kind: "bogus" } as any)).toThrow(/unknown-kind/);
    expect(() => attachSpatialEvidence(audit, null as any)).toThrow(/missing-kind/);
    expect(audit.getEvents().length).toBe(0); // nothing recorded
  });

  it("multiple evidence attachments chain correctly", () => {
    const audit = new MerkleAudit();
    attachSpatialEvidence(audit, validProof());
    attachSpatialEvidence(audit, validSplat());
    expect(audit.getEvents().length).toBe(2);
    expect(audit.verify()).toBe(true);
    const chain = audit.getChain();
    // Each link's hash should be unique (chain progresses).
    expect(chain[0]).not.toBe(chain[1]);
  });
});

describe("Article 12 bundle includes spatial events", () => {
  const charter: Charter = {
    name: "drone-delivery-test",
    goal: "deliver package and prove location",
    budget: { maxUsd: 5.0, approvalThresholdUsd: 1.0 },
    agents: [{ role: "research" }],
    outputs: ["text"],
    compliance: { article12: true },
  };

  it("Article 12 bundle CSV + JSON include the spatial.evidence event", () => {
    const audit = new MerkleAudit();
    audit.record("mission.start", { charter: "drone-delivery-test" });
    attachSpatialEvidence(audit, validProof());
    audit.record("payment.settle", { rail: "stripe", amountUsd: 2.5 });
    attachSpatialEvidence(audit, validSplat());

    const result: MissionResult = {
      charterName: charter.name,
      status: "ok",
      spentUsd: 2.5,
      outputs: ["delivered"],
      auditDigest: audit.finalize(),
      startedAt: "2026-05-08T17:00:00Z",
      finishedAt: "2026-05-08T17:30:00Z",
    };

    const bundle = buildArticle12Bundle({ charter, result, audit });

    const eventsJson = bundle.files.find((f) => f.path === "events.json")!.body;
    const eventsCsv = bundle.files.find((f) => f.path === "events.csv")!.body;

    expect(eventsJson).toContain("spatial.evidence");
    expect(eventsJson).toContain("spatial_proof_v1");
    expect(eventsJson).toContain("splat_v1");
    expect(eventsCsv).toContain("spatial.evidence");
    // 4 events recorded: mission.start + spatial_proof_v1 + payment.settle + splat_v1
    const events = JSON.parse(eventsJson);
    expect(events.length).toBe(4);
    expect(events.filter((e: { type: string }) => e.type === "spatial.evidence").length).toBe(2);
  });
});
