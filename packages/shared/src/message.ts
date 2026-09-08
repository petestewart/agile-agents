/**
 * Message (design/agile-agents-design.md §5 "Comms bus" → "Message", plus
 * fields §5 defines in prose outside that one yaml block: "Questions"
 * (`promote_to`), "HIL" (hil sub-`kind` + `deadline`), "Delivery by
 * priority" (`fyi`), "Ordering / failure" (`deadline` on `requires_ack`
 * re-delivery), and §4 "Quota" / §10 (`quota_low`, `quota_exhausted` bus
 * events).
 *
 * Body size cap is a CLAUDE.md tunable (800 chars) and is enforced here so
 * every producer gets the same rejection rather than relying on the daemon
 * alone.
 */

import { z } from 'zod';
import { AgentIdSchema, TicketIdSchema, UlidSchema, formatZodError } from './ids';

export const MESSAGE_BODY_MAX_CHARS = 800;

/**
 * The §5 yaml block's `kind:` line is a pipe-separated illustration, not the
 * closed set — `fyi` (§5 "Delivery by priority", §16 delegated gates) and
 * `quota_low` / `quota_exhausted` (§4 "Quota", §10 "Quota-driven pause and
 * handoff" — both named as "Bus events") are mandated elsewhere in the doc
 * and are included here.
 */
export const MESSAGE_KINDS = [
  'assign',
  'question',
  'answer',
  'discovery',
  'halt',
  'resume',
  'decision',
  'review_request',
  'review_verdict',
  'qa_verdict',
  'escalate',
  'standup_call',
  'standup_report',
  'hil_request',
  'hil_response',
  'fyi',
  'quota_low',
  'quota_exhausted',
] as const;
export const MessageKindSchema = z.enum(MESSAGE_KINDS);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const MESSAGE_PRIORITIES = ['urgent', 'normal', 'low'] as const;
export const MessagePrioritySchema = z.enum(MESSAGE_PRIORITIES);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

/** `to: [em]`, or broadcast, or `ticket:<id>` fan-out (§5 "Message"). */
export const MessageRecipientSchema = z.union([
  AgentIdSchema,
  z.literal('broadcast'),
  z.string().regex(/^ticket:TKT-\d{4,}$/, 'must look like ticket:TKT-0231'),
]);
export type MessageRecipient = z.infer<typeof MessageRecipientSchema>;

export const MessageBodySchema = z
  .string()
  .max(
    MESSAGE_BODY_MAX_CHARS,
    `message body exceeds the ${MESSAGE_BODY_MAX_CHARS}-char cap — write the payload to a file and reference it via refs`,
  );

/**
 * "Every `answer` carries `promote_to: none | kb | decision` so it gets
 * written down once" (§5 "Questions").
 */
export const PROMOTE_TO_VALUES = ['none', 'kb', 'decision'] as const;
export const PromoteToSchema = z.enum(PROMOTE_TO_VALUES);
export type PromoteTo = z.infer<typeof PromoteToSchema>;

/**
 * "`hil_request` has `kind: approve_decision | steer | demo | unblock`"
 * (§5 "HIL"). Named `hil_kind` (a distinct field, not nested) to avoid
 * colliding with the envelope-level `kind` (`hil_request`/`hil_response`
 * etc.) that every message carries.
 */
export const HIL_KINDS = ['approve_decision', 'steer', 'demo', 'unblock'] as const;
export const HilKindSchema = z.enum(HIL_KINDS);
export type HilKind = z.infer<typeof HilKindSchema>;

export const MessageSchema = z
  .object({
    id: UlidSchema,
    ts: z.string().min(1),
    from: AgentIdSchema,
    to: z.array(MessageRecipientSchema).min(1),
    kind: MessageKindSchema,
    priority: MessagePrioritySchema,
    ticket: TicketIdSchema.optional(),
    reply_to: UlidSchema.optional(),
    body: MessageBodySchema,
    refs: z.array(z.string().min(1)).default([]),
    requires_ack: z.boolean().default(false),
    // "and a deadline; daemon holds the related halt or sprint review until
    // hil_response" (§5 "HIL") — also the redelivery deadline for any
    // `requires_ack` message ("Unacked requires_ack past deadline
    // re-delivers one priority up", §5 "Ordering / failure").
    deadline: z.string().min(1).optional(),
    promote_to: PromoteToSchema.optional(),
    hil_kind: HilKindSchema.optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.kind === 'hil_request' && message.hil_kind === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hil_kind'],
        message: 'hil_request messages must carry a hil_kind (§5 "HIL")',
      });
    }
    if (message.kind === 'hil_request' && message.deadline === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deadline'],
        message: 'hil_request messages must carry a deadline (§5 "HIL")',
      });
    }
    if (message.kind === 'answer' && message.promote_to === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['promote_to'],
        message: 'answer messages must carry promote_to (§5 "Questions")',
      });
    }
  });

export type Message = z.infer<typeof MessageSchema>;

export function validateMessage(input: unknown): Message {
  const result = MessageSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Message', result.error));
  }
  return result.data;
}
