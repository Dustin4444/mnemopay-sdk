/**
 * Example 08 — Invoice Collector (governed MnemoSkill)
 *
 * Demonstrates the full trust stack for a B2B collections agent:
 *   - MnemoPay memory (customer payment history)
 *   - MnemoSkills (permissioned capability)
 *   - Policy + approval (refunds need human sign-off)
 *   - ActionLedger (provable audit trail)
 *
 * Run: npx tsx examples/08-invoice-collector.ts
 */

import { MnemoPay } from "../src/index.js";
import { runSkill, type MnemoSkill } from "../src/skills/skill.js";
import { InMemoryApprovalStore } from "../src/governance/approval.js";

interface InvoiceInput {
  customer_id: string;
  invoice_id: string;
  amount_usd: number;
  days_overdue: number;
  /** When true, skill attempts a refund (requires approval above threshold). */
  offer_discount?: boolean;
}

interface InvoiceOutput {
  draft_email: string;
  payment_link?: string;
  status: "drafted" | "awaiting_approval" | "blocked";
}

// ── Stub backends (replace with CRM / email / Stripe in production) ─────────

function searchCustomer(customerId: string) {
  return { id: customerId, name: "ACME Corp", contact: "billing@acme.example" };
}

function draftReminderEmail(customer: { name: string }, invoiceId: string, daysOverdue: number) {
  return `Subject: Invoice ${invoiceId} — ${daysOverdue} days overdue\n\nHi ${customer.name},\n\nFriendly reminder that invoice ${invoiceId} is past due. Pay here: https://pay.example/${invoiceId}`;
}

function createPaymentLink(invoiceId: string, amountUsd: number) {
  return `https://pay.example/${invoiceId}?amount=${amountUsd}`;
}

// ── Governed skill definition ───────────────────────────────────────────────

const invoiceCollectorSkill: MnemoSkill<InvoiceInput, InvoiceOutput> = {
  id: "invoice-collector",
  name: "Invoice Collector",
  purpose: "Draft payment reminders and payment links for overdue invoices",
  version: "1.0.0",
  owner: "finance@company.com",
  permissions: {
    allowed_tools: ["crm.search", "email.draft", "payments.link", "payments.refund"],
    disallowed: ["email.send"],
    spend_limit_usd: 500,
    approval_above_usd: 50,
  },
  validateInput: (input): input is InvoiceInput =>
    typeof input === "object" &&
    input != null &&
    typeof (input as InvoiceInput).customer_id === "string" &&
    typeof (input as InvoiceInput).invoice_id === "string",
  run(ctx) {
    const { customer_id, invoice_id, amount_usd, days_overdue, offer_discount } = ctx.input;

    const searchGrant = ctx.act({
      kind: "tool_call",
      target: "crm.search",
      estimated_usd: 0.01,
      args_text: `customer_id=${customer_id}`,
    });
    if (!searchGrant.allowed) {
      return { draft_email: "", status: "blocked" as const };
    }
    const customer = searchCustomer(customer_id);

    const draftGrant = ctx.act({
      kind: "tool_call",
      target: "email.draft",
      estimated_usd: 0.05,
      args_text: `reminder invoice ${invoice_id}`,
    });
    if (!draftGrant.allowed) {
      return { draft_email: "", status: "blocked" as const };
    }
    const draft_email = draftReminderEmail(customer, invoice_id, days_overdue);

    const linkGrant = ctx.act({
      kind: "tool_call",
      target: "payments.link",
      estimated_usd: 0.1,
      args_text: `link invoice ${invoice_id}`,
    });
    if (!linkGrant.allowed) {
      return { draft_email, status: "blocked" as const };
    }
    const payment_link = createPaymentLink(invoice_id, amount_usd);

    if (offer_discount) {
      const refundGrant = ctx.act({
        kind: "payment",
        target: "payments.refund",
        estimated_usd: amount_usd * 0.1,
        args_text: `refund discount invoice ${invoice_id}`,
      });
      if (!refundGrant.allowed) {
        return {
          draft_email,
          payment_link,
          status: refundGrant.blocker === "pending" ? "awaiting_approval" : "blocked",
        };
      }
    }

    return { draft_email, payment_link, status: "drafted" };
  },
};

// ── Demo run ────────────────────────────────────────────────────────────────

async function main() {
  const agent = MnemoPay.quick("invoice-agent");
  await agent.remember("ACME Corp usually pays 5–7 days late — escalate after day 14");
  const memories = await agent.recall("ACME payment", 3);
  const memoryId = memories[0]?.id ?? "mem-local";

  const approvalStore = new InMemoryApprovalStore();

  // Run 1: draft reminder + payment link (should complete)
  const run1 = await runSkill(
    invoiceCollectorSkill,
    {
      customer_id: "cust_acme",
      invoice_id: "1042",
      amount_usd: 1200,
      days_overdue: 12,
    },
    { agent_id: "invoice-agent", approvalStore },
  );

  const rec1 = run1.ledger.get(run1.action_id)!;
  rec1.memories_used.push(memoryId);
  console.log("\n=== Run 1: payment reminder ===");
  console.log("ok:", run1.ok);
  console.log("output:", run1.output);
  console.log("ledger:", {
    status: rec1.status,
    tools: rec1.tools_used,
    cost_usd: rec1.cost_usd,
    merkle_root: run1.ledger.auditChain().rollMerkleRoot().slice(0, 16) + "…",
  });

  // Run 2: discount/refund path (should halt for approval — $120 > $50 threshold)
  const run2 = await runSkill(
    invoiceCollectorSkill,
    {
      customer_id: "cust_acme",
      invoice_id: "1042",
      amount_usd: 1200,
      days_overdue: 18,
      offer_discount: true,
    },
    { agent_id: "invoice-agent", approvalStore },
  );

  console.log("\n=== Run 2: discount request (approval gate) ===");
  console.log("ok:", run2.ok);
  console.log("pending_approval_id:", run2.pending_approval_id);
  console.log("ledger status:", run2.ledger.get(run2.action_id)?.status);

  if (run2.pending_approval_id) {
    approvalStore.decide(run2.pending_approval_id, "reject", "finance@company.com", "No discounts without account review");
    run2.ledger.resolveApproval(run2.action_id, run2.pending_approval_id, "rejected", "finance@company.com");
    console.log("Supervisor rejected discount — agent must not refund.");
  }

  console.log("\nPending approvals remaining:", approvalStore.pending().length);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
