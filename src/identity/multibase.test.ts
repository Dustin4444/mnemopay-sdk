/**
 * Multibase / base58btc round-trip tests.
 *
 * The base58btc Bitcoin alphabet is fixed by RFC-equivalent spec; the
 * canonical fixtures here are tiny but cover the awkward edges:
 *  - empty input
 *  - leading zero bytes → leading `1`s
 *  - max-byte values (so we exercise the carry path)
 *  - 64-byte Ed25519 signature (real-world payload size)
 */

import { describe, it, expect } from "vitest";

import {
  base58btcDecode,
  base58btcEncode,
  multibaseBase58btcDecode,
  multibaseBase58btcEncode,
} from "./multibase.js";

describe("base58btc encode / decode", () => {
  it("empty bytes round-trip to empty string", () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe("");
    expect(base58btcDecode("")).toEqual(new Uint8Array(0));
  });

  it("leading zero bytes encode to leading '1' characters", () => {
    const bytes = new Uint8Array([0, 0, 0, 1, 2, 3]);
    const enc = base58btcEncode(bytes);
    expect(enc.startsWith("111")).toBe(true);
    expect(base58btcDecode(enc)).toEqual(bytes);
  });

  it("encodes the canonical Bitcoin reference vector", () => {
    // "Hello World!" → "2NEpo7TZRRrLZSi2U"  (per multiple base58 reference impls)
    const bytes = new TextEncoder().encode("Hello World!");
    const enc = base58btcEncode(bytes);
    expect(enc).toBe("2NEpo7TZRRrLZSi2U");
    expect(new TextDecoder().decode(base58btcDecode(enc))).toBe("Hello World!");
  });

  it("round-trips a 64-byte payload (Ed25519 signature size)", () => {
    const bytes = new Uint8Array(64);
    for (let i = 0; i < 64; i++) bytes[i] = (i * 17 + 3) & 0xff;
    const enc = base58btcEncode(bytes);
    const dec = base58btcDecode(enc);
    expect(dec).toEqual(bytes);
  });

  it("rejects characters outside the base58 alphabet", () => {
    // '0', 'O', 'I', 'l' are excluded.
    expect(() => base58btcDecode("0abc")).toThrow(/invalid character/i);
    expect(() => base58btcDecode("aIbc")).toThrow(/invalid character/i);
  });
});

describe("Multibase wrapper", () => {
  it("adds the canonical 'z' prefix on encode", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const mb = multibaseBase58btcEncode(bytes);
    expect(mb.charAt(0)).toBe("z");
    expect(mb.length).toBeGreaterThan(1);
  });

  it("round-trips arbitrary bytes via the Multibase wrapper", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x10, 0x20]);
    expect(multibaseBase58btcDecode(multibaseBase58btcEncode(bytes))).toEqual(bytes);
  });

  it("rejects a string without the 'z' prefix", () => {
    expect(() => multibaseBase58btcDecode("xabc")).toThrow(/expected 'z'/i);
    expect(() => multibaseBase58btcDecode("")).toThrow(/expected 'z'/i);
  });
});
