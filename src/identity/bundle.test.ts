import { describe, it, expect, beforeEach } from "vitest";

import { mintDid, _resetResolver, resolveDid, type Did } from "./did.js";
import {
  exportBundle,
  importBundle,
  canonicalize,
  hashPaymentHistory,
} from "./bundle.js";

describe("bundle — canonicalize", () => {
  it("produces stable output regardless of input key order", () => {
    const a = canonicalize({ b: 2, a: 1, c: { z: 1, a: 2 } });
    const b = canonicalize({ c: { a: 2, z: 1 }, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("drops undefined fields", () => {
    expect(canonicalize({ a: 1, b: undefined, c: 3 })).toBe('{"a":1,"c":3}');
  });

  it("preserves array order", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });
});

describe("bundle — hashPaymentHistory", () => {
  it("is order-insensitive over object keys, order-sensitive over array order", () => {
    const a = hashPaymentHistory({ total: 100, txns: [{ id: "x" }, { id: "y" }] });
    const b = hashPaymentHistory({ txns: [{ id: "x" }, { id: "y" }], total: 100 });
    const c = hashPaymentHistory({ txns: [{ id: "y" }, { id: "x" }], total: 100 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("bundle — export / import round trip", () => {
  beforeEach(() => _resetResolver());

  it("exports a signed bundle that import verifies", () => {
    const { did, publicKey, privateKey } = mintDid();
    const bundle = exportBundle(did, privateKey, publicKey, {
      fico: 742,
      recallPointer: "mnemopay://recall/agent/xyz",
      paymentHistoryHash: hashPaymentHistory({ txns: [] }),
      issuedAt: "2026-05-13T00:00:00.000Z",
    });

    const parsed = importBundle(bundle);
    expect(parsed.valid).toBe(true);
    expect(parsed.did).toBe(did);
    expect(parsed.payload?.fico).toBe(742);
    expect(parsed.payload?.recallPointer).toBe("mnemopay://recall/agent/xyz");
  });

  it("survives JSON-string transport", () => {
    const { did, publicKey, privateKey } = mintDid();
    const bundle = exportBundle(did, privateKey, publicKey, { fico: 700 });
    const wire = JSON.stringify(bundle);
    const parsed = importBundle(wire);
    expect(parsed.valid).toBe(true);
    expect(parsed.did).toBe(did);
  });

  it("registers the DID with the local resolver on successful import", () => {
    const { did, publicKey, privateKey } = mintDid();
    const bundle = exportBundle(did, privateKey, publicKey);
    _resetResolver();
    expect(resolveDid(did)).toBeNull();
    const parsed = importBundle(bundle);
    expect(parsed.valid).toBe(true);
    expect(resolveDid(did)).not.toBeNull();
  });

  it("rejects a bundle with a tampered payload", () => {
    const { did, publicKey, privateKey } = mintDid();
    const bundle = exportBundle(did, privateKey, publicKey, { fico: 700 });
    const tampered = {
      ...bundle,
      payload: { ...bundle.payload, fico: 850 },
    };
    expect(importBundle(tampered).valid).toBe(false);
  });

  it("rejects a bundle whose pubkey doesn't self-certify the DID", () => {
    const a = mintDid();
    const b = mintDid();
    const bundle = exportBundle(a.did, a.privateKey, a.publicKey);
    // Swap in b's pubkey but keep a's DID — should fail the self-cert check.
    const forged = {
      ...bundle,
      payload: { ...bundle.payload, publicKey: b.publicKey },
    };
    expect(importBundle(forged).valid).toBe(false);
  });

  it("rejects malformed JSON gracefully", () => {
    expect(importBundle("{not json").valid).toBe(false);
  });

  it("refuses to export with a mismatched public key", () => {
    const a = mintDid();
    const b = mintDid();
    expect(() => exportBundle(a.did, a.privateKey, b.publicKey)).toThrow();
  });
});
