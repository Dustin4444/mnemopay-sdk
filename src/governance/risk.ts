/**
 * @mnemopay/sdk — action risk taxonomy ("MnemoGuard" tiering).
 *
 * `policy.ts` answers "is this specific action allowed by these rules?" — it
 * is the enforcement engine. This module answers the orthogonal question
 * "how dangerous is this action *by default*?" and turns that into a ready-made
 * policy preset so callers don't have to hand-author a rule per tool.
 *
 * The tiers (low → critical) and the action→tier defaults follow the standard
 * agent-action risk ladder: reads + drafts are cheap, sends + form-fills are
 * reversible-but-visible, uploads + payments are consequential, and moving
 * money / signing / deleting is irreversible.
 *
 * Pure module — depends only on policy.ts types.
 */

import type { Policy, PolicyAction, PolicyRule } from "./policy.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export const RISK_ORDER: readonly RiskLevel[] = ["low", "medium", "high", "critical"];

export function riskRank(level: RiskLevel): number {
  return RISK_ORDER.indexOf(level);
}

/** Default tier for each action kind before keyword escalation. */
const KIND_BASELINE: Record<PolicyAction["kind"], RiskLevel> = {
  llm_call: "low",
  tool_call: "medium",
  http_request: "medium",
  file_write: "high",
  payment: "high",
};

/**
 * Keyword → minimum tier escalations applied against `target` + `args_text`.
 * A match raises the tier to at least the listed level (never lowers it).
 * Ordered most-severe first so the scan can stop early.
 */
const ESCALATIONS: ReadonlyArray<{ level: RiskLevel; re: RegExp; why: string }> = [
  {
    level: "critical",
    re: /\b(wire|payout|transfer|withdraw|send\s+money|move\s+money|sign|contract|delete|drop\s+table|destroy|revoke|deactivate|close\s+account)\b/i,
    why: "irreversible money/contract/destructive action",
  },
  {
    level: "high",
    re: /\b(upload|ssn|passport|bank\s+statement|id\s+document|kyc|purchase|checkout|pay|refund|disburse|deploy|production)\b/i,
    why: "sensitive upload / spend / production mutation",
  },
  {
    level: "medium",
    re: /\b(send|email|message|dm|post|submit|fill|book|reserve|schedule)\b/i,
    why: "externally-visible send / form submission",
  },
];

export interface RiskAssessment {
  level: RiskLevel;
  /** Human-readable why — surfaced in approval queues + the action ledger. */
  rationale: string;
}

/**
 * Classify an action into a default risk tier. Combines the kind baseline with
 * keyword escalation over target + args. Amount-aware: a payment over $1k is
 * always critical regardless of wording.
 */
export function classifyRisk(action: PolicyAction): RiskAssessment {
  let level = KIND_BASELINE[action.kind] ?? "medium";
  let rationale = `${action.kind} baseline`;

  // Normalize separators (snake_case / kebab / dotted tool ids) to spaces so
  // word-boundary keyword escalation matches `wire_transfer`, `sign-contract`,
  // `delete.account` the same as the spaced phrases.
  const haystack = `${action.target} ${action.args_text ?? ""}`.replace(/[_.\-/:]+/g, " ");
  for (const esc of ESCALATIONS) {
    if (esc.re.test(haystack)) {
      if (riskRank(esc.level) > riskRank(level)) {
        level = esc.level;
        rationale = esc.why;
      }
      break; // escalations are ordered severe-first
    }
  }

  const usd = action.estimated_usd ?? 0;
  if (action.kind === "payment" || usd > 0) {
    let amountLevel: RiskLevel | null = null;
    if (usd > 1000) amountLevel = "critical";
    else if (usd > 100) amountLevel = "high";
    else if (usd > 0) amountLevel = "medium";
    if (amountLevel && riskRank(amountLevel) > riskRank(level)) {
      level = amountLevel;
      rationale = `spend $${usd.toFixed(2)}`;
    }
  }

  return { level, rationale };
}

export interface RiskPolicyOptions {
  /** Spend at or below this is auto-allowed; above it needs approval. Default 50. */
  approvalThresholdUsd?: number;
  /** Spend above this is blocked outright (no approval path). Default 5000. */
  hardCapUsd?: number;
  /** Action targets to block outright (e.g. ["upload_id", "sign_contract"]). */
  blockTargets?: readonly string[];
  /** Policy id + version stamped into the audit chain. */
  id?: string;
  version?: number;
}

/**
 * Build a ready-to-compile `Policy` from the risk ladder. This is the
 * batteries-included default for callers who want sane governance without
 * authoring rules: a spend approval threshold, a hard cap, and an explicit
 * block-list for the irreversible-sensitive actions.
 */
export function buildRiskPolicy(opts: RiskPolicyOptions = {}): Policy {
  const approvalThresholdUsd = opts.approvalThresholdUsd ?? 50;
  const hardCapUsd = opts.hardCapUsd ?? 5000;
  const rules: PolicyRule[] = [];

  for (const target of opts.blockTargets ?? []) {
    rules.push({
      id: `block:${target}`,
      description: `risk preset — ${target} requires explicit human action`,
      target_in: [target],
      outright_block: true,
    });
  }

  rules.push({
    id: "risk:spend-hard-cap",
    description: `block any single action above $${hardCapUsd}`,
    applies_to: ["payment", "tool_call", "http_request"],
    hard_cap_usd: hardCapUsd,
  });

  rules.push({
    id: "risk:spend-approval",
    description: `require approval above $${approvalThresholdUsd}`,
    applies_to: ["payment", "tool_call", "http_request"],
    approval_threshold_usd: approvalThresholdUsd,
  });

  return {
    id: opts.id ?? "mnemoguard-risk-default",
    version: opts.version ?? 1,
    rules,
  };
}
