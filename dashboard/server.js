/**
 * MnemoPay Live Dashboard Server
 * REST API backed by the real SDK + GitHub repo monitoring
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT = process.env.PORT || 3200;
const GITHUB_USER = process.env.GITHUB_USER || 'mnemopay';
const GH_CLI = process.env.GH_CLI || 'C:/Program Files/GitHub CLI/gh';
const BRAIN_AGENT_ID = process.env.MNEMOPAY_BRAIN_AGENT_ID || 'hosted-brain';
const DEFAULT_PLAN = process.env.MNEMOPAY_PLAN || 'free';
const DEFAULT_ACCOUNT_ID = process.env.MNEMOPAY_ACCOUNT_ID || 'default';
const CONSOLE_STORE_PATH = process.env.MNEMOPAY_CONSOLE_STORE || path.join(process.cwd(), '.mnemopay-console', 'console-store.json');
const CONSOLE_STORE_DRIVER = process.env.MNEMOPAY_CONSOLE_STORE_DRIVER || (process.env.MNEMOPAY_CONSOLE_SQLITE ? 'sqlite' : 'json');
const CONSOLE_SQLITE_PATH = process.env.MNEMOPAY_CONSOLE_SQLITE || path.join(process.cwd(), '.mnemopay-console', 'console-store.sqlite');
const SESSION_COOKIE_NAME = process.env.MNEMOPAY_SESSION_COOKIE || 'mnemo_console_session';
const SESSION_SECRET = process.env.MNEMOPAY_SESSION_SECRET || process.env.MNEMOPAY_SECRET || 'mnemopay-console-dev-secret';
const SESSION_TTL_MS = Math.max(3600_000, parseInt(process.env.MNEMOPAY_SESSION_TTL_MS || String(7 * 24 * 3600_000), 10));
let consoleSqlite;

// ── Initialize the real SDK ─────────────────────────────────────────────────
let agent;
let brain;
const brainMemories = new Map();
const apiKeys = new Map();
const usageCounters = new Map();
const accountPlans = new Map();
const consoleSessions = new Map();
const auditEvents = [];
try {
  const SDK = require('../dist/index.js');
  agent = SDK.MnemoPay.quick(process.env.MNEMOPAY_AGENT_ID || 'dashboard-live');
  const RecallEngine = SDK.RecallEngine || SDK.recall?.RecallEngine;
  if (RecallEngine) {
    brain = new RecallEngine({
      strategy: process.env.MNEMOPAY_BRAIN_STRATEGY || 'hybrid',
      embeddingProvider: process.env.MNEMOPAY_BRAIN_EMBEDDING || 'local',
      agentId: BRAIN_AGENT_ID,
    });
  }
  console.log('[sdk] MnemoPayLite initialized (live mode)');
} catch (e) {
  console.error('[sdk] Failed to load SDK:', e.message);
  console.log('[sdk] Falling back to inline implementation');
  // Minimal fallback if dist isn't built
  agent = createFallbackAgent();
}

function createFallbackAgent() {
  const memories = new Map();
  const transactions = new Map();
  const auditLog = [];
  let wallet = 0, reputation = 0.5;

  function uuid() { return crypto.randomUUID(); }
  function autoScore(c) {
    let s = 0.5;
    if (c.length > 200) s += 0.1;
    if (/error|fail|crash|critical|bug/i.test(c)) s += 0.2;
    if (/success|complete|paid|delivered/i.test(c)) s += 0.15;
    if (/prefer|always|never|important|must/i.test(c)) s += 0.15;
    return Math.min(s, 1.0);
  }
  function computeScore(imp, lastAcc, accCnt, decay = 0.05) {
    const hrs = (Date.now() - new Date(lastAcc).getTime()) / 3600000;
    return imp * Math.exp(-decay * hrs) * (1 + Math.log(1 + accCnt));
  }

  return {
    agentId: 'dashboard-live',
    async remember(content, opts = {}) {
      const importance = opts.importance ?? autoScore(content);
      const id = uuid();
      const now = new Date();
      memories.set(id, { id, agentId: 'dashboard-live', content, importance: Math.min(Math.max(importance, 0), 1), score: importance, createdAt: now, lastAccessed: now, accessCount: 0, tags: opts.tags || [] });
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'memory:stored', details: { id, content: content.slice(0, 100), importance }, createdAt: now });
      return id;
    },
    async recall(queryOrLimit, maybeLimit) {
      const limit = typeof queryOrLimit === 'number' ? queryOrLimit : (maybeLimit ?? 5);
      const all = Array.from(memories.values()).map(m => { m.score = computeScore(m.importance, m.lastAccessed, m.accessCount); return m; });
      all.sort((a, b) => b.score - a.score);
      const results = all.slice(0, limit);
      results.forEach(m => { m.lastAccessed = new Date(); m.accessCount++; });
      return results;
    },
    async forget(id) { return memories.delete(id); },
    async reinforce(id, boost = 0.1) {
      const m = memories.get(id); if (!m) return false;
      m.importance = Math.min(m.importance + boost, 1.0); m.lastAccessed = new Date();
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'memory:reinforced', details: { id, boost }, createdAt: new Date() });
      return true;
    },
    async consolidate() {
      let pruned = 0;
      for (const [id, m] of memories) { if (computeScore(m.importance, m.lastAccessed, m.accessCount) < 0.01) { memories.delete(id); pruned++; } }
      return pruned;
    },
    async charge(amount, reason) {
      const id = uuid(); const tx = { id, agentId: 'dashboard-live', amount, reason, status: 'pending', createdAt: new Date() };
      transactions.set(id, tx);
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'payment:pending', details: { id, amount, reason }, createdAt: new Date() });
      return { ...tx };
    },
    async settle(txId) {
      const tx = transactions.get(txId); if (!tx || tx.status !== 'pending') return null;
      tx.status = 'completed'; tx.completedAt = new Date();
      wallet += tx.amount; reputation = Math.min(reputation + 0.01, 1.0);
      const oneHourAgo = Date.now() - 3600000; let reinforced = 0;
      for (const m of memories.values()) { if (new Date(m.lastAccessed).getTime() > oneHourAgo) { m.importance = Math.min(m.importance + 0.05, 1.0); reinforced++; } }
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'payment:completed', details: { id: txId, amount: tx.amount, reinforced }, createdAt: new Date() });
      return { ...tx };
    },
    async refund(txId) {
      const tx = transactions.get(txId); if (!tx) return null;
      if (tx.status === 'completed') { wallet = Math.max(wallet - tx.amount, 0); reputation = Math.max(reputation - 0.05, 0); }
      tx.status = 'refunded';
      auditLog.push({ id: uuid(), agentId: 'dashboard-live', action: 'payment:refunded', details: { id: txId, amount: tx.amount }, createdAt: new Date() });
      return { ...tx };
    },
    balance() { return { wallet, reputation }; },
    profile() { return { id: 'dashboard-live', reputation, wallet, memoriesCount: memories.size, transactionsCount: transactions.size }; },
    logs(limit = 30) { return auditLog.slice(-limit).reverse(); },
    history(limit = 20) { return Array.from(transactions.values()).reverse().slice(0, limit); },
  };
}

// ── GitHub repo cache ───────────────────────────────────────────────────────
let repoCache = { data: null, lastFetch: 0 };
const REPO_CACHE_TTL = 60_000; // 1 minute

const MONITORED_REPOS = [
  { upstream: 'coinbase/agentkit', fork: `${GITHUB_USER}/agentkit`, branch: 'feat/mnemopay-action-provider' },
  { upstream: 'elizaOS/eliza', fork: `${GITHUB_USER}/eliza`, branch: 'feat/plugin-mnemopay' },
  { upstream: 'mastra-ai/mastra', fork: `${GITHUB_USER}/mastra`, branch: 'feat/mnemopay-integration' },
  { upstream: 'coinbase/x402', fork: `${GITHUB_USER}/x402`, branch: 'feat/mnemopay-middleware' },
  { upstream: 'Xiaoher-C/agentbnb', fork: `${GITHUB_USER}/agentbnb`, branch: 'feat/mnemopay-adapter' },
];

async function fetchRepoStatus() {
  if (Date.now() - repoCache.lastFetch < REPO_CACHE_TTL && repoCache.data) return repoCache.data;

  const results = [];
  for (const repo of MONITORED_REPOS) {
    try {
      // Get fork info
      const forkJson = execSync(`"${GH_CLI}" repo view ${repo.fork} --json name,stargazerCount,updatedAt,url,description `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
      const fork = JSON.parse(forkJson);

      // Get upstream stars
      let upstreamStars = 0;
      try {
        const upJson = execSync(`"${GH_CLI}" repo view ${repo.upstream} --json stargazerCount `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
        upstreamStars = JSON.parse(upJson).stargazerCount;
      } catch (e) {}

      // Get PR status
      let pr = null;
      try {
        const prJson = execSync(`"${GH_CLI}" pr list --repo ${repo.upstream} --author ${GITHUB_USER} --json number,title,state,url,createdAt,reviews,statusCheckRollup --limit 1 `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
        const prs = JSON.parse(prJson);
        if (prs.length > 0) pr = prs[0];
      } catch (e) {}

      // Also check PRs on own fork
      if (!pr) {
        try {
          const prJson = execSync(`"${GH_CLI}" pr list --repo ${repo.fork} --json number,title,state,url,createdAt --limit 1 `, { encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] });
          const prs = JSON.parse(prJson);
          if (prs.length > 0) pr = prs[0];
        } catch (e) {}
      }

      results.push({
        name: repo.upstream,
        fork: repo.fork,
        branch: repo.branch,
        forkUrl: fork.url,
        upstreamStars,
        forkStars: fork.stargazerCount,
        updatedAt: fork.updatedAt,
        description: fork.description,
        pr: pr ? { number: pr.number, title: pr.title, state: pr.state, url: pr.url, createdAt: pr.createdAt } : null,
        status: pr ? (pr.state === 'MERGED' ? 'merged' : pr.state === 'OPEN' ? 'pr-open' : 'pr-closed') : 'forked',
      });
    } catch (e) {
      results.push({ name: repo.upstream, fork: repo.fork, branch: repo.branch, status: 'error', error: e.message });
    }
  }

  repoCache = { data: results, lastFetch: Date.now() };
  return results;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => resolve(body));
  });
}

function errorJson(res, e, fallbackStatus = 400) {
  return json(res, { ok: false, error: e.message, details: e.details || undefined }, e.status || fallbackStatus);
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function hmac(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(String(value)).digest('base64url');
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  return header.split(';').reduce((cookies, part) => {
    const idx = part.indexOf('=');
    if (idx > -1) cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    return cookies;
  }, {});
}

function signedSessionCookie(sessionId) {
  return `${sessionId}.${hmac(sessionId)}`;
}

function verifySessionCookie(value) {
  const raw = String(value || '');
  const idx = raw.lastIndexOf('.');
  if (idx < 1) return null;
  const sessionId = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = hmac(sessionId);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  return sessionId;
}

function publicSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    accountId: session.accountId,
    email: session.email || null,
    name: session.name || null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt || null,
  };
}

function sessionForRequest(req) {
  const sessionId = verifySessionCookie(parseCookies(req)[SESSION_COOKIE_NAME]);
  if (!sessionId) return null;
  const session = consoleSessions.get(sessionId);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    consoleSessions.delete(sessionId);
    saveConsoleStore();
    return null;
  }
  session.lastSeenAt = new Date().toISOString();
  return session;
}

function setSessionCookie(res, sessionId) {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedSessionCookie(sessionId))}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function blankUsage() {
  return { brainWrites: 0, brainQueries: 0, railCharges: 0, railSettlements: 0 };
}

const PLAN_CATALOG = {
  free: {
    plan: 'free',
    name: 'Free',
    monthlyCents: 0,
    missions: 5,
    llmCapCents: 100,
    seats: 1,
    features: ['public charters', 'hosted brain dev mode'],
  },
  pro: {
    plan: 'pro',
    name: 'Pro',
    monthlyCents: 2900,
    yearlyCents: 29000,
    missions: 100,
    llmCapCents: 2500,
    seats: 1,
    features: ['private charters', 'EU AI Act audit bundles', 'hosted brain namespaces'],
  },
  team: {
    plan: 'team',
    name: 'Team',
    monthlyCents: 9900,
    yearlyCents: 99000,
    missions: 'unlimited',
    llmCapCents: 10000,
    seats: 5,
    features: ['marketplace publish', 'team audit feed', 'BYOK above cap'],
  },
  enterprise: {
    plan: 'enterprise',
    name: 'Enterprise',
    monthlyCents: null,
    missions: 'custom',
    llmCapCents: null,
    seats: 'custom',
    features: ['SLA', 'on-prem', 'KYA governance', '7y audit retention'],
  },
};

const PRICE_LOOKUP_TO_PLAN = {
  mnemopay_pro_monthly: { plan: 'pro', interval: 'monthly' },
  mnemopay_pro_yearly: { plan: 'pro', interval: 'yearly' },
  mnemopay_team_monthly: { plan: 'team', interval: 'monthly' },
  mnemopay_team_yearly: { plan: 'team', interval: 'yearly' },
  praetor_pro_monthly: { plan: 'pro', interval: 'monthly' },
  praetor_pro_yearly: { plan: 'pro', interval: 'yearly' },
  praetor_team_monthly: { plan: 'team', interval: 'monthly' },
  praetor_team_yearly: { plan: 'team', interval: 'yearly' },
};

function usageForAccount(accountId) {
  if (!usageCounters.has(accountId)) usageCounters.set(accountId, blankUsage());
  return usageCounters.get(accountId);
}

function defaultAccountPlan(accountId) {
  const plan = PLAN_CATALOG[DEFAULT_PLAN] ? DEFAULT_PLAN : 'free';
  return {
    accountId,
    plan,
    interval: 'monthly',
    status: 'active',
    source: 'default',
    priceLookupKey: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    checkoutSessionId: null,
    provisionedAt: null,
    updatedAt: null,
    limits: PLAN_CATALOG[plan],
  };
}

function accountPlanFor(accountId) {
  const current = accountPlans.get(accountId);
  if (current) return { ...current, limits: PLAN_CATALOG[current.plan] || PLAN_CATALOG.free };
  return defaultAccountPlan(accountId);
}

function createConsoleSession({ accountId, email, name }) {
  const now = new Date();
  const session = {
    id: `sess_${uuid()}`,
    accountId: String(accountId || DEFAULT_ACCOUNT_ID).slice(0, 120),
    email: email ? String(email).slice(0, 180) : null,
    name: name ? String(name).slice(0, 120) : null,
    createdAt: now.toISOString(),
    lastSeenAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
  };
  consoleSessions.set(session.id, session);
  recordAudit(session.accountId, 'auth.session.created', `session:${session.id}`, { email: session.email, name: session.name });
  saveConsoleStore();
  return session;
}

function missionUsage(usage) {
  return (usage.brainWrites || 0) + (usage.brainQueries || 0) + (usage.railCharges || 0);
}

class PlanLimitError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'PlanLimitError';
    this.status = 402;
    this.details = details;
  }
}

function meteringSnapshot(accountId) {
  const usage = usageForAccount(accountId);
  const billing = accountPlanFor(accountId);
  const limits = billing.limits || PLAN_CATALOG.free;
  const missionsUsed = missionUsage(usage);
  const missionLimit = limits.missions;
  const unlimited = missionLimit === 'unlimited' || missionLimit === 'custom';
  const missionsRemaining = unlimited ? null : Math.max(0, Number(missionLimit || 0) - missionsUsed);
  return {
    accountId,
    period: 'lifetime-prototype',
    billing,
    usage,
    missions: {
      used: missionsUsed,
      limit: missionLimit,
      remaining: missionsRemaining,
      overLimit: !unlimited && missionsUsed >= Number(missionLimit || 0),
    },
    llmCapCents: limits.llmCapCents,
    seats: limits.seats,
    features: limits.features || [],
  };
}

function assertPlanAllows(accountId, action) {
  const snapshot = meteringSnapshot(accountId);
  const missionActions = new Set(['brain.write', 'brain.query', 'rail.charge']);
  if (!missionActions.has(action)) return snapshot;
  if (snapshot.missions.overLimit) {
    throw new PlanLimitError(`mission limit reached for ${snapshot.billing.plan}`, {
      action,
      plan: snapshot.billing.plan,
      used: snapshot.missions.used,
      limit: snapshot.missions.limit,
    });
  }
  return snapshot;
}

function verifyStripeWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!secret) return { ok: true, mode: 'unsigned-dev' };
  const parts = String(signatureHeader || '').split(',').reduce((acc, part) => {
    const [key, value] = part.split('=');
    if (key && value) {
      if (!acc[key]) acc[key] = [];
      acc[key].push(value);
    }
    return acc;
  }, {});
  const timestamp = Number(parts.t?.[0]);
  if (!timestamp || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) {
    return { ok: false, reason: 'timestamp outside tolerance' };
  }
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  const signatures = parts.v1 || [];
  const ok = signatures.some((sig) => {
    try {
      return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  });
  return ok ? { ok: true, mode: 'verified' } : { ok: false, reason: 'signature mismatch' };
}

function provisioningBodyFromStripeEvent(event, fallbackAccountId) {
  const object = event?.data?.object || {};
  const metadata = object.metadata || {};
  const subscriptionMetadata = object.subscription_details?.metadata || {};
  const merged = { ...subscriptionMetadata, ...metadata };
  return {
    accountId: merged.accountId || object.client_reference_id || fallbackAccountId,
    plan: merged.plan,
    interval: merged.interval,
    priceLookupKey: merged.priceLookupKey || merged.lookupKey,
    status: object.status === 'canceled' ? 'canceled' : (object.status || 'active'),
    source: 'stripe-webhook',
    stripeCustomerId: object.customer || object.customer_id || null,
    stripeSubscriptionId: object.subscription || object.id || null,
    checkoutSessionId: event.type === 'checkout.session.completed' ? object.id : null,
    createApiKey: merged.createApiKey !== 'false',
  };
}

function publicApiKey(key) {
  return {
    id: key.id,
    accountId: key.accountId,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt || null,
    revokedAt: key.revokedAt || null,
  };
}

function publicAuditEvent(event) {
  return {
    id: event.id,
    accountId: event.accountId,
    action: event.action,
    subject: event.subject,
    details: event.details || {},
    createdAt: event.createdAt,
  };
}

function recordAudit(accountId, action, subject, details = {}) {
  const event = {
    id: `evt_${uuid()}`,
    accountId,
    action,
    subject,
    details,
    createdAt: new Date().toISOString(),
  };
  auditEvents.push(event);
  if (auditEvents.length > 5000) auditEvents.splice(0, auditEvents.length - 5000);
  return event;
}

function accountIdForRequest(req) {
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m?.[1]) {
    const keyHash = hashSecret(m[1].trim());
    const key = Array.from(apiKeys.values()).find((k) => k.keyHash === keyHash && !k.revokedAt);
    if (key) {
      key.lastUsedAt = new Date().toISOString();
      saveConsoleStore();
      return key.accountId;
    }
  }
  const session = sessionForRequest(req);
  if (session?.accountId) return session.accountId;
  const headerAccount = req.headers['x-mnemopay-account'];
  return String(Array.isArray(headerAccount) ? headerAccount[0] : headerAccount || DEFAULT_ACCOUNT_ID).slice(0, 120);
}

function openConsoleSqlite() {
  if (consoleSqlite) return consoleSqlite;
  // Optional dependency already ships with the SDK. JSON remains the default dev store.
  const Database = require('better-sqlite3');
  fs.mkdirSync(path.dirname(CONSOLE_SQLITE_PATH), { recursive: true });
  const db = new Database(CONSOLE_SQLITE_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS console_api_keys (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_api_keys_account ON console_api_keys(account_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_console_api_keys_hash ON console_api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS console_brain_memories (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      namespace TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL NOT NULL,
      tags_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_brain_account_namespace ON console_brain_memories(account_id, namespace);

    CREATE TABLE IF NOT EXISTS console_audit_events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      action TEXT NOT NULL,
      subject TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_audit_account_created ON console_audit_events(account_id, created_at);

    CREATE TABLE IF NOT EXISTS console_usage_counters (
      account_id TEXT PRIMARY KEY,
      brain_writes INTEGER NOT NULL DEFAULT 0,
      brain_queries INTEGER NOT NULL DEFAULT 0,
      rail_charges INTEGER NOT NULL DEFAULT 0,
      rail_settlements INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS console_account_plans (
      account_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL,
      interval TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      price_lookup_key TEXT,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT,
      checkout_session_id TEXT,
      provisioned_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS console_sessions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      email TEXT,
      name TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT,
      expires_at TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_sessions_account ON console_sessions(account_id);
  `);
  consoleSqlite = db;
  return consoleSqlite;
}

function loadConsoleStoreFromSqlite() {
  const db = openConsoleSqlite();
  for (const row of db.prepare('SELECT payload FROM console_api_keys').all()) {
    const key = JSON.parse(row.payload);
    apiKeys.set(key.id, key);
  }
  for (const row of db.prepare('SELECT payload FROM console_brain_memories').all()) {
    const memory = JSON.parse(row.payload);
    brainMemories.set(memory.id, memory);
  }
  for (const row of db.prepare('SELECT payload FROM console_audit_events ORDER BY created_at ASC').all()) {
    auditEvents.push(JSON.parse(row.payload));
  }
  for (const row of db.prepare('SELECT account_id, payload FROM console_usage_counters').all()) {
    const counters = JSON.parse(row.payload);
    usageCounters.set(row.account_id, { ...blankUsage(), ...counters });
  }
  for (const row of db.prepare('SELECT account_id, payload FROM console_account_plans').all()) {
    accountPlans.set(row.account_id, JSON.parse(row.payload));
  }
  for (const row of db.prepare('SELECT id, payload FROM console_sessions').all()) {
    const session = JSON.parse(row.payload);
    if (new Date(session.expiresAt).getTime() > Date.now()) consoleSessions.set(row.id, session);
  }
  console.log(`[console-store] loaded ${apiKeys.size} keys, ${brainMemories.size} brain memories, ${auditEvents.length} audit events from sqlite ${CONSOLE_SQLITE_PATH}`);
}

function saveConsoleStoreToSqlite() {
  const db = openConsoleSqlite();
  const usage = {};
  for (const [accountId, counters] of usageCounters.entries()) usage[accountId] = counters;

  const write = db.transaction(() => {
    db.prepare('DELETE FROM console_api_keys').run();
    db.prepare('DELETE FROM console_brain_memories').run();
    db.prepare('DELETE FROM console_audit_events').run();
    db.prepare('DELETE FROM console_usage_counters').run();
    db.prepare('DELETE FROM console_account_plans').run();
    db.prepare('DELETE FROM console_sessions').run();

    const insertKey = db.prepare(`INSERT INTO console_api_keys
      (id, account_id, name, prefix, key_hash, created_at, last_used_at, revoked_at, payload)
      VALUES (@id, @accountId, @name, @prefix, @keyHash, @createdAt, @lastUsedAt, @revokedAt, @payload)`);
    for (const key of apiKeys.values()) {
      insertKey.run({
        ...key,
        lastUsedAt: key.lastUsedAt || null,
        revokedAt: key.revokedAt || null,
        payload: JSON.stringify(key),
      });
    }

    const insertMemory = db.prepare(`INSERT INTO console_brain_memories
      (id, account_id, namespace, content, importance, tags_json, created_at, payload)
      VALUES (@id, @accountId, @namespace, @content, @importance, @tagsJson, @createdAt, @payload)`);
    for (const memory of brainMemories.values()) {
      insertMemory.run({
        ...memory,
        tagsJson: JSON.stringify(memory.tags || []),
        payload: JSON.stringify(memory),
      });
    }

    const insertAudit = db.prepare(`INSERT INTO console_audit_events
      (id, account_id, action, subject, details_json, created_at, payload)
      VALUES (@id, @accountId, @action, @subject, @detailsJson, @createdAt, @payload)`);
    for (const event of auditEvents) {
      insertAudit.run({
        ...event,
        detailsJson: JSON.stringify(event.details || {}),
        payload: JSON.stringify(event),
      });
    }

    const insertUsage = db.prepare(`INSERT INTO console_usage_counters
      (account_id, brain_writes, brain_queries, rail_charges, rail_settlements, payload)
      VALUES (@accountId, @brainWrites, @brainQueries, @railCharges, @railSettlements, @payload)`);
    for (const [accountId, counters] of Object.entries(usage)) {
      insertUsage.run({
        accountId,
        brainWrites: counters.brainWrites || 0,
        brainQueries: counters.brainQueries || 0,
        railCharges: counters.railCharges || 0,
        railSettlements: counters.railSettlements || 0,
        payload: JSON.stringify(counters),
      });
    }

    const insertPlan = db.prepare(`INSERT INTO console_account_plans
      (account_id, plan, interval, status, source, price_lookup_key, stripe_customer_id, stripe_subscription_id, checkout_session_id, provisioned_at, updated_at, payload)
      VALUES (@accountId, @plan, @interval, @status, @source, @priceLookupKey, @stripeCustomerId, @stripeSubscriptionId, @checkoutSessionId, @provisionedAt, @updatedAt, @payload)`);
    for (const plan of accountPlans.values()) {
      insertPlan.run({
        ...plan,
        priceLookupKey: plan.priceLookupKey || null,
        stripeCustomerId: plan.stripeCustomerId || null,
        stripeSubscriptionId: plan.stripeSubscriptionId || null,
        checkoutSessionId: plan.checkoutSessionId || null,
        provisionedAt: plan.provisionedAt || null,
        updatedAt: plan.updatedAt || null,
        payload: JSON.stringify(plan),
      });
    }

    const insertSession = db.prepare(`INSERT INTO console_sessions
      (id, account_id, email, name, created_at, last_seen_at, expires_at, payload)
      VALUES (@id, @accountId, @email, @name, @createdAt, @lastSeenAt, @expiresAt, @payload)`);
    for (const session of consoleSessions.values()) {
      if (new Date(session.expiresAt).getTime() <= Date.now()) continue;
      insertSession.run({
        ...session,
        email: session.email || null,
        name: session.name || null,
        lastSeenAt: session.lastSeenAt || null,
        payload: JSON.stringify(session),
      });
    }
  });

  write();
}

function loadConsoleStore() {
  try {
    if (CONSOLE_STORE_DRIVER === 'sqlite') {
      loadConsoleStoreFromSqlite();
      return;
    }
    if (!fs.existsSync(CONSOLE_STORE_PATH)) return;
    const raw = fs.readFileSync(CONSOLE_STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const row of data.apiKeys || []) apiKeys.set(row.id, row);
    for (const row of data.brainMemories || []) brainMemories.set(row.id, row);
    for (const row of data.auditEvents || []) auditEvents.push(row);
    for (const [accountId, usage] of Object.entries(data.usageCounters || {})) {
      usageCounters.set(accountId, { ...blankUsage(), ...usage });
    }
    for (const row of data.accountPlans || []) accountPlans.set(row.accountId, row);
    for (const row of data.consoleSessions || []) {
      if (new Date(row.expiresAt).getTime() > Date.now()) consoleSessions.set(row.id, row);
    }
    console.log(`[console-store] loaded ${apiKeys.size} keys, ${brainMemories.size} brain memories, ${auditEvents.length} audit events from ${CONSOLE_STORE_PATH}`);
  } catch (e) {
    console.warn(`[console-store] failed to load ${CONSOLE_STORE_PATH}: ${e.message}`);
  }
}

function saveConsoleStore() {
  try {
    if (CONSOLE_STORE_DRIVER === 'sqlite') {
      saveConsoleStoreToSqlite();
      return;
    }
    fs.mkdirSync(path.dirname(CONSOLE_STORE_PATH), { recursive: true });
    const usage = {};
    for (const [accountId, counters] of usageCounters.entries()) usage[accountId] = counters;
    fs.writeFileSync(CONSOLE_STORE_PATH, JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      apiKeys: Array.from(apiKeys.values()),
      brainMemories: Array.from(brainMemories.values()),
      auditEvents,
      usageCounters: usage,
      accountPlans: Array.from(accountPlans.values()),
      consoleSessions: Array.from(consoleSessions.values()).filter((session) => new Date(session.expiresAt).getTime() > Date.now()),
    }, null, 2));
  } catch (e) {
    console.warn(`[console-store] failed to save ${CONSOLE_STORE_PATH}: ${e.message}`);
  }
}

function publicBrainMemory(memory) {
  return {
    id: memory.id,
    accountId: memory.accountId,
    namespace: memory.namespace,
    content: memory.content,
    importance: memory.importance,
    tags: memory.tags,
    createdAt: memory.createdAt,
  };
}

async function storeBrainMemory(body, accountId) {
  const namespace = String(body.namespace || 'default').slice(0, 120);
  const content = String(body.content || '').trim();
  if (!content) throw new Error('content required');
  const id = body.id ? String(body.id).slice(0, 160) : `mem_${uuid()}`;
  const tags = Array.isArray(body.tags) ? body.tags.map((t) => String(t).slice(0, 64)).slice(0, 16) : [];
  const importance = Number.isFinite(Number(body.importance)) ? Math.max(0, Math.min(1, Number(body.importance))) : 0.6;
  const createdAt = new Date().toISOString();
  if (!body.systemWrite) assertPlanAllows(accountId, 'brain.write');
  const memory = { id, accountId, namespace, content, importance, score: importance, createdAt, lastAccessed: createdAt, accessCount: 0, tags };
  brainMemories.set(id, memory);
  if (!body.systemWrite) usageForAccount(accountId).brainWrites++;
  recordAudit(accountId, 'brain.memory.created', `brain:${namespace}`, { memoryId: id, namespace, tags, importance });
  if (brain?.embed) {
    await brain.embed(id, content, { accountId, namespace, tags, importance, createdAt });
  }
  saveConsoleStore();
  return publicBrainMemory(memory);
}

async function provisionAccount(body, accountId) {
  const lookup = body.priceLookupKey ? PRICE_LOOKUP_TO_PLAN[String(body.priceLookupKey)] : null;
  const plan = lookup?.plan || String(body.plan || DEFAULT_PLAN || 'free').toLowerCase();
  if (!PLAN_CATALOG[plan]) throw new Error(`unsupported plan: ${plan}`);
  const interval = lookup?.interval || String(body.interval || 'monthly').toLowerCase();
  if (!['monthly', 'yearly', 'custom'].includes(interval)) throw new Error(`unsupported interval: ${interval}`);

  const now = new Date().toISOString();
  const existing = accountPlans.get(accountId) || {};
  const accountPlan = {
    accountId,
    plan,
    interval,
    status: String(body.status || 'active').slice(0, 40),
    source: String(body.source || (body.checkoutSessionId ? 'checkout' : 'manual')).slice(0, 40),
    priceLookupKey: body.priceLookupKey ? String(body.priceLookupKey).slice(0, 120) : null,
    stripeCustomerId: body.stripeCustomerId ? String(body.stripeCustomerId).slice(0, 160) : null,
    stripeSubscriptionId: body.stripeSubscriptionId ? String(body.stripeSubscriptionId).slice(0, 160) : null,
    checkoutSessionId: body.checkoutSessionId ? String(body.checkoutSessionId).slice(0, 180) : null,
    provisionedAt: existing.provisionedAt || now,
    updatedAt: now,
  };
  accountPlans.set(accountId, accountPlan);

  const namespace = String(body.namespace || 'default').slice(0, 120);
  const hasNamespaceMemory = Array.from(brainMemories.values())
    .some((m) => m.accountId === accountId && m.namespace === namespace && (m.tags || []).includes('provisioning'));
  let starterMemory = null;
  if (!hasNamespaceMemory) {
    starterMemory = await storeBrainMemory({
      id: `mem_provision_${crypto.createHash('sha1').update(`${accountId}:${namespace}`).digest('hex').slice(0, 24)}`,
      namespace,
      content: `Account ${accountId} provisioned on MnemoPay ${PLAN_CATALOG[plan].name} (${interval}). Use this namespace as the default hosted brain for onboarding and first agent memory.`,
      tags: ['provisioning', 'system'],
      importance: 0.85,
      systemWrite: true,
    }, accountId);
  }

  let apiKey = null;
  const shouldCreateKey = body.createApiKey !== false;
  const hasActiveKey = Array.from(apiKeys.values()).some((key) => key.accountId === accountId && !key.revokedAt);
  if (shouldCreateKey && !hasActiveKey) {
    apiKey = createApiKey(accountId, body.apiKeyName || `${plan}-default`);
  }

  recordAudit(accountId, 'billing.account.provisioned', `account:${accountId}`, {
    plan,
    interval,
    source: accountPlan.source,
    priceLookupKey: accountPlan.priceLookupKey,
    checkoutSessionId: accountPlan.checkoutSessionId,
    starterMemoryId: starterMemory?.id || null,
    apiKeyId: apiKey?.id || null,
  });
  saveConsoleStore();

  return {
    account: accountPlanFor(accountId),
    starterMemory,
    apiKey: apiKey ? { ...publicApiKey(apiKey), secret: apiKey.secret } : null,
    onboarding: onboardingState(accountId),
  };
}

async function queryBrain(body, accountId) {
  const namespace = String(body.namespace || 'default').slice(0, 120);
  const query = String(body.query || '').trim();
  const limit = Math.max(1, Math.min(25, parseInt(body.limit || '8', 10)));
  if (!query) throw new Error('query required');
  assertPlanAllows(accountId, 'brain.query');
  usageForAccount(accountId).brainQueries++;
  const candidates = Array.from(brainMemories.values()).filter((m) => m.accountId === accountId && m.namespace === namespace);
  if (brain?.search) {
    const results = await brain.search(query, candidates, limit);
    recordAudit(accountId, 'brain.query', `brain:${namespace}`, { namespace, query, limit, resultCount: results.length });
    saveConsoleStore();
    return {
      namespace,
      query,
      count: results.length,
      results: results.map((r) => ({
        id: r.id,
        content: r.content,
        importance: r.importance,
        score: r.combinedScore ?? r.score,
        tags: r.tags,
      })),
    };
  }
  const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = candidates
    .map((m) => ({
      ...m,
      score: terms.reduce((sum, term) => sum + (m.content.toLowerCase().includes(term) ? 1 : 0), 0) + m.importance,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  recordAudit(accountId, 'brain.query', `brain:${namespace}`, { namespace, query, limit, resultCount: scored.length });
  saveConsoleStore();
  return { namespace, query, count: scored.length, results: scored.map(publicBrainMemory) };
}

function createApiKey(accountId, name = 'default') {
  const secret = `mnemo_${crypto.randomBytes(32).toString('base64url')}`;
  const key = {
    id: `key_${uuid()}`,
    accountId,
    name: String(name).slice(0, 64),
    prefix: secret.slice(0, 14),
    keyHash: hashSecret(secret),
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  apiKeys.set(key.id, key);
  recordAudit(accountId, 'api_key.created', `api_key:${key.id}`, { keyId: key.id, name: key.name, prefix: key.prefix });
  saveConsoleStore();
  return { ...key, secret };
}

function onboardingState(accountId) {
  const usage = usageForAccount(accountId);
  const billing = accountPlanFor(accountId);
  const hasKey = Array.from(apiKeys.values()).some((k) => k.accountId === accountId && !k.revokedAt);
  const hasBrainMemory = Array.from(brainMemories.values()).some((m) => m.accountId === accountId);
  const hasAuditExport = auditEvents.some((event) => event.accountId === accountId && ['brain.namespace.exported', 'usage.report.exported'].includes(event.action));
  const profileTasks = [
    { id: 'provision-account', label: 'Provision account plan', done: !!billing.provisionedAt || billing.source !== 'default' },
    { id: 'create-api-key', label: 'Create first API key', done: hasKey },
    { id: 'write-brain-memory', label: 'Write first hosted brain memory', done: hasBrainMemory },
    { id: 'run-brain-query', label: 'Run first hosted recall query', done: usage.brainQueries > 0 },
    { id: 'test-payment-rail', label: 'Create first rail hold', done: usage.railCharges > 0 },
    { id: 'export-audit', label: 'Export first audit bundle', done: hasAuditExport },
  ];
  return {
    accountId,
    plan: billing.plan,
    billing,
    complete: profileTasks.every((task) => task.done),
    tasks: profileTasks,
  };
}

loadConsoleStore();

// ── Server ──────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-MnemoPay-Account, Stripe-Signature');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API Routes ──────────────────────────────────────────────────────────

  if (pathname === '/api/v1/auth/session' && req.method === 'GET') {
    const session = sessionForRequest(req);
    return json(res, { ok: true, authenticated: !!session, session: publicSession(session) });
  }

  if (pathname === '/api/v1/auth/login' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const accountId = String(body.accountId || DEFAULT_ACCOUNT_ID).trim().slice(0, 120);
      if (!accountId) throw new Error('accountId required');
      const session = createConsoleSession({ accountId, email: body.email, name: body.name });
      setSessionCookie(res, session.id);
      return json(res, { ok: true, session: publicSession(session), accountId: session.accountId }, 201);
    } catch (e) {
      return errorJson(res, e);
    }
  }

  if (pathname === '/api/v1/auth/logout' && req.method === 'POST') {
    const session = sessionForRequest(req);
    if (session) {
      consoleSessions.delete(session.id);
      recordAudit(session.accountId, 'auth.session.revoked', `session:${session.id}`, {});
      saveConsoleStore();
    }
    clearSessionCookie(res);
    return json(res, { ok: true });
  }

  // Memories
  if (pathname === '/api/memories' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '50');
    const query = url.searchParams.get('q');
    const memories = query ? await agent.recall(query, limit) : await agent.recall(limit);
    return json(res, memories);
  }

  if (pathname === '/api/memories' && req.method === 'POST') {
    const body = await readBody(req);
    const id = await agent.remember(body.content, { importance: body.importance, tags: body.tags });
    return json(res, { id, status: 'stored' }, 201);
  }

  if (pathname.startsWith('/api/memories/') && req.method === 'DELETE') {
    const id = pathname.split('/')[3];
    const deleted = await agent.forget(id);
    return json(res, { deleted });
  }

  if (pathname === '/api/memories/reinforce' && req.method === 'POST') {
    const body = await readBody(req);
    await agent.reinforce(body.id, body.boost || 0.1);
    return json(res, { reinforced: true });
  }

  if (pathname === '/api/memories/consolidate' && req.method === 'POST') {
    const pruned = await agent.consolidate();
    return json(res, { pruned });
  }

  // Payments
  if (pathname === '/api/charge' && req.method === 'POST') {
    try {
      const accountId = accountIdForRequest(req);
      const body = await readBody(req);
      assertPlanAllows(accountId, 'rail.charge');
      const tx = await agent.charge(body.amount, body.reason);
      usageForAccount(accountId).railCharges++;
      recordAudit(accountId, 'rail.charge.created', `tx:${tx.id || 'unknown'}`, { txId: tx.id, amount: body.amount, reason: body.reason });
      saveConsoleStore();
      return json(res, tx, 201);
    } catch (e) {
      return errorJson(res, e);
    }
  }

  if (pathname === '/api/settle' && req.method === 'POST') {
    const accountId = accountIdForRequest(req);
    const body = await readBody(req);
    const tx = await agent.settle(body.txId);
    if (tx) {
      usageForAccount(accountId).railSettlements++;
      recordAudit(accountId, 'rail.charge.settled', `tx:${body.txId}`, { txId: body.txId });
      saveConsoleStore();
    }
    return json(res, tx || { error: 'Transaction not found or not pending' });
  }

  if (pathname === '/api/refund' && req.method === 'POST') {
    const body = await readBody(req);
    const tx = await agent.refund(body.txId);
    return json(res, tx || { error: 'Transaction not found' });
  }

  // Profile & status
  if (pathname === '/api/profile' && req.method === 'GET') {
    const profile = await agent.profile();
    return json(res, profile);
  }

  if (pathname === '/api/balance' && req.method === 'GET') {
    const balance = await agent.balance();
    return json(res, balance);
  }

  if (pathname === '/api/history' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const history = await agent.history(limit);
    return json(res, history);
  }

  if (pathname === '/api/logs' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '30');
    const logs = await agent.logs(limit);
    return json(res, logs);
  }

  // Console/app surface
  if (pathname === '/api/v1/console/overview' && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    const profile = await agent.profile();
    const balance = await agent.balance();
    const billing = accountPlanFor(accountId);
    const accountKeys = Array.from(apiKeys.values()).filter((key) => key.accountId === accountId);
    const accountMemories = Array.from(brainMemories.values()).filter((memory) => memory.accountId === accountId);
    return json(res, {
      ok: true,
      accountId,
      positioning: 'brain, wallet, and audit trail for AI agents',
      plan: billing.plan,
      billing,
      profile,
      balance,
      usage: usageForAccount(accountId),
      metering: meteringSnapshot(accountId),
      onboarding: onboardingState(accountId),
      apiKeys: accountKeys.map(publicApiKey),
      brain: {
        mode: brain ? 'recall-engine' : 'fallback',
        namespaces: Array.from(new Set(accountMemories.map((m) => m.namespace))).length,
        memories: accountMemories.length,
      },
    });
  }

  if (pathname === '/api/v1/developer/api-keys' && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    return json(res, { ok: true, accountId, keys: Array.from(apiKeys.values()).filter((key) => key.accountId === accountId).map(publicApiKey) });
  }

  if (pathname.startsWith('/api/v1/developer/api-keys/') && pathname.endsWith('/revoke') && req.method === 'POST') {
    const accountId = accountIdForRequest(req);
    const keyId = pathname.split('/')[5];
    const key = apiKeys.get(keyId);
    if (!key || key.accountId !== accountId) return json(res, { ok: false, error: 'API key not found' }, 404);
    if (!key.revokedAt) {
      key.revokedAt = new Date().toISOString();
      recordAudit(accountId, 'api_key.revoked', `api_key:${key.id}`, { keyId: key.id, name: key.name, prefix: key.prefix });
      saveConsoleStore();
    }
    return json(res, { ok: true, key: publicApiKey(key) });
  }

  if (pathname === '/api/v1/developer/api-keys' && req.method === 'POST') {
    const accountId = accountIdForRequest(req);
    const body = await readBody(req);
    const key = createApiKey(accountId, body.name || 'default');
    const { secret } = key;
    const publicKey = publicApiKey(key);
    return json(res, { ok: true, key: publicKey, secret, warning: 'Store this secret now. MnemoPay will not show it again.' }, 201);
  }

  if (pathname === '/api/v1/billing/onboarding' && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    return json(res, { ok: true, ...onboardingState(accountId), usage: usageForAccount(accountId) });
  }

  if ((pathname === '/api/v1/billing/provision' || pathname === '/api/v1/billing/checkout/success') && req.method === 'POST') {
    try {
      const accountId = accountIdForRequest(req);
      const body = await readBody(req);
      const provisioned = await provisionAccount(body, accountId);
      return json(res, { ok: true, accountId, ...provisioned }, 201);
    } catch (e) {
      return errorJson(res, e);
    }
  }

  if (pathname === '/api/v1/billing/stripe/webhook' && req.method === 'POST') {
    try {
      const rawBody = await readRawBody(req);
      const signature = req.headers['stripe-signature'];
      const verification = verifyStripeWebhookSignature(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
      if (!verification.ok) return json(res, { ok: false, error: verification.reason }, 400);
      const event = JSON.parse(rawBody || '{}');
      const handledTypes = new Set(['checkout.session.completed', 'customer.subscription.updated', 'customer.subscription.deleted']);
      if (!handledTypes.has(event.type)) {
        return json(res, { ok: true, ignored: true, type: event.type || 'unknown', verification });
      }
      const fallbackAccountId = accountIdForRequest(req);
      const provisionBody = provisioningBodyFromStripeEvent(event, fallbackAccountId);
      const accountId = String(provisionBody.accountId || fallbackAccountId).slice(0, 120);
      delete provisionBody.accountId;
      const provisioned = await provisionAccount(provisionBody, accountId);
      recordAudit(accountId, 'billing.stripe.webhook.handled', `stripe:${event.id || event.type}`, {
        eventId: event.id || null,
        type: event.type,
        verification: verification.mode,
      });
      saveConsoleStore();
      return json(res, { ok: true, accountId, type: event.type, verification, ...provisioned }, 200);
    } catch (e) {
      return errorJson(res, e);
    }
  }

  if (pathname === '/api/v1/usage/report' && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    return json(res, { ok: true, ...meteringSnapshot(accountId) });
  }

  if (pathname === '/api/v1/usage/export' && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    const report = meteringSnapshot(accountId);
    const events = auditEvents
      .filter((event) => event.accountId === accountId)
      .slice(-200)
      .map(publicAuditEvent);
    recordAudit(accountId, 'usage.report.exported', `account:${accountId}`, {
      period: report.period,
      missionsUsed: report.missions.used,
      missionLimit: report.missions.limit,
    });
    saveConsoleStore();
    return json(res, { ok: true, exportedAt: new Date().toISOString(), report, events });
  }

  if (pathname === '/api/v1/audit/events' && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10)));
    const events = auditEvents
      .filter((event) => event.accountId === accountId)
      .slice(-limit)
      .reverse()
      .map(publicAuditEvent);
    return json(res, { ok: true, accountId, events });
  }

  // Hosted Brain API prototype. This is the contract that becomes the
  // production brain service once auth + persistent storage are wired.
  if (pathname === '/api/v1/brain/memories' && req.method === 'POST') {
    try {
      const accountId = accountIdForRequest(req);
      const body = await readBody(req);
      const memory = await storeBrainMemory(body, accountId);
      return json(res, { ok: true, memory }, 201);
    } catch (e) {
      return errorJson(res, e);
    }
  }

  if (pathname === '/api/v1/brain/query' && req.method === 'POST') {
    try {
      const accountId = accountIdForRequest(req);
      const body = await readBody(req);
      const result = await queryBrain(body, accountId);
      return json(res, { ok: true, ...result });
    } catch (e) {
      return errorJson(res, e);
    }
  }

  if (pathname.startsWith('/api/v1/brain/namespaces/') && !pathname.endsWith('/export') && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    const namespace = decodeURIComponent(pathname.split('/').pop() || 'default');
    const rows = Array.from(brainMemories.values()).filter((m) => m.accountId === accountId && m.namespace === namespace);
    const lastWrite = rows.map((m) => m.createdAt).sort().pop() || null;
    return json(res, { ok: true, accountId, namespace, memoryCount: rows.length, lastWrite, mode: brain ? 'recall-engine' : 'fallback' });
  }

  if (pathname.startsWith('/api/v1/brain/namespaces/') && pathname.endsWith('/export') && req.method === 'GET') {
    const accountId = accountIdForRequest(req);
    const namespace = decodeURIComponent(pathname.split('/')[5] || 'default');
    const rows = Array.from(brainMemories.values())
      .filter((m) => m.accountId === accountId && m.namespace === namespace)
      .map(publicBrainMemory);
    recordAudit(accountId, 'brain.namespace.exported', `brain:${namespace}`, { namespace, memoryCount: rows.length });
    saveConsoleStore();
    return json(res, { ok: true, accountId, namespace, exportedAt: new Date().toISOString(), memories: rows });
  }

  if (pathname.startsWith('/api/v1/brain/namespaces/') && req.method === 'DELETE') {
    const accountId = accountIdForRequest(req);
    const namespace = decodeURIComponent(pathname.split('/').pop() || 'default');
    let deleted = 0;
    for (const [id, memory] of brainMemories.entries()) {
      if (memory.accountId === accountId && memory.namespace === namespace) {
        brainMemories.delete(id);
        if (brain?.remove) brain.remove(id);
        deleted++;
      }
    }
    recordAudit(accountId, 'brain.namespace.deleted', `brain:${namespace}`, { namespace, deleted });
    saveConsoleStore();
    return json(res, { ok: true, accountId, namespace, deleted });
  }

  // GitHub repos
  if (pathname === '/api/repos' && req.method === 'GET') {
    try {
      const repos = await fetchRepoStatus();
      return json(res, repos);
    } catch (e) {
      return json(res, { error: e.message }, 500);
    }
  }

  // Health
  if (pathname === '/healthz') {
    return json(res, { status: 'ok', mode: 'live', agentId: agent.agentId || 'dashboard-live' });
  }

  // ── Static files ────────────────────────────────────────────────────────
  if (pathname === '/' || pathname === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(html);
  }

  // 404
  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n  MnemoPay Live Dashboard`);
  console.log(`  ────────────────────────`);
  console.log(`  URL:     http://localhost:${PORT}`);
  console.log(`  Agent:   ${agent.agentId || 'dashboard-live'}`);
  console.log(`  Mode:    Live (real SDK)`);
  console.log(`  API:     /api/memories, /api/charge, /api/settle, /api/repos`);
  console.log(`  Brain:   /api/v1/brain/memories, /api/v1/brain/query`);
  console.log(`  Repos:   ${MONITORED_REPOS.length} monitored\n`);
});
