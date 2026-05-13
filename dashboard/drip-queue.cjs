/**
 * 4-touch onboarding drip after Stripe provisioning.
 *
 * Touches:
 *   1. immediate    — mnemopay-welcome  (api key + 60-sec quickstart)
 *   2. +24h         — mnemopay-day-1    (first-call diagnostics)
 *   3. +3d          — mnemopay-day-3    (common pattern: charge + memory)
 *   4. +7d          — mnemopay-day-7    (open blocker question)
 *
 * Scheduling: rows persisted in `drip_schedule` sqlite table on the same db
 * the console already uses (MNEMOPAY_CONSOLE_SQLITE). A setInterval ticks
 * every 5 min, pulls due rows, sends via maileroo, and marks them sent.
 *
 * If MAILEROO_API_KEY is missing, the drip still schedules — sends just no-op
 * and stay in the queue marked status='deferred' so they fire as soon as the
 * key is set.
 *
 * Reads are namespaced by account_id + email; if the same email is provisioned
 * twice, we use INSERT OR IGNORE on (account_id, email, touch) so we never
 * double-send the same touch.
 */

const { sendMailerooTemplate } = require('./lib/maileroo.cjs');

const TOUCHES = [
  { id: 1, template: 'mnemopay-welcome', delayMs: 0 },
  { id: 2, template: 'mnemopay-day-1',   delayMs: 24 * 60 * 60 * 1000 },
  { id: 3, template: 'mnemopay-day-3',   delayMs: 3 * 24 * 60 * 60 * 1000 },
  { id: 4, template: 'mnemopay-day-7',   delayMs: 7 * 24 * 60 * 60 * 1000 },
];

const TICK_MS = parseInt(process.env.MNEMOPAY_DRIP_TICK_MS || String(5 * 60 * 1000), 10);

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS drip_schedule (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT NOT NULL,
      touch INTEGER NOT NULL,
      template TEXT NOT NULL,
      send_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      vars TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT,
      last_error TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drip_status_send_at ON drip_schedule(status, send_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_drip_account_email_touch ON drip_schedule(account_id, email, touch);
  `);
}

function uuid() {
  return 'drip_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function createDripQueue({ db, logger, sender, now = () => Date.now() }) {
  if (!db) throw new Error('drip-queue: db (sqlite) is required');
  const log = logger || { info: () => {}, warn: () => {}, error: () => {} };
  const send = sender || sendMailerooTemplate;
  ensureTable(db);

  /**
   * Enqueue 4 touches for a newly-provisioned account. Idempotent: re-running
   * for the same (account_id, email) is a no-op thanks to the UNIQUE index.
   */
  function enqueueOnboardingDrip({ accountId, email, firstName, tier, priceMonthly, apiKey, startAt }) {
    if (!accountId || !email) return { enqueued: 0, reason: 'missing accountId or email' };
    const vars = JSON.stringify({
      firstName: firstName || null,
      tier: tier || null,
      priceMonthly: priceMonthly || null,
      apiKey: apiKey || null,
    });
    const base = startAt ? new Date(startAt).getTime() : now();
    const createdAt = new Date(now()).toISOString();

    const insert = db.prepare(`
      INSERT OR IGNORE INTO drip_schedule
        (id, account_id, email, touch, template, send_at, status, vars, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?)
    `);

    let count = 0;
    const txn = db.transaction(() => {
      for (const t of TOUCHES) {
        const sendAt = new Date(base + t.delayMs).toISOString();
        const result = insert.run(uuid(), accountId, email, t.id, t.template, sendAt, vars, createdAt);
        if (result.changes > 0) count += 1;
      }
    });
    txn();
    log.info('drip enqueued', { accountId, email, touchesEnqueued: count });
    return { enqueued: count };
  }

  /**
   * Pull due (status='pending', send_at <= now) rows and send them.
   * Returns { sent, deferred, failed }.
   */
  async function pumpOnce({ limit = 25 } = {}) {
    const cutoff = new Date(now()).toISOString();
    const rows = db.prepare(`
      SELECT id, account_id, email, touch, template, vars, attempts
      FROM drip_schedule
      WHERE status = 'pending' AND send_at <= ?
      ORDER BY send_at ASC
      LIMIT ?
    `).all(cutoff, limit);

    if (rows.length === 0) return { sent: 0, deferred: 0, failed: 0 };

    let sent = 0, deferred = 0, failed = 0;

    for (const row of rows) {
      let vars = {};
      try { vars = JSON.parse(row.vars || '{}'); } catch { vars = {}; }
      try {
        const result = await send(row.email, row.template, vars);
        const attemptAt = new Date(now()).toISOString();
        if (result.delivered) {
          db.prepare(`
            UPDATE drip_schedule
            SET status = 'sent', sent_at = ?, last_attempt_at = ?, attempts = attempts + 1, last_error = NULL
            WHERE id = ?
          `).run(attemptAt, attemptAt, row.id);
          sent += 1;
          log.info('drip sent', { id: row.id, email: row.email, template: row.template });
        } else if (result.reason && /MAILEROO_API_KEY/.test(result.reason)) {
          db.prepare(`
            UPDATE drip_schedule
            SET status = 'deferred', last_attempt_at = ?, attempts = attempts + 1, last_error = ?
            WHERE id = ?
          `).run(attemptAt, result.reason, row.id);
          deferred += 1;
          log.warn('drip deferred (no maileroo key)', { id: row.id, email: row.email, template: row.template });
        } else {
          const newStatus = row.attempts + 1 >= 5 ? 'dead' : 'pending';
          db.prepare(`
            UPDATE drip_schedule
            SET status = ?, last_attempt_at = ?, attempts = attempts + 1, last_error = ?
            WHERE id = ?
          `).run(newStatus, attemptAt, result.reason || 'send failed', row.id);
          failed += 1;
          log.error('drip failed', { id: row.id, email: row.email, template: row.template, reason: result.reason });
        }
      } catch (err) {
        const attemptAt = new Date(now()).toISOString();
        const attempts = row.attempts + 1;
        const newStatus = attempts >= 5 ? 'dead' : 'pending';
        db.prepare(`
          UPDATE drip_schedule
          SET status = ?, last_attempt_at = ?, attempts = ?, last_error = ?
          WHERE id = ?
        `).run(newStatus, attemptAt, attempts, err.message || String(err), row.id);
        failed += 1;
        log.error('drip threw', { id: row.id, err: err.message });
      }
    }

    return { sent, deferred, failed };
  }

  /**
   * Retry deferred touches once the env var is restored. Re-marks them as
   * pending so the next pumpOnce() picks them up.
   */
  function rehydrateDeferred() {
    const result = db.prepare(`
      UPDATE drip_schedule SET status = 'pending' WHERE status = 'deferred'
    `).run();
    if (result.changes > 0) log.info('drip deferred rehydrated', { rehydrated: result.changes });
    return result.changes;
  }

  let timer = null;
  function start() {
    if (timer) return;
    // Tick on a 5-min interval. unref() so a stray timer doesn't keep the
    // process alive past graceful shutdown.
    const tick = async () => {
      try {
        // Rehydrate any deferred rows in case MAILEROO_API_KEY was just set.
        if (process.env.MAILEROO_API_KEY) rehydrateDeferred();
        const result = await pumpOnce();
        if (result.sent + result.failed + result.deferred > 0) {
          log.info('drip tick', result);
        }
      } catch (err) {
        log.error('drip tick crashed', { err: err.message });
      }
    };
    timer = setInterval(tick, TICK_MS);
    timer.unref?.();
    log.info('drip queue started', { tickMs: TICK_MS, touches: TOUCHES.length });
    // Fire one immediate tick so welcome-touch (delayMs=0) goes out without
    // waiting for the first 5-min interval.
    setImmediate(() => { tick().catch(() => {}); });
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  function status() {
    const counts = db.prepare(`
      SELECT status, COUNT(*) as n FROM drip_schedule GROUP BY status
    `).all();
    return { running: !!timer, tickMs: TICK_MS, counts };
  }

  return {
    enqueueOnboardingDrip,
    pumpOnce,
    rehydrateDeferred,
    start,
    stop,
    status,
  };
}

module.exports = {
  createDripQueue,
  TOUCHES,
  ensureTable,
};
