/**
 * Plan and Contract (projects-design §14.4, §9.1, T281).
 *
 * `plans/<node-id>.yaml`: one per coordinating node — who owns which paths,
 * and which contracts are the seams between the children. It starts
 * `draft`; the human approves it (an inbox card), which bumps `version`.
 *
 * `contracts/<C-id>.yaml`: one seam, written by the coordinator; its
 * `parties` are the children that rely on it. A body change bumps the
 * version, keeps the last 20 in `history`, and notifies the parties.
 */

import { z } from 'zod';
import { ULID_PATTERN, UlidSchema, formatZodError } from './ids';

export const CONTRACT_ID_PATTERN = new RegExp(`^C-${ULID_PATTERN.source.slice(1, -1)}$`);
export const ContractIdSchema = z.string().regex(CONTRACT_ID_PATTERN, 'must look like C-<ulid>');
export type ContractId = z.infer<typeof ContractIdSchema>;

export const CONTRACT_PROPOSAL_ID_PATTERN = new RegExp(`^CP-${ULID_PATTERN.source.slice(1, -1)}$`);
export const ContractProposalIdSchema = z
  .string()
  .regex(CONTRACT_PROPOSAL_ID_PATTERN, 'must look like CP-<ulid>');

/** §14.4: the seam as text; longer bodies go to a docs file with a pointer. */
export const CONTRACT_BODY_MAX_CHARS = 800;
export const CONTRACT_TITLE_MAX_CHARS = 200;
export const CONTRACT_HISTORY_MAX = 20;
/** A plan names at most this many children, globs per child and contracts. */
export const PLAN_LIST_MAX = 50;

const Glob = z.string().trim().min(1).max(512);

export const PlanOwnerSchema = z
  .object({ child: UlidSchema, owns: z.array(Glob).max(PLAN_LIST_MAX) })
  .strict();
export type PlanOwner = z.infer<typeof PlanOwnerSchema>;

export const PLAN_STATUSES = ['draft', 'approved'] as const;
export const PlanApproverSchema = z.enum(['human', 'coordinator', 'director']);

export const PlanSchema = z
  .object({
    node: UlidSchema,
    /** Bumped on every accepted change; 0 until the first approval. */
    version: z.number().int().nonnegative(),
    owners: z.array(PlanOwnerSchema).max(PLAN_LIST_MAX),
    contracts: z.array(ContractIdSchema).max(PLAN_LIST_MAX),
    status: z.enum(PLAN_STATUSES),
    approved_by: PlanApproverSchema.optional(),
    /** The last approved version, kept while a revision is in draft; children are briefed from it. */
    approved: z
      .object({
        version: z.number().int().positive(),
        owners: z.array(PlanOwnerSchema).max(PLAN_LIST_MAX),
        contracts: z.array(ContractIdSchema).max(PLAN_LIST_MAX),
      })
      .strict()
      .optional(),
    updated_at: z.string().datetime(),
  })
  .strict()
  .refine((p) => new Set(p.owners.map((o) => o.child)).size === p.owners.length, {
    message: 'a child is named once',
    path: ['owners'],
  });
export type Plan = z.infer<typeof PlanSchema>;

const ContractBody = z.string().trim().min(1).max(CONTRACT_BODY_MAX_CHARS);

export const ContractHistoryEntrySchema = z
  .object({
    version: z.number().int().positive(),
    body: ContractBody,
    changed_by: z.string().min(1),
    reason: z.string().max(400),
    at: z.string().datetime(),
  })
  .strict();

export const ContractProposalSchema = z
  .object({
    id: ContractProposalIdSchema,
    from: z.array(UlidSchema).min(1).max(PLAN_LIST_MAX),
    body: ContractBody,
    reason: z.string().max(400),
    routine: z.boolean(),
    status: z.enum(['open', 'approved', 'rejected', 'asked_human']),
    at: z.string().datetime(),
  })
  .strict();
export type ContractProposal = z.infer<typeof ContractProposalSchema>;

export const ContractSchema = z
  .object({
    id: ContractIdSchema,
    /** The coordinating node that owns it. */
    node: UlidSchema,
    title: z.string().trim().min(1).max(CONTRACT_TITLE_MAX_CHARS),
    body: ContractBody,
    parties: z.array(UlidSchema).max(PLAN_LIST_MAX),
    version: z.number().int().positive(),
    history: z.array(ContractHistoryEntrySchema).max(CONTRACT_HISTORY_MAX),
    proposals: z.array(ContractProposalSchema).max(PLAN_LIST_MAX).optional(),
  })
  .strict();
export type Contract = z.infer<typeof ContractSchema>;

export function validatePlan(input: unknown): Plan {
  const result = PlanSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('Plan', result.error));
  return result.data;
}

export function validateContract(input: unknown): Contract {
  const result = ContractSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('Contract', result.error));
  return result.data;
}

/** The coordinator's `plan_write` body, minus `session` (verbs.ts adds it). */
export const PlanWriteFieldsSchema = z
  .object({
    owners: z.array(PlanOwnerSchema).max(PLAN_LIST_MAX),
    contracts: z.array(ContractIdSchema).max(PLAN_LIST_MAX).optional(),
  })
  .strict();

/** The coordinator's `contract_write` body: no `id` creates, an `id` bumps. */
export const ContractWriteFieldsSchema = z
  .object({
    id: ContractIdSchema.optional(),
    title: z.string().trim().min(1).max(CONTRACT_TITLE_MAX_CHARS),
    body: ContractBody,
    parties: z.array(UlidSchema).max(PLAN_LIST_MAX),
    reason: z.string().max(400).optional(),
    /** P12: the coordinator's claim the change is additive; at Run a routine change is applied. */
    routine: z.boolean().optional(),
  })
  .strict();

/**
 * T282 (projects-design §9 "Autonomy", P12): the structural actions a
 * coordinator (or the Director, T301) may take, gated by its autonomy
 * level. `reorder` and `merge_siblings` have no verb yet; the gate covers
 * them so a later verb only has to call it.
 */
export const COORDINATOR_ACTIONS = [
  'add_child',
  'add_waits_on',
  'reorder',
  'set_owner',
  'merge_siblings',
  'approve_contract',
] as const;
export const CoordinatorActionSchema = z.enum(COORDINATOR_ACTIONS);
export type CoordinatorAction = z.infer<typeof CoordinatorActionSchema>;

/** Never allowed to a coordinator or the Director, at any level (§9, §14.12). */
export const HUMAN_ONLY_ACTIONS = [
  'merge',
  'accept_knowledge',
  'answer_question',
  'change_goal',
] as const;
export type HumanOnlyAction = (typeof HUMAN_ONLY_ACTIONS)[number];

export const AUTONOMY_PROPOSAL_ID_PATTERN = new RegExp(`^AP-${ULID_PATTERN.source.slice(1, -1)}$`);
export const AutonomyProposalIdSchema = z
  .string()
  .regex(AUTONOMY_PROPOSAL_ID_PATTERN, 'must look like AP-<ulid>');

/** One gated change, with what applying it needs. */
export const CoordinatorChangeSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('add_child'),
      title: z.string().trim().min(1).max(200),
      goal: z.string().trim().min(1).max(CONTRACT_BODY_MAX_CHARS),
      repo: z.string().min(1).optional(),
    })
    .strict(),
  z.object({ action: z.literal('add_waits_on'), child: UlidSchema, on: UlidSchema }).strict(),
  z
    .object({
      action: z.literal('set_owner'),
      child: UlidSchema,
      owns: z.array(Glob).max(PLAN_LIST_MAX),
    })
    .strict(),
  z
    .object({
      action: z.literal('approve_contract'),
      contract: ContractIdSchema,
      title: z.string().trim().min(1).max(CONTRACT_TITLE_MAX_CHARS),
      body: ContractBody,
      parties: z.array(UlidSchema).max(PLAN_LIST_MAX),
      reason: z.string().max(400).optional(),
      routine: z.boolean().optional(),
      /** T285: the child's proposal this approves; dropped from the contract when applied. */
      proposal: ContractProposalIdSchema.optional(),
    })
    .strict(),
]);
export type CoordinatorChange = z.infer<typeof CoordinatorChangeSchema>;

/**
 * `proposals/<AP-id>.yaml`: a gated change held at Advise (or a
 * non-routine contract change at any level) until the human clicks Apply
 * on its inbox card, or dismisses it.
 */
export const AutonomyProposalSchema = z
  .object({
    id: AutonomyProposalIdSchema,
    /** The coordinating node the change is on. */
    node: UlidSchema,
    principal: z.enum(['coordinator', 'director']),
    /** `agent:<session>` when a session asked. */
    by: z.string().min(1),
    change: CoordinatorChangeSchema,
    summary: z.string().min(1).max(800),
    status: z.enum(['open', 'applied', 'dismissed']),
    created_at: z.string().datetime(),
    decided_at: z.string().datetime().optional(),
  })
  .strict();
export type AutonomyProposal = z.infer<typeof AutonomyProposalSchema>;

export function validateAutonomyProposal(input: unknown): AutonomyProposal {
  const result = AutonomyProposalSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('AutonomyProposal', result.error));
  return result.data;
}
