/**
 * @mnemopay/sdk — swarm primitive.
 *
 * The swarm is what browse.sh / browserbase shipped as a "skill catalog +
 * fleet of headless browsers". Their differentiator is the catalog. Ours
 * is what sits underneath: every agent in the swarm carries a DID, every
 * action is FiscalGate-gated, every result is appended to a shared
 * Article-12 audit chain. Trust + audit + per-skill billing — not just
 * "N browsers in parallel".
 *
 * Surface (alpha — build with us):
 *
 *   import { Swarm } from "@mnemopay/sdk/swarm";
 *   import { open } from "@mnemopay/browser";   // any provider
 *   import { AuditChain } from "@mnemopay/sdk/governance";
 *
 *   const swarm = new Swarm({
 *     size: 4,
 *     provider: myBrowserProvider,
 *     budget: { perAgent: 1.00, total: 3.50 },
 *     did: "did:mp:abc...",
 *     audit: { chain: new AuditChain() },
 *   });
 *
 *   const run = await swarm.spawn([
 *     { id: "t1", skillId: "ramp.com/expense-create", prompt: "...", budget: 0.25 },
 *     { id: "t2", skillId: "linear/issue-create",      prompt: "...", budget: 0.10 },
 *     // ...
 *   ]);
 *
 *   const results = await swarm.gather(run);
 *   const merged  = await swarm.recombine(results, "merge-json");
 *
 * Implementation contract:
 *   - `spawn` is non-blocking after the per-task precheck round-trip.
 *     Tasks above `budget.perAgent` are stamped `budget-denied` before
 *     any provider session opens. The session for that task is NEVER
 *     started — saves money and audit noise.
 *   - `gather` awaits every in-flight task. Tasks killed mid-flight by
 *     `stop()` or the total-budget guard surface as `ok=false` with
 *     `error="aborted"`. Each completed TaskResult is appended to the
 *     shared audit chain via `chain.append({ kind: "swarm.task", ... })`.
 *   - `recombine` is pure — strategy functions are deterministic. The
 *     four built-ins (`first-success`, `majority-vote`, `merge-json`,
 *     `concat`) never look at task ordering beyond what the strategy
 *     defines, so a swarm + recombine pair always produces the same
 *     final output for the same gathered results.
 *   - `stop` is two-phase — first fires `provider.abort(sessionId)` if
 *     the provider exposes it, then waits up to 5s (configurable), then
 *     calls `provider.close()` as the hard force.
 *
 * v1.10.0-alpha.0 — public API may shift before 1.10.0 final.
 */

/**
 * Structural shape of a browser provider — identical to the one shipped
 * by `@mnemopay/browser` v0.1.0-alpha.0. We define it here instead of
 * importing because the dependency runs the other way: the browser
 * package depends on the SDK, not the reverse. Any consumer that
 * passes a Browserbase/Stagehand/Playwright/mock provider from
 * `@mnemopay/browser` satisfies this shape by construction.
 */
export interface BrowserProvider {
  readonly name: string;
  open(options: {
    did: string;
    budget_usd: number;
    provider: string;
    start_url?: string;
    persona_id?: string;
  }): Promise<{
    session_id: string;
    did: string;
    provider: string;
    opened_at: string;
    budget_usd: number;
  }>;
  perform(
    sessionId: string,
    action: {
      kind: "navigate" | "click" | "fill" | "submit" | "screenshot" | "evaluate";
      target?: string;
      value?: string;
      estimated_usd?: number;
    },
  ): Promise<{ ok: boolean; note?: string }>;
  close(sessionId: string): Promise<void>;
  /** Optional graceful-cancel hook — `stop()` uses it when present. */
  abort?(sessionId: string): Promise<void>;
}

/** Minimal AuditChain shape — accept anything with an `append(event)` method. */
export interface AuditChain {
  append(event: Record<string, unknown>): unknown;
}

export interface SwarmConfig {
  /** Number of parallel agents — also the max tasks accepted per `spawn`. */
  size: number;
  /** Backing browser provider — one provider, N sessions. */
  provider: BrowserProvider;
  /**
   * USD caps. `perAgent` is enforced via FiscalGate.precheck before each
   * session opens; `total` is enforced across the whole run — exceeding
   * mid-run cancels every in-flight task.
   */
  budget: { perAgent: number; total: number };
  /** Optional shared agent DID for the run. */
  did?: string;
  /** Optional shared audit chain — every TaskResult is appended. */
  audit?: { chain: AuditChain };
  /**
   * How long `stop()` waits for graceful provider.abort() before
   * forcing provider.close(). Default 5_000 ms.
   */
  gracefulStopMs?: number;
}

export interface Task {
  /** Caller-stable id — used as `audit_id` cross-reference + dedupe. */
  id: string;
  /** Optional reference to a published skill (`@catalog/path`). */
  skillId?: string;
  /** Free-form prompt — passed to the underlying provider. */
  prompt: string;
  /** Optional starting URL. */
  url?: string;
  /** Per-task budget cap (USD). Falls back to `config.budget.perAgent`. */
  budget?: number;
  /**
   * Optional: ask the swarm to invoke Supertonic on the result text.
   * Falls back to no-op if `SUPERTONIC_BIN` is not set. See `./voice.ts`.
   */
  voiceAnnotate?: boolean;
}

export interface TaskResult {
  taskId: string;
  ok: boolean;
  output?: unknown;
  /** Actual USD spent on the task (may be 0 for budget-denied). */
  spend: number;
  /** Cross-reference into the audit chain (`""` when no chain attached). */
  auditRef: string;
  /** When `ok=false`, why. */
  error?: "budget-denied" | "aborted" | "total-budget-exceeded" | "provider-error" | string;
  /** Optional Supertonic narration text (see `./voice.ts`). */
  voice?: string;
}

export type RecombineStrategy =
  | "first-success"
  | "majority-vote"
  | "merge-json"
  | "concat"
  | ((rs: readonly TaskResult[]) => unknown);

/**
 * SwarmRun — opaque handle returned from `spawn`. Lives until `gather` or
 * `stop` returns. The caller never inspects the fields directly; they're
 * passed by reference back into `gather` / `stop`.
 */
export interface SwarmRun {
  /** UUID — caller can log it / cross-reference with audit chain. */
  id: string;
  /** Snapshot of tasks the swarm accepted (post-size-cap). */
  tasks: readonly Task[];
  /** Internal — per-task in-flight Promise + abort hook. */
  readonly _inflight: Map<string, InflightTask>;
  /** Internal — running tally for total-budget enforcement. */
  _totalSpend: number;
  /** Internal — set when stop() has been invoked, so gather knows. */
  _aborted: boolean;
  /** Internal — collected results, populated as tasks complete. */
  readonly _results: TaskResult[];
}

interface InflightTask {
  task: Task;
  /** Provider session id once opened, null while still in precheck. */
  sessionId: string | null;
  /** Resolves to the TaskResult — used by `gather`. */
  promise: Promise<TaskResult>;
  /** Flips true when stop() targets this task. */
  cancelled: boolean;
}

// ─── FiscalGate precheck (loose-coupled — same shape as mnemopay-browser) ──
interface PrecheckResult {
  allowed: boolean;
  reason?: "budget" | "policy";
}

/**
 * Mirrors `precheckSpend` from `@mnemopay/browser` middleware,
 * deliberately inlined so this module has no runtime dep on the browser
 * package — the SDK is the contract, the browser is one implementation.
 */
export const FiscalGate = {
  precheck(budgetUsd: number, requestedUsd: number): PrecheckResult {
    if (requestedUsd <= 0) return { allowed: true };
    if (requestedUsd > budgetUsd) return { allowed: false, reason: "budget" };
    return { allowed: true };
  },
};

export class Swarm {
  private readonly cfg: SwarmConfig;
  private readonly gracefulStopMs: number;

  constructor(cfg: SwarmConfig) {
    if (!cfg || typeof cfg !== "object") {
      throw new TypeError("Swarm: cfg required");
    }
    if (!Number.isFinite(cfg.size) || cfg.size < 1) {
      throw new RangeError("Swarm: size must be >= 1");
    }
    if (!cfg.budget || !Number.isFinite(cfg.budget.perAgent) || !Number.isFinite(cfg.budget.total)) {
      throw new TypeError("Swarm: budget.perAgent + budget.total required (USD)");
    }
    if (cfg.budget.perAgent < 0 || cfg.budget.total < 0) {
      throw new RangeError("Swarm: budgets must be non-negative");
    }
    this.cfg = cfg;
    this.gracefulStopMs = cfg.gracefulStopMs ?? 5_000;
  }

  /**
   * Spawn N parallel agents — N = min(tasks.length, cfg.size). Each is
   * pre-checked against per-agent budget BEFORE any session is opened.
   * Tasks that exceed per-agent budget are immediately stamped
   * `budget-denied`. The remaining tasks open provider sessions in
   * parallel via `Promise.allSettled` — one failed open does not abort
   * its siblings.
   */
  async spawn(tasks: readonly Task[]): Promise<SwarmRun> {
    if (!Array.isArray(tasks)) {
      throw new TypeError("Swarm.spawn: tasks must be an array");
    }
    const accepted = tasks.slice(0, this.cfg.size);
    const run: SwarmRun = {
      id: randomId(),
      tasks: accepted,
      _inflight: new Map(),
      _totalSpend: 0,
      _aborted: false,
      _results: [],
    };

    // Phase 1: synchronous precheck + dispatch decisions.
    const provider = this.cfg.provider;

    for (const task of accepted) {
      const requested = task.budget ?? this.cfg.budget.perAgent;
      const decision = FiscalGate.precheck(this.cfg.budget.perAgent, requested);
      if (!decision.allowed) {
        // Synthesize a budget-denied result inline — no session opens.
        const denied: TaskResult = {
          taskId: task.id,
          ok: false,
          spend: 0,
          auditRef: "",
          error: "budget-denied",
        };
        this.recordResult(run, denied);
        // Surface the denial via a settled promise so `gather` sees it.
        const inflight: InflightTask = {
          task,
          sessionId: null,
          cancelled: false,
          promise: Promise.resolve(denied),
        };
        run._inflight.set(task.id, inflight);
        continue;
      }

      // Phase 2: dispatch the open + perform pipeline in parallel.
      const inflight: InflightTask = {
        task,
        sessionId: null,
        cancelled: false,
        promise: undefined as unknown as Promise<TaskResult>,
      };
      inflight.promise = this.runTask(run, provider, task, inflight);
      run._inflight.set(task.id, inflight);
    }

    return run;
  }

  /**
   * Await every in-flight task. Returns the gathered TaskResult[] in
   * the same order the tasks were spawned. Safe to call multiple times
   * — subsequent calls return the cached results.
   */
  async gather(run: SwarmRun): Promise<TaskResult[]> {
    const settled = await Promise.allSettled(
      Array.from(run._inflight.values(), (i) => i.promise),
    );
    const results: TaskResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const taskId = run.tasks[i]!.id;
      const s = settled[i]!;
      if (s.status === "fulfilled") {
        results.push(s.value);
      } else {
        // Should be rare — runTask catches everything. But be safe.
        results.push({
          taskId,
          ok: false,
          spend: 0,
          auditRef: "",
          error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
    return results;
  }

  /**
   * Recombine — pure function over the gathered results. Strategy
   * functions are deterministic; the four built-ins never depend on
   * runtime ordering except where the strategy explicitly does.
   */
  async recombine(
    results: readonly TaskResult[],
    strategy: RecombineStrategy,
  ): Promise<unknown> {
    if (typeof strategy === "function") return strategy(results);

    switch (strategy) {
      case "first-success": {
        const hit = results.find((r) => r.ok);
        return hit?.output ?? null;
      }
      case "concat": {
        const out: string[] = [];
        for (const r of results) {
          if (!r.ok) continue;
          if (typeof r.output === "string") out.push(r.output);
          else if (r.output != null) out.push(JSON.stringify(r.output));
        }
        return out.join("\n");
      }
      case "merge-json": {
        const merged: Record<string, unknown> = {};
        for (const r of results) {
          if (!r.ok || r.output == null) continue;
          if (typeof r.output === "object" && !Array.isArray(r.output)) {
            // Stable iteration: sort keys before merging so the output
            // is byte-identical across runs with the same input set.
            const obj = r.output as Record<string, unknown>;
            for (const key of Object.keys(obj).sort()) {
              merged[key] = obj[key];
            }
          }
        }
        return merged;
      }
      case "majority-vote": {
        const counts = new Map<string, { count: number; output: unknown }>();
        for (const r of results) {
          if (!r.ok) continue;
          const key = stableKey(r.output);
          const prev = counts.get(key);
          if (prev) prev.count += 1;
          else counts.set(key, { count: 1, output: r.output });
        }
        let winner: { count: number; output: unknown } | null = null;
        // Sort keys to make ties deterministic.
        for (const k of Array.from(counts.keys()).sort()) {
          const cur = counts.get(k)!;
          if (!winner || cur.count > winner.count) winner = cur;
        }
        return winner?.output ?? null;
      }
      default: {
        const _exhaustive: never = strategy;
        void _exhaustive;
        throw new Error(`Swarm.recombine: unknown strategy ${String(strategy)}`);
      }
    }
  }

  /**
   * Stop a run. Two-phase:
   *   1. Mark every in-flight task cancelled. Fire provider.abort() if
   *      the provider exposes it.
   *   2. Wait up to `gracefulStopMs`. Force-close any session still
   *      open after the timeout.
   */
  async stop(run: SwarmRun, reason: string): Promise<void> {
    if (run._aborted) return;
    run._aborted = true;
    const provider = this.cfg.provider;

    const aborts: Promise<unknown>[] = [];
    for (const inflight of run._inflight.values()) {
      inflight.cancelled = true;
      if (!inflight.sessionId) continue;
      if (typeof provider.abort === "function") {
        aborts.push(
          provider.abort(inflight.sessionId).catch(() => undefined),
        );
      }
    }
    // Race the in-flight set against the graceful timeout.
    await Promise.race([
      Promise.allSettled(aborts),
      new Promise((res) => setTimeout(res, this.gracefulStopMs)),
    ]);

    // Force-close anything still alive.
    const closes: Promise<unknown>[] = [];
    for (const inflight of run._inflight.values()) {
      if (!inflight.sessionId) continue;
      closes.push(
        provider.close(inflight.sessionId).catch(() => undefined),
      );
    }
    await Promise.allSettled(closes);

    if (this.cfg.audit) {
      try {
        this.cfg.audit.chain.append({
          kind: "swarm.stop",
          runId: run.id,
          reason,
          aborted_tasks: run._inflight.size,
        });
      } catch { /* audit chain failures must never crash stop() */ }
    }
  }

  // ─── internals ────────────────────────────────────────────────────────

  private async runTask(
    run: SwarmRun,
    provider: BrowserProvider,
    task: Task,
    inflight: InflightTask,
  ): Promise<TaskResult> {
    if (run._aborted || inflight.cancelled) {
      const r: TaskResult = {
        taskId: task.id,
        ok: false,
        spend: 0,
        auditRef: "",
        error: "aborted",
      };
      this.recordResult(run, r);
      return r;
    }

    // Total-budget guard before the session opens — cheap pre-check.
    if (run._totalSpend >= this.cfg.budget.total) {
      const r: TaskResult = {
        taskId: task.id,
        ok: false,
        spend: 0,
        auditRef: "",
        error: "total-budget-exceeded",
      };
      this.recordResult(run, r);
      return r;
    }

    // Open the session. Errors are surfaced as `provider-error` — the
    // sibling tasks are unaffected (Promise.allSettled-style isolation).
    let sessionId: string;
    try {
      const info = await provider.open({
        did: this.cfg.did ?? task.id,
        budget_usd: task.budget ?? this.cfg.budget.perAgent,
        provider: provider.name,
        ...(task.url ? { start_url: task.url } : {}),
      });
      sessionId = info.session_id;
      inflight.sessionId = sessionId;
    } catch (err) {
      const r: TaskResult = {
        taskId: task.id,
        ok: false,
        spend: 0,
        auditRef: "",
        error:
          err instanceof Error ? `provider-error: ${err.message}` : "provider-error",
      };
      this.recordResult(run, r);
      return r;
    }

    // Cooperative cancellation — if stop() flipped us before we got
    // here, bail without performing.
    if (inflight.cancelled || run._aborted) {
      await provider.close(sessionId).catch(() => undefined);
      const r: TaskResult = {
        taskId: task.id,
        ok: false,
        spend: 0,
        auditRef: "",
        error: "aborted",
      };
      this.recordResult(run, r);
      return r;
    }

    // The actual action is provider-shape: kind=evaluate with the prompt
    // as the value so the provider can route it through whatever skill
    // executor is wired (Stagehand, Playwright, mock). The audit chain
    // records the prompt content + outcome.
    let providerResult: { ok: boolean; note?: string };
    let output: unknown;
    try {
      providerResult = await provider.perform(sessionId, {
        kind: "evaluate",
        target: task.skillId ?? task.id,
        value: task.prompt,
      });
      output = providerResult.note;
    } catch (err) {
      providerResult = {
        ok: false,
        note: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await provider.close(sessionId).catch(() => undefined);
    }

    const spend = providerResult.ok ? (task.budget ?? this.cfg.budget.perAgent) : 0;
    run._totalSpend += spend;

    // If we just crossed the total-budget line, trigger a swarm-level
    // stop. This is fire-and-forget — outer caller's `gather` will pick
    // up the cancelled tasks as `aborted`.
    if (run._totalSpend > this.cfg.budget.total && !run._aborted) {
      this.stop(run, "total-budget-exceeded").catch(() => undefined);
    }

    const result: TaskResult = {
      taskId: task.id,
      ok: providerResult.ok && !inflight.cancelled && !run._aborted,
      spend,
      auditRef: "",
      ...(output !== undefined ? { output } : {}),
      ...(!providerResult.ok && providerResult.note
        ? { error: `provider-error: ${providerResult.note}` }
        : {}),
      ...(inflight.cancelled || run._aborted ? { error: "aborted" } : {}),
    };
    this.recordResult(run, result);

    // Optional Supertonic voice annotation — lazy-loaded so the swarm
    // module has no eager dep on the binary.
    if (task.voiceAnnotate) {
      try {
        const { annotateResult } = await import("./voice.js");
        const voice = await annotateResult(result);
        if (voice) result.voice = voice;
      } catch { /* voice is best-effort — never blocks the swarm */ }
    }

    return result;
  }

  private recordResult(run: SwarmRun, result: TaskResult): void {
    run._results.push(result);
    if (!this.cfg.audit) return;
    try {
      const ev = this.cfg.audit.chain.append({
        kind: "swarm.task",
        runId: run.id,
        taskId: result.taskId,
        spend: result.spend,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      }) as { id?: string } | undefined;
      // If the chain returns a ChainEvent-shaped object with an id,
      // back-fill the auditRef so callers can correlate.
      if (ev && typeof ev === "object" && "id" in ev && typeof ev.id === "string") {
        result.auditRef = ev.id;
      }
    } catch {
      // Audit chain failures must never bubble into task results.
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function randomId(): string {
  // Inline mini-UUIDv4. We avoid pulling node:crypto here because the
  // swarm module is browser-safe in principle (no Node-only APIs in the
  // hot path — `runTask` only ever touches the injected provider).
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

function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableKey).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableKey(obj[k])).join(",") + "}";
}
