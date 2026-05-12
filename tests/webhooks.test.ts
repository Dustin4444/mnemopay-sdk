/**
 * WebhookStore tests — persistent subscriptions + HMAC-signed delivery + retry/DLQ.
 *
 * The bug we're closing: `webhook_register` returned success but no POST ever
 * fired. The store now persists subs to SQLite, fire() enqueues a delivery
 * per matching sub, and pumpOnce() drains the queue with HMAC signatures
 * and exponential-backoff retry up to 6 attempts.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  WebhookStore,
  signPayload,
  verifySignature,
} from "../src/storage/webhooks.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-webhooks-"));
}

function makeStore(dir: string): WebhookStore {
  return new WebhookStore({ dbPath: path.join(dir, "webhooks.db") });
}

describe("WebhookStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("register issues an opaque signing secret and persists across rebuilds", () => {
    const s1 = makeStore(dir);
    const sub = s1.register("https://example.com/hook", ["charge.success", "settle"]);
    expect(sub.secret).toMatch(/^whsec_/);
    expect(sub.id).toMatch(/^wh_/);
    expect(sub.events).toEqual(["charge.success", "settle"]);
    s1.close();

    const s2 = makeStore(dir);
    const list = s2.list();
    expect(list).toHaveLength(1);
    expect(list[0].secret).toBe(sub.secret);
    s2.close();
  });

  it("matching() filters by event and respects the wildcard '*'", () => {
    const s = makeStore(dir);
    s.register("https://a.example.com/hook", ["charge.success"]);
    s.register("https://b.example.com/hook", ["settle"]);
    s.register("https://c.example.com/hook", ["*"]);
    expect(s.matching("charge.success").map((x) => x.url)).toEqual(
      expect.arrayContaining(["https://a.example.com/hook", "https://c.example.com/hook"])
    );
    expect(s.matching("settle").map((x) => x.url)).toEqual(
      expect.arrayContaining(["https://b.example.com/hook", "https://c.example.com/hook"])
    );
    expect(s.matching("refund").map((x) => x.url)).toEqual([
      "https://c.example.com/hook",
    ]);
    s.close();
  });

  it("fire() enqueues one delivery per matching subscription", () => {
    const s = makeStore(dir);
    s.register("https://a.example.com/hook", ["charge.success"]);
    s.register("https://b.example.com/hook", ["*"]);
    s.register("https://c.example.com/hook", ["settle"]); // not matching

    const n = s.fire("charge.success", { txId: "tx_1", amount: 9.99 });
    expect(n).toBe(2);
    const counts = s.countByStatus();
    expect(counts.pending).toBe(2);
    expect(counts.delivered).toBe(0);
    expect(counts.dead).toBe(0);
    s.close();
  });

  it("pumpOnce delivers to a 2xx endpoint and includes an HMAC header verifiable with the secret", async () => {
    const s = makeStore(dir);
    const sub = s.register("https://example.com/hook", ["charge.success"]);
    s.fire("charge.success", { txId: "tx_42", amount: 12.0 });

    let receivedHeader: string | null = null;
    let receivedBody: string | null = null;
    const fakeFetch: any = async (_url: string, init: any) => {
      receivedHeader = init.headers["x-mnemopay-signature"];
      receivedBody = init.body;
      return { status: 200 };
    };
    await s.pumpOnce(10, fakeFetch);

    expect(receivedHeader).toMatch(/^t=\d+,v1=[a-f0-9]+$/);
    expect(verifySignature(sub.secret, receivedBody!, receivedHeader!)).toBe(true);
    // Tampered body must fail verification
    expect(verifySignature(sub.secret, receivedBody! + "x", receivedHeader!)).toBe(false);

    const counts = s.countByStatus();
    expect(counts.delivered).toBe(1);
    expect(counts.pending).toBe(0);
    s.close();
  });

  it("non-2xx responses schedule a retry with exponential backoff (not delivered, not dead)", async () => {
    const s = makeStore(dir);
    s.register("https://example.com/hook", ["settle"]);
    s.fire("settle", { txId: "tx_50" });

    const fakeFetch: any = async () => ({ status: 503 });
    await s.pumpOnce(10, fakeFetch);

    const counts = s.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.delivered).toBe(0);
    expect(counts.dead).toBe(0);
    s.close();
  });

  it("after MAX_ATTEMPTS failures the delivery is marked 'dead' (DLQ)", async () => {
    const s = makeStore(dir);
    s.register("https://example.com/hook", ["refund"]);
    s.fire("refund", { txId: "tx_dead" });

    const fakeFetch: any = async () => ({ status: 500 });
    // Force-pump 6 times; we manually advance next_attempt_at by writing
    // directly through SQL since this test should not actually sleep.
    for (let i = 0; i < 6; i++) {
      await s.pumpOnce(10, fakeFetch);
      // bring the next_attempt_at back to now so we can re-pump in the loop
      const db = (s as any).db;
      db.prepare(`UPDATE deliveries SET next_attempt_at = ? WHERE status = 'pending'`).run(
        Date.now()
      );
    }
    const counts = s.countByStatus();
    expect(counts.dead).toBe(1);
    expect(counts.pending).toBe(0);
    expect(counts.delivered).toBe(0);
    s.close();
  });

  it("unregister removes the sub and matching() drops it", () => {
    const s = makeStore(dir);
    const sub = s.register("https://example.com/hook", ["charge.success"]);
    expect(s.list()).toHaveLength(1);
    expect(s.unregister(sub.id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.matching("charge.success")).toHaveLength(0);
    s.close();
  });
});

describe("signPayload / verifySignature", () => {
  it("round-trip is correct", () => {
    const body = JSON.stringify({ hello: "world" });
    const t = Math.floor(Date.now() / 1000);
    const header = signPayload("whsec_test_secret", body, t);
    expect(verifySignature("whsec_test_secret", body, header)).toBe(true);
  });

  it("wrong secret fails", () => {
    const body = "{}";
    const t = Math.floor(Date.now() / 1000);
    const header = signPayload("right", body, t);
    expect(verifySignature("wrong", body, header)).toBe(false);
  });

  it("stale timestamp fails (default tolerance is 5 minutes)", () => {
    const body = "{}";
    const stale = Math.floor(Date.now() / 1000) - 10 * 60; // 10 min ago
    const header = signPayload("whsec_test", body, stale);
    expect(verifySignature("whsec_test", body, header)).toBe(false);
  });
});
