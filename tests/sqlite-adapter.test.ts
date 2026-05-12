/**
 * SQLiteAdapter unit tests.
 *
 * Covers:
 *  - set → get roundtrip preserves content, embedding bytes (exact), metadata
 *  - delete is idempotent
 *  - search returns top-K in descending cosine-similarity order
 *  - agent isolation: rows for agentA invisible to agentB
 *  - persistence across close + reopen at the same path
 *  - readOnly mode: get/search work, set/delete throw
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { SQLiteAdapter, localEmbed, l2Normalize } from "../src/index.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mnemopay-sqlite-"));
}

function pad(v: Float32Array, dims = 384): Float32Array {
  const out = new Float32Array(dims);
  out.set(v);
  return l2Normalize(out);
}

describe("SQLiteAdapter", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tmpDir();
    dbPath = path.join(dir, "memory.db");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("set → get roundtrip preserves content, embedding bytes, metadata", async () => {
    const adapter = new SQLiteAdapter({ dbPath });
    const emb = localEmbed("hello world");
    await adapter.set("agent-a", "m1", "hello world", emb, {
      tag: "greeting",
      n: 42,
    });

    const row = await adapter.get("agent-a", "m1");
    expect(row).not.toBeNull();
    expect(row!.content).toBe("hello world");
    expect(row!.embedding.length).toBe(emb.length);
    for (let i = 0; i < emb.length; i++) {
      // Exact byte equality — Float32 is bit-stable on roundtrip through BLOB.
      expect(row!.embedding[i]).toBe(emb[i]);
    }
    expect(row!.metadata).toEqual({ tag: "greeting", n: 42 });
    await adapter.close();
  });

  it("get returns null for missing rows", async () => {
    const adapter = new SQLiteAdapter({ dbPath });
    expect(await adapter.get("agent-a", "ghost")).toBeNull();
    await adapter.close();
  });

  it("set overwrites prior row with same (agentId, id)", async () => {
    const adapter = new SQLiteAdapter({ dbPath });
    await adapter.set("agent-a", "k", "v1", localEmbed("v1"), { v: 1 });
    await adapter.set("agent-a", "k", "v2", localEmbed("v2"), { v: 2 });
    const row = await adapter.get("agent-a", "k");
    expect(row!.content).toBe("v2");
    expect(row!.metadata).toEqual({ v: 2 });
    await adapter.close();
  });

  it("delete is idempotent", async () => {
    const adapter = new SQLiteAdapter({ dbPath });
    await adapter.set("agent-a", "to-del", "bye", localEmbed("bye"));
    expect(await adapter.get("agent-a", "to-del")).not.toBeNull();

    await adapter.delete("agent-a", "to-del");
    expect(await adapter.get("agent-a", "to-del")).toBeNull();
    // Second delete must not throw.
    await expect(adapter.delete("agent-a", "to-del")).resolves.toBeUndefined();
    // Deleting a never-existed id must also not throw.
    await expect(adapter.delete("agent-a", "never-existed")).resolves.toBeUndefined();
    await adapter.close();
  });

  it("search returns top-K in descending cosine-similarity order", async () => {
    const adapter = new SQLiteAdapter({ dbPath });
    const agent = "agent-search";

    const base = pad(new Float32Array([1, 0, 0, 0]));
    const close = pad(new Float32Array([0.9, 0.1, 0, 0]));
    const mid = pad(new Float32Array([0.5, 0.5, 0, 0]));
    const far = pad(new Float32Array([0, 1, 0, 0]));

    await adapter.set(agent, "near", "near content", close);
    await adapter.set(agent, "mid", "mid content", mid);
    await adapter.set(agent, "far", "far content", far);

    const results = await adapter.search(agent, base, 3);
    expect(results).toHaveLength(3);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[1].score).toBeGreaterThanOrEqual(results[2].score);
    expect(results[0].id).toBe("near");
    expect(results[2].id).toBe("far");

    // topK truncation
    const top2 = await adapter.search(agent, base, 2);
    expect(top2).toHaveLength(2);
    expect(top2[0].id).toBe("near");
    await adapter.close();
  });

  it("agent isolation: rows for agentA are invisible to agentB", async () => {
    const adapter = new SQLiteAdapter({ dbPath });
    const emb = localEmbed("shared content");
    await adapter.set("agent-a", "only-a", "only in A", emb);
    await adapter.set("agent-b", "only-b", "only in B", emb);

    expect(await adapter.get("agent-a", "only-b")).toBeNull();
    expect(await adapter.get("agent-b", "only-a")).toBeNull();

    const aHits = await adapter.search("agent-a", emb, 10);
    const bHits = await adapter.search("agent-b", emb, 10);
    expect(aHits.some((h) => h.id === "only-a")).toBe(true);
    expect(aHits.some((h) => h.id === "only-b")).toBe(false);
    expect(bHits.some((h) => h.id === "only-b")).toBe(true);
    expect(bHits.some((h) => h.id === "only-a")).toBe(false);
    await adapter.close();
  });

  it("persists across close + reopen at the same path", async () => {
    const emb = localEmbed("durable content");
    const a1 = new SQLiteAdapter({ dbPath });
    await a1.set("agent-a", "m1", "durable content", emb, { keep: true });
    await a1.close();

    // Re-open at the same path; row must still be there.
    const a2 = new SQLiteAdapter({ dbPath });
    const row = await a2.get("agent-a", "m1");
    expect(row).not.toBeNull();
    expect(row!.content).toBe("durable content");
    expect(row!.metadata).toEqual({ keep: true });
    for (let i = 0; i < emb.length; i++) {
      expect(row!.embedding[i]).toBe(emb[i]);
    }
    await a2.close();
  });

  it("readOnly mode: get/search work, set/delete throw", async () => {
    // Seed the DB with a writable adapter first.
    const seed = new SQLiteAdapter({ dbPath });
    const emb = localEmbed("readonly content");
    await seed.set("agent-a", "m1", "readonly content", emb, { ro: 1 });
    await seed.close();

    const ro = new SQLiteAdapter({ dbPath, readOnly: true });

    // Reads work.
    const row = await ro.get("agent-a", "m1");
    expect(row!.content).toBe("readonly content");
    const hits = await ro.search("agent-a", emb, 5);
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe("m1");

    // Writes refuse.
    await expect(
      ro.set("agent-a", "m2", "nope", emb),
    ).rejects.toThrow(/read-only/);
    await expect(ro.delete("agent-a", "m1")).rejects.toThrow(/read-only/);

    await ro.close();
  });

  it("readOnly mode refuses to fabricate a missing file", () => {
    const missing = path.join(dir, "does-not-exist.db");
    expect(() => new SQLiteAdapter({ dbPath: missing, readOnly: true })).toThrow();
  });

  it("defaultDbPath resolves to the per-agent directory", () => {
    const prev = process.env.MNEMOPAY_PERSIST_DIR;
    process.env.MNEMOPAY_PERSIST_DIR = dir;
    try {
      const p = SQLiteAdapter.defaultDbPath("alpha");
      expect(p).toBe(path.join(dir, "agent-alpha", "memory.db"));
      // Parent directory must have been created.
      expect(fs.existsSync(path.dirname(p))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MNEMOPAY_PERSIST_DIR;
      else process.env.MNEMOPAY_PERSIST_DIR = prev;
    }
  });
});
