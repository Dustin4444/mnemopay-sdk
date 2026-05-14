import { describe, it, expect, beforeEach } from "vitest";

import {
  mintDid,
  sign,
  verify,
  resolveDid,
  isDid,
  publicKeyMatchesDid,
  _resetResolver,
  type Did,
} from "./did.js";

describe("did — mint", () => {
  beforeEach(() => _resetResolver());

  it("produces a syntactically valid did:mp identifier", () => {
    const { did } = mintDid();
    expect(isDid(did)).toBe(true);
    expect(did).toMatch(/^did:mp:[0-9a-f]{32}$/);
  });

  it("returns an Ed25519 keypair as SPKI/PKCS8 hex", () => {
    const { publicKey, privateKey } = mintDid();
    // Ed25519 SPKI DER ≈ 44 bytes ⇒ 88 hex chars; PKCS8 ≈ 48 bytes ⇒ 96 hex.
    expect(publicKey).toHaveLength(88);
    expect(privateKey).toHaveLength(96);
    expect(publicKey).not.toEqual(privateKey);
  });

  it("self-certifies — the DID tail is SHA-256(pubkey)[:16]", () => {
    const { did, publicKey } = mintDid();
    expect(publicKeyMatchesDid(did, publicKey)).toBe(true);
  });

  it("registers the document so resolveDid() succeeds immediately", () => {
    const { did, document } = mintDid();
    const resolved = resolveDid(did);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(did);
    expect(resolved?.verificationMethod[0].publicKeyHex).toBe(
      document.verificationMethod[0].publicKeyHex,
    );
  });

  it("produces unique DIDs across calls", () => {
    const a = mintDid();
    const b = mintDid();
    expect(a.did).not.toBe(b.did);
  });
});

describe("did — sign / verify round trip", () => {
  beforeEach(() => _resetResolver());

  it("verifies a signature it just produced (string payload)", () => {
    const { did, publicKey, privateKey } = mintDid();
    const sig = sign(did, privateKey, "hello world");
    expect(verify(did, sig, "hello world", publicKey)).toBe(true);
  });

  it("verifies a signature over Uint8Array payload", () => {
    const { did, publicKey, privateKey } = mintDid();
    const bytes = new TextEncoder().encode("agent decided to buy");
    const sig = sign(did, privateKey, bytes);
    expect(verify(did, sig, bytes, publicKey)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const { did, publicKey, privateKey } = mintDid();
    const sig = sign(did, privateKey, "msg");
    // Flip a byte in the signature.
    const bad = Buffer.from(sig, "base64");
    bad[0] = bad[0] ^ 0xff;
    expect(verify(did, bad.toString("base64"), "msg", publicKey)).toBe(false);
  });

  it("rejects when payload was tampered", () => {
    const { did, publicKey, privateKey } = mintDid();
    const sig = sign(did, privateKey, "original");
    expect(verify(did, sig, "modified", publicKey)).toBe(false);
  });

  it("rejects when public key doesn't self-certify the DID", () => {
    const a = mintDid();
    const b = mintDid();
    // Sign with a's private key but lie about which key matches the DID.
    const sig = sign(a.did, a.privateKey, "msg");
    expect(verify(a.did, sig, "msg", b.publicKey)).toBe(false);
  });

  it("rejects an invalid DID up front", () => {
    const { publicKey, privateKey } = mintDid();
    expect(() => sign("did:web:example.com" as Did, privateKey, "x")).toThrow();
    expect(verify("did:web:example.com" as Did, "AAAA", "x", publicKey)).toBe(false);
  });
});

describe("did — resolveDid", () => {
  beforeEach(() => _resetResolver());

  it("returns null for unknown DIDs without throwing", () => {
    expect(resolveDid("did:mp:00000000000000000000000000000000" as Did)).toBeNull();
  });

  it("returns null for syntactically invalid DIDs", () => {
    expect(resolveDid("did:web:example.com" as Did)).toBeNull();
  });
});
