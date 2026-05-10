/**
 * Postgres/Neon console store for the hosted MnemoPay dashboard.
 *
 * The live dashboard server still defaults to JSON/SQLite. This adapter is the
 * production DB bridge: it persists the same console snapshot into typed
 * Postgres tables with JSONB payload copies, and keeps `pg` optional through a
 * dynamic import.
 */

const DEFAULT_PREFIX = 'console';
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function assertIdent(value, label) {
  if (!IDENT_RE.test(value)) {
    throw new Error(`PostgresConsoleStore: invalid ${label} "${value}"`);
  }
}

function tableNames(prefix = DEFAULT_PREFIX) {
  assertIdent(prefix, 'table prefix');
  return {
    apiKeys: `${prefix}_api_keys`,
    brainMemories: `${prefix}_brain_memories`,
    brainEntities: `${prefix}_brain_entities`,
    brainEdges: `${prefix}_brain_edges`,
    auditEvents: `${prefix}_audit_events`,
    usageCounters: `${prefix}_usage_counters`,
    accountPlans: `${prefix}_account_plans`,
    sessions: `${prefix}_sessions`,
    members: `${prefix}_account_members`,
  };
}

function normalizeSnapshot(snapshot = {}) {
  return {
    apiKeys: snapshot.apiKeys || [],
    brainMemories: snapshot.brainMemories || [],
    brainEntities: snapshot.brainEntities || [],
    brainEdges: snapshot.brainEdges || [],
    auditEvents: snapshot.auditEvents || [],
    usageCounters: snapshot.usageCounters || {},
    accountPlans: snapshot.accountPlans || [],
    consoleSessions: snapshot.consoleSessions || [],
    accountMembers: snapshot.accountMembers || [],
  };
}

function json(value) {
  return JSON.stringify(value ?? null);
}

async function loadPgPool(url) {
  let pgMod;
  try {
    const modName = 'pg';
    pgMod = await import(modName);
    if (!pgMod.Pool && pgMod.default?.Pool) pgMod = pgMod.default;
  } catch (err) {
    throw new Error(`PostgresConsoleStore: install optional dependency "pg" to use Neon/Postgres persistence. ${err.message}`);
  }
  if (!pgMod.Pool) throw new Error('PostgresConsoleStore: loaded pg module has no Pool export');
  return new pgMod.Pool({ connectionString: url });
}

function createSchemaSql(prefix = DEFAULT_PREFIX) {
  const t = tableNames(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.apiKeys} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.apiKeys}_account_idx ON ${t.apiKeys}(account_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t.apiKeys}_hash_idx ON ${t.apiKeys}(key_hash)`,
    `CREATE TABLE IF NOT EXISTS ${t.brainMemories} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      content TEXT NOT NULL,
      importance DOUBLE PRECISION NOT NULL,
      tags JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.brainMemories}_account_namespace_idx ON ${t.brainMemories}(account_id, namespace)`,
    `CREATE TABLE IF NOT EXISTS ${t.brainEntities} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      type TEXT NOT NULL,
      aliases JSONB NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.brainEntities}_account_namespace_idx ON ${t.brainEntities}(account_id, namespace)`,
    `CREATE TABLE IF NOT EXISTS ${t.brainEdges} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object_id TEXT NOT NULL,
      memory_ids JSONB NOT NULL,
      weight DOUBLE PRECISION NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.brainEdges}_account_namespace_idx ON ${t.brainEdges}(account_id, namespace)`,
    `CREATE TABLE IF NOT EXISTS ${t.auditEvents} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      action TEXT NOT NULL,
      subject TEXT NOT NULL,
      details JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.auditEvents}_account_created_idx ON ${t.auditEvents}(account_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ${t.usageCounters} (
      account_id TEXT PRIMARY KEY,
      brain_writes INTEGER NOT NULL DEFAULT 0,
      brain_queries INTEGER NOT NULL DEFAULT 0,
      rail_charges INTEGER NOT NULL DEFAULT 0,
      rail_settlements INTEGER NOT NULL DEFAULT 0,
      payload JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.accountPlans} (
      account_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      interval TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      price_lookup_key TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      checkout_session_id TEXT,
      provisioned_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ,
      payload JSONB NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${t.sessions} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.sessions}_account_idx ON ${t.sessions}(account_id)`,
    `CREATE TABLE IF NOT EXISTS ${t.members} (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      role TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ,
      payload JSONB NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ${t.members}_account_idx ON ${t.members}(account_id)`,
  ];
}

class PostgresConsoleStore {
  constructor({ url, pool, tablePrefix = DEFAULT_PREFIX, skipBootstrap = false } = {}) {
    if (!url && !pool) throw new Error('PostgresConsoleStore: url or pool is required');
    this.url = url;
    this.pool = pool || null;
    this.tablePrefix = tablePrefix;
    this.tables = tableNames(tablePrefix);
    this.bootstrapped = skipBootstrap;
  }

  async getPool() {
    if (!this.pool) this.pool = await loadPgPool(this.url);
    return this.pool;
  }

  async bootstrap() {
    if (this.bootstrapped) return;
    const pool = await this.getPool();
    for (const statement of createSchemaSql(this.tablePrefix)) {
      await pool.query(statement);
    }
    this.bootstrapped = true;
  }

  async loadSnapshot() {
    await this.bootstrap();
    const pool = await this.getPool();
    const t = this.tables;
    const payloads = async (table, order = '') => {
      const res = await pool.query(`SELECT payload FROM ${table}${order}`);
      return res.rows.map((row) => row.payload);
    };
    const usageRows = await pool.query(`SELECT account_id, payload FROM ${t.usageCounters}`);
    return {
      apiKeys: await payloads(t.apiKeys),
      brainMemories: await payloads(t.brainMemories),
      brainEntities: await payloads(t.brainEntities),
      brainEdges: await payloads(t.brainEdges),
      auditEvents: await payloads(t.auditEvents, ' ORDER BY created_at ASC'),
      usageCounters: Object.fromEntries(usageRows.rows.map((row) => [row.account_id, row.payload])),
      accountPlans: await payloads(t.accountPlans),
      consoleSessions: await payloads(t.sessions),
      accountMembers: await payloads(t.members),
    };
  }

  async saveSnapshot(input) {
    await this.bootstrap();
    const snapshot = normalizeSnapshot(input);
    const pool = await this.getPool();
    const t = this.tables;
    await pool.query('BEGIN');
    try {
      for (const table of Object.values(t)) await pool.query(`DELETE FROM ${table}`);

      for (const key of snapshot.apiKeys) {
        await pool.query(
          `INSERT INTO ${t.apiKeys} (id, account_id, name, prefix, key_hash, created_at, last_used_at, revoked_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [key.id, key.accountId, key.name, key.prefix, key.keyHash, key.createdAt, key.lastUsedAt || null, key.revokedAt || null, json(key)],
        );
      }
      for (const memory of snapshot.brainMemories) {
        await pool.query(
          `INSERT INTO ${t.brainMemories} (id, account_id, namespace, content, importance, tags, created_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`,
          [memory.id, memory.accountId, memory.namespace, memory.content, memory.importance, json(memory.tags || []), memory.createdAt, json(memory)],
        );
      }
      for (const entity of snapshot.brainEntities) {
        await pool.query(
          `INSERT INTO ${t.brainEntities} (id, account_id, namespace, name, normalized_name, type, aliases, mention_count, created_at, updated_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)`,
          [entity.id, entity.accountId, entity.namespace, entity.name, entity.normalizedName, entity.type, json(entity.aliases || []), entity.mentionCount || 0, entity.createdAt, entity.updatedAt, json(entity)],
        );
      }
      for (const edge of snapshot.brainEdges) {
        await pool.query(
          `INSERT INTO ${t.brainEdges} (id, account_id, namespace, subject_id, predicate, object_id, memory_ids, weight, created_at, updated_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)`,
          [edge.id, edge.accountId, edge.namespace, edge.subjectId, edge.predicate, edge.objectId, json(edge.memoryIds || []), edge.weight || 1, edge.createdAt, edge.updatedAt, json(edge)],
        );
      }
      for (const event of snapshot.auditEvents) {
        await pool.query(
          `INSERT INTO ${t.auditEvents} (id, account_id, action, subject, details, created_at, payload)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`,
          [event.id, event.accountId, event.action, event.subject, json(event.details || {}), event.createdAt, json(event)],
        );
      }
      for (const [accountId, counters] of Object.entries(snapshot.usageCounters)) {
        await pool.query(
          `INSERT INTO ${t.usageCounters} (account_id, brain_writes, brain_queries, rail_charges, rail_settlements, payload)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [accountId, counters.brainWrites || 0, counters.brainQueries || 0, counters.railCharges || 0, counters.railSettlements || 0, json(counters)],
        );
      }
      for (const plan of snapshot.accountPlans) {
        await pool.query(
          `INSERT INTO ${t.accountPlans} (account_id, plan, interval, status, source, price_lookup_key, stripe_customer_id, stripe_subscription_id, checkout_session_id, provisioned_at, updated_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
          [plan.accountId, plan.plan, plan.interval, plan.status, plan.source, plan.priceLookupKey || null, plan.stripeCustomerId || null, plan.stripeSubscriptionId || null, plan.checkoutSessionId || null, plan.provisionedAt || null, plan.updatedAt || null, json(plan)],
        );
      }
      for (const session of snapshot.consoleSessions) {
        await pool.query(
          `INSERT INTO ${t.sessions} (id, account_id, email, name, created_at, last_seen_at, expires_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [session.id, session.accountId, session.email || null, session.name || null, session.createdAt, session.lastSeenAt || null, session.expiresAt, json(session)],
        );
      }
      for (const member of snapshot.accountMembers) {
        await pool.query(
          `INSERT INTO ${t.members} (id, account_id, email, name, role, source, created_at, updated_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [member.id, member.accountId, member.email, member.name || null, member.role, member.source, member.createdAt, member.updatedAt || null, json(member)],
        );
      }
      await pool.query('COMMIT');
    } catch (err) {
      await pool.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async close() {
    if (this.pool?.end) await this.pool.end();
  }
}

module.exports = {
  PostgresConsoleStore,
  createSchemaSql,
  normalizeSnapshot,
  tableNames,
};
