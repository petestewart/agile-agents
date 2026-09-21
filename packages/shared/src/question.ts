/**
 * Question — an agent (or the operator) at a fork that needs the human
 * (design/cockpit-design.md §1.4 "The question flow", §3 "The inbox").
 *
 * T121 re-keys the record to the reshape's unit of work: a question is
 * raised **on a stream**, never on a ticket, and the only resolution left
 * is a reply. Answering one appends an `answer` entry to the stream thread
 * and unblocks the waiting session; recording a decision or editing a
 * ticket went with the oracle and the ticket model.
 *
 * One file per question, `questions/Q-<ulid>.yaml` under the state home
 * (`AGILE_HOME`, §7.2 — a sibling of `streams/` and `threads/`), written
 * and read only through the daemon's store
 * (`packages/daemon/src/questions/service.ts` is the one writer).
 *
 * "Questions are records with a status, not mail" (§1.4): the inbox reads
 * these files, never the bus, so a leftover message from a previous daemon
 * run cannot surface as a question.
 */

import { z } from 'zod';
import { AgentIdSchema, ULID_PATTERN, UlidSchema, formatZodError } from './ids';
import { MessageBodySchema } from './message';

/**
 * `Q-<ulid>` — same shape and rationale as `HIL-<ulid>` (`hil.ts`): raised
 * by daemon-internal code at whatever rate agents ask, so a sortable,
 * collision-free ulid fits better than a hand-assigned numeric id.
 */
export const QuestionIdSchema = z
  .string()
  .regex(new RegExp(`^Q-${ULID_PATTERN.source.slice(1, -1)}$`), 'must look like Q-<ulid>');
export type QuestionId = z.infer<typeof QuestionIdSchema>;

export const QUESTION_STATUSES = ['open', 'answered'] as const;
export const QuestionStatusSchema = z.enum(QUESTION_STATUSES);
export type QuestionStatus = z.infer<typeof QuestionStatusSchema>;

/**
 * T121: the union shrank to one member. `decision` (a `DEC-####` id) and
 * `ticket` (a `TKT-####` edit) went with the oracle and the ticket model;
 * an answer is a reply that reaches the waiting session, and the permanent
 * record is the stream thread.
 */
export const QuestionResolvedAsSchema = z.literal('reply');
export type QuestionResolvedAs = z.infer<typeof QuestionResolvedAsSchema>;

/**
 * Question/answer text is capped at the same 800 chars as a thread entry
 * body (CLAUDE.md "Signal over volume at every boundary") — it becomes
 * exactly that when the answer is appended to the thread. Non-empty, same
 * as `HilNoteSchema`.
 */
export const QuestionTextSchema = MessageBodySchema.min(1, 'must not be empty');

export const QuestionSchema = z
  .object({
    id: QuestionIdSchema,
    /** The stream this question is about (§1.4) — required, never a ticket. */
    stream: UlidSchema,
    /** Who is asking: an agent role id, or `human` when the operator raises one from the UI. */
    raised_by: AgentIdSchema,
    /**
     * The vendor session that is blocked on the answer, when one is. It is
     * half of the delivery key (stream + session) that replaced the ticket
     * assignee lookup, and it is what the thread entry is attributed to
     * (`by: agent:<session>`).
     */
    session: UlidSchema.optional(),
    text: QuestionTextSchema,
    /** Answer options the raiser offered (an agent at a fork), if any. */
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
