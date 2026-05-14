/**
 * EU AI Act sample policy — illustrative starter, NOT a substitute for legal review.
 *
 * Encodes a defensible first pass at the Article 5 (prohibited practices),
 * Article 14 (human oversight), and Annex IV (documentation) signals that
 * an agent stack can enforce automatically. Buyers (banks, healthcare,
 * defense) should treat this as the seed for their own policy and add
 * sector-specific overlays.
 *
 * Reference dates:
 *   - Article 5 prohibitions enforceable: 2025-02-02
 *   - GPAI obligations enforceable: 2025-08-02
 *   - High-risk system obligations enforceable: 2026-08-02
 *
 * This file ships as data — consumers `compilePolicy(EU_AI_ACT_POLICY_V1)`
 * and pass the result to `evaluateAction()`.
 */

import type { Policy } from "../policy.js";

export const EU_AI_ACT_POLICY_V1: Policy = {
  id: "eu-ai-act-v1",
  version: 1,
  rules: [
    // Article 5(1)(a) — subliminal techniques deploying manipulative imagery
    {
      id: "art5-subliminal-manipulation",
      description:
        "Block actions tagged as subliminal/manipulative under Article 5(1)(a). Tag is upstream — this rule fires on the kind+target.",
      applies_to: ["llm_call", "tool_call"],
      target_pattern: "^(manipulate|subliminal)\\..*",
      outright_block: true,
    },
    // Article 5(1)(c) — social scoring by public authorities (EU only)
    {
      id: "art5-social-scoring",
      description: "Prohibit social-scoring computation when locale is in EU.",
      applies_to: ["tool_call"],
      target_in: ["social.score", "social.ranking", "citizen.score"],
      block_locales: ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
    },
    // Article 5(1)(d) — real-time biometric identification in public spaces (EU only)
    {
      id: "art5-realtime-biometric-public",
      description: "Block real-time biometric ID in EU public spaces.",
      applies_to: ["tool_call"],
      target_pattern: "^biometric\\.(realtime|publicspace)\\..*",
      block_locales: ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"],
    },
    // Article 14 — high-risk system human oversight: any irreversible action
    //   above $10 requires approval; above $1000 is hard-blocked.
    {
      id: "art14-human-oversight",
      description: "High-risk system action escalation — Article 14.",
      applies_to: ["payment", "tool_call"],
      approval_threshold_usd: 10,
      hard_cap_usd: 1000,
    },
    // Annex IV — documentation: every llm_call must be auditable. Rate-limited
    //   so we don't lose oversight under burst load. 60 calls/minute per
    //   target — enough for normal use, low enough to catch runaway loops.
    {
      id: "annex-iv-llm-rate-cap",
      description: "Rate-limit LLM calls so the audit chain stays observable.",
      applies_to: ["llm_call"],
      target_pattern: ".*",
      rate_limit: { window: "minute", max: 60 },
    },
  ],
};

/**
 * Helper — install the sample policy + compile it in one call. Consumers
 * who want a more aggressive or laxer policy compose their own rules,
 * but this is the "happy path" for getting compliant by default.
 */
export function defaultEuAiActPolicy(): Policy {
  return EU_AI_ACT_POLICY_V1;
}
