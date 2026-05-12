/**
 * PersistentApprovalQueue tests.
 *
 * Proves the HITL queues survive a process restart — the original bug was
 * that pending charge approvals lived in an in-process Map and silently
 * vanished on any pod restart. Now they're SQLite-backed.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { PersistentApprovalQueue } from "../src/storage/approval-queue.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-approval-"));
}

function makeQueue(dir: string): PersistentApprovalQueue {
  return new PersistentApprovalQueue({ dbPath: path.join(dir, "approvals.db") });
}

describe("PersistentApprovalQueue", () => {
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

  it("persists charge requests across a queue rebuild (simulates pod restart)", () => {
    const q1 = makeQueue(dir);
    q1.addCharge({
      id: "cr_test_abc",
      amount: 112.0,
      reason: "monthly_pro_subscription_renewal",
      context: { customerId: "cus_2N9k" },
      payOptions: { rail: "stripe" },
      createdAt: Date.now(),
    });
    expect(q1.charges.size).toBe(1);
    q1.close();

    // Pod dies. New process boots. We get a fresh queue pointed at the same dir.
    const q2 = makeQueue(dir);
    expect(q2.charges.size).toBe(1);
    const got = q2.charges.get("cr_test_abc");
    expect(got).toBeDefined();
    expect(got!.amount).toBe(112.0);
    expect(got!.reason).toBe("monthly_pro_subscription_renewal");
    expect(got!.context).toEqual({ customerId: "cus_2N9k" });
    expect(got!.payOptions).toEqual({ rail: "stripe" });
    q2.close();
  });

  it("removeCharge persists the deletion across rebuilds", () => {
    const q1 = makeQueue(dir);
    q1.addCharge({ id: "cr_keep", amount: 5, reason: "keep", createdAt: 1 });
    q1.addCharge({ id: "cr_drop", amount: 10, reason: "drop", createdAt: 2 });
    expect(q1.removeCharge("cr_drop")?.amount).toBe(10);
    q1.close();

    const q2 = makeQueue(dir);
    expect(q2.charges.size).toBe(1);
    expect(q2.charges.has("cr_keep")).toBe(true);
    expect(q2.charges.has("cr_drop")).toBe(false);
    q2.close();
  });

  it("persists shop approvals as serialized order data; resolve is no-op on rehydrate", () => {
    const q1 = makeQueue(dir);
    let originalResolveCalled = false;
    q1.addShopApproval({
      orderId: "ord_42",
      order: { product: { title: "Widget", price: 9.99, merchant: "acme.com" } },
      createdAt: Date.now(),
      resolve: () => {
        originalResolveCalled = true;
      },
    });
    q1.close();

    const q2 = makeQueue(dir);
    expect(q2.shopApprovals.size).toBe(1);
    const got = q2.shopApprovals.get("ord_42")!;
    expect(got.order.product.title).toBe("Widget");
    // resolve survived as a no-op, calling it should not throw
    expect(() => got.resolve(true)).not.toThrow();
    // and the original process's resolve callback obviously did NOT fire — it lived in a dead process
    expect(originalResolveCalled).toBe(false);
    q2.close();
  });

  it("expireOlderThan drops aged entries and removes their rows", () => {
    const q = makeQueue(dir);
    const now = 1_000_000;
    q.addCharge({ id: "old", amount: 1, reason: "old", createdAt: now - 700_000 });
    q.addCharge({ id: "young", amount: 1, reason: "young", createdAt: now - 100_000 });
    const removed = q.expireOlderThan(600_000, now);
    expect(removed).toBe(1);
    expect(q.charges.has("old")).toBe(false);
    expect(q.charges.has("young")).toBe(true);
    q.close();

    // Rebuild — old must not come back, young must still be there.
    const q2 = makeQueue(dir);
    expect(q2.charges.has("old")).toBe(false);
    expect(q2.charges.has("young")).toBe(true);
    q2.close();
  });

  it("expireOlderThan invokes shop resolve(false) so any live Promise unblocks", () => {
    const q = makeQueue(dir);
    let resolvedWith: boolean | null = null;
    q.addShopApproval({
      orderId: "stale",
      order: {},
      createdAt: 1,
      resolve: (v) => {
        resolvedWith = v;
      },
    });
    q.expireOlderThan(600_000, 700_001);
    expect(resolvedWith).toBe(false);
    expect(q.shopApprovals.size).toBe(0);
    q.close();
  });

  it("addCharge with undefined context/payOptions round-trips correctly", () => {
    const q1 = makeQueue(dir);
    q1.addCharge({ id: "cr_min", amount: 1, reason: "min", createdAt: 1 });
    q1.close();

    const q2 = makeQueue(dir);
    const got = q2.charges.get("cr_min")!;
    expect(got.context).toBeUndefined();
    expect(got.payOptions).toBeUndefined();
    q2.close();
  });
});
