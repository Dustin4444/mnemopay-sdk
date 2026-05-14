/**
 * Compile-time linter for `Policy` objects.
 *
 * Validates:
 *   - Every rule has a non-empty id
 *   - Rule ids are unique within a policy
 *   - target_pattern compiles as a regex
 *   - arg_pattern_blocks compiles as a regex
 *   - hard_cap_usd > approval_threshold_usd (otherwise hard cap is unreachable)
 *   - block_locales + allow_only_locales don't contradict
 *   - rate_limit.max is a positive integer
 *   - applies_to entries are valid kinds
 *
 * Returns a structured report — empty `issues` array means clean.
 */

import type { Policy, PolicyAction, PolicyRule } from "./policy.js";

export interface LintIssue {
  rule_id: string;
  field: string;
  severity: "error" | "warning";
  message: string;
}

export interface LintReport {
  policy_id: string;
  ok: boolean;
  issues: readonly LintIssue[];
}

const VALID_KINDS: ReadonlySet<PolicyAction["kind"]> = new Set([
  "tool_call",
  "llm_call",
  "http_request",
  "file_write",
  "payment",
]);

export function lintPolicy(policy: Policy): LintReport {
  const issues: LintIssue[] = [];
  const seenIds = new Set<string>();

  for (const rule of policy.rules) {
    if (!rule.id || typeof rule.id !== "string") {
      issues.push({ rule_id: "<missing>", field: "id", severity: "error", message: "rule.id must be a non-empty string" });
      continue;
    }
    if (seenIds.has(rule.id)) {
      issues.push({ rule_id: rule.id, field: "id", severity: "error", message: `duplicate rule id '${rule.id}'` });
    }
    seenIds.add(rule.id);
    issues.push(...lintRule(rule));
  }

  return {
    policy_id: policy.id,
    ok: issues.every((i) => i.severity !== "error"),
    issues,
  };
}

function lintRule(rule: PolicyRule): LintIssue[] {
  const out: LintIssue[] = [];

  if (rule.applies_to) {
    for (const kind of rule.applies_to) {
      if (!VALID_KINDS.has(kind)) {
        out.push({ rule_id: rule.id, field: "applies_to", severity: "error", message: `unknown action kind '${kind}'` });
      }
    }
  }

  if (rule.target_pattern) {
    try { new RegExp(rule.target_pattern); }
    catch (err) {
      out.push({ rule_id: rule.id, field: "target_pattern", severity: "error", message: `invalid regex: ${(err as Error).message}` });
    }
  }

  if (rule.arg_pattern_blocks) {
    try { new RegExp(rule.arg_pattern_blocks); }
    catch (err) {
      out.push({ rule_id: rule.id, field: "arg_pattern_blocks", severity: "error", message: `invalid regex: ${(err as Error).message}` });
    }
  }

  if (rule.hard_cap_usd != null && rule.approval_threshold_usd != null) {
    if (rule.hard_cap_usd <= rule.approval_threshold_usd) {
      out.push({
        rule_id: rule.id,
        field: "hard_cap_usd",
        severity: "error",
        message: `hard_cap_usd (${rule.hard_cap_usd}) must exceed approval_threshold_usd (${rule.approval_threshold_usd}) or hard cap is unreachable`,
      });
    }
  }

  if (rule.hard_cap_usd != null && rule.hard_cap_usd < 0) {
    out.push({ rule_id: rule.id, field: "hard_cap_usd", severity: "error", message: "must be >= 0" });
  }
  if (rule.approval_threshold_usd != null && rule.approval_threshold_usd < 0) {
    out.push({ rule_id: rule.id, field: "approval_threshold_usd", severity: "error", message: "must be >= 0" });
  }

  if (rule.block_locales && rule.allow_only_locales) {
    const blockSet = new Set(rule.block_locales);
    const intersect = rule.allow_only_locales.filter((l) => blockSet.has(l));
    if (intersect.length > 0) {
      out.push({
        rule_id: rule.id,
        field: "allow_only_locales",
        severity: "error",
        message: `locale(s) ${intersect.join(",")} appear in both block_locales and allow_only_locales`,
      });
    }
  }

  if (rule.rate_limit) {
    if (!Number.isInteger(rule.rate_limit.max) || rule.rate_limit.max <= 0) {
      out.push({ rule_id: rule.id, field: "rate_limit.max", severity: "error", message: "must be a positive integer" });
    }
  }

  // Warnings — non-blocking, but worth noting.
  const usesAnyConstraint =
    rule.target_in ||
    rule.target_pattern ||
    rule.arg_pattern_blocks ||
    rule.block_locales ||
    rule.allow_only_locales ||
    rule.hard_cap_usd != null ||
    rule.approval_threshold_usd != null ||
    rule.rate_limit ||
    rule.outright_block;
  if (!usesAnyConstraint) {
    out.push({ rule_id: rule.id, field: "<rule>", severity: "warning", message: "rule has no constraints — it will always match without effect" });
  }

  return out;
}
