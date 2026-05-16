import { describe, it, expect } from "vitest";
import { Wallet } from "../src/identity/wallet.js";
import { anchorMemory, type MemoryAnchor } from "../src/recall/anchor.js";
import {
  NoopAnchorAdapter,
  InMemoryAnchorAdapter,
  GridStampAnchorAdapter,
  computeAnchorContentId,
  type GridStampRemoteIdSink,
} from "../src/recall/anchor-adapter.js";

const FIXED_NONCE = "0123456789abcdef0123456789abcdef";
const FIXED_DATE = new Date("2026-05-16T12:00:00.000Z");

function mintAnchor(content: string, sequence = 0): MemoryAnchor {
  const wallet = Wallet.create();
  return anchorMemory({
    memory_id: `mem_${sequence}`,
    content,
    wallet,
    sequence,
    nonce: FIXED_NONCE,
    now: FIXED_DATE,
  });
}

describe("computeAnchorContentId", () => {
  it("is deterministic for identical anchors and 64-hex", () => {
    const wallet = Wallet.create();
    const a1 = anchorMemory({
      memory_id: "m1",
      content: "x",
      wallet,
      sequence: 0,
      nonce: FIXED_NONCE,
      now: FIXED_DATE,
    });
    const a2: MemoryAnchor = JSON.parse(JSON.stringify(a1));
    const id1 = computeAnchorContentId(a1);
    const id2 = computeAnchorContentId(a2);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("NoopAnchorAdapter", () => {
  it("produces a receipt with content_id and null sink_receipt", async () => {
    const anchor = mintAnchor("hello world");
    const adapter = new NoopAnchorAdapter();
    const r = await adapter.receipt({ anchor, content: "hello world" });

    expect(r.version).toBe(1);
    expect(r.sink_id).toBe("noop");
    expect(r.memory_id).toBe(anchor.memory_id);
    expect(r.content_id).toBe(computeAnchorContentId(anchor));
    expect(r.sink_receipt).toBeNull();
    expect(Date.parse(r.receipted_at)).not.toBeNaN();
  });
});

describe("InMemoryAnchorAdapter", () => {
  it("tracks a Merkle batch and the running root grows monotonically", async () => {
    const adapter = new InMemoryAnchorAdapter();
    const anchors = [
      mintAnchor("first", 0),
      mintAnchor("second", 1),
      mintAnchor("third", 2),
    ];

    expect(adapter.currentRoot()).toBe("");

    const r1 = await adapter.receipt({ anchor: anchors[0]!, content: "first" });
    const root1 = adapter.currentRoot();
    expect(root1).toMatch(/^[0-9a-f]{64}$/);
    expect((r1.sink_receipt as any).batch_index).toBe(0);
    expect((r1.sink_receipt as any).running_root).toBe(root1);

    const r2 = await adapter.receipt({ anchor: anchors[1]!, content: "second" });
    const root2 = adapter.currentRoot();
    expect(root2).not.toBe(root1);
    expect((r2.sink_receipt as any).batch_index).toBe(1);

    await adapter.receipt({ anchor: anchors[2]!, content: "third" });
    expect(adapter.batchHashes()).toHaveLength(3);

    adapter.reset();
    expect(adapter.batchHashes()).toHaveLength(0);
    expect(adapter.currentRoot()).toBe("");
  });
});

describe("GridStampAnchorAdapter (loose-coupled sink)", () => {
  it("forwards a successful sign call into sink_receipt", async () => {
    const calls: Array<{ memory_id: string; content_id: string }> = [];
    const sink: GridStampRemoteIdSink = {
      async signRecallAnchor(input) {
        calls.push({ memory_id: input.memory_id, content_id: input.content_id });
        return { log_id: "log_abc", signature: "deadbeef".repeat(8) };
      },
    };
    const adapter = new GridStampAnchorAdapter({ sink });
    const anchor = mintAnchor("delivered to porch");

    const r = await adapter.receipt({ anchor, content: "delivered to porch" });

    expect(r.sink_id).toBe("gridstamp");
    expect(r.content_id).toBe(computeAnchorContentId(anchor));
    expect(r.sink_receipt).toMatchObject({
      log_id: "log_abc",
      signature: "deadbeef".repeat(8),
    });
    expect(calls).toEqual([
      { memory_id: anchor.memory_id, content_id: r.content_id },
    ]);
  });

  it("fail-soft: sink error never throws, returns sink_error in receipt", async () => {
    const sink: GridStampRemoteIdSink = {
      async signRecallAnchor(): Promise<never> {
        throw new Error("gridstamp unreachable");
      },
    };
    const adapter = new GridStampAnchorAdapter({ sink });
    const anchor = mintAnchor("payload");

    const r = await adapter.receipt({ anchor, content: "payload" });

    expect(r.sink_id).toBe("gridstamp");
    expect(r.content_id).toBe(computeAnchorContentId(anchor));
    expect(r.sink_receipt).toMatchObject({ sink_error: "gridstamp unreachable" });
  });

  it("rejects construction without a sink (fail-fast on misconfig)", () => {
    expect(
      () => new GridStampAnchorAdapter({ sink: undefined as unknown as GridStampRemoteIdSink }),
    ).toThrow(/sink required/);
  });
});
