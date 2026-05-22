/**
 * @mnemopay/sdk/swarm/browser — BrowserSwarm v0.2.
 *
 * Extends the v0.1 Swarm with a native browser-session adapter. Where the
 * base `Swarm` treats the provider as opaque (one `perform({kind:"evaluate"})`
 * per task), `BrowserSwarm` runs a typed sequence of {goto, act, extract,
 * screenshot, wait} steps per task and surfaces structured per-task output
 * (final URL, screenshots, extracted data).
 *
 * Wiring contract:
 *   - The actual provider session is opened/closed via `@mnemopay/browser`,
 *     imported LAZILY via dynamic `import("@mnemopay/browser")` so the SDK
 *     never hard-deps on Playwright. Consumers who don't use BrowserSwarm
 *     pay zero bundle cost.
 *   - `@mnemopay/browser` is declared `peerDependenciesMeta.optional` in
 *     package.json — installing the SDK does not pull Playwright.
 *   - Each step appends an audit-chain event:
 *       { kind: "browser.step", taskId, stepType, ts, success, ...details }
 *   - Per-session billing follows the v0.1 mnemopay-browser pattern —
 *     `BillingMeter.emitStart()` on open + `BillingMeter.emitEnd()` on close.
 *     The meter is best-effort: failures never crash the task.
 *   - Per-session failure isolation: a thrown step does NOT propagate; the
 *     task is marked ok=false and sibling tasks keep running. This mirrors
 *     the `Promise.allSettled`-style isolation the base Swarm already gives.
 *
 * v1.11.0-alpha.0 — public API may shift before 1.11.0 final.
 */

import {
  Swarm,
  type SwarmConfig,
  type Task,
  type TaskResult,
  type SwarmRun,
  type BrowserProvider,
  type AuditChain,
} from "./index.js";

// ─── Step / Task / Result types ─────────────────────────────────────────────

export type BrowserTaskStep =
  | { type: "goto"; url: string }
  | { type: "act"; instruction: string }
  | { type: "extract"; selector?: string; instruction?: string }
  | { type: "screenshot"; fullPage?: boolean }
  | { type: "wait"; ms: number };

export interface BrowserTask extends Task {
  steps: BrowserTaskStep[];
}

export interface BrowserTaskResult extends TaskResult {
  finalUrl?: string;
  /** Base64-encoded PNGs collected from `screenshot` steps, in step order. */
  screenshots: string[];
  /** Outputs from `extract` steps, in step order. */
  extractedData: unknown[];
}

// ─── @mnemopay/browser surface (loose-coupled — peer-dep, lazy import) ──────

/**
 * Subset of the `@mnemopay/browser` surface that BrowserSwarm uses. We
 * deliberately do NOT `import { BrowserProvider } from "@mnemopay/browser"`
 * — the SDK has no compile-time knowledge of that package. Instead, this
 * shape is what the lazy `import()` is asserted against at runtime. Any
 * future drift in `@mnemopay/browser` shows up as a duck-typed runtime
 * error, not a TS compile failure that breaks the rest of the SDK build.
 */
export interface MnemopayBrowserSurface {
  open(options: {
    did: string;
    budget_usd: number;
    provider: "browserbase" | "stagehand" | "local" | "mock";
    start_url?: string;
    persona_id?: string;
  }): Promise<{ session_id: string; did: string; provider: string }>;
  perform(
    sessionId: string,
    action: {
      kind: "navigate" | "click" | "fill" | "submit" | "screenshot" | "evaluate";
      target?: string;
      value?: string;
      estimated_usd?: number;
    },
  ): Promise<{ ok: boolean; note?: string }>;
  /** Optional — only present when the underlying provider is StagehandProvider. */
  evaluate?(sessionId: string, expression: string): Promise<unknown>;
  /** Optional — only present when the underlying provider exposes screenshot bytes. */
  capture?(sessionId: string, fullPage?: boolean): Promise<string>;
  close(sessionId: string): Promise<void>;
}

/**
 * Optional billing-meter shape — mirrors `@mnemopay/browser`'s `BillingMeter`.
 * BrowserSwarm calls `emitStart` on session open + `emitEnd` on close. Errors
 * are swallowed inside the meter itself; nothing here ever throws.
 */
export interface BillingMeterLike {
  emitStart(input: { session_id: string; agent_did: string }): Promise<void>;
  emitEnd(input: { session_id: string }): Promise<void>;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export interface BrowserSwarmConfig extends SwarmConfig {
  browser: {
    /** Backing automation runtime — passed through to @mnemopay/browser. */
    provider: "stagehand" | "local-playwright" | "browserbase";
    /** Browserbase API key (when provider==="browserbase"). */
    apiKey?: string;
    /** Default: true. */
    headless?: boolean;
    /** Per-task hard cap — total ms across all steps in one task. */
    timeoutMs?: number;
    /**
     * Optional: pre-built BrowserProvider from @mnemopay/browser. When
     * provided, BrowserSwarm uses it directly instead of lazy-importing.
     * Test injection point + escape hatch for consumers who already wired
     * a session pool elsewhere.
     */
    surface?: MnemopayBrowserSurface;
    /**
     * Optional: BillingMeter instance from @mnemopay/browser. When set,
     * BrowserSwarm emits session.start/session.end per task. Errors are
     * swallowed by the meter — the meter must NEVER block a task.
     */
    billingMeter?: BillingMeterLike;
  };
}

// ─── Internal: provider adapter wrapping MnemopayBrowserSurface ─────────────

/**
 * Bridge the @mnemopay/browser surface onto the base Swarm's BrowserProvider
 * contract. The base class opens/closes sessions through this adapter; the
 * sequential step loop is driven by BrowserSwarm.runBrowserTask() directly.
 *
 * `perform()` on this adapter is a NO-OP — the base Swarm calls it once per
 * task with `kind: "evaluate"`, but the actual step sequence runs inside
 * `runBrowserTask()` before the base hands control back. We satisfy the
 * shape so the base Swarm's audit/budget accounting still works.
 */
class SurfaceAdapter implements BrowserProvider {
  readonly name = "mnemopay-browser";
  constructor(private readonly surface: MnemopayBrowserSurface, private readonly providerName: "browserbase" | "stagehand" | "local" | "mock") {}

  async open(options: {
    did: string;
    budget_usd: number;
    provider: string;
    start_url?: string;
    persona_id?: string;
  }): Promise<{ session_id: string; did: string; provider: string; opened_at: string; budget_usd: number }> {
    const info = await this.surface.open({
      did: options.did,
      budget_usd: options.budget_usd,
      provider: this.providerName,
      ...(options.start_url ? { start_url: options.start_url } : {}),
      ...(options.persona_id ? { persona_id: options.persona_id } : {}),
    });
    return {
      session_id: info.session_id,
      did: info.did,
      provider: info.provider,
      opened_at: new Date().toISOString(),
      budget_usd: options.budget_usd,
    };
  }

  async perform(): Promise<{ ok: boolean; note?: string }> {
    // BrowserSwarm drives the step sequence directly via the surface —
    // this method exists only to satisfy the base BrowserProvider shape.
    return { ok: true, note: "browser-swarm:step-sequence-driven-externally" };
  }

  async close(sessionId: string): Promise<void> {
    await this.surface.close(sessionId);
  }
}

// ─── BrowserSwarm ────────────────────────────────────────────────────────────

export class BrowserSwarm extends Swarm {
  private readonly browserCfg: BrowserSwarmConfig["browser"];
  private readonly auditChain: AuditChain | null;
  private surfacePromise: Promise<MnemopayBrowserSurface> | null = null;

  constructor(cfg: BrowserSwarmConfig) {
    if (!cfg || !cfg.browser || typeof cfg.browser !== "object") {
      throw new TypeError("BrowserSwarm: cfg.browser required");
    }
    if (
      cfg.browser.provider !== "stagehand" &&
      cfg.browser.provider !== "local-playwright" &&
      cfg.browser.provider !== "browserbase"
    ) {
      throw new TypeError(
        `BrowserSwarm: cfg.browser.provider must be one of stagehand|local-playwright|browserbase (got ${String(cfg.browser.provider)})`,
      );
    }

    // The base Swarm needs a provider. We inject a placeholder; the real
    // session work happens in `spawn` overrides below.
    const placeholder: BrowserProvider = {
      name: "browser-swarm-placeholder",
      async open() {
        throw new Error("BrowserSwarm: placeholder provider should not be invoked directly");
      },
      async perform() {
        return { ok: false, note: "placeholder" };
      },
      async close() {
        /* no-op */
      },
    };

    super({ ...cfg, provider: cfg.browser.surface ? new SurfaceAdapter(cfg.browser.surface, mapProviderName(cfg.browser.provider)) : placeholder });
    this.browserCfg = cfg.browser;
    this.auditChain = cfg.audit?.chain ?? null;
  }

  /**
   * Lazy-load `@mnemopay/browser`. Returns the cached promise on subsequent
   * calls. Throws a structured error pointing at the install command if the
   * peer dep isn't present.
   */
  private async loadSurface(): Promise<MnemopayBrowserSurface> {
    if (this.browserCfg.surface) return this.browserCfg.surface;
    if (this.surfacePromise) return this.surfacePromise;

    this.surfacePromise = (async () => {
      const moduleName = "@mnemopay/browser";
      let mod: unknown;
      try {
        mod = await import(moduleName);
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e);
        throw new Error(
          `BrowserSwarm: optional peer dependency '@mnemopay/browser' is not installed. ` +
          `Install it (\`npm install @mnemopay/browser\`) and re-run. Underlying: ${reason}`,
        );
      }
      const surface = pickSurfaceFromModule(mod, this.browserCfg);
      return surface;
    })();
    return this.surfacePromise;
  }

  /**
   * Spawn N parallel BrowserTasks. Per-task FiscalGate precheck still applies
   * (inherited from base Swarm). Each accepted task opens its own browser
   * session, runs the step sequence, then closes the session.
   */
  override async spawn(tasks: readonly Task[]): Promise<SwarmRun> {
    // Validate that every task carries a `steps` array — fail fast at
    // spawn-time rather than half-way through a session.
    for (const t of tasks) {
      const bt = t as BrowserTask;
      if (!Array.isArray(bt.steps)) {
        throw new TypeError(`BrowserSwarm.spawn: task ${t.id} missing steps[]`);
      }
    }

    // Lazy-load the surface up front so the first task doesn't pay the
    // import latency — but don't throw if it fails; per-task error paths
    // pick that up and mark only the affected task as failed.
    let surface: MnemopayBrowserSurface | null = null;
    try {
      surface = await this.loadSurface();
    } catch {
      surface = null;
    }

    // Reach into the base Swarm's pipeline. We re-implement the per-task
    // dispatch loop because the base Swarm's `runTask` is single-step.
    const accepted = tasks.slice(0, (this as unknown as { cfg: SwarmConfig }).cfg.size);
    const run: SwarmRun = {
      id: makeRunId(),
      tasks: accepted,
      _inflight: new Map(),
      _totalSpend: 0,
      _aborted: false,
      _results: [],
    };

    const perAgent = (this as unknown as { cfg: SwarmConfig }).cfg.budget.perAgent;
    const total = (this as unknown as { cfg: SwarmConfig }).cfg.budget.total;
    const did = (this as unknown as { cfg: SwarmConfig }).cfg.did;

    for (const task of accepted) {
      const bt = task as BrowserTask;
      const requested = task.budget ?? perAgent;

      // Per-agent FiscalGate precheck — identical contract to base Swarm.
      if (requested > perAgent && requested > 0) {
        const denied: BrowserTaskResult = {
          taskId: task.id,
          ok: false,
          spend: 0,
          auditRef: "",
          error: "budget-denied",
          screenshots: [],
          extractedData: [],
        };
        this.appendAudit({ kind: "browser.step", taskId: task.id, stepType: "precheck", ts: now(), success: false, error: "budget-denied" });
        run._results.push(denied);
        run._inflight.set(task.id, {
          task: bt,
          sessionId: null,
          cancelled: false,
          promise: Promise.resolve(denied),
        } as never);
        continue;
      }

      // Total-budget guard.
      if (run._totalSpend >= total) {
        const blocked: BrowserTaskResult = {
          taskId: task.id,
          ok: false,
          spend: 0,
          auditRef: "",
          error: "total-budget-exceeded",
          screenshots: [],
          extractedData: [],
        };
        run._results.push(blocked);
        run._inflight.set(task.id, {
          task: bt,
          sessionId: null,
          cancelled: false,
          promise: Promise.resolve(blocked),
        } as never);
        continue;
      }

      const inflight = {
        task: bt,
        sessionId: null as string | null,
        cancelled: false,
        promise: undefined as unknown as Promise<BrowserTaskResult>,
      };
      inflight.promise = this.runBrowserTask(run, bt, surface, did, perAgent, total, inflight);
      run._inflight.set(task.id, inflight as never);
    }

    return run;
  }

  /**
   * Internal: run one BrowserTask end-to-end. Opens session, executes step
   * sequence, closes session. Per-step audit-chain events. Per-session
   * billing-meter (best effort). All errors are caught and surfaced as
   * `ok=false` — never propagated to siblings.
   */
  private async runBrowserTask(
    run: SwarmRun,
    task: BrowserTask,
    surface: MnemopayBrowserSurface | null,
    did: string | undefined,
    perAgent: number,
    total: number,
    inflight: { sessionId: string | null; cancelled: boolean },
  ): Promise<BrowserTaskResult> {
    const screenshots: string[] = [];
    const extractedData: unknown[] = [];
    const budget = task.budget ?? perAgent;

    // Cooperative cancellation check.
    if (run._aborted || inflight.cancelled) {
      return this.finalize(run, task, { ok: false, spend: 0, error: "aborted" }, screenshots, extractedData);
    }
    // Total-budget guard before opening.
    if (run._totalSpend >= total) {
      return this.finalize(run, task, { ok: false, spend: 0, error: "total-budget-exceeded" }, screenshots, extractedData);
    }
    if (!surface) {
      // Try one more time inside the task — surfaces the error per-task
      // instead of nuking the whole spawn.
      try {
        surface = await this.loadSurface();
      } catch (e) {
        const error = e instanceof Error ? `provider-error: ${e.message}` : "provider-error";
        return this.finalize(run, task, { ok: false, spend: 0, error }, screenshots, extractedData);
      }
    }

    // Open session.
    let sessionId: string;
    try {
      const startUrl = firstGotoUrl(task.steps);
      const info = await surface.open({
        did: did ?? task.id,
        budget_usd: budget,
        provider: mapProviderName(this.browserCfg.provider),
        ...(startUrl ? { start_url: startUrl } : {}),
      });
      sessionId = info.session_id;
      inflight.sessionId = sessionId;
    } catch (e) {
      const error = e instanceof Error ? `provider-error: ${e.message}` : "provider-error";
      return this.finalize(run, task, { ok: false, spend: 0, error }, screenshots, extractedData);
    }

    // Best-effort billing meter — emit session.start.
    if (this.browserCfg.billingMeter) {
      try {
        await this.browserCfg.billingMeter.emitStart({
          session_id: sessionId,
          agent_did: did ?? task.id,
        });
      } catch { /* meter must never block */ }
    }

    // Per-task timeout — soft cap that races every step against the wall.
    const deadline =
      this.browserCfg.timeoutMs && this.browserCfg.timeoutMs > 0
        ? Date.now() + this.browserCfg.timeoutMs
        : Number.POSITIVE_INFINITY;

    let finalUrl: string | undefined;
    let sessionOk = true;
    let firstError: string | undefined;

    // Step loop. One failure stops THIS task but does NOT propagate. The
    // task's own ok=false flag tells the caller; siblings keep running.
    for (let i = 0; i < task.steps.length; i++) {
      const step = task.steps[i]!;
      if (inflight.cancelled || run._aborted) {
        sessionOk = false;
        firstError = firstError ?? "aborted";
        break;
      }
      if (Date.now() > deadline) {
        sessionOk = false;
        firstError = firstError ?? "task-timeout";
        this.appendAudit({ kind: "browser.step", taskId: task.id, stepType: step.type, ts: now(), success: false, error: "task-timeout" });
        break;
      }

      try {
        const stepResult = await this.executeStep(surface, sessionId, step);
        if (step.type === "goto") finalUrl = step.url;
        if (step.type === "screenshot" && typeof stepResult === "string") {
          screenshots.push(stepResult);
        }
        if (step.type === "extract") {
          extractedData.push(stepResult);
        }
        this.appendAudit({
          kind: "browser.step",
          taskId: task.id,
          stepType: step.type,
          ts: now(),
          success: true,
          ...stepDetails(step),
        });
      } catch (e) {
        sessionOk = false;
        const note = e instanceof Error ? e.message : String(e);
        firstError = firstError ?? `provider-error: ${note}`;
        this.appendAudit({
          kind: "browser.step",
          taskId: task.id,
          stepType: step.type,
          ts: now(),
          success: false,
          error: note,
          ...stepDetails(step),
        });
        // One bad step kills this task — but the session still gets
        // cleanly closed below.
        break;
      }
    }

    // Best-effort billing meter — emit session.end.
    if (this.browserCfg.billingMeter) {
      try {
        await this.browserCfg.billingMeter.emitEnd({ session_id: sessionId });
      } catch { /* meter must never block */ }
    }

    // Always close the session, even on error.
    try {
      await surface.close(sessionId);
    } catch { /* close errors are non-fatal */ }

    const spend = sessionOk ? budget : 0;
    run._totalSpend += spend;

    // Trip the total-budget envelope if we just crossed.
    if (run._totalSpend > total && !run._aborted) {
      this.stop(run, "total-budget-exceeded").catch(() => undefined);
    }

    return this.finalize(
      run,
      task,
      {
        ok: sessionOk && !inflight.cancelled && !run._aborted,
        spend,
        ...(firstError ? { error: firstError } : {}),
      },
      screenshots,
      extractedData,
      finalUrl,
    );
  }

  /**
   * Run one BrowserTaskStep against the @mnemopay/browser surface. Returns
   * the value the step yields (string for screenshots, unknown for extracts,
   * undefined otherwise). Throws on provider error — caller catches.
   */
  private async executeStep(
    surface: MnemopayBrowserSurface,
    sessionId: string,
    step: BrowserTaskStep,
  ): Promise<unknown> {
    switch (step.type) {
      case "goto": {
        const r = await surface.perform(sessionId, { kind: "navigate", target: step.url });
        if (!r.ok) throw new Error(r.note ?? "goto failed");
        return undefined;
      }
      case "act": {
        // Stagehand-style natural-language act. We route through `evaluate`
        // because the v0.1 BrowserAction set has no dedicated `act` kind —
        // the underlying StagehandProvider can recognise the prompt-shaped
        // value and dispatch to page.act(). LocalPlaywrightProvider will
        // fall through to its own evaluate semantics.
        const r = await surface.perform(sessionId, {
          kind: "evaluate",
          target: "act",
          value: step.instruction,
        });
        if (!r.ok) throw new Error(r.note ?? "act failed");
        return undefined;
      }
      case "extract": {
        // Two paths: CSS selector → evaluate document.querySelector text;
        // natural-language → route through evaluate with a marker so the
        // provider can dispatch to Stagehand.extract().
        if (typeof surface.evaluate === "function") {
          const expr =
            step.selector
              ? `document.querySelector(${JSON.stringify(step.selector)})?.textContent ?? null`
              : `__stagehand_extract(${JSON.stringify(step.instruction ?? "")})`;
          const out = await surface.evaluate(sessionId, expr);
          return out;
        }
        const r = await surface.perform(sessionId, {
          kind: "evaluate",
          target: step.selector ?? "extract",
          value: step.instruction ?? step.selector ?? "",
        });
        if (!r.ok) throw new Error(r.note ?? "extract failed");
        return r.note;
      }
      case "screenshot": {
        if (typeof surface.capture === "function") {
          const png = await surface.capture(sessionId, step.fullPage ?? false);
          return png;
        }
        const r = await surface.perform(sessionId, { kind: "screenshot" });
        if (!r.ok) throw new Error(r.note ?? "screenshot failed");
        // Underlying provider does not expose bytes — record an empty
        // placeholder string so the caller still gets one entry per
        // screenshot step.
        return "";
      }
      case "wait": {
        await new Promise((res) => setTimeout(res, Math.max(0, step.ms)));
        return undefined;
      }
      default: {
        const _exhaustive: never = step;
        void _exhaustive;
        throw new Error(`unsupported step type`);
      }
    }
  }

  private finalize(
    run: SwarmRun,
    task: BrowserTask,
    partial: { ok: boolean; spend: number; error?: string },
    screenshots: string[],
    extractedData: unknown[],
    finalUrl?: string,
  ): BrowserTaskResult {
    const result: BrowserTaskResult = {
      taskId: task.id,
      ok: partial.ok,
      spend: partial.spend,
      auditRef: "",
      screenshots,
      extractedData,
      ...(finalUrl !== undefined ? { finalUrl } : {}),
      ...(partial.error ? { error: partial.error } : {}),
    };
    run._results.push(result);
    // Append the swarm.task event (mirrors base Swarm.recordResult).
    if (this.auditChain) {
      try {
        const ev = this.auditChain.append({
          kind: "swarm.task",
          runId: run.id,
          taskId: result.taskId,
          spend: result.spend,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        }) as { id?: string } | undefined;
        if (ev && typeof ev === "object" && "id" in ev && typeof ev.id === "string") {
          result.auditRef = ev.id;
        }
      } catch { /* audit failures never bubble */ }
    }
    return result;
  }

  private appendAudit(event: Record<string, unknown>): void {
    if (!this.auditChain) return;
    try {
      this.auditChain.append(event);
    } catch { /* never bubble */ }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function mapProviderName(p: BrowserSwarmConfig["browser"]["provider"]): "browserbase" | "stagehand" | "local" | "mock" {
  if (p === "local-playwright") return "local";
  return p;
}

function firstGotoUrl(steps: readonly BrowserTaskStep[]): string | undefined {
  for (const s of steps) {
    if (s.type === "goto") return s.url;
  }
  return undefined;
}

function stepDetails(step: BrowserTaskStep): Record<string, unknown> {
  switch (step.type) {
    case "goto": return { url: step.url };
    case "act": return { instruction: step.instruction };
    case "extract": return {
      ...(step.selector ? { selector: step.selector } : {}),
      ...(step.instruction ? { instruction: step.instruction } : {}),
    };
    case "screenshot": return { fullPage: step.fullPage ?? false };
    case "wait": return { ms: step.ms };
  }
}

function now(): string {
  return new Date().toISOString();
}

function makeRunId(): string {
  const hex = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < 32; i++) {
    if (i === 8 || i === 12 || i === 16 || i === 20) out += "-";
    if (i === 12) out += "4";
    else if (i === 16) out += hex[(8 + Math.floor(Math.random() * 4)) | 0]!;
    else out += hex[Math.floor(Math.random() * 16)]!;
  }
  return out;
}

/**
 * Extract the MnemopayBrowserSurface from the lazy-imported @mnemopay/browser
 * module. The module exposes a class-based API (`Browser`, `open`, etc.) —
 * we adapt to the surface shape BrowserSwarm needs.
 */
function pickSurfaceFromModule(
  mod: unknown,
  cfg: BrowserSwarmConfig["browser"],
): MnemopayBrowserSurface {
  if (mod == null || typeof mod !== "object") {
    throw new Error("@mnemopay/browser: module shape unrecognized");
  }
  const m = mod as Record<string, unknown>;

  // Preferred path: the consumer pre-wired a `surface` and exported it.
  if (typeof m.surface === "object" && m.surface !== null) {
    return m.surface as MnemopayBrowserSurface;
  }

  // Pull the concrete provider class based on cfg.provider.
  const ProviderCtor =
    cfg.provider === "stagehand"
      ? (m.StagehandProvider as (new (opts: unknown) => MnemopayBrowserSurface) | undefined)
      : cfg.provider === "local-playwright"
        ? (m.LocalPlaywrightProvider as (new (opts: unknown) => MnemopayBrowserSurface) | undefined)
        : (m.BrowserbaseProvider as (new (opts: unknown) => MnemopayBrowserSurface) | undefined);

  if (!ProviderCtor) {
    throw new Error(
      `@mnemopay/browser: provider class for '${cfg.provider}' not exported — got keys [${Object.keys(m).slice(0, 8).join(",")}]`,
    );
  }
  const inst = new ProviderCtor({
    ...(cfg.apiKey ? { api_key: cfg.apiKey } : {}),
    ...(cfg.headless !== undefined ? { headless: cfg.headless } : {}),
  });
  return inst;
}
