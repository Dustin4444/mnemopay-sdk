/**
 * BrowserSwarm spec — covers the five contract guarantees of v0.2:
 *
 *   1. spawn(N) opens N parallel sessions
 *   2. per-session FiscalGate budget enforcement
 *   3. step sequence execution (goto → act → extract → screenshot)
 *   4. audit-chain integration (every step + every task logged)
 *   5. per-session failure isolation (one bad session does not kill peers)
 *
 * Mock surface — no Playwright, no Browserbase, no real network. The mock
 * implements the same MnemopayBrowserSurface shape the lazy import would
 * resolve to.
 */
import { describe, it, expect } from "vitest";
import { BrowserSwarm, type BrowserTask, type BrowserTaskResult, type MnemopayBrowserSurface } from "./browser.js";
import type { AuditChain } from "./index.js";

// ─── mock surface ───────────────────────────────────────────────────────────

interface MockSurfaceOptions {
  /** Force these task ids to fail at open(). */
  openFails?: Set<string>;
  /** Force perform() to fail when target matches one of these keys. */
  performFails?: Set<string>;
  /** Optional gate to keep perform() in-flight until released. */
  performGate?: () => Promise<void>;
}

function makeSurface(opts: MockSurfaceOptions = {}) {
  const opened: string[] = [];
  const closed: string[] = [];
  const performed: Array<{ session_id: string; kind: string; target?: string; value?: string }> = [];
  const captured: string[] = [];
  let counter = 0;

  const surface: MnemopayBrowserSurface & {
    opened: typeof opened;
    closed: typeof closed;
    performed: typeof performed;
    captured: typeof captured;
  } = {
    opened,
    closed,
    performed,
    captured,
    async open(o) {
      if (opts.openFails && opts.openFails.has(o.did)) {
        throw new Error(`open_failed:${o.did}`);
      }
      const session_id = `s-${++counter}`;
      opened.push(session_id);
      return { session_id, did: o.did, provider: o.provider };
    },
    async perform(session_id, action) {
      performed.push({
        session_id,
        kind: action.kind,
        ...(action.target !== undefined ? { target: action.target } : {}),
        ...(action.value !== undefined ? { value: action.value } : {}),
      });
      if (opts.performGate) await opts.performGate();
      if (opts.performFails && action.target && opts.performFails.has(action.target)) {
        return { ok: false, note: `perform_failed:${action.target}` };
      }
      return { ok: true, note: `did:${action.kind}:${action.target ?? ""}` };
    },
    async evaluate(session_id, expr) {
      return `eval:${expr}`;
    },
    async capture(session_id, fullPage) {
      const png = `b64:${session_id}:${fullPage ? "full" : "vp"}`;
      captured.push(png);
      return png;
    },
    async close(session_id) {
      closed.push(session_id);
    },
  };

  return surface;
}

function makeAuditChain(): AuditChain & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    append(ev) {
      const stamped = { id: `ev-${events.length + 1}`, ...ev };
      events.push(stamped);
      return stamped;
    },
  };
}

// ─── 1. parallel N sessions ─────────────────────────────────────────────────

describe("BrowserSwarm.spawn — N parallel browser sessions", () => {
  it("opens one session per task, in parallel, up to cfg.size", async () => {
    const surface = makeSurface();
    const swarm = new BrowserSwarm({
      size: 3,
      provider: undefined as never, // overridden by surface adapter
      budget: { perAgent: 1.0, total: 10.0 },
      browser: { provider: "stagehand", surface },
    });

    const tasks: BrowserTask[] = [
      { id: "t1", prompt: "scrape A", steps: [{ type: "goto", url: "https://a.test" }] },
      { id: "t2", prompt: "scrape B", steps: [{ type: "goto", url: "https://b.test" }] },
      { id: "t3", prompt: "scrape C", steps: [{ type: "goto", url: "https://c.test" }] },
    ];
    const run = await swarm.spawn(tasks);
    const results = (await swarm.gather(run)) as BrowserTaskResult[];

    expect(surface.opened.length).toBe(3);
    expect(surface.closed.length).toBe(3);
    expect(results.map((r) => r.taskId).sort()).toEqual(["t1", "t2", "t3"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

// ─── 2. per-session FiscalGate budget enforcement ───────────────────────────

describe("BrowserSwarm — per-session FiscalGate budget enforcement", () => {
  it("budget-denied tasks never open a session; siblings still run", async () => {
    const surface = makeSurface();
    const swarm = new BrowserSwarm({
      size: 3,
      provider: undefined as never,
      budget: { perAgent: 0.50, total: 10.0 },
      browser: { provider: "local-playwright", surface },
    });

    const tasks: BrowserTask[] = [
      { id: "ok1",    prompt: "x", budget: 0.25, steps: [{ type: "goto", url: "https://a.test" }] },
      { id: "denied", prompt: "y", budget: 99.0, steps: [{ type: "goto", url: "https://b.test" }] },
      { id: "ok2",    prompt: "z", budget: 0.40, steps: [{ type: "goto", url: "https://c.test" }] },
    ];
    const run = await swarm.spawn(tasks);
    const results = (await swarm.gather(run)) as BrowserTaskResult[];
    const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));

    expect(byId["denied"]!.ok).toBe(false);
    expect(byId["denied"]!.error).toBe("budget-denied");
    expect(byId["denied"]!.spend).toBe(0);
    expect(byId["ok1"]!.ok).toBe(true);
    expect(byId["ok2"]!.ok).toBe(true);
    // Denied task NEVER opens a session.
    expect(surface.opened.length).toBe(2);
  });
});

// ─── 3. step sequence execution ─────────────────────────────────────────────

describe("BrowserSwarm — step sequence (goto → act → extract → screenshot)", () => {
  it("executes every step in order and collects screenshots + extractedData", async () => {
    const surface = makeSurface();
    const swarm = new BrowserSwarm({
      size: 1,
      provider: undefined as never,
      budget: { perAgent: 1.0, total: 5.0 },
      browser: { provider: "stagehand", surface },
    });

    const task: BrowserTask = {
      id: "seq",
      prompt: "full flow",
      steps: [
        { type: "goto", url: "https://example.com/products" },
        { type: "act", instruction: "click the first product" },
        { type: "extract", selector: ".price" },
        { type: "screenshot", fullPage: true },
        { type: "wait", ms: 1 },
      ],
    };
    const run = await swarm.spawn([task]);
    const results = (await swarm.gather(run)) as BrowserTaskResult[];
    const r = results[0]!;

    expect(r.ok).toBe(true);
    expect(r.finalUrl).toBe("https://example.com/products");
    expect(r.screenshots).toHaveLength(1);
    expect(r.screenshots[0]).toMatch(/^b64:/);
    expect(r.extractedData).toHaveLength(1);
    // evaluate() was called with the selector path for `extract`.
    expect(r.extractedData[0]).toMatch(/^eval:document\.querySelector/);
    // Step order is preserved in performed calls.
    const kinds = surface.performed.map((p) => p.kind);
    expect(kinds.indexOf("navigate")).toBeLessThan(kinds.indexOf("evaluate"));
  });
});

// ─── 4. audit-chain integration ─────────────────────────────────────────────

describe("BrowserSwarm — audit chain integration", () => {
  it("appends one browser.step event per step + one swarm.task per task", async () => {
    const surface = makeSurface();
    const chain = makeAuditChain();
    const swarm = new BrowserSwarm({
      size: 2,
      provider: undefined as never,
      budget: { perAgent: 1.0, total: 10.0 },
      audit: { chain },
      did: "did:mp:audit",
      browser: { provider: "stagehand", surface },
    });

    const tasks: BrowserTask[] = [
      { id: "a", prompt: "x", steps: [
        { type: "goto", url: "https://a.test" },
        { type: "screenshot" },
      ]},
      { id: "b", prompt: "y", steps: [
        { type: "goto", url: "https://b.test" },
        { type: "act", instruction: "scroll" },
      ]},
    ];
    const run = await swarm.spawn(tasks);
    const results = (await swarm.gather(run)) as BrowserTaskResult[];

    const stepEvents = chain.events.filter((e) => e.kind === "browser.step");
    const taskEvents = chain.events.filter((e) => e.kind === "swarm.task");
    // 2 tasks * 2 steps each.
    expect(stepEvents.length).toBe(4);
    expect(stepEvents.every((e) => e.success === true)).toBe(true);
    expect(taskEvents.length).toBe(2);
    // Back-filled auditRef on every result.
    expect(results.every((r) => r.auditRef.length > 0)).toBe(true);
  });
});

// ─── 5. per-session failure isolation ───────────────────────────────────────

describe("BrowserSwarm — per-session failure isolation", () => {
  it("one session's open()/step failure does not affect siblings", async () => {
    // `openFails` keys off the did passed into open() — which is the task
    // id when no shared `did` is configured. `performFails` keys off the
    // `target` field — "act" steps set target="act", which is what we use
    // here to force a mid-flight step failure on `did:bad-step`.
    const surface = makeSurface({
      openFails: new Set(["did:bad-open"]),
      performFails: new Set(["act"]),
    });
    const swarm = new BrowserSwarm({
      size: 3,
      provider: undefined as never,
      budget: { perAgent: 1.0, total: 10.0 },
      browser: { provider: "stagehand", surface },
    });

    const tasks: BrowserTask[] = [
      { id: "did:good",     prompt: "ok",  steps: [{ type: "goto", url: "https://ok.test" }] },
      { id: "did:bad-open", prompt: "bad", steps: [{ type: "goto", url: "https://bad.test" }] },
      { id: "did:bad-step", prompt: "mid", steps: [
        { type: "goto", url: "https://mid.test" },
        { type: "act", instruction: "this will fail at perform()" },
      ]},
    ];
    const run = await swarm.spawn(tasks);
    const results = (await swarm.gather(run)) as BrowserTaskResult[];
    const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));

    expect(byId["did:good"]!.ok).toBe(true);
    expect(byId["did:bad-open"]!.ok).toBe(false);
    expect(byId["did:bad-open"]!.error).toMatch(/^provider-error/);
    expect(byId["did:bad-step"]!.ok).toBe(false);
    expect(byId["did:bad-step"]!.error).toMatch(/^provider-error/);
    // 2 sessions actually opened (good + bad-step). bad-open never opens.
    expect(surface.opened.length).toBe(2);
    // Both opened sessions get cleanly closed even on step failure.
    expect(surface.closed.length).toBe(2);
  });
});
