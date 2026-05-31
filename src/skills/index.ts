/**
 * @mnemopay/sdk — MnemoSkills barrel.
 *
 * A MnemoSkill is a versioned, permissioned, billable agent capability whose
 * every side-effect flows through the governance choke point (policy + risk +
 * approval + action ledger). See skill.ts for the full contract.
 */

export { policyForSkill, runSkill } from "./skill.js";
export type {
  SkillPermissions,
  SkillTestCase,
  SkillActRequest,
  ActGrant,
  SkillContext,
  MnemoSkill,
  RunSkillOptions,
  SkillRunResult,
} from "./skill.js";
