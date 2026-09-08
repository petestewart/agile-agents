/**
 * Sprint (design/agile-agents-design.md §4 "Sprint", §15 "Git model and
 * teams" for `team`, §16 "HIL gates policy" for the sprint-level `gates`
 * override).
 */

import { z } from 'zod';
import { SprintIdSchema, TicketIdSchema, formatZodError } from './ids';
import { GatesBlockSchema } from './policy';

export const SprintRetroSchema = z
  .object({
    // "mispointed: [TKT-0229]  # spent > 3x estimate"
    mispointed: z.array(TicketIdSchema).default([]),
    global_halts: z.number().int().min(0).default(0),
    escalations: z.number().int().min(0).default(0),
  })
  .strict();
export type SprintRetro = z.infer<typeof SprintRetroSchema>;

export const SprintSchema = z
  .object({
    id: SprintIdSchema,
    goal: z.string().min(1),
    tickets: z.array(TicketIdSchema).default([]),
    // DESIGN-GAP: scalar, per the §4 example. §4 "Quota" notes "Sprint budget
    // carries a per-vendor breakdown", which this doesn't model — out of
    // scope for v0 per PLAN §2 (quota-aware routing is a later ticket).
    budget_tokens: z.number().int().min(0),
    started: z.string().min(1),
    // "review_at: <HIL demo>" — a timestamp once scheduled, placeholder before.
    review_at: z.string().min(1).optional(),
    carried_over: z.array(TicketIdSchema).default([]),
    // "computed from ledger, not agent-written" — optional until the sprint closes.
    retro: SprintRetroSchema.optional(),
    // "team on sprints, agents, and epics" (§15) — one EM per team.
    // DESIGN-GAP: optional — the §4 example sprint predates the §15 team
    // addition and has no `team` key, so it stays parseable without one.
    team: z.string().min(1).optional(),
    // "The sprint file carries its own gates: block" (§16), most-specific-wins override.
    gates: GatesBlockSchema.optional(),
  })
  .strict();

export type Sprint = z.infer<typeof SprintSchema>;

export function validateSprint(input: unknown): Sprint {
  const result = SprintSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Sprint', result.error));
  }
  return result.data;
}
