const assert = require('assert');
const { createLogger, createRequestLogger, requestId, serializeError } = require('./logger.cjs');

function captureStream(stream) {
  const orig = stream.write.bind(stream);
  const chunks = [];
  stream.write = (data) => { chunks.push(String(data)); return true; };
  return { chunks, restore: () => { stream.write = orig; } };
}

function withProdEnv(fn) {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('./logger.cjs')];
  const mod = require('./logger.cjs');
  try { fn(mod); } finally {
    process.env.NODE_ENV = prev;
    delete require.cache[require.resolve('./logger.cjs')];
  }
}

function main() {
  // Dev format includes module name.
  const captured = captureStream(process.stdout);
  const log = createLogger('test');
  log.info('hello', { foo: 'bar' });
  captured.restore();
  assert(captured.chunks.some((c) => c.includes('[test]')), 'dev log includes module');
  assert(captured.chunks.some((c) => c.includes('hello')), 'dev log includes msg');

  // Prod format is JSON.
  withProdEnv((prodMod) => {
    const cap = captureStream(process.stdout);
    const l = prodMod.createLogger('prod');
    l.info('hello', { foo: 'bar' });
    cap.restore();
    const parsed = JSON.parse(cap.chunks[0].trim());
    assert.strictEqual(parsed.module, 'prod');
    assert.strictEqual(parsed.msg, 'hello');
    assert.strictEqual(parsed.foo, 'bar');
    assert.strictEqual(parsed.level, 'info');
  });

  // Errors go to stderr.
  const capErr = captureStream(process.stderr);
  const l = createLogger('err');
  l.error('boom', new Error('bang'));
  capErr.restore();
  assert(capErr.chunks.some((c) => c.includes('boom')), 'error wrote to stderr');

  // requestId uses header when present.
  const id = requestId({ headers: { 'x-request-id': 'rid-123' } });
  assert.strictEqual(id, 'rid-123');
  const auto = requestId({ headers: {} });
  assert(auto.startsWith('req_'), 'auto-generated rid prefix');

  // createRequestLogger attaches rid.
  const cap2 = captureStream(process.stdout);
  const req = { headers: {} };
  const rl = createRequestLogger(req, 'http');
  rl.info('x');
  cap2.restore();
  assert(req._rid, 'request gets _rid');
  assert(cap2.chunks[0].includes(req._rid), 'log line includes rid');

  // serializeError handles Error and plain values.
  const ser = serializeError(new Error('x'));
  assert.strictEqual(ser.message, 'x');
  assert.strictEqual(serializeError(null), undefined);
  assert.strictEqual(serializeError('plain').value, 'plain');

  console.log('logger.test.cjs OK');
}

main();
