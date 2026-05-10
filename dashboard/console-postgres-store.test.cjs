const assert = require('assert');
const {
  PostgresConsoleStore,
  createSchemaSql,
  normalizeSnapshot,
  tableNames,
} = require('./console-postgres-store.cjs');

class MockPool {
  constructor() {
    this.queries = [];
    this.rowsByTable = new Map();
  }

  async query(text, values = []) {
    this.queries.push({ text, values });
    const match = text.match(/SELECT payload FROM ([A-Za-z0-9_]+)/);
    if (match) return { rows: this.rowsByTable.get(match[1]) || [] };
    const usageMatch = text.match(/SELECT account_id, payload FROM ([A-Za-z0-9_]+)/);
    if (usageMatch) return { rows: this.rowsByTable.get(usageMatch[1]) || [] };
    return { rows: [], rowCount: 0 };
  }

  async end() {}
}

async function main() {
  const sql = createSchemaSql('mnemo_console');
  assert(sql.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS mnemo_console_api_keys')));
  assert(sql.some((statement) => statement.includes('CREATE TABLE IF NOT EXISTS mnemo_console_auth_challenges')));
  assert.throws(() => tableNames('bad-prefix'), /invalid table prefix/);

  const normalized = normalizeSnapshot({
    apiKeys: [{ id: 'key_1' }],
    usageCounters: { acct: { brainWrites: 1 } },
  });
  assert.deepStrictEqual(normalized.brainMemories, []);
  assert.deepStrictEqual(normalized.usageCounters.acct, { brainWrites: 1 });

  const pool = new MockPool();
  const store = new PostgresConsoleStore({ pool, tablePrefix: 'mnemo_console' });
  await store.saveSnapshot({
    apiKeys: [{
      id: 'key_1',
      accountId: 'acct_1',
      name: 'default',
      prefix: 'mnemo_abc',
      keyHash: 'hash',
      createdAt: '2026-05-10T00:00:00.000Z',
    }],
    brainMemories: [{
      id: 'mem_1',
      accountId: 'acct_1',
      namespace: 'default',
      content: 'MnemoPay remembers.',
      importance: 0.8,
      tags: ['brain'],
      createdAt: '2026-05-10T00:00:00.000Z',
    }],
    usageCounters: { acct_1: { brainWrites: 1, brainQueries: 0, railCharges: 0, railSettlements: 0 } },
    authChallenges: [{
      id: 'auth_1',
      accountId: 'acct_1',
      email: 'j@example.com',
      codeHash: 'hash',
      attempts: 0,
      maxAttempts: 5,
      createdAt: '2026-05-10T00:00:00.000Z',
      expiresAt: '2026-05-10T00:10:00.000Z',
    }],
  });

  assert(pool.queries.some((q) => q.text === 'BEGIN'));
  assert(pool.queries.some((q) => q.text === 'COMMIT'));
  assert(pool.queries.some((q) => q.text.includes('INSERT INTO mnemo_console_api_keys')));
  assert(pool.queries.some((q) => q.text.includes('INSERT INTO mnemo_console_brain_memories')));
  assert(pool.queries.some((q) => q.text.includes('INSERT INTO mnemo_console_auth_challenges')));

  pool.rowsByTable.set('mnemo_console_api_keys', [{ payload: { id: 'key_1' } }]);
  pool.rowsByTable.set('mnemo_console_usage_counters', [{ account_id: 'acct_1', payload: { brainWrites: 1 } }]);
  pool.rowsByTable.set('mnemo_console_auth_challenges', [{ payload: { id: 'auth_1' } }]);
  const loaded = await store.loadSnapshot();
  assert.strictEqual(loaded.apiKeys[0].id, 'key_1');
  assert.strictEqual(loaded.usageCounters.acct_1.brainWrites, 1);
  assert.strictEqual(loaded.authChallenges[0].id, 'auth_1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
