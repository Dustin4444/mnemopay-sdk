/**
 * DID (Decentralized Identifier) primitive for MnemoPay — the native-shift cornerstone.
 *
 * Provides a self-contained DID method `did:mp:<32-hex>` plus mint / sign / verify
 * helpers backed by Node's built-in Ed25519. Zero new runtime dependencies — only
 * `node:crypto` and an in-process resolver registry. Future versions can swap the
 * resolver for a network registry without changing the public surface.
 *
 * Why a custom method?  Agents need a portable identity primitive that works
 * without a third-party registry (DNS, blockchain, did:web). did:mp anchors the
 * identifier to its own Ed25519 public key — the 32-hex tail is the SHA-256 of
 * the SPKI-DER-encoded public key, truncated to 16 bytes. That gives every DID
 * cryptographic self-certification: a verifier can reject any document whose
 * pubkey doesn't hash back to the DID's tail.
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createPublicKey,
  createPrivateKey,
  createHash,
  type KeyObject,
} from "node:crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

/** A MnemoPay DID — `did:mp:<32-hex>` (lowercase). */
export type Did = `did:mp:${string}`;

/**
 * Minimal DID document for v1. Shape mirrors the W3C DID Core
 * `verificationMethod` block so future versions can expand without breaking
 * consumers. The public key is exported as SPKI-DER hex (same format the
 * existing `IdentityRegistry` already uses).
 */
export interface DidDocument {
  /** The fully qualified DID. */
  id: Did;
  /** ISO timestamp of mint or last refresh. */
  createdAt: string;
  /** Verification methods attached to this DID. v1 only carries one. */
  verificationMethod: Array<{
    id: `${Did}#keys-1`;
    type: "Ed25519VerificationKey2020";
    controller: Did;
    /** SPKI-DER encoded Ed25519 public key, hex. */
    publicKeyHex: string;
  }>;
}

/** Output of `mintDid()` — DID plus matching keypair. Private key is hex. */
export interface MintedDid {
  did: Did;
  document: DidDocument;
  publicKey: string;
  /** Hex-encoded PKCS#8 DER. Never log this. */
  privateKey: string;
}

// ─── Internal: registry ────────────────────────────────────────────────────

/**
 * In-process resolver. v1 only knows about DIDs we minted in this process or
 * explicitly registered (e.g. after importing a bundle). Future versions will
 * fall through to a network registry. The registry intentionally stores only
 * public material — never the private key.
 */
const _registry = new Map<Did, DidDocument>();

/** Register a DID document — used by `mintDid()` and bundle import. */
export function registerDid(doc: DidDocument): void {
  _registry.set(doc.id, doc);
}

// ─── Crypto helpers ─────────────────────────────────────────────────────────

function publicKeyHexFromKeyObject(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("hex");
}

function privateKeyHexFromKeyObject(key: KeyObject): string {
  return key.export({ type: "pkcs8", format: "der" }).toString("hex");
}

function loadPublicKey(publicKeyHex: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(publicKeyHex, "hex"),
    format: "der",
    type: "spki",
  });
}

function loadPrivateKey(privateKeyHex: string): KeyObject {
  return createPrivateKey({
    key: Buffer.from(privateKeyHex, "hex"),
    format: "der",
    type: "pkcs8",
  });
}

function toBuffer(payload: Uint8Array | string): Buffer {
  if (typeof payload === "string") return Buffer.from(payload, "utf-8");
  return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
}

/**
 * Compute the `did:mp` tail for a given public key.
 * tail = first 16 bytes of SHA-256(spki-der(pubkey)), hex.
 * 16 bytes = 32 hex chars = 128 bits of identifier entropy — well above
 * the birthday-bound for any realistic agent population.
 */
function tailForPublicKey(publicKeyHex: string): string {
  const der = Buffer.from(publicKeyHex, "hex");
  const hash = createHash("sha256").update(der).digest();
  return hash.subarray(0, 16).toString("hex");
}

/** True when `s` is a syntactically valid `did:mp:<32-hex>` string. */
export function isDid(s: string): s is Did {
  return /^did:mp:[0-9a-f]{32}$/.test(s);
}

/**
 * Confirm that a public key actually self-certifies the DID — protects against
 * a forged DID document where the tail doesn't match the embedded key.
 */
export function publicKeyMatchesDid(did: Did, publicKeyHex: string): boolean {
  if (!isDid(did)) return false;
  const expected = did.slice("did:mp:".length);
  return tailForPublicKey(publicKeyHex) === expected;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Mint a new agent DID + Ed25519 keypair. Registers the resulting document
 * with the in-process resolver so `resolveDid()` works immediately.
 */
export function mintDid(): MintedDid {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKeyHexFromKeyObject(publicKey);
  const privateKeyHex = privateKeyHexFromKeyObject(privateKey);

  const tail = tailForPublicKey(publicKeyHex);
  const did = `did:mp:${tail}` as Did;
  const now = new Date().toISOString();

  const document: DidDocument = {
    id: did,
    createdAt: now,
    verificationMethod: [
      {
        id: `${did}#keys-1`,
        type: "Ed25519VerificationKey2020",
        controller: did,
        publicKeyHex,
      },
    ],
  };

  registerDid(document);

  return { did, document, publicKey: publicKeyHex, privateKey: privateKeyHex };
}

/**
 * Sign a payload with the DID's private key. The DID parameter is informational
 * for v1 — Ed25519 signing doesn't actually need the DID — but keeping it in
 * the signature lets us add cross-checks (e.g. selecting the right key when
 * a wallet rotates) in later versions without breaking the API.
 *
 * Returns base64 — shorter than hex and friendlier for JSON transport.
 */
export function sign(
  did: Did,
  privateKeyHex: string,
  payload: Uint8Array | string,
): string {
  if (!isDid(did)) throw new Error(`sign: invalid DID: ${did}`);
  const key = loadPrivateKey(privateKeyHex);
  const sig = cryptoSign(null, toBuffer(payload), key);
  return sig.toString("base64");
}

/**
 * Verify a base64 signature against a payload and public key, also checking
 * that the public key self-certifies the DID. Either check failing returns
 * false — verifiers never get a "signature was valid but DID was wrong"
 * silent pass.
 */
export function verify(
  did: Did,
  signature: string,
  payload: Uint8Array | string,
  publicKeyHex: string,
): boolean {
  if (!isDid(did)) return false;
  if (!publicKeyMatchesDid(did, publicKeyHex)) return false;
  try {
    const key = loadPublicKey(publicKeyHex);
    return cryptoVerify(null, toBuffer(payload), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/**
 * Look up a DID document. v1 returns whatever the in-process registry holds;
 * future versions will fall through to a network registry. Returns `null`
 * for unknown DIDs rather than throwing — consumers commonly need to branch.
 */
export function resolveDid(did: Did): DidDocument | null {
  if (!isDid(did)) return null;
  return _registry.get(did) ?? null;
}

/** Test-only — drop the resolver cache. Not part of the published API. */
export function _resetResolver(): void {
  _registry.clear();
}
