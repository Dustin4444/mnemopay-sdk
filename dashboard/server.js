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

// ── Initialize the real SDK ─────────────────────────────────────────────────
let agent;
let brain;
const brainMemories = new Map();
const apiKeys = new Map();
const usageCounters = new Map();
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

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

function blankUsage() {
  return { brainWrites: 0, brainQueries: 0, railCharges: 0, railSettlements: 0 };
}

function usageForAccount(accountId) {
  if (!usageCounters.has(accountId)) usageCounters.set(accountId, blankUsage());
  return usageCounters.get(accountId);
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
  const headerAccount = req.headers['x-mnemopay-account'];
  return String(Array.isArray(headerAccount) ? headerAccount[0] : headerAccount || DEFAULT_ACCOUNT_ID).slice(0, 120);
}

function loadConsoleStore() {
  try {
    if (!fs.existsSync(CONSOLE_STORE_PATH)) return;
    const raw = fs.readFileSync(CONSOLE_STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    for (const row of data.apiKeys || []) apiKeys.set(row.id, row);
    for (const row of data.brainMemories || []) brainMemories.set(row.id, row);
    for (const row of data.auditEvents || []) auditEvents.push(row);
    for (const [accountId, usage] of Object.entries(data.usageCounters || {})) {
      usageCounters.set(accountId, { ...blankUsage(), ...usage });
    }
    console.log(`[console-store] loaded ${apiKeys.size} keys, ${brainMemories.size} brain memories, ${auditEvents.length} audit events from ${CONSOLE_STORE_PATH}`);
  } catch (e) {
    console.warn(`[console-store] failed to load ${CONSOLE_STORE_PATH}: ${e.message}`);
  }
}

function saveConsoleStore() {
  try {
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
  const memory = { id, accountId, namespace, content, importance, score: importance, createdAt, lastAccessed: createdAt, accessCount: 0, tags };
  brainMemories.set(id, memory);
  usageForAccount(accountId).brainWrites++;
  recordAudit(accountId, 'brain.memory.created', `brain:${namespace}`, { memoryId: id, namespace, tags, importance });
  if (brain?.embed) {
    await brain.embed(id, content, { accountId, namespace, tags, importance, createdAt });
  }
  saveConsoleStore();
  return publicBrainMemory(memory);
}

async function queryBrain(body, accountId) {
  const namespace = String(body.namespace || 'default').slice(0, 120);
  const query = String(body.query || '').trim();
  const limit = Math.max(1, Math.min(25, parseInt(body.limit || '8', 10)));
  if (!query) throw new Error('query required');
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
  const hasKey = Array.from(apiKeys.values()).some((k) => k.accountId === accountId && !k.revokedAt);
  const hasBrainMemory = Array.from(brainMemories.values()).some((m) => m.accountId === accountId);
  const profileTasks = [
    { id: 'create-api-key', label: 'Create first API key', done: hasKey },
    { id: 'write-brain-memory', label: 'Write first hosted brain memory', done: hasBrainMemory },
    { id: 'run-brain-query', label: 'Run first hosted recall query', done: usage.brainQueries > 0 },
    { id: 'test-payment-rail', label: 'Create first rail hold', done: usage.railCharges > 0 },
    { id: 'export-audit', label: 'Export first audit bundle', done: false },
  ];
  return {
    accountId,
    plan: DEFAULT_PLAN,
    complete: profileTasks.every((task) => task.done),
    tasks: profileTasks,
  };
}

loadConsoleStore();

// ── Server ──────────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // ── API Routes ──────────────────────────────────────────────────────────

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
    const accountId = accountIdForRequest(req);
    const body = await readBody(req);
    const tx = await agent.charge(body.amount, body.reason);
    usageForAccount(accountId).railCharges++;
    recordAudit(accountId, 'rail.charge.created', `tx:${tx.id || 'unknown'}`, { txId: tx.id, amount: body.amount, reason: body.reason });
    saveConsoleStore();
    return json(res, tx, 201);
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
    const accountKeys = Array.from(apiKeys.values()).filter((key) => key.accountId === accountId);
    const accountMemories = Array.from(brainMemories.values()).filter((memory) => memory.accountId === accountId);
    return json(res, {
      ok: true,
      accountId,
      positioning: 'brain, wallet, and audit trail for AI agents',
      plan: DEFAULT_PLAN,
      profile,
      balance,
      usage: usageForAccount(accountId),
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
      return json(res, { ok: false, error: e.message }, 400);
    }
  }

  if (pathname === '/api/v1/brain/query' && req.method === 'POST') {
    try {
      const accountId = accountIdForRequest(req);
      const body = await readBody(req);
      const result = await queryBrain(body, accountId);
      return json(res, { ok: true, ...result });
    } catch (e) {
      return json(res, { ok: false, error: e.message }, 400);
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
