/**
 * Question — the open half of "Questions vs Decisions"
 * (design/agile-agents-design.md §17 "Control room v2"): "A Question is
 * unresolved: an architect at a fork, an engineer who thinks the ticket is
 * wrong (the missing `escalate` handler lands here), the EM flagging a gap,
 * or the operator. Answering one records a Decision, edits a ticket or rule,
 * or is just a reply. Decisions is the permanent record of answered
 * questions that changed something. Both need a file home;
 * `board/questions/` is proposed."
 *
 * One file per question, `board/questions/Q-<ulid>.yaml` — a sibling of
 * `board/hil/`, `board/halts/`, `board/status/`, written/read only through
 * the daemon's store (`packages/daemon/src/questions/service.ts` is the one
 * writer). The new `board/` subdirectory is a new artifact type, named by
 * the design section above and pre-approved by the operator for this run;
 * see the PLAN Decisions log.
 */

import { z } from 'zod';
import {
  AgentIdSchema,
  DecisionIdSchema,
  TicketIdSchema,
  ULID_PATTERN,
  formatZodError,
} from './ids';
import { MessageBodySchema } from './message';

/**
 * `Q-<ulid>` — same shape and rationale as `HIL-<ulid>` (`hil.ts`): raised by
 * daemon-internal code (the `escalate` handler) at whatever rate agents
 * escalate, so a sortable, collision-free ulid fits better than a
 * hand-assigned numeric id like `H-12`.
 */
export const QuestionIdSchema = z
  .string()
  .regex(new RegExp(`^Q-${ULID_PATTERN.source.slice(1, -1)}$`), 'must look like Q-<ulid>');
export type QuestionId = z.infer<typeof QuestionIdSchema>;

export const QUESTION_STATUSES = ['open', 'answered'] as const;
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/**
 * "`resolved_as` = decision id | ticket edit | reply" (ticket scope). The
 * three shapes are distinguishable without a tag: a published decision is
 * its `DEC-####` id, a ticket edit is the `TKT-####` id that was edited, and
 * a plain reply is the literal `reply`.
 */
export const QuestionResolvedAsSchema = z.union([
  z.literal('reply'),
  DecisionIdSchema,
  TicketIdSchema,
]);
export type QuestionResolvedAs = z.infer<typeof QuestionResolvedAsSchema>;

/**
 * Question/answer text is capped at the same 800 chars as a bus message body
 * (CLAUDE.md "Signal over volume at every boundary") — it becomes exactly
 * that when the answer is delivered to the raiser's inbox. Non-empty, same
 * as `HilNoteSchema`.
 */
export const QuestionTextSchema = MessageBodySchema.min(1, 'must not be empty');

export const QuestionSchema = z
  .object({
    id: QuestionIdSchema,
    /** Who is asking: an engineer, the architect, the EM, or `human` (§17 v2 names all four). */
    raised_by: AgentIdSchema,
    /** The ticket the question is about, when it is about one. */
    ticket: TicketIdSchema.optional(),
    text: QuestionTextSchema,
    /** Answer options the raiser offered (an architect at a fork), if any. */
    options: z.array(z.string().min(1)).min(1).optional(),
    status: QuestionStatusSchema,
    /** ISO-8601, mirrors `HilRequest.requested_at`. */
    raised_at: z.string().datetime(),
    answer: QuestionTextSchema.optional(),
    resolved_as: QuestionResolvedAsSchema.optional(),
    answered_by: z.string().min(1).optional(),
    answered_at: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((question, ctx) => {
    // An answered question must actually carry its answer and how it was
    // resolved; an open one must carry neither (the status line is the
    // state, exactly like `HilRequest.status`).
    if (question.status === 'answered') {
      for (const field of ['answer', 'resolved_as'] as const) {
        if (question[field] === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `an answered question must carry "${field}"`,
          });
        }
      }
    } else {
      for (const field of ['answer', 'resolved_as', 'answered_by', 'answered_at'] as const) {
        if (question[field] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `an open question must not carry "${field}"`,
          });
        }
      }
    }
  });
export type Question = z.infer<typeof QuestionSchema>;

export function validateQuestion(input: unknown): Question {
  const result = QuestionSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Question', result.error));
  }
  return result.data;
}
