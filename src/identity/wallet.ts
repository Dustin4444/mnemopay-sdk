/**
 * Per-agent identity wallet — wraps a DID, its Ed25519 keys, and the bundle
 * export path into a single object. Persistence is optional: `memory` (default)
 * keeps keys in process only; `fs` writes them to `~/.mnemopay/identities/<did>.json`
 * with mode 0600 (best-effort on Windows — `fs.chmodSync` is called regardless).
 *
 * The wallet deliberately doesn't take a network registry parameter — that
 * concern lives in did.ts and bundle.ts. Wallets are local-first.
 */

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

import {
  mintDid,
  registerDid,
  sign as didSign,
  verify as didVerify,
  isDid,
  type Did,
  type DidDocument,
} from "./did.js";
import {
  exportBundle,
  type ExportBundleOptions,
  type IdentityBundle,
} from "./bundle.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export type WalletPersistMode = "memory" | "fs";

export interface WalletOptions {
  /** Human-friendly label — never affects the DID. */
  name?: string;
  /**
   * Persistence target.
   *   "memory" (default) — keys live in this Wallet instance only.
   *   "fs"               — keys persisted to `~/.mnemopay/identities/<did>.json`,
   *                        chmod 0600 on creation.
   */
  persist?: WalletPersistMode;
  /** Override the persistence root — useful for tests. */
  rootDir?: string;
}

/** Shape of the on-disk wallet file. */
interface WalletFile {
  version: 1;
  did: Did;
  name?: string;
  publicKey: string;
  /** Hex PKCS#8 DER. Stored at file-mode 0600. Never log. */
  privateKey: string;
  createdAt: string;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function defaultRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".mnemopay", "identities");
}

function fileForDid(did: Did, rootDir?: string): string {
  return join(defaultRoot(rootDir), `${did.replace(/:/g, "_")}.json`);
}

function readWalletFile(path: string): WalletFile {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as WalletFile;
  if (parsed?.version !== 1) {
    throw new Error(`Wallet: unsupported file version: ${String(parsed?.version)}`);
  }
  if (!isDid(parsed.did)) {
    throw new Error(`Wallet: file at ${path} has invalid DID`);
  }
  return parsed;
}

function writeWalletFile(path: string, data: WalletFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Write then chmod. On POSIX this locks the file to the owner; on Windows
  // chmodSync is mostly a no-op but we call it for forward-compat per brief.
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8" });
  try {
    chmodSync(path, 0o600);
  } catch {
    // chmod failures on locked-down filesystems shouldn't break persistence.
  }
}

// ─── Wallet ────────────────────────────────────────────────────────────────

/**
 * Private wallet state lives in a module-local WeakMap, not on the instance.
 * This makes `Object.keys(wallet)` show only public-safe fields and prevents
 * structured-clone / JSON.stringify from accidentally leaking the private
 * key. The key material is collected when the Wallet instance is gc'd.
 */
interface WalletSecrets {
  privateKey: string;
  persist: WalletPersistMode;
  rootDir: string | undefined;
}

const _secrets = new WeakMap<Wallet, WalletSecrets>();

export class Wallet {
  readonly did: Did;
  readonly publicKey: string;
  readonly name: string | undefined;
  readonly createdAt: string;

  /**
   * Construct directly — prefer `Wallet.create()` / `Wallet.load()` /
   * `Wallet.openOrCreate()` in user code so persistence behaviour is explicit.
   */
  constructor(args: {
    did: Did;
    publicKey: string;
    privateKey: string;
    name?: string;
    createdAt?: string;
    persist?: WalletPersistMode;
    rootDir?: string;
  }) {
    if (!isDid(args.did)) throw new Error(`Wallet: invalid DID: ${args.did}`);
    this.did = args.did;
    this.publicKey = args.publicKey;
    this.name = args.name;
    this.createdAt = args.createdAt ?? new Date().toISOString();

    _secrets.set(this, {
      privateKey: args.privateKey,
      persist: args.persist ?? "memory",
      rootDir: args.rootDir,
    });

    // Register so resolveDid() / bundle verify work in-process.
    const doc: DidDocument = {
      id: this.did,
      createdAt: this.createdAt,
      verificationMethod: [
        {
          id: `${this.did}#keys-1`,
          type: "Ed25519VerificationKey2020",
          controller: this.did,
          publicKeyHex: this.publicKey,
        },
      ],
    };
    registerDid(doc);

    if ((_secrets.get(this) as WalletSecrets).persist === "fs") {
      this.persistToDisk();
    }
  }

  /** Internal accessor — never exported. */
  private _secret(): WalletSecrets {
    const s = _secrets.get(this);
    if (!s) throw new Error("Wallet: instance has no secret context");
    return s;
  }

  // ── Factories ──────────────────────────────────────────────────────────

  /** Mint a fresh DID and wrap it in a new wallet. */
  static create(opts: WalletOptions = {}): Wallet {
    const minted = mintDid();
    return new Wallet({
      did: minted.did,
      publicKey: minted.publicKey,
      privateKey: minted.privateKey,
      name: opts.name,
      persist: opts.persist ?? "memory",
      rootDir: opts.rootDir,
    });
  }

  /** Load an existing wallet from disk by DID. Throws if missing. */
  static load(did: Did, opts: { rootDir?: string } = {}): Wallet {
    const path = fileForDid(did, opts.rootDir);
    if (!existsSync(path)) {
      throw new Error(`Wallet.load: no wallet file at ${path}`);
    }
    const file = readWalletFile(path);
    return new Wallet({
      did: file.did,
      publicKey: file.publicKey,
      privateKey: file.privateKey,
      name: file.name,
      createdAt: file.createdAt,
      persist: "fs",
      rootDir: opts.rootDir,
    });
  }

  /** Convenience — load if exists, otherwise mint + persist. */
  static openOrCreate(opts: WalletOptions & { did?: Did } = {}): Wallet {
    if (opts.did) {
      const path = fileForDid(opts.did, opts.rootDir);
      if (existsSync(path)) return Wallet.load(opts.did, { rootDir: opts.rootDir });
    }
    return Wallet.create({ ...opts, persist: opts.persist ?? "fs" });
  }

  // ── Operations ─────────────────────────────────────────────────────────

  /** Sign a payload with the wallet's private key. */
  sign(payload: Uint8Array | string): string {
    return didSign(this.did, this._secret().privateKey, payload);
  }

  /**
   * Verify a signature from another DID. Pass the counterparty's DID +
   * signature + payload + their public key.
   */
  verify(
    otherDid: Did,
    signature: string,
    payload: Uint8Array | string,
    otherPublicKey: string,
  ): boolean {
    return didVerify(otherDid, signature, payload, otherPublicKey);
  }

  /** Build a signed identity bundle for this wallet. */
  exportBundle(options: ExportBundleOptions = {}): IdentityBundle {
    return exportBundle(this.did, this._secret().privateKey, this.publicKey, options);
  }

  /**
   * Short, human-friendly identifier — first 12 hex chars of the DID tail.
   * Safe to log; never includes private key material.
   */
  fingerprint(): string {
    return `${this.did.slice(0, 19)}...`;
  }

  /**
   * Force a disk write. Useful if the wallet was constructed in "memory"
   * mode and you decide later to persist it.
   */
  persistToDisk(rootDir?: string): string {
    const secret = this._secret();
    const path = fileForDid(this.did, rootDir ?? secret.rootDir);
    const file: WalletFile = {
      version: 1,
      did: this.did,
      name: this.name,
      publicKey: this.publicKey,
      privateKey: secret.privateKey,
      createdAt: this.createdAt,
    };
    writeWalletFile(path, file);
    return path;
  }

  /**
   * Reveal the on-disk path this wallet would write to, even if it currently
   * lives in memory. Helpful for diagnostics.
   */
  diskPath(rootDir?: string): string {
    return fileForDid(this.did, rootDir ?? this._secret().rootDir);
  }
}
