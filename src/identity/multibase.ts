/**
 * Minimal Multibase / base58btc encoder + decoder.
 *
 * Required by AP2 v0.2 and the W3C VC Data Integrity 1.0 spec for the
 * `Ed25519Signature2020` proof type — `proofValue` MUST be a Multibase
 * string and the only widely-supported base for Ed25519 signatures is
 * `base58btc` (prefix `z`).
 *
 * Implemented inline because the SDK is dependency-conservative: this is
 * the only place we need base58btc, the Bitcoin alphabet is stable, and
 * ~40 lines of code beats a transitive dependency.
 *
 * The alphabet (Bitcoin base58 — omits `0`, `O`, `I`, `l`) and the
 * Multibase `z` prefix are both fixed by spec; do not parameterise.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const INDEX: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET.charAt(i)] = i;
  return m;
})();

/** Encode raw bytes to a base58btc string (no Multibase prefix). */
export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  const input = Array.from(bytes);
  const out: number[] = [];
  let start = zeros;
  while (start < input.length) {
    let carry = 0;
    for (let i = start; i < input.length; i++) {
      const x = (input[i] as number) + carry * 256;
      input[i] = Math.floor(x / 58);
      carry = x % 58;
    }
    out.push(carry);
    if (input[start] === 0) start++;
  }

  let result = "1".repeat(zeros);
  for (let i = out.length - 1; i >= 0; i--) {
    result += ALPHABET.charAt(out[i] as number);
  }
  return result;
}

/** Decode a base58btc string (no Multibase prefix) back to raw bytes. */
export function base58btcDecode(str: string): Uint8Array {
  if (str.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < str.length && str.charAt(zeros) === "1") zeros++;

  const bytes: number[] = [];
  for (let i = zeros; i < str.length; i++) {
    const ch = str.charAt(i);
    const value = INDEX[ch];
    if (value === undefined) {
      throw new Error(`base58btcDecode: invalid character '${ch}' at index ${i}`);
    }
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      const x = (bytes[j] as number) * 58 + carry;
      bytes[j] = x & 0xff;
      carry = x >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry = carry >> 8;
    }
  }
  bytes.reverse();
  const result = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    result[zeros + i] = bytes[i] as number;
  }
  return result;
}

/**
 * Multibase-encode bytes as base58btc with the canonical `z` prefix.
 * Matches W3C Multibase 2025 draft and AP2 v0.2 wire format.
 */
export function multibaseBase58btcEncode(bytes: Uint8Array): string {
  return `z${base58btcEncode(bytes)}`;
}

/**
 * Multibase-decode a `z…` string back to bytes. Throws if the prefix is
 * missing or wrong — callers should branch on the structured error rather
 * than silently accepting a non-base58btc Multibase variant.
 */
export function multibaseBase58btcDecode(mb: string): Uint8Array {
  if (mb.length === 0 || mb.charAt(0) !== "z") {
    throw new Error(
      `multibaseBase58btcDecode: expected 'z' Multibase prefix, got '${mb.charAt(0) || "(empty)"}'`,
    );
  }
  return base58btcDecode(mb.slice(1));
}
