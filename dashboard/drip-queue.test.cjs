const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createDripQueue, TOUCHES, ensureTable } = require('./drip-queue.cjs');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-test-'));
  return new Database(path.join(dir, 'drip.db'));
}

async function main() {
  // ── enqueueOnboardingDrip schedules all 4 touches with monotonic send_at ─
  {
    const db = tmpDb();
    const sent = [];
    const sender = async (to, templateId) => {
      sent.push({ to, templateId });
      return { delivered: true, id: 'msg_' + templateId };
    };
    const queue = createDripQueue({ db, sender, now: () => Date.parse('2026-05-13T12:00:00Z') });
    const { enqueued } = queue.enqueueOnboardingDrip({
      accountId: 'acct_1',
      email: 'jane@example.com',
      firstName: 'Jane',
      tier: 'pro',
      priceMonthly: 49,
      apiKey: 'mp_test_abcdef',
    });
    assert.strictEqual(enqueued, TOUCHES.length, 'enqueues 4 touches');

    const rows = db.prepare('SELECT touch, template, send_at FROM drip_schedule ORDER BY touch ASC').all();
    assert.strictEqual(rows.length, 4);
    assert.strictEqual(rows[0].template, 'mnemopay-welcome');
    assert.strictEqual(rows[3].template, 'mnemopay-day-7');
    for (let i = 1; i < rows.length; i++) {
      assert(rows[i].send_at > rows[i - 1].send_at, 'send_at strictly increasing');
    }
  }

  // ── idempotent: re-enqueuing for same (account_id, email) is a no-op ────
  {
    const db = tmpDb();
    const queue = createDripQueue({ db, sender: async () => ({ delivered: true }) });
    const first = queue.enqueueOnboardingDrip({ accountId: 'acct_2', email: 'a@b.co' });
    const second = queue.enqueueOnboardingDrip({ accountId: 'acct_2', email: 'a@b.co' });
    assert.strictEqual(first.enqueued, TOUCHES.length);
    assert.strictEqual(second.enqueued, 0, 'second call inserts zero rows');
    const total = db.prepare('SELECT COUNT(*) AS n FROM drip_schedule').get().n;
    assert.strictEqual(total, TOUCHES.length, 'still only 4 rows total');
  }

  // ── pumpOnce marks rows deferred when MAILEROO_API_KEY is missing ───────
  {
    const db = tmpDb();
    const sender = async () => ({ delivered: false, reason: 'MAILEROO_API_KEY not set' });
    // Enqueue at T0; pump 8 days later so all 4 touches (0h/+1d/+3d/+7d) are due.
    let t = Date.parse('2026-05-13T12:00:00Z');
    const queue = createDripQueue({ db, sender, now: () => t });
    queue.enqueueOnboardingDrip({ accountId: 'acct_3', email: 'c@d.co' });
    t = Date.parse('2026-05-21T12:00:00Z');
    const result = await queue.pumpOnce();
    assert.strictEqual(result.sent, 0);
    assert.strictEqual(result.deferred, 4);
    assert.strictEqual(result.failed, 0);
    const deferred = db.prepare(`SELECT COUNT(*) AS n FROM drip_schedule WHERE status = 'deferred'`).get().n;
    assert.strictEqual(deferred, 4);
  }

  // ── rehydrateDeferred flips deferred → pending so the next tick retries ─
  {
    const db = tmpDb();
    ensureTable(db);
    db.prepare(`
      INSERT INTO drip_schedule (id, account_id, email, touch, template, send_at, status, vars, created_at)
      VALUES ('x1', 'a', 'b@c.co', 1, 'mnemopay-welcome', '2026-05-01T00:00:00Z', 'deferred', '{}', '2026-05-01T00:00:00Z')
    `).run();
    const queue = createDripQueue({ db, sender: async () => ({ delivered: true }) });
    const rehydrated = queue.rehydrateDeferred();
    assert.strictEqual(rehydrated, 1);
    const row = db.prepare('SELECT status FROM drip_schedule WHERE id = ?').get('x1');
    assert.strictEqual(row.status, 'pending');
  }

  // ── pumpOnce escalates row to status='dead' after 5 transient failures ──
  {
    const db = tmpDb();
    const sender = async () => ({ delivered: false, reason: 'maileroo 503' });
    let t = Date.parse('2026-05-13T12:00:00Z');
    const queue = createDripQueue({ db, sender, now: () => t });
    queue.enqueueOnboardingDrip({ accountId: 'acct_4', email: 'd@e.co' });
    t = Date.parse('2026-05-21T12:00:00Z');
    for (let i = 0; i < 5; i++) {
      await queue.pumpOnce();
    }
    const dead = db.prepare(`SELECT COUNT(*) AS n FROM drip_schedule WHERE status = 'dead'`).get().n;
    assert.strictEqual(dead, 4, 'all four touches escalate to dead after 5 attempts');
  }

  // ── successful delivery flips status='sent' and records sent_at ─────────
  {
    const db = tmpDb();
    const sender = async () => ({ delivered: true, id: 'msg_1' });
    let t = Date.parse('2026-05-13T12:00:00Z');
    const queue = createDripQueue({ db, sender, now: () => t });
    queue.enqueueOnboardingDrip({ accountId: 'acct_5', email: 'e@f.co' });
    t = Date.parse('2026-05-21T12:00:00Z');
    const result = await queue.pumpOnce({ limit: 4 });
    assert.strictEqual(result.sent, 4);
    const sentRows = db.prepare(`SELECT id, sent_at FROM drip_schedule WHERE status = 'sent'`).all();
    assert.strictEqual(sentRows.length, 4);
    for (const r of sentRows) assert(r.sent_at, 'sent_at is populated');
  }

  console.log('drip-queue.test.cjs — all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
