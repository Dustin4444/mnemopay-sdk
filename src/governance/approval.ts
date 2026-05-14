/**
 * Approval queue hook — bridges `evaluateAction()` `needs_approval` verdicts
 * to a human (or supervising agent) outside the hot path.
 *
 * The Approval store is intentionally minimal: id, action snapshot, reason,
 * status, decision. Production implementations swap the in-memory map for
 * Redis / Postgres / Slack / pager — the interface stays the same.
 *
 * Pure module.
 */

import { randomUUID } from "node:crypto";
import type { PolicyAction, PolicyVerdict } from "./policy.js";

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface ApprovalRequest {
  id: string;
  reason: string;
  matched_rule: string;
  action: PolicyAction;
  status: ApprovalStatus;
  requested_at: string;
  decided_at?: string;
  decided_by?: string;
  notes?: string;
}

export interface ApprovalStore {
  open(req: Omit<ApprovalRequest, "id" | "status" | "requested_at">): ApprovalRequest;
  get(id: string): ApprovalRequest | null;
  pending(): readonly ApprovalRequest[];
  decide(id: string, decision: "approve" | "reject", decidedBy: string, notes?: string): ApprovalRequest;
  expire(id: string): ApprovalRequest;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly map = new Map<string, ApprovalRequest>();

  open(req: Omit<ApprovalRequest, "id" | "status" | "requested_at">): ApprovalRequest {
    const full: ApprovalRequest = {
      id: randomUUID(),
      status: "pending",
      requested_at: new Date().toISOString(),
      ...req,
    };
    this.map.set(full.id, full);
    return full;
  }

  get(id: string): ApprovalRequest | null { return this.map.get(id) ?? null; }

  pending(): readonly ApprovalRequest[] {
    return Array.from(this.map.values()).filter((r) => r.status === "pending");
  }

  decide(id: string, decision: "approve" | "reject", decidedBy: string, notes?: string): ApprovalRequest {
    const req = this.map.get(id);
    if (!req) throw new Error(`approval: ${id} not found`);
    if (req.status !== "pending") throw new Error(`approval: ${id} already ${req.status}`);
    const updated: ApprovalRequest = {
      ...req,
      status: decision === "approve" ? "approved" : "rejected",
      decided_at: new Date().toISOString(),
      decided_by: decidedBy,
      ...(notes ? { notes } : {}),
    };
    this.map.set(id, updated);
    return updated;
  }

  expire(id: string): ApprovalRequest {
    const req = this.map.get(id);
    if (!req) throw new Error(`approval: ${id} not found`);
    const updated: ApprovalRequest = { ...req, status: "expired", decided_at: new Date().toISOString() };
    this.map.set(id, updated);
    return updated;
  }
}

/**
 * Convenience — given a policy verdict, route through the approval store.
 *
 * Returns:
 *   - { allowed: true }                                    → caller proceeds
 *   - { allowed: false, blocker: 'blocked'|'pending' }     → caller halts
 *   - { allowed: false, blocker: 'pending', approval: id } → caller awaits decision
 */
export function routeVerdict(
  store: ApprovalStore,
  action: PolicyAction,
  verdict: PolicyVerdict,
): { allowed: true } | { allowed: false; blocker: "blocked" | "pending"; approval_id?: string; reason?: string } {
  if ("needs_approval" in verdict) {
    const req = store.open({
      reason: verdict.reason,
      matched_rule: verdict.matched_rule,
      action,
    });
    return { allowed: false, blocker: "pending", approval_id: req.id };
  }
  if ("allowed" in verdict && verdict.allowed) return { allowed: true };
  if ("allowed" in verdict && !verdict.allowed) {
    return { allowed: false, blocker: "blocked", reason: verdict.reason };
  }
  return { allowed: false, blocker: "blocked" };
}
