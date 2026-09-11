/**
 * MergeRecord (design/agile-agents-design.md §15 "Git model and teams":
 * "Merge cadence: ticket -> integration on done ... integration -> main at
 * sprint review"). `.agile/board/merges/<ticket>.yaml` — one file per
 * ticket, overwritten on each merge attempt, holding the outcome the merge
 * and integration owner (T019, `packages/daemon/src/merge/**`) most
 * recently recorded for it.
 *
 * DESIGN-GAP: the design never gives a yaml example for a merge-outcome
 * record the way it does for `Halt`/`HilRequest`/etc. — this schema is the
 * minimal shape `packages/daemon/src/merge/owner.ts` needs to answer
 * `merge.status` and to survive a daemon restart, named and shaped after
 * the sibling entities it sits alongside (`board/hil/`, `board/halts/`,
 * `board/status/`).
 */

import { z } from 'zod';
import { HaltIdSchema, TicketIdSchema, formatZodError } from './ids';

/**
 * `merged`: landed on `integration` (or `integration` landed on `main`, for
 * a ticket-less record — see `MergeOwner.mergeIntegrationToMain`, which
 * does not write a per-ticket record at all, only the `integration_merged_
 * to_main` event; `merged` here is always a per-ticket outcome).
 * `conflict` / `test_failed`: a scoped halt was raised instead (§15:
 * "conflicts bounce to the ticket owner as a scoped halt").
 * `gated`: `integration -> main` was refused for lack of an approved
 * `sprint_review` gate (§16) — not written to a per-ticket record either
 * (see above); included in the enum for `MergeOwner`'s in-memory outcome
 * type, which this schema doubles as the validator for.
 */
export const MERGE_OUTCOME_STATUSES = ['merged', 'conflict', 'test_failed', 'gated'] as const;
export const MergeOutcomeStatusSchema = z.enum(MERGE_OUTCOME_STATUSES);
export type MergeOutcomeStatus = z.infer<typeof MergeOutcomeStatusSchema>;

/** "keep if stale/abandoned" (T019 ticket scope) — see `owner.ts`'s `keepReasonFor`. */
export const MERGE_KEEP_REASONS = ['stale', 'abandoned'] as const;
export const MergeKeepReasonSchema = z.enum(MERGE_KEEP_REASONS);
export type MergeKeepReason = z.infer<typeof MergeKeepReasonSchema>;

export const MergeRecordSchema = z
  .object({
    ticket: TicketIdSchema,
    status: MergeOutcomeStatusSchema,
    at: z.string().datetime(),
    /** Conflict/test-failure summary — the same text the scoped halt carries as its `reason`. */
    summary: z.string().min(1).optional(),
    /** The halt raised for a `conflict`/`test_failed` outcome. */
    haltId: HaltIdSchema.optional(),
    /** The ticket branch head when a `conflict` was recorded — the fix cycle is resolved once the engineer has moved it (see `MergeOwner.conflictResolved`). */
    branchHead: z.string().min(1).optional(),
    /** The `integration` merge commit sha for a `merged` outcome. */
    mergeCommit: z.string().min(1).optional(),
    worktreeKept: z.boolean().optional(),
    keepReason: MergeKeepReasonSchema.optional(),
  })
  .strict();

export type MergeRecord = z.infer<typeof MergeRecordSchema>;

export function validateMergeRecord(input: unknown): MergeRecord {
  const result = MergeRecordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('MergeRecord', result.error));
  }
  return result.data;
}
