const assert = require('assert');
const { createIdempotencyLog } = require('./idempotency.cjs');

function main() {
  let t = 0;
  const log = createIdempotencyLog({ ttlMs: 1000, now: () => t });

  assert.strictEqual(log.get('evt_1'), null);
  log.record('evt_1', { ok: true, accountId: 'a' });
  const hit = log.get('evt_1');
  assert.deepStrictEqual(hit.result, { ok: true, accountId: 'a' });
  assert.strictEqual(log.size(), 1);

  // TTL expiry.
  t += 2000;
  assert.strictEqual(log.get('evt_1'), null);
  log.sweep();
  assert.strictEqual(log.size(), 0);

  // snapshot/load round-trip.
  log.record('evt_2', { ok: false });
  const snap = log.snapshot();
  const log2 = createIdempotencyLog({ ttlMs: 1000, now: () => t });
  log2.load(snap);
  assert.deepStrictEqual(log2.get('evt_2').result, { ok: false });

  // load skips rows without id.
  log2.load([{ result: 1 }, null]);
  assert.strictEqual(log2.size(), 1);

  console.log('idempotency.test.cjs OK');
}

main();
