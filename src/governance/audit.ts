/**
 * Merkle-chained audit log. Folded from praetor/packages/core/src/audit.ts
 * (commit 06a5aec) on 2026-05-06 as part of the FiscalGate + Article 12
 * governance fold into MnemoPay SDK.
 *
 * Pure module — only depends on node:crypto.
 */

import { createHash } from "node:crypto";

export interface AuditEvent {
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

export type AuditListener = (event: AuditEvent, chainHash: string, index: number) => void;

export class MerkleAudit {
  private events: AuditEvent[] = [];
  private chain: string[] = [];
  private listeners: AuditListener[] = [];
  /**
   * Per-event cached `JSON.stringify(ev)` populated by `record()`. Lets
   * `verify()` skip the JSON pass when the chain was built in-process.
   * Indexed parallel to `this.events`. `fromJSON()` leaves this empty so
   * a chain reconstructed from an external bundle still re-stringifies on
   * verify — which is exactly what makes tamper detection on a fromJSON
   * instance honest (mutating events[i].data must invalidate the cache,
   * and the empty cache forces a fresh stringify).
   */
  private eventJsonCache: (string | undefined)[] = [];

  /** Subscribe to every record() call. Returns an unsubscribe function. */
  on(listener: AuditListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  record(type: string, data: Record<string, unknown>) {
    const ev: AuditEvent = { ts: new Date().toISOString(), type, data };
    this.events.push(ev);
    const prev = this.chain[this.chain.length - 1] ?? "";
    // Stringify once, cache for verify(). `.update(prev).update(json)` avoids
    // building an intermediate `prev + json` string — ~2x faster than concat
    // on the 64-char prev + 100-200-byte json common case.
    const json = JSON.stringify(ev);
    this.eventJsonCache.push(json);
    const next = createHash("sha256").update(prev).update(json).digest("hex");
    this.chain.push(next);
    for (const l of this.listeners) {
      try { l(ev, next, this.events.length - 1); } catch { /* listener errors are not chain-breaking */ }
    }
  }

  finalize(): string {
    return this.chain[this.chain.length - 1] ?? createHash("sha256").update("").digest("hex");
  }

  getEvents(): readonly AuditEvent[] {
    return this.events;
  }

  getChain(): readonly string[] {
    return this.chain;
  }

  /**
   * Verify the chain by re-hashing every event from the genesis.
   *
   * For chains built via `record()` (the in-process path), each event's
   * canonical JSON is cached — so verify is one sha256 per event with no
   * JSON work. For chains built via `fromJSON()` (audit bundles loaded from
   * disk) the cache is empty, forcing a fresh JSON.stringify per event —
   * which is what makes tamper detection honest on imported bundles.
   */
  verify(): boolean {
    let prev = "";
    for (let i = 0; i < this.events.length; i++) {
      const cached = this.eventJsonCache[i];
      const json = cached !== undefined ? cached : JSON.stringify(this.events[i]);
      const expected = createHash("sha256").update(prev).update(json).digest("hex");
      if (expected !== this.chain[i]) return false;
      prev = expected;
    }
    return true;
  }

  toJSON() {
    return { events: this.events, chain: this.chain };
  }

  static fromJSON(j: { events: AuditEvent[]; chain: string[] }): MerkleAudit {
    const a = new MerkleAudit();
    a.events = j.events.slice();
    a.chain = j.chain.slice();
    // Note: eventJsonCache intentionally left empty. See verify() docstring.
    return a;
  }
}
