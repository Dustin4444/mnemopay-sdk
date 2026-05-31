/**
 * @mnemopay/sdk — typed agent action ledger ("MnemoLedger").
 *
 * `AuditChain` (audit-chain.ts) is the untyped event-stream primitive: it
 * accepts any `kind` + payload and rolls a Merkle root for Article-12 export.
 * This module is the opinionated layer on top: it records a *whole agent
 * action* — intent, plan, the tools it used, the memories it read, the files
 * and sites it touched, the approvals it asked for, what it spent, its risk
 * tier, and whether it can be rolled back — as a structured record.
 *
 * The point is provable autonomy: after the fact a user or auditor can answer
 * "what did the agent do, why, with what data, who approved it, what did it
 * cost, and can we undo it?" — straight off the chain, without spelunking logs.
 *
 * Each lifecycle transition is emitted to the underlying AuditChain so the
 * Merkle root still covers every state change, and `actions()` reconstructs
 * the typed view for dashboards / exports.
 *
 * Pure module — depends only on audit-chain.ts + risk.ts types.
 */

import { randomUUID } from "node:crypto";
import { AuditChain, type ChainEvent } from "./audit-chain.js";
import type { RiskLevel } from "./risk.js";

export type ActionStatus =
  | "planned"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed"
  | "blocked"
  | "rolled_back";

export interface ActionApproval {
  approval_id: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decided_by?: string;
}

export interface AgentActionRecord {
  id: string;
  agent_id: string;
  /** What the user/caller asked for. */
  intent: string;
  /** The agent's stated plan for this action. */
  plan?: string;
  status: ActionStatus;
  risk?: RiskLevel;
  /** Tool ids invoked. */
  tools_used: string[];
  /** Memory ids read while deciding/executing. */
  memories_used: string[];
  /** File paths accessed. */
  files_accessed: string[];
  /** URLs visited. */
  sites_visited: string[];
  approvals: ActionApproval[];
  /** USD cost attributed to this action. */
  cost_usd: number;
  /** Human-readable note on how to undo, when reversible. */
  rollback?: string;
  /** Final result summary. */
  result?: string;
  /** Error message when status is failed/blocked. */
  error?: string;
  started_at: string;
  ended_at?: string;
}

export interface BeginActionInput {
  agent_id: string;
  intent: string;
  plan?: string;
  risk?: RiskLevel;
}

/** Mutable fields a caller can roll up onto an in-flight action. */
export interface ActionUpdate {
  tools_used?: string[];
  memories_used?: string[];
  files_accessed?: string[];
  sites_visited?: string[];
  cost_usd?: number;
  plan?: string;
  rollback?: string;
}

const EVENT_PREFIX = "action.";

/**
 * Typed action ledger. Wraps an AuditChain — every begin/update/approval/end
 * is emitted as an `action.*` event so the Merkle root covers the full
 * lifecycle, while the in-memory map gives O(1) typed access for live views.
 */
export class ActionLedger {
  private readonly chain: AuditChain;
  private readonly actions = new Map<string, AgentActionRecord>();

  /** Pass an existing chain to share one audit stream across the app. */
  constructor(chain?: AuditChain) {
    this.chain = chain ?? new AuditChain();
  }

  /** Underlying chain — for Merkle root, bundle export, verification. */
  auditChain(): AuditChain {
    return this.chain;
  }

  begin(input: BeginActionInput): AgentActionRecord {
    const rec: AgentActionRecord = {
      id: randomUUID(),
      agent_id: input.agent_id,
      intent: input.intent,
      ...(input.plan ? { plan: input.plan } : {}),
      status: "planned",
      ...(input.risk ? { risk: input.risk } : {}),
      tools_used: [],
      memories_used: [],
      files_accessed: [],
      sites_visited: [],
      approvals: [],
      cost_usd: 0,
      started_at: new Date().toISOString(),
    };
    this.actions.set(rec.id, rec);
    this.chain.emit(`${EVENT_PREFIX}begin`, {
      action_id: rec.id,
      agent_id: rec.agent_id,
      intent: rec.intent,
      plan: rec.plan,
      risk: rec.risk,
    });
    return rec;
  }

  /** Append usage onto an in-flight action (dedupes arrays, adds cost). */
  update(actionId: string, patch: ActionUpdate): AgentActionRecord {
    const rec = this.require(actionId);
    if (patch.tools_used) rec.tools_used = dedupe([...rec.tools_used, ...patch.tools_used]);
    if (patch.memories_used) rec.memories_used = dedupe([...rec.memories_used, ...patch.memories_used]);
    if (patch.files_accessed) rec.files_accessed = dedupe([...rec.files_accessed, ...patch.files_accessed]);
    if (patch.sites_visited) rec.sites_visited = dedupe([...rec.sites_visited, ...patch.sites_visited]);
    if (typeof patch.cost_usd === "number") rec.cost_usd += patch.cost_usd;
    if (patch.plan) rec.plan = patch.plan;
    if (patch.rollback) rec.rollback = patch.rollback;
    this.chain.emit(`${EVENT_PREFIX}update`, { action_id: actionId, ...patch });
    return rec;
  }

  /** Record that this action opened an approval request and is now waiting. */
  awaitApproval(actionId: string, approval_id: string): AgentActionRecord {
    const rec = this.require(actionId);
    rec.status = "awaiting_approval";
    rec.approvals.push({ approval_id, status: "pending" });
    this.chain.emit(`${EVENT_PREFIX}approval.requested`, { action_id: actionId, approval_id });
    return rec;
  }

  /** Record the decision on a previously-requested approval. */
  resolveApproval(
    actionId: string,
    approval_id: string,
    status: "approved" | "rejected" | "expired",
    decided_by?: string,
  ): AgentActionRecord {
    const rec = this.require(actionId);
    const ap = rec.approvals.find((a) => a.approval_id === approval_id);
    if (ap) {
      ap.status = status;
      if (decided_by) ap.decided_by = decided_by;
    }
    this.chain.emit(`${EVENT_PREFIX}approval.resolved`, {
      action_id: actionId,
      approval_id,
      status,
      decided_by,
    });
    return rec;
  }

  markExecuting(actionId: string): AgentActionRecord {
    const rec = this.require(actionId);
    rec.status = "executing";
    this.chain.emit(`${EVENT_PREFIX}executing`, { action_id: actionId });
    return rec;
  }

  complete(actionId: string, result?: string): AgentActionRecord {
    return this.end(actionId, "completed", { result });
  }

  fail(actionId: string, error: string): AgentActionRecord {
    return this.end(actionId, "failed", { error });
  }

  block(actionId: string, reason: string): AgentActionRecord {
    return this.end(actionId, "blocked", { error: reason });
  }

  rollBack(actionId: string, note?: string): AgentActionRecord {
    return this.end(actionId, "rolled_back", { result: note });
  }

  private end(
    actionId: string,
    status: ActionStatus,
    fields: { result?: string; error?: string },
  ): AgentActionRecord {
    const rec = this.require(actionId);
    rec.status = status;
    if (fields.result != null) rec.result = fields.result;
    if (fields.error != null) rec.error = fields.error;
    rec.ended_at = new Date().toISOString();
    this.chain.emit(`${EVENT_PREFIX}end`, {
      action_id: actionId,
      status,
      result: fields.result,
      error: fields.error,
      cost_usd: rec.cost_usd,
    });
    return rec;
  }

  get(actionId: string): AgentActionRecord | null {
    return this.actions.get(actionId) ?? null;
  }

  /** All recorded actions, optionally filtered by agent. */
  list(agentId?: string): readonly AgentActionRecord[] {
    const all = Array.from(this.actions.values());
    return agentId ? all.filter((a) => a.agent_id === agentId) : all;
  }

  /** Raw lifecycle events from the underlying chain. */
  events(): readonly ChainEvent[] {
    return this.chain.events();
  }

  private require(actionId: string): AgentActionRecord {
    const rec = this.actions.get(actionId);
    if (!rec) throw new Error(`action-ledger: ${actionId} not found`);
    return rec;
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
