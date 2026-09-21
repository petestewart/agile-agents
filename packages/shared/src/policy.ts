/**
 * Policy (design/agile-agents-design.md §16 "HIL gates policy").
 *
 * `.agile/policy.yaml` (repo default); the same `gates` shape is reused on a
 * sprint file ("The sprint file carries its own gates: block", §16), most
 * specific wins: sprint → epic → team → repo default.
 */

import { z } from 'zod';
import { formatZodError } from './ids';
import { HIL_KINDS, type HilKind, HilKindSchema } from './message';

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
 * T121: `gates` is a **closed** set, not a free-form record. The three
 * surviving gate kinds are design/cockpit-design.md §3.1's — `land`,
 * `rule_accept`, `classifier_review` — and they are exactly `HIL_KINDS`
 * (`message.ts`), so a policy row and a `hil_kind` can never drift apart.
 * A policy naming any other gate (`approve_plan`, `sprint_review`,
 * `unblock`, `demo`, `promote_to_main`, …) is rejected at the boundary
 * rather than silently resolving to `human`.
 */
export const GATE_KINDS = HIL_KINDS;
export const GateKindSchema = HilKindSchema;
export type GateKind = HilKind;

export const GatesBlockSchema = z.record(GateKindSchema, GateOwnerSchema);
export type GatesBlock = z.infer<typeof GatesBlockSchema>;

/**
 * "Circuit breaker: configurable signals (global halt this sprint, budget
 * over X%, integration tests red, escalation ladder exhausted,
 * reviewer/engineer deadlock) force every gate to human until cleared" (§16).
 * DESIGN-GAP: no yaml key is given for this list; modeled as a free-form
 * string array of signal names.
 */
export const PolicySchema = z
  .object({
    gates: GatesBlockSchema,
    breaker_signals: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type Policy = z.infer<typeof PolicySchema>;

export function validatePolicy(input: unknown): Policy {
  const result = PolicySchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Policy', result.error));
  }
  return result.data;
}
