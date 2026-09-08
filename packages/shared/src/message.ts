/**
 * Message (design/agile-agents-design.md §5 "Comms bus" → "Message").
 *
 * Body size cap is a CLAUDE.md tunable (800 chars) and is enforced here so
 * every producer gets the same rejection rather than relying on the daemon
 * alone.
 */

import { z } from 'zod';
import { AgentIdSchema, TicketIdSchema, UlidSchema, formatZodError } from './ids';

export const MESSAGE_BODY_MAX_CHARS = 800;

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

export const MessageSchema = z.object({
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
});

export type Message = z.infer<typeof MessageSchema>;

export function validateMessage(input: unknown): Message {
  const result = MessageSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Message', result.error));
  }
  return result.data;
}
