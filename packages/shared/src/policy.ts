/**
 * Policy (design/agile-agents-design.md §16 "HIL gates policy").
 *
 * `.agile/policy.yaml` (repo default); the same `gates` shape is reused on a
 * sprint file ("The sprint file carries its own gates: block", §16), most
 * specific wins: sprint → epic → team → repo default.
 */

import { z } from 'zod';
import { formatZodError } from './ids';

/**
 * "Owner: human | em | architect | human_timeout: <duration> (ask the human;
 * if no answer by the deadline, proceed as the fallback owner would)" (§16).
 * DESIGN-GAP: `human_timeout` is written in the design as a mapping-style
 * entry (`human_timeout: <duration>`); modeled as a single string value
 * `human_timeout:<duration>` so `gates` stays a flat `string -> owner` map
 * like every other role in the enum.
 */
export const HUMAN_TIMEOUT_PATTERN = /^human_timeout:\S+$/;
export const GateOwnerSchema = z.union([
  z.literal('human'),
  z.literal('em'),
  z.literal('architect'),
  z.string().regex(HUMAN_TIMEOUT_PATTERN, 'must look like human_timeout:2h'),
]);
export type GateOwner = z.infer<typeof GateOwnerSchema>;

/**
 * Named gates in the repo-default example (§16): approve_plan,
 * approve_decision, sprint_review, unblock, demo. DESIGN-GAP: kept as
 * documentation only — `gates` is a permissive record so a sprint/epic/team
 * override can add gate names the repo default doesn't list.
 */
export const KNOWN_GATES = [
  'approve_plan',
  'approve_decision',
  'sprint_review',
  'unblock',
  'demo',
] as const;

export const GatesBlockSchema = z.record(z.string().min(1), GateOwnerSchema);
export type GatesBlock = z.infer<typeof GatesBlockSchema>;

/**
 * "Circuit breaker: configurable signals (global halt this sprint, budget
 * over X%, integration tests red, escalation ladder exhausted,
 * reviewer/engineer deadlock) force every gate to human until cleared" (§16).
 * DESIGN-GAP: no yaml key is given for this list; modeled as a free-form
 * string array of signal names.
 */
export const PolicySchema = z.object({
  gates: GatesBlockSchema,
  breaker_signals: z.array(z.string().min(1)).default([]),
});

export type Policy = z.infer<typeof PolicySchema>;

export function validatePolicy(input: unknown): Policy {
  const result = PolicySchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Policy', result.error));
  }
  return result.data;
}
