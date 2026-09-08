/**
 * Ticket (design/agile-agents-design.md §4 "Ticket", §10 "Quota-driven pause
 * and handoff" for `paused`/`resume_at`, §12 "Review protocol" for
 * `security: true`, §13 "QA environment and protocol" for `contract.env`,
 * §11 "Pointing rubric and routing calibration" for tier/reasoning).
 */

import { z } from 'zod';
import {
  EpicIdSchema,
  KbIdSchema,
  OracleIdSchema,
  SprintIdSchema,
  TicketIdSchema,
  formatZodError,
} from './ids';

export const TICKET_STATUSES = [
  'draft',
  'ready',
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
  'done',
  'blocked',
  'stale',
  'paused',
] as const;

export const TicketStatusSchema = z.enum(TICKET_STATUSES);
export type TicketStatus = z.infer<typeof TicketStatusSchema>;

export const TICKET_TIERS = ['trivial', 'standard', 'hard', 'novel'] as const;
export const TicketTierSchema = z.enum(TICKET_TIERS);
export type TicketTier = z.infer<typeof TicketTierSchema>;

export const TICKET_REASONING_LEVELS = ['low', 'medium', 'high'] as const;
export const TicketReasoningSchema = z.enum(TICKET_REASONING_LEVELS);
export type TicketReasoning = z.infer<typeof TicketReasoningSchema>;

/**
 * `contract.done` — "machine-checkable definition of done" (§3, §4 example).
 * DESIGN-GAP: the example lists exactly these four; treated as a closed enum
 * since §12/§13 never mention any other done-criterion kind.
 */
export const DONE_CRITERIA = [
  'tests_pass',
  'review_approved',
  'qa_accepted',
  'oracle_consistent',
] as const;
export const DoneCriterionSchema = z.enum(DONE_CRITERIA);

/** `contract.env: clone | compose: <path>` (§13 "QA environment and protocol"). */
export const ContractEnvSchema = z.union([
  z.literal('clone'),
  z.string().regex(/^compose:\s*\S+/, 'must look like "compose: docker/compose.test.yml"'),
]);
export type ContractEnv = z.infer<typeof ContractEnvSchema>;

export const TicketContractSchema = z.object({
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),
  acceptance: z.array(z.string().min(1)).default([]),
  done: z.array(DoneCriterionSchema).default([]),
  env: ContractEnvSchema.default('clone'),
});
export type TicketContract = z.infer<typeof TicketContractSchema>;

export const TicketEstimateSchema = z.object({
  points: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8)]),
  tier: TicketTierSchema,
  reasoning: TicketReasoningSchema,
  pointed_by: z.string().min(1),
  pointed_at: z.string().min(1),
});
export type TicketEstimate = z.infer<typeof TicketEstimateSchema>;

export const TicketRoutingSchema = z.object({
  // "<resolved by daemon from tier at assignment>" — absent before assignment.
  model: z.string().min(1).optional(),
  attempts: z.number().int().min(0).default(0),
  max_attempts: z.number().int().min(1),
  escalation: z.array(TicketTierSchema).default([]),
});
export type TicketRouting = z.infer<typeof TicketRoutingSchema>;

export const TicketBudgetSchema = z.object({
  ceiling_tokens: z.number().int().min(0),
  // "spent_tokens: 0  # daemon-maintained"
  spent_tokens: z.number().int().min(0).default(0),
});
export type TicketBudget = z.infer<typeof TicketBudgetSchema>;

export const TicketSchema = z.object({
  id: TicketIdSchema,
  title: z.string().min(1),
  status: TicketStatusSchema,
  sprint: SprintIdSchema.optional(),
  parent: EpicIdSchema.optional(),
  depends: z.array(TicketIdSchema).default([]),
  oracle_refs: z.array(OracleIdSchema).default([]),
  kb_refs: z.array(KbIdSchema).default([]),
  contract: TicketContractSchema,
  estimate: TicketEstimateSchema.optional(),
  routing: TicketRoutingSchema.optional(),
  budget: TicketBudgetSchema.optional(),
  assignee: z.string().min(1).optional(),
  worktree: z.string().min(1).optional(),
  history: z.array(z.string().min(1)).default([]),
  // "anything the architect tags security: true" (§12).
  security: z.boolean().default(false),
  // "ticket status paused, resume_at = earliest resets_at among candidates" (§10).
  resume_at: z.string().min(1).optional(),
  // "blocked: agent-declared, carries a reason pointing at a ticket, a
  // message, or a proposed decision" (§4 "Ticket").
  blocked_reason: z.string().min(1).optional(),
});

export type Ticket = z.infer<typeof TicketSchema>;

export function validateTicket(input: unknown): Ticket {
  const result = TicketSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Ticket', result.error));
  }
  return result.data;
}

/**
 * Legal status edges, for T005's transition guard ("illegal transitions
 * throw"). The design names the states (§4 "Ticket") but not an exhaustive
 * edge list, so edges are derived from the workflows that name a `from` and
 * `to` explicitly:
 *
 * - draft -> ready: architect readies a refined ticket (§4, §9).
 * - ready -> assigned: EM assigns off the sprint frontier (§9).
 * - assigned -> in_progress: engineer picks up (§6 "ticket pickup" gate).
 * - in_progress -> in_review: engineer submits (`review_submitted` stanza, §4 "Board").
 * - in_review -> in_progress: reviewer `request_changes` verdict (§12).
 * - in_review -> in_qa: reviewer `approve` verdict (§12).
 * - in_qa -> in_progress: QA `reject` verdict (§13).
 * - in_qa -> done: QA `accept` verdict (§13).
 * - {assigned, in_progress, in_review, in_qa} -> ready: dead-agent / quota
 *   reassignment, "ticket back to ready" (§5 "Liveness", §10 "Quota-driven pause").
 * - {assigned, in_progress, in_review, in_qa} -> paused: quota-floor pause,
 *   "ticket status paused" (§10).
 * - paused -> ready: scheduler resumes into the reassignment pool (§10).
 * - {in_progress, in_review, in_qa} -> blocked: agent-declared block (§4 "Ticket").
 * - blocked -> in_progress: unblocked by an `answer`/`decision` (§5 "Questions").
 * - {ready, assigned, in_progress, in_review, in_qa, blocked, paused} -> stale:
 *   ripple walk marks any live ticket whose `oracle_refs` intersect a changed
 *   decision (§4 "Oracle": "every ticket whose oracle_refs intersects gets
 *   marked stale").
 * - stale -> ready: "architect re-refines" (§4 "Ticket").
 * - done: terminal — DESIGN-GAP, the design never describes reopening a done ticket.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  draft: ['ready'],
  ready: ['assigned', 'stale'],
  assigned: ['in_progress', 'ready', 'paused', 'stale'],
  in_progress: ['in_review', 'blocked', 'ready', 'paused', 'stale'],
  in_review: ['in_progress', 'in_qa', 'ready', 'paused', 'stale'],
  in_qa: ['in_progress', 'done', 'ready', 'paused', 'stale'],
  blocked: ['in_progress', 'stale'],
  stale: ['ready'],
  paused: ['ready'],
  done: [],
};

export function isLegalTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}
