/**
 * SQLiteAdapter — PersistenceAdapter backed by a single better-sqlite3 file.
 *
 * Matches the "share the engine, isolate the corpus" model: every agent gets
 * its own DB file under ${MNEMOPAY_PERSIST_DIR || ~/.mnemopay/data}/agent-<id>/memory.db,
 * so rows from different agents never share a backing store. The agent_id
 * column is still present (and the primary key still includes it) so a single
 * file can host multiple agents when callers want that — e.g. the read-only
 * `brain` corpus bridged into the MCP server uses one shared file with a
 * fixed agentId.
 *
 * Schema:
 *   CREATE TABLE memory_rows (
 *     agent_id   TEXT NOT NULL,
 *     id         TEXT NOT NULL,
 *     content    TEXT NOT NULL,
 *     embedding  BLOB NOT NULL,           -- raw Float32Array bytes (LE)
 *     metadata   TEXT NOT NULL DEFAULT '{}',
 *     created_at INTEGER NOT NULL,
 *     PRIMARY KEY (agent_id, id)
 *   );
 *   CREATE INDEX idx_memory_agent ON memory_rows(agent_id);
 *
 * Behaviour:
 *   - WAL journal_mode + synchronous=NORMAL (matches approval-queue / webhooks)
 *   - set() is INSERT OR REPLACE — same idempotency contract as Memory/Neon
 *   - search() pulls all rows for the agentId and runs cosine similarity in JS;
 *     no ANN index — corpus sizes here are bounded (single-digit thousands).
 *   - close() WAL-checkpoints then closes; safe to call multiple times.
 *
 * Read-only mode:
 *   When constructed with `readOnly: true` the DB is opened with better-sqlite3's
 *   readonly flag (no schema bootstrap is attempted). set()/delete() reject so
 *   callers can't accidentally mutate a foreign corpus (the brain bridge).
 *
 * Single-process writes only — matches the broader SQLite usage in this repo.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { PersistedRow, PersistenceAdapter, SearchHit } from "./types.js";
import { cosineSimilarity } from "../engine.js";

export interface SQLiteAdapterConfig {
  /** Absolute path to the SQLite file. Default: see SQLiteAdapter.defaultDbPath(). */
  dbPath?: string;
  /** Open the DB in read-only mode. set()/delete() will throw. */
  readOnly?: boolean;
  /** Override the agentId used by defaultDbPath() when dbPath is omitted. */
  agentId?: string;
}

interface MemoryRow {
  agent_id: string;
  id: string;
  content: string;
  embedding: Buffer;
  metadata: string;
  created_at: number;
}

function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy into a freshly aligned ArrayBuffer — better-sqlite3 returns a Buffer
  // that *may* share an underlying pool whose byteOffset is not 4-byte aligned.
  // Float32Array requires 4-byte alignment, so we always copy.
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return new Float32Array(ab);
}

function float32ToBuffer(vec: Float32Array): Buffer {
  // Slice() guarantees the returned Float32Array's buffer is exactly its own
  // bytes (not a view into a larger pool). Buffer.from(ArrayBuffer) then
  // wraps without copying.
  const sliced = vec.slice();
  return Buffer.from(sliced.buffer, sliced.byteOffset, sliced.byteLength);
}

export class SQLiteAdapter implements PersistenceAdapter {
  private db: any;
  private readonly dbPath: string;
  private readonly readOnly: boolean;
  private closed = false;
  private setStmt: any;
  private getStmt: any;
  private deleteStmt: any;
  private searchStmt: any;

  constructor(config: SQLiteAdapterConfig = {}) {
    this.readOnly = config.readOnly ?? false;
    this.dbPath =
      config.dbPath ?? SQLiteAdapter.defaultDbPath(config.agentId ?? "default");
    this._open();
    if (!this.readOnly) this._createTables();
    this._prepareStatements();
  }

  /**
   * Default path: ${MNEMOPAY_PERSIST_DIR || ~/.mnemopay/data}/agent-<id>/memory.db
   * The parent directory is created if missing (mkdir -p). Read-only callers
   * can pass an explicit dbPath instead and skip the directory side effect.
   */
  static defaultDbPath(agentId: string): string {
    const base =
      process.env.MNEMOPAY_PERSIST_DIR || path.join(os.homedir(), ".mnemopay", "data");
    const dir = path.join(base, `agent-${agentId}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore — _open will surface a clearer error if dir is unusable */
    }
    return path.join(dir, "memory.db");
  }

  private _open(): void {
    try {
      const Database = require("better-sqlite3");
      if (this.readOnly) {
        // Refuse to fabricate the file in read-only mode — the brain bridge
        // should not silently create an empty corpus just because the env
        // var pointed at the wrong path.
        if (!fs.existsSync(this.dbPath)) {
          throw new Error(`file does not exist: ${this.dbPath}`);
        }
        this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      } else {
        this.db = new Database(this.dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
      }
    } catch (err: any) {
      throw new Error(
        `SQLiteAdapter: failed to open ${this.dbPath} — ${err?.message || err}`,
      );
    }
  }

  private _createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_rows (
        agent_id TEXT NOT NULL,
        id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        PRIMARY KEY (agent_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_agent ON memory_rows(agent_id);
    `);
  }

  private _prepareStatements(): void {
    if (!this.readOnly) {
      this.setStmt = this.db.prepare(
        `INSERT OR REPLACE INTO memory_rows
           (agent_id, id, content, embedding, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      this.deleteStmt = this.db.prepare(
        `DELETE FROM memory_rows WHERE agent_id = ? AND id = ?`,
      );
    }
    this.getStmt = this.db.prepare(
      `SELECT agent_id, id, content, embedding, metadata, created_at
         FROM memory_rows WHERE agent_id = ? AND id = ?`,
    );
    this.searchStmt = this.db.prepare(
      `SELECT id, content, embedding, metadata FROM memory_rows WHERE agent_id = ?`,
    );
  }

  async set(
    agentId: string,
    id: string,
    content: string,
    embedding: Float32Array,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    if (this.closed) throw new Error("SQLiteAdapter.set: adapter is closed");
    if (this.readOnly) {
      throw new Error("SQLiteAdapter.set: adapter is read-only");
    }
    if (!agentId) throw new Error("SQLiteAdapter.set: agentId is required");
    if (!id) throw new Error("SQLiteAdapter.set: id is required");

    const blob = float32ToBuffer(embedding);
    const meta = metadata == null ? "{}" : JSON.stringify(metadata);
    this.setStmt.run(agentId, id, content, blob, meta, Date.now());
  }

  async get(agentId: string, id: string): Promise<PersistedRow | null> {
    if (this.closed) throw new Error("SQLiteAdapter.get: adapter is closed");
    const row = this.getStmt.get(agentId, id) as MemoryRow | undefined;
    if (!row) return null;
    let meta: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(row.metadata || "{}");
      meta = parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      meta = undefined;
    }
    return {
      content: row.content,
      embedding: bufferToFloat32(row.embedding),
      metadata: meta,
    };
  }

  async delete(agentId: string, id: string): Promise<void> {
    if (this.closed) throw new Error("SQLiteAdapter.delete: adapter is closed");
    if (this.readOnly) {
      throw new Error("SQLiteAdapter.delete: adapter is read-only");
    }
    this.deleteStmt.run(agentId, id);
  }

  async search(
    agentId: string,
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<SearchHit[]> {
    if (this.closed) throw new Error("SQLiteAdapter.search: adapter is closed");
    const k = Math.max(1, Math.floor(topK || 10));
    const rows = this.searchStmt.all(agentId) as Array<{
      id: string;
      content: string;
      embedding: Buffer;
      metadata: string;
    }>;
    if (rows.length === 0) return [];

    const scored: SearchHit[] = [];
    for (const row of rows) {
      const emb = bufferToFloat32(row.embedding);
      let score = 0;
      try {
        score = cosineSimilarity(queryEmbedding, emb);
      } catch {
        // Dimension mismatch — skip rather than abort the whole search.
        continue;
      }
      let meta: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(row.metadata || "{}");
        meta = parsed && typeof parsed === "object" && Object.keys(parsed).length > 0
          ? (parsed as Record<string, unknown>)
          : undefined;
      } catch {
        meta = undefined;
      }
      scored.push({ id: row.id, content: row.content, score, metadata: meta });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, k);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (!this.readOnly) {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        /* best-effort */
      }
    }
    try {
      this.db.close();
    } catch {
      /* best-effort */
    }
  }
}
