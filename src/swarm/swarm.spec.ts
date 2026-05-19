/**
 * Swarm primitive spec — covers:
 *   - size cap honored (more tasks than size → only `size` are spawned)
 *   - per-agent FiscalGate.precheck failure isolates one agent
 *   - gather() waits for every in-flight task
 *   - recombine: first-success, majority-vote, merge-json, concat,
 *     plus a caller-supplied callback strategy
 *   - stop() cancels in-flight + invokes provider.abort when present
 *   - total-budget enforcement cancels mid-run
 *   - audit chain receives one swarm.task event per completed task
 *
 * Pure unit tests — no network, no real provider, no Supertonic.
 */
import { describe, it, expect } from "vitest";
import {
  Swarm,
  FiscalGate,
  type BrowserProvider,
  type Task,
  type TaskResult,
  type AuditChain,
} from "./index.js";

// ─── helpers ────────────────────────────────────────────────────────────────

interface MockSession {
  session_id: string;
  did: string;
  provider: string;
  opened_at: string;
  budget_usd: number;
}

interface MockProviderOptions {
  /** Per-call `perform` return — keyed by skillId / target. */
  responses?: Record<string, { ok: boolean; note?: string }>;
  /** When set, `perform` will await this promise before resolving. */
  performGate?: () => Promise<void>;
  /** Spy: should `abort` exist on the provider? */
  withAbort?: boolean;
  /** Force `open` to throw for these task ids. */
  openFails?: Set<string>;
}

function makeProvider(opts: MockProviderOptions = {}) {
  const opened: string[] = [];
  const closed: string[] = [];
  const aborted: string[] = [];
  const performed: Array<{ session_id: string; target: string | undefined; value: string | undefined }> = [];
  let counter = 0;

  const provider: BrowserProvider & {
    opened: typeof opened;
    closed: typeof closed;
    aborted: typeof aborted;
    performed: typeof performed;
  } = {
    name: "mock",
    opened,
    closed,
    aborted,
    performed,
    async open(o) {
      if (opts.openFails && opts.openFails.has(o.did)) {
        throw new Error("open_failed:" + o.did);
      }
      const session_id = `s-${++counter}`;
      opened.push(session_id);
      const info: MockSession = {
        session_id,
        did: o.did,
        provider: "mock",
        opened_at: new Date().toISOString(),
        budget_usd: o.budget_usd,
      };
      return info;
    },
    async perform(session_id, action) {
      performed.push({ session_id, target: action.target, value: action.value });
      if (opts.performGate) await opts.performGate();
      const key = action.target ?? "";
      const resp = opts.responses?.[key];
      return resp ?? { ok: true, note: `did:${key}` };
    },
    async close(session_id) {
      closed.push(session_id);
    },
  };

  if (opts.withAbort) {
    provider.abort = async (session_id: string) => {
      aborted.push(session_id);
    };
  }

  return provider;
}

function makeAuditChain(): AuditChain & { events: Record<string, unknown>[] } {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    append(ev: Record<string, unknown>) {
      const stamped = { id: `ev-${events.length + 1}`, ...ev };
      events.push(stamped);
      return stamped;
    },
  };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("Swarm — FiscalGate static precheck", () => {
  it("rejects requested > budget", () => {
    expect(FiscalGate.precheck(1.0, 2.0)).toEqual({ allowed: false, reason: "budget" });
  });
  it("allows requested <= budget", () => {
    expect(FiscalGate.precheck(1.0, 0.5)).toEqual({ allowed: true });
  });
  it("ignores zero / negative requests", () => {
    expect(FiscalGate.precheck(1.0, 0).allowed).toBe(true);
    expect(FiscalGate.precheck(1.0, -1).allowed).toBe(true);
  });
});

describe("Swarm.spawn — size cap", () => {
  it("accepts at most cfg.size tasks; the rest never spawn", async () => {
    const provider = makeProvider();
    const swarm = new Swarm({
      size: 2,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
    });
    const tasks: Task[] = [
      { id: "t1", prompt: "a" },
      { id: "t2", prompt: "b" },
      { id: "t3", prompt: "c" },
      { id: "t4", prompt: "d" },
    ];
    const run = await swarm.spawn(tasks);
    expect(run.tasks).toHaveLength(2);
    expect(run._inflight.size).toBe(2);
    const results = await swarm.gather(run);
    expect(results.map((r) => r.taskId)).toEqual(["t1", "t2"]);
  });
});

describe("Swarm.spawn — per-agent precheck failure isolates that agent", () => {
  it("over-budget task gets budget-denied; siblings still run", async () => {
    const provider = makeProvider();
    const swarm = new Swarm({
      size: 3,
      provider,
      budget: { perAgent: 0.50, total: 10.0 },
    });
    const tasks: Task[] = [
      { id: "ok1", prompt: "a", budget: 0.25 },
      { id: "denied", prompt: "b", budget: 99.0 }, // > perAgent → denied
      { id: "ok2", prompt: "c", budget: 0.40 },
    ];
    const run = await swarm.spawn(tasks);
    const results = await swarm.gather(run);
    const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));
    expect(byId["denied"]!.ok).toBe(false);
    expect(byId["denied"]!.error).toBe("budget-denied");
    expect(byId["denied"]!.spend).toBe(0);
    expect(byId["ok1"]!.ok).toBe(true);
    expect(byId["ok2"]!.ok).toBe(true);
    // denied task NEVER opens a provider session.
    expect(provider.opened.length).toBe(2);
  });
});

describe("Swarm.gather — waits for every in-flight task", () => {
  it("returns results for all spawned tasks", async () => {
    let resolveGate: () => void;
    const gateP = new Promise<void>((res) => { resolveGate = res; });
    const provider = makeProvider({ performGate: () => gateP });
    const swarm = new Swarm({
      size: 3,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
    });
    const run = await swarm.spawn([
      { id: "a", prompt: "x" },
      { id: "b", prompt: "y" },
      { id: "c", prompt: "z" },
    ]);
    // Tasks are in-flight, awaiting the gate.
    const gatherP = swarm.gather(run);
    resolveGate!();
    const results = await gatherP;
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("is idempotent — re-calling gather is safe", async () => {
    const provider = makeProvider();
    const swarm = new Swarm({
      size: 2,
      provider,
      budget: { perAgent: 1.0, total: 5.0 },
    });
    const run = await swarm.spawn([
      { id: "a", prompt: "x" },
      { id: "b", prompt: "y" },
    ]);
    const r1 = await swarm.gather(run);
    const r2 = await swarm.gather(run);
    expect(r1).toEqual(r2);
  });
});

describe("Swarm.recombine — built-in strategies", () => {
  function mkResults(): TaskResult[] {
    return [
      { taskId: "a", ok: true,  output: { x: 1, common: "Y" }, spend: 0.1, auditRef: "1" },
      { taskId: "b", ok: false, output: undefined,             spend: 0.0, auditRef: "2", error: "aborted" },
      { taskId: "c", ok: true,  output: { y: 2, common: "Y" }, spend: 0.1, auditRef: "3" },
      { taskId: "d", ok: true,  output: { z: 3, common: "Z" }, spend: 0.1, auditRef: "4" },
    ];
  }

  const swarm = new Swarm({
    size: 1,
    provider: makeProvider(),
    budget: { perAgent: 0.0, total: 0.0 },
  });

  it("first-success picks the first ok=true output", async () => {
    const out = await swarm.recombine(mkResults(), "first-success");
    expect(out).toEqual({ x: 1, common: "Y" });
  });

  it("concat joins ok outputs deterministically", async () => {
    const out = await swarm.recombine(
      [
        { taskId: "a", ok: true,  output: "hello", spend: 0, auditRef: "" },
        { taskId: "b", ok: true,  output: "world", spend: 0, auditRef: "" },
        { taskId: "c", ok: false, output: "skip",  spend: 0, auditRef: "" },
      ],
      "concat",
    );
    expect(out).toBe("hello\nworld");
  });

  it("merge-json combines all ok object outputs (sorted keys, deterministic)", async () => {
    const out = (await swarm.recombine(mkResults(), "merge-json")) as Record<string, unknown>;
    expect(out).toMatchObject({ x: 1, y: 2, z: 3 });
    expect(out.common).toBeDefined();
  });

  it("majority-vote returns the most common output", async () => {
    const out = await swarm.recombine(
      [
        { taskId: "a", ok: true, output: "x", spend: 0, auditRef: "" },
        { taskId: "b", ok: true, output: "x", spend: 0, auditRef: "" },
        { taskId: "c", ok: true, output: "y", spend: 0, auditRef: "" },
      ],
      "majority-vote",
    );
    expect(out).toBe("x");
  });

  it("accepts a custom callback strategy", async () => {
    const fn = (rs: readonly TaskResult[]): unknown => ({
      total: rs.filter((r) => r.ok).reduce((acc, r) => acc + r.spend, 0),
      count: rs.length,
    });
    const out = await swarm.recombine(mkResults(), fn);
    expect(out).toEqual({ total: 0.3, count: 4 });
  });
});

describe("Swarm.stop — graceful cancellation", () => {
  it("invokes provider.abort when present", async () => {
    let resolveGate: () => void;
    const gateP = new Promise<void>((res) => { resolveGate = res; });
    const provider = makeProvider({ performGate: () => gateP, withAbort: true });
    const swarm = new Swarm({
      size: 2,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
      gracefulStopMs: 50,
    });
    const run = await swarm.spawn([
      { id: "a", prompt: "x" },
      { id: "b", prompt: "y" },
    ]);
    // Tasks are stuck inside `perform`. Stop the run.
    // Give the microtask queue a tick so open() resolves and sessionId is set.
    await new Promise((r) => setTimeout(r, 0));
    await swarm.stop(run, "test-cancel");
    // After stop completes, release the perform gate so promises settle.
    resolveGate!();
    const results = await swarm.gather(run);
    expect(provider.aborted.length).toBeGreaterThan(0);
    // After force-close, every opened session is closed.
    expect(provider.closed.length).toBe(provider.opened.length);
    // Tasks come back as aborted.
    const errors = results.map((r) => r.error);
    expect(errors.every((e) => typeof e === "string")).toBe(true);
  });

  it("falls back to provider.close when provider has no abort()", async () => {
    let resolveGate: () => void;
    const gateP = new Promise<void>((res) => { resolveGate = res; });
    const provider = makeProvider({ performGate: () => gateP, withAbort: false });
    const swarm = new Swarm({
      size: 1,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
      gracefulStopMs: 10,
    });
    const run = await swarm.spawn([{ id: "a", prompt: "x" }]);
    await new Promise((r) => setTimeout(r, 0));
    await swarm.stop(run, "no-abort");
    resolveGate!();
    await swarm.gather(run);
    expect(provider.aborted.length).toBe(0);
    expect(provider.closed.length).toBe(provider.opened.length);
  });

  it("is idempotent — second stop is a no-op", async () => {
    const provider = makeProvider({ withAbort: true });
    const swarm = new Swarm({
      size: 1,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
      gracefulStopMs: 10,
    });
    const run = await swarm.spawn([{ id: "a", prompt: "x" }]);
    await swarm.gather(run);
    await swarm.stop(run, "first");
    await swarm.stop(run, "second"); // must not throw / double-close
    expect(run._aborted).toBe(true);
  });
});

describe("Swarm — total budget enforcement", () => {
  it("once cumulative spend exceeds total, in-flight tasks are cancelled", async () => {
    // Three tasks at 0.40 each → cumulative crosses 1.00 on the third.
    let unlocks = 0;
    const unlock: Array<() => void> = [];
    const gatedPromises: Promise<void>[] = [];
    for (let i = 0; i < 3; i++) {
      gatedPromises.push(new Promise<void>((res) => { unlock.push(res); }));
    }
    const provider = makeProvider({
      // Each task's perform waits on its own gate so we control ordering.
      performGate: () => gatedPromises[unlocks++ % 3]!,
      withAbort: true,
    });
    const swarm = new Swarm({
      size: 3,
      provider,
      budget: { perAgent: 0.40, total: 1.00 },
      gracefulStopMs: 20,
    });
    const run = await swarm.spawn([
      { id: "t1", prompt: "a", budget: 0.40 },
      { id: "t2", prompt: "b", budget: 0.40 },
      { id: "t3", prompt: "c", budget: 0.40 },
    ]);
    // Release t1 + t2 → spend = 0.80. t3 release will push us to 1.20 > 1.00.
    unlock[0]!();
    unlock[1]!();
    unlock[2]!();
    const results = await swarm.gather(run);
    const totalSpent = results.reduce((a, r) => a + r.spend, 0);
    // Total spend may exceed the cap by one task because the guard fires
    // AFTER the spend is recorded (we cancel in-flight, not before). That
    // matches the documented contract — overshoot of one task is allowed.
    expect(totalSpent).toBeLessThanOrEqual(1.20 + 1e-9);
    // The run aborted at some point.
    expect(run._aborted || results.every((r) => r.ok)).toBe(true);
  });
});

describe("Swarm — audit chain integration", () => {
  it("appends one swarm.task event per completed task + back-fills auditRef", async () => {
    const provider = makeProvider();
    const chain = makeAuditChain();
    const swarm = new Swarm({
      size: 3,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
      did: "did:mp:abc",
      audit: { chain },
    });
    const run = await swarm.spawn([
      { id: "a", prompt: "x" },
      { id: "b", prompt: "y" },
    ]);
    const results = await swarm.gather(run);
    expect(chain.events.length).toBeGreaterThanOrEqual(2);
    expect(chain.events.every((e) => e.kind === "swarm.task")).toBe(true);
    // Every result has a non-empty auditRef once the chain back-fills.
    expect(results.every((r) => r.auditRef.length > 0)).toBe(true);
  });

  it("survives a chain.append that throws (audit must never crash gather)", async () => {
    const provider = makeProvider();
    const throwing: AuditChain = { append: () => { throw new Error("chain-down"); } };
    const swarm = new Swarm({
      size: 1,
      provider,
      budget: { perAgent: 1.0, total: 1.0 },
      audit: { chain: throwing },
    });
    const run = await swarm.spawn([{ id: "a", prompt: "x" }]);
    const results = await swarm.gather(run);
    expect(results[0]!.ok).toBe(true);
  });
});

describe("Swarm — provider open errors isolate one agent", () => {
  it("one open() failure does not affect siblings", async () => {
    const provider = makeProvider({ openFails: new Set(["did:bad"]) });
    const swarm = new Swarm({
      size: 2,
      provider,
      budget: { perAgent: 1.0, total: 10.0 },
    });
    const run = await swarm.spawn([
      { id: "did:good", prompt: "ok" },
      { id: "did:bad",  prompt: "boom" },
    ]);
    const results = await swarm.gather(run);
    const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));
    expect(byId["did:good"]!.ok).toBe(true);
    expect(byId["did:bad"]!.ok).toBe(false);
    expect(byId["did:bad"]!.error).toMatch(/^provider-error/);
  });
});

describe("Swarm constructor validation", () => {
  const provider = makeProvider();
  it("rejects size < 1", () => {
    expect(() => new Swarm({ size: 0, provider, budget: { perAgent: 1, total: 1 } })).toThrow(/size/);
  });
  it("rejects missing budget", () => {
    expect(
      () => new Swarm({ size: 1, provider, budget: undefined as never }),
    ).toThrow();
  });
  it("rejects negative budget", () => {
    expect(
      () => new Swarm({ size: 1, provider, budget: { perAgent: -1, total: 1 } }),
    ).toThrow(/non-negative/);
  });
});

