/**
 * @mnemopay/sdk — governed skills ("MnemoSkills").
 *
 * A skill is not a prompt. It is a versioned, permissioned, billable agent
 * capability: it declares what it is allowed to touch, how much it may spend,
 * and which actions need a human. The runner is the spine that ties the
 * governance primitives together — every action a skill takes flows through
 * the policy engine (policy.ts), routes approvals (approval.ts), is classified
 * for risk (risk.ts), and is recorded on the action ledger (action-ledger.ts).
 *
 * The contract is: a skill never performs a side-effect directly. It asks the
 * context to `act()`, gets a grant, and only then does the work. That single
 * choke point is what makes the autonomy provable.
 *
 * Pure module — composes existing governance primitives, no new I/O.
 */

import {
  compilePolicy,
  evaluateAction,
  type CompiledPolicy,
  type Policy,
  type PolicyAction,
} from "../governance/policy.js";
import {
  InMemoryApprovalStore,
  routeVerdict,
  type ApprovalStore,
} from "../governance/approval.js";
import { buildRiskPolicy, classifyRisk } from "../governance/risk.js";
import { ActionLedger } from "../governance/action-ledger.js";

export interface SkillPermissions {
  /** Whitelist of tool/endpoint targets. Empty/undefined = any target allowed. */
  allowed_tools?: readonly string[];
  /** Targets that are always denied, even if otherwise allowed. */
  disallowed?: readonly string[];
  /** Hard ceiling on a single action's USD cost. */
  spend_limit_usd?: number;
  /** Actions above this USD cost require human approval. */
  approval_above_usd?: number;
  /** Restrict actions to these ISO-2 locales. */
  allowed_locales?: readonly string[];
}

export interface SkillTestCase {
  name: string;
  input: unknown;
  /** Optional predicate run against the skill output. */
  expect?: (output: unknown) => boolean;
}

/** The governed action request a skill hands to the context. */
export type SkillActRequest = Omit<PolicyAction, "at">;

export type ActGrant =
  | { allowed: true; action_id: string }
  | {
      allowed: false;
      blocker: "blocked" | "pending";
      reason?: string;
      approval_id?: string;
    };

export interface SkillContext<I> {
  input: I;
  /** Stable id of the ledger action wrapping this skill run. */
  action_id: string;
  /** The action ledger — for reading the in-flight record. */
  ledger: ActionLedger;
  /**
   * The governed choke point. Ask before every side-effect. Records the tool
   * onto the ledger, evaluates policy, routes approvals. Only proceed with the
   * real side-effect when `allowed` is true.
   */
  act(req: SkillActRequest): ActGrant;
  /** Note a memory id that informed this run (recorded on the ledger). */
  noteMemory(id: string): void;
}

export interface MnemoSkill<I = unknown, O = unknown> {
  id: string;
  name: string;
  purpose: string;
  version: string;
  owner: string;
  permissions: SkillPermissions;
  /** Optional 0-1 trust score — used by callers to gate which skills run autonomously. */
  trust_score?: number;
  /** Optional input validator — throw or return false to reject. */
  validateInput?: (input: unknown) => input is I;
  /** Optional declared test cases (documentation + CI harness). */
  tests?: readonly SkillTestCase[];
  /** The skill body. Must route every side-effect through `ctx.act`. */
  run(ctx: SkillContext<I>): Promise<O> | O;
}

export interface RunSkillOptions {
  agent_id?: string;
  /** Share an approval store across runs (defaults to a fresh in-memory store). */
  approvalStore?: ApprovalStore;
  /** Share an action ledger across runs (defaults to a fresh ledger). */
  ledger?: ActionLedger;
  /** Extra policy rules layered on top of the skill's permission-derived policy. */
  extraPolicy?: Policy;
}

export interface SkillRunResult<O> {
  ok: boolean;
  output?: O;
  error?: string;
  action_id: string;
  /** Approval id if the run halted waiting on a human. */
  pending_approval_id?: string;
  ledger: ActionLedger;
}

/** Derive a compiled policy from a skill's declared permissions. */
export function policyForSkill(skill: MnemoSkill, extra?: Policy): CompiledPolicy {
  const base = buildRiskPolicy({
    id: `skill:${skill.id}`,
    approvalThresholdUsd: skill.permissions.approval_above_usd,
    hardCapUsd: skill.permissions.spend_limit_usd,
    blockTargets: skill.permissions.disallowed,
  });

  const rules = [...base.rules];
  if (skill.permissions.allowed_locales?.length) {
    rules.push({
      id: "skill:locale-allowlist",
      allow_only_locales: skill.permissions.allowed_locales,
    });
  }
  if (extra) rules.push(...extra.rules);

  return compilePolicy({ id: base.id, version: base.version, rules });
}

/**
 * Run a skill under full governance. Opens a ledger action, builds the choke
 * point, and on a `needs_approval` verdict halts the run with the approval id
 * so a supervisor can decide out-of-band.
 */
export async function runSkill<I, O>(
  skill: MnemoSkill<I, O>,
  input: I,
  opts: RunSkillOptions = {},
): Promise<SkillRunResult<O>> {
  const ledger = opts.ledger ?? new ActionLedger();
  const approvals = opts.approvalStore ?? new InMemoryApprovalStore();
  const compiled = policyForSkill(skill as MnemoSkill, opts.extraPolicy);

  if (skill.validateInput && !skill.validateInput(input)) {
    const rec = ledger.begin({
      agent_id: opts.agent_id ?? skill.id,
      intent: skill.purpose,
    });
    ledger.fail(rec.id, "input validation failed");
    return { ok: false, error: "input validation failed", action_id: rec.id, ledger };
  }

  const action = ledger.begin({
    agent_id: opts.agent_id ?? skill.id,
    intent: skill.purpose,
  });

  let pendingApprovalId: string | undefined;

  const allowedSet = skill.permissions.allowed_tools
    ? new Set(skill.permissions.allowed_tools)
    : null;

  const ctx: SkillContext<I> = {
    input,
    action_id: action.id,
    ledger,
    noteMemory(id: string) {
      ledger.update(action.id, { memories_used: [id] });
    },
    act(req: SkillActRequest): ActGrant {
      // Skill-level allow-list precedes the policy engine.
      if (allowedSet && (req.kind === "tool_call" || req.kind === "http_request") && !allowedSet.has(req.target)) {
        ledger.block(action.id, `tool not in allow-list: ${req.target}`);
        return { allowed: false, blocker: "blocked", reason: "tool_not_allowed" };
      }

      // Record what was touched, classify risk.
      const risk = classifyRisk(req);
      const patch: Parameters<ActionLedger["update"]>[1] = { cost_usd: req.estimated_usd ?? 0 };
      if (req.kind === "tool_call" || req.kind === "llm_call") patch.tools_used = [req.target];
      else if (req.kind === "http_request") patch.sites_visited = [req.target];
      else if (req.kind === "file_write") patch.files_accessed = [req.target];
      ledger.update(action.id, patch);

      const verdict = evaluateAction(compiled, { ...req, at: new Date() });
      const routed = routeVerdict(approvals, { ...req }, verdict);
      if (routed.allowed) {
        ledger.markExecuting(action.id);
        return { allowed: true, action_id: action.id };
      }
      if (routed.blocker === "pending" && routed.approval_id) {
        pendingApprovalId = routed.approval_id;
        ledger.awaitApproval(action.id, routed.approval_id);
        return { allowed: false, blocker: "pending", approval_id: routed.approval_id, reason: `risk:${risk.level}` };
      }
      ledger.block(action.id, routed.reason ?? "blocked by policy");
      return { allowed: false, blocker: "blocked", reason: routed.reason };
    },
  };

  try {
    const output = await skill.run(ctx);
    // A governed act() may already have driven the action to a terminal/halted
    // state (blocked by policy, or waiting on a human). Never let a clean body
    // return overwrite that with `completed`.
    const status = ledger.get(action.id)?.status;
    if (status === "awaiting_approval") {
      return {
        ok: false,
        output,
        action_id: action.id,
        pending_approval_id: pendingApprovalId,
        ledger,
      };
    }
    if (status === "blocked") {
      return {
        ok: false,
        output,
        error: ledger.get(action.id)?.error ?? "blocked by policy",
        action_id: action.id,
        ledger,
      };
    }
    ledger.complete(action.id, summarize(output));
    return { ok: true, output, action_id: action.id, ledger };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    ledger.fail(action.id, message);
    return { ok: false, error: message, action_id: action.id, ledger };
  }
}

function summarize(output: unknown): string {
  if (output == null) return "ok";
  if (typeof output === "string") return output.slice(0, 200);
  try {
    return JSON.stringify(output).slice(0, 200);
  } catch {
    return "ok";
  }
}
