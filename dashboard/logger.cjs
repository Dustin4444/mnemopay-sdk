/**
 * Structured JSON logger for the MnemoPay dashboard.
 *
 * Designed to drop into existing console.log call sites with minimal churn:
 *   const log = createLogger('module');
 *   log.info('msg', { key: 'value' });
 *   log.error('boom', err);
 *
 * In production mode (NODE_ENV=production) it emits one JSON line per call,
 * suitable for Fly/Loki/Datadog ingestion. In dev mode it pretty-prints.
 *
 * Request-scoped logging: createRequestLogger(req) attaches a request id
 * (from x-request-id header or generated) so downstream calls share context.
 */

const crypto = require('crypto');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const PROD = process.env.NODE_ENV === 'production';
const MIN_LEVEL = LEVELS[process.env.MNEMOPAY_LOG_LEVEL] || (PROD ? LEVELS.info : LEVELS.debug);

function format(level, module, msg, extra) {
  const base = {
    ts: new Date().toISOString(),
    level,
    module,
    msg,
    ...extra,
  };
  if (PROD) return JSON.stringify(base);
  const parts = [`[${base.ts.slice(11, 19)}]`, `[${level}]`, `[${module}]`, msg];
  if (extra && Object.keys(extra).length) parts.push(JSON.stringify(extra));
  return parts.join(' ');
}

function serializeError(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: PROD ? undefined : err.stack,
      ...(err.status ? { status: err.status } : {}),
      ...(err.code ? { code: err.code } : {}),
    };
  }
  return { value: String(err) };
}

function createLogger(module = 'server', baseFields = {}) {
  function emit(level, msg, extra) {
    if (LEVELS[level] < MIN_LEVEL) return;
    const merged = { ...baseFields, ...(extra || {}) };
    if (merged.err) merged.err = serializeError(merged.err);
    const line = format(level, module, msg, merged);
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, errOrExtra) => {
      if (errOrExtra instanceof Error) return emit('error', msg, { err: errOrExtra });
      return emit('error', msg, errOrExtra);
    },
    child: (extra) => createLogger(module, { ...baseFields, ...extra }),
  };
}

function requestId(req) {
  const h = req?.headers?.['x-request-id'];
  if (typeof h === 'string' && h.length > 0 && h.length < 128) return h;
  return `req_${crypto.randomBytes(8).toString('hex')}`;
}

function createRequestLogger(req, module = 'http') {
  const id = requestId(req);
  if (req) req._rid = id;
  return createLogger(module, { rid: id });
}

module.exports = { createLogger, createRequestLogger, requestId, serializeError };
