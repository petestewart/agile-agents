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
import { MessageBodySchema } from './agent-message';
import { AgentIdSchema, ULID_PATTERN, UlidSchema, formatZodError } from './ids';

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
 *
 * T145 adds the one resolution a human never types: `superseded`, written
 * by the daemon when a gate on the same session is decided while this
 * question is still open. The live run left such a question open forever —
 * the operator had already answered the thing in front of them (the gate),
 * and nothing closed the `ask` beside it. The RPC edge still accepts
 * `reply` and nothing else (`questions/rpc.ts`): only the daemon supersedes.
 */
/**
 * T502 (D62, design/chat-threads.md §5) adds `settled`: the agent's own
 * `settle_question`, after the operator talked back to a choice question
 * instead of picking. Only the agent verb writes it; the RPC edge and the
 * browser still answer with `reply`.
 */
export const QUESTION_RESOLUTIONS = ['reply', 'superseded', 'settled'] as const;
export const QuestionResolvedAsSchema = z.enum(QUESTION_RESOLUTIONS);
export type QuestionResolvedAs = z.infer<typeof QuestionResolvedAsSchema>;

/**
 * Question/answer text is capped at the same 800 chars as a thread entry
 * body (CLAUDE.md "Signal over volume at every boundary") — it becomes
 * exactly that when the answer is appended to the thread. Non-empty, same
 * as `HilNoteSchema`.
 */
export const QuestionTextSchema = MessageBodySchema.min(1, 'must not be empty');

/**
 * T361: the choices an agent's `ask` may offer, shown as buttons (the
 * operator can still type an answer). One line each, a handful at most.
 */
export const QUESTION_OPTIONS_MIN = 2;
export const QUESTION_OPTIONS_MAX = 6;
export const QUESTION_OPTION_MAX_CHARS = 200;
export const QuestionOptionSchema = z.string().trim().min(1).max(QUESTION_OPTION_MAX_CHARS);
export const QuestionChoicesSchema = z
  .array(QuestionOptionSchema)
  .min(QUESTION_OPTIONS_MIN)
  .max(QUESTION_OPTIONS_MAX);

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
    /**
     * T338: a part's question about a shared thing (a sibling, a contract,
     * the plan) goes to its coordinator first: this is that parent node. It
     * stays out of the operator's inbox while the coordinator is live and
     * has not passed it up (`passed_up_at`); approving the parent's plan
     * supersedes it.
     */
    coordinator: UlidSchema.optional(),
    passed_up_at: z.string().datetime().optional(),
    status: QuestionStatusSchema,
    /** ISO-8601, mirrors `HilRequest.requested_at`. */
    raised_at: z.string().datetime(),
    answer: QuestionTextSchema.optional(),
    resolved_as: QuestionResolvedAsSchema.optional(),
    answered_by: z.string().min(1).optional(),
    answered_at: z.string().datetime().optional(),
    /**
     * T502 (D62): the agent asked again while this one waited on its
     * settle: the newer question this one was superseded by. Its thread
     * carries on under that one (one thread on the chat).
     */
    superseded_by: QuestionIdSchema.optional(),
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
      for (const field of [
        'answer',
        'resolved_as',
        'answered_by',
        'answered_at',
        'superseded_by',
      ] as const) {
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

/**
 * T502 (design/chat-threads.md §5, §8 step 1): where a question's thread
 * stands. Derived from its record, its thread lines and their deliveries,
 * never stored.
 *
 * - `waits_on_you`: open, and nothing you wrote is with the agent.
 * - `waiting_on_agent`: you replied to a choice question (D62); the agent
 *   has not finished the turn your reply started.
 * - `unsettled`: that turn finished without a settle or a re-ask: a Needs
 *   me row, "<Agent> didn't settle …".
 * - `with_coordinator`: a part's question its coordinator has first (T338).
 * - `resolved`: answered, settled or superseded.
 */
export const QUESTION_THREAD_STATES = [
  'waits_on_you',
  'waiting_on_agent',
  'unsettled',
  'with_coordinator',
  'resolved',
] as const;
export const QuestionThreadStateSchema = z.enum(QUESTION_THREAD_STATES);
export type QuestionThreadState = z.infer<typeof QuestionThreadStateSchema>;

/** How many thread lines one question thread lists (a page reads at most 500). */
export const QUESTION_THREAD_ENTRIES_MAX = 500;

/**
 * T502: one question's thread, as the node page (and a coordinator's chat,
 * D63) reads it. `entries` are the thread `ts` of its lines on its node:
 * the question (and the ones it re-asked), your replies, the agent's turns
 * those replies started (by cause, design §4.1), the answer. No thread
 * entry carries a new field (that is T503's): this is derived.
 */
export const QuestionThreadSchema = z
  .object({
    /** The question the thread is about now: the newest of a re-asked chain. */
    question: QuestionIdSchema,
    /** The questions it carries on from (re-asked, D62), oldest first. */
    earlier: z.array(QuestionIdSchema).max(50),
    stream: UlidSchema,
    text: QuestionTextSchema,
    options: z.array(QuestionOptionSchema).min(1).max(QUESTION_OPTIONS_MAX).optional(),
    state: QuestionThreadStateSchema,
    /** The asking agent's vendor (`codex`), when its session is on the node. */
    vendor: z.string().min(1).max(80).optional(),
    /** Your replies in the thread (the whole chain). */
    replies: z.number().int().nonnegative(),
    entries: z.array(z.string().min(1)).max(QUESTION_THREAD_ENTRIES_MAX),
    raised_at: z.string().datetime(),
    answer: QuestionTextSchema.optional(),
    resolved_as: QuestionResolvedAsSchema.optional(),
    /**
     * D63: on a coordinator's chat, the child it was asked on, and the
     * coordinator's own lines its question caused (`ts` on the coordinator's
     * thread): its notes.
     */
    node_title: z.string().min(1).max(200).optional(),
    notes: z.array(z.string().min(1)).max(QUESTION_THREAD_ENTRIES_MAX).optional(),
  })
  .strict();
export type QuestionThread = z.infer<typeof QuestionThreadSchema>;

/** T502: the question a thread line's `ref` (`questions/<id>.yaml`) names, or undefined. */
export function questionIdOfThreadRef(ref: string | undefined): QuestionId | undefined {
  return ref?.match(/^questions\/(Q-[0-9A-HJKMNP-TV-Z]{26})\.yaml$/)?.[1];
}

export function validateQuestion(input: unknown): Question {
  const result = QuestionSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Question', result.error));
  }
  return result.data;
}
