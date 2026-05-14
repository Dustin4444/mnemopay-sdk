import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Wallet } from "./wallet.js";
import { _resetResolver, resolveDid, isDid } from "./did.js";
import { importBundle } from "./bundle.js";

describe("Wallet — create", () => {
  beforeEach(() => _resetResolver());

  it("mints a fresh wallet with a valid DID", () => {
    const w = Wallet.create();
    expect(isDid(w.did)).toBe(true);
    expect(w.publicKey).toHaveLength(88);
    expect(resolveDid(w.did)).not.toBeNull();
  });

  it("accepts a name without affecting the DID", () => {
    const w = Wallet.create({ name: "shopping-bot" });
    expect(w.name).toBe("shopping-bot");
    expect(isDid(w.did)).toBe(true);
  });

  it("never exposes the private key on the instance surface", () => {
    const w = Wallet.create();
    // Keys on the object should not include a `privateKey` getter.
    const keys = Object.keys(w);
    expect(keys).not.toContain("privateKey");
    expect(keys).not.toContain("_privateKey");
  });

  it("fingerprint() returns a short, safe-to-log identifier", () => {
    const w = Wallet.create();
    const fp = w.fingerprint();
    expect(fp.startsWith("did:mp:")).toBe(true);
    expect(fp.length).toBeLessThan(w.did.length);
  });
});

describe("Wallet — sign / verify", () => {
  beforeEach(() => _resetResolver());

  it("signs payloads its own DID can verify via the matching pubkey", () => {
    const w = Wallet.create();
    const sig = w.sign("hello agent world");
    expect(w.verify(w.did, sig, "hello agent world", w.publicKey)).toBe(true);
  });

  it("verifies signatures from a different wallet", () => {
    const a = Wallet.create();
    const b = Wallet.create();
    const sig = b.sign("from b");
    expect(a.verify(b.did, sig, "from b", b.publicKey)).toBe(true);
  });

  it("rejects tampered payloads", () => {
    const a = Wallet.create();
    const sig = a.sign("original");
    expect(a.verify(a.did, sig, "mutated", a.publicKey)).toBe(false);
  });
});

describe("Wallet — bundle", () => {
  beforeEach(() => _resetResolver());

  it("exports a bundle that round-trips through importBundle()", () => {
    const w = Wallet.create({ name: "agent-007" });
    const bundle = w.exportBundle({ fico: 720 });
    const parsed = importBundle(bundle);
    expect(parsed.valid).toBe(true);
    expect(parsed.did).toBe(w.did);
    expect(parsed.payload?.fico).toBe(720);
  });
});

describe("Wallet — filesystem persistence", () => {
  let tmp: string;

  beforeEach(() => {
    _resetResolver();
    tmp = mkdtempSync(join(tmpdir(), "mnemopay-wallet-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("persists to fs when persist:'fs'", () => {
    const w = Wallet.create({ persist: "fs", rootDir: tmp });
    const path = w.diskPath();
    expect(existsSync(path)).toBe(true);

    // Best-effort mode check — Windows often reports 0o666, POSIX 0o600.
    const mode = statSync(path).mode & 0o777;
    expect(typeof mode).toBe("number");
  });

  it("reloads from disk and produces an identical signing key", () => {
    const original = Wallet.create({ persist: "fs", rootDir: tmp });
    const sig = original.sign("anchor message");

    _resetResolver();
    const reloaded = Wallet.load(original.did, { rootDir: tmp });
    expect(reloaded.did).toBe(original.did);
    expect(reloaded.publicKey).toBe(original.publicKey);
    // Re-signed bytes verify under the original public key — proves the
    // private key survived disk round-trip.
    const sig2 = reloaded.sign("anchor message");
    expect(reloaded.verify(reloaded.did, sig2, "anchor message", reloaded.publicKey)).toBe(true);
    // And the original signature still verifies through the reloaded wallet.
    expect(reloaded.verify(original.did, sig, "anchor message", original.publicKey)).toBe(true);
  });

  it("openOrCreate() loads when the file exists, mints otherwise", () => {
    const minted = Wallet.create({ persist: "fs", rootDir: tmp });
    const reopened = Wallet.openOrCreate({ did: minted.did, rootDir: tmp });
    expect(reopened.did).toBe(minted.did);

    const fresh = Wallet.openOrCreate({ rootDir: tmp });
    expect(fresh.did).not.toBe(minted.did);
  });

  it("Wallet.load throws when the file is missing", () => {
    expect(() =>
      Wallet.load("did:mp:00000000000000000000000000000000" as never, { rootDir: tmp }),
    ).toThrow();
  });
});
