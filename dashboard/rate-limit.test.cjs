const assert = require('assert');
const { createRateLimiter, clientKeyForRequest } = require('./rate-limit.cjs');

function main() {
  let t = 0;
  const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1, sweepMs: 1000, now: () => t });

  // First three consumes succeed.
  assert.strictEqual(limiter.consume('a').ok, true);
  assert.strictEqual(limiter.consume('a').ok, true);
  assert.strictEqual(limiter.consume('a').ok, true);
  const denied = limiter.consume('a');
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.retryAfterSec, 1);

  // Refill over time.
  t += 2000;
  const refilled = limiter.consume('a');
  assert.strictEqual(refilled.ok, true);

  // Different key has its own bucket.
  assert.strictEqual(limiter.consume('b').ok, true);
  assert.strictEqual(limiter.peek('b').remaining >= 2, true);

  // Cap respects capacity.
  t += 100_000;
  const peek = limiter.peek('a');
  assert.strictEqual(peek.remaining, 3);

  // client key extracts from x-forwarded-for first.
  assert.strictEqual(
    clientKeyForRequest({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: {} }),
    '1.2.3.4',
  );
  assert.strictEqual(
    clientKeyForRequest({ headers: { 'fly-client-ip': '9.9.9.9' }, socket: {} }),
    '9.9.9.9',
  );
  assert.strictEqual(
    clientKeyForRequest({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }),
    '127.0.0.1',
  );

  clearInterval(limiter._sweepTimer);
  console.log('rate-limit.test.cjs OK');
}

main();
