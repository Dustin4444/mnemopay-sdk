/**
 * @mnemopay/sdk/swarm/voice — optional Supertonic narration for swarm
 * task results.
 *
 * Supertonic is a local-only TTS binary. When `SUPERTONIC_BIN` is set in
 * env and the binary is executable, `annotateResult` shells out with the
 * task's text output and returns the narration text (typically a path
 * to a generated audio file, or the inline transcript Supertonic
 * produces when invoked with `--print-transcript`). Falls back to a
 * silent no-op if the binary isn't installed — never throws.
 *
 * Scaffold only — Supertonic is not bundled, not auto-installed, not
 * required. The swarm calls into this module lazily (`await import`)
 * so consumers who don't opt in pay zero startup cost.
 */

import type { TaskResult } from "./index.js";

export interface VoiceOptions {
  /** Override the env var lookup — caller-supplied path to the binary. */
  binPath?: string;
  /** Extra args passed to the binary. Default: ["--print-transcript"]. */
  args?: string[];
  /** Override the spawn function (test injection). */
  spawn?: SpawnFn;
}

/** Minimum spawn-fn shape — child_process.spawn is structurally compatible. */
export type SpawnFn = (
  cmd: string,
  args: readonly string[],
) => {
  stdin: { write(s: string): void; end(): void };
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
};

/**
 * Resolve the Supertonic binary path. Returns `null` when not configured
 * — callers MUST treat null as "voice annotation disabled, proceed".
 */
export function resolveSupertonicBin(opts: VoiceOptions = {}): string | null {
  if (opts.binPath && opts.binPath.length > 0) return opts.binPath;
  const env = typeof process !== "undefined" && process.env
    ? process.env["SUPERTONIC_BIN"]
    : undefined;
  return env && env.length > 0 ? env : null;
}

/** Pick the narration source text from a TaskResult. */
export function pickNarrationText(result: TaskResult): string | null {
  if (typeof result.output === "string" && result.output.length > 0) {
    return result.output;
  }
  if (result.output != null && typeof result.output === "object") {
    try {
      return JSON.stringify(result.output);
    } catch {
      return null;
    }
  }
  if (result.error) return `Task ${result.taskId} failed: ${result.error}`;
  return null;
}

/**
 * Run Supertonic on the task result text. Returns the captured stdout
 * as a string (Supertonic conventionally prints the path of the
 * generated wav + the transcript). Returns `null` when:
 *   - SUPERTONIC_BIN is not set,
 *   - the spawn errors / exits non-zero,
 *   - the task result has no narratable text.
 *
 * NEVER throws — voice is best-effort cosmetic on top of the swarm.
 */
export async function annotateResult(
  result: TaskResult,
  opts: VoiceOptions = {},
): Promise<string | null> {
  const bin = resolveSupertonicBin(opts);
  if (!bin) return null;

  const text = pickNarrationText(result);
  if (!text) return null;

  const spawn = opts.spawn ?? (await loadDefaultSpawn());
  if (!spawn) return null;

  const args = opts.args ?? ["--print-transcript"];
  return new Promise<string | null>((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = spawn(bin, args);
    } catch {
      resolve(null);
      return;
    }

    let stdout = "";
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    child.stdout.on("data", (chunk) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr.on("data", () => {
      // discard — non-zero exit handled in close
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code === 0) finish(stdout.trim() || null);
      else finish(null);
    });

    try {
      child.stdin.write(text);
      child.stdin.end();
    } catch {
      finish(null);
    }
  });
}

/**
 * Lazy-load node:child_process.spawn. Returns null when not running on
 * Node (Edge / Workers / browsers) — voice is Node-only by design.
 */
async function loadDefaultSpawn(): Promise<SpawnFn | null> {
  try {
    const mod = await import("node:child_process");
    return mod.spawn as unknown as SpawnFn;
  } catch {
    return null;
  }
}
