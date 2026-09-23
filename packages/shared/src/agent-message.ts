/**
 * AgentMessage — a note filed in one session's bus inbox
 * (`bus/inbox/<agent>/<ulid>.yaml`) and handed to that session by its hooks
 * (`hook/decide.ts`: urgent denies, normal is injected as additional
 * context, low is drained at `Stop`). T168 narrowed it from the old team
 * `Message` envelope to the two kinds the reshape still writes: a
 * `hil_response` (a human's note on the gate a session is parked on,
 * `gates/service.ts`) and a `hil_request` (the ACP permission responder's
 * record of a routed call, `permissions/responder.ts`).
 *
 * Also home to the 800-char body cap (CLAUDE.md tunable) and the closed set
 * of gate kinds, which every other schema imports from here.
 */

import { z } from 'zod';
import { AgentIdSchema, UlidSchema, formatZodError } from './ids';

export const MESSAGE_BODY_MAX_CHARS = 800;

export const MessageBodySchema = z
  .string()
  .max(
    MESSAGE_BODY_MAX_CHARS,
    `message body exceeds the ${MESSAGE_BODY_MAX_CHARS}-char cap — write the payload to a file and reference it via refs`,
  );

/**
 * The closed set of gate kinds after the reshape (design/cockpit-design.md
 * §3.1): `land` (the Land button, when the repo policy asks for a gate),
 * `rule_accept` (lessons at stream close, or an agent's `propose_rule`) and
 * `classifier_review` (the hook's route band, §6.3).
 */
export const HIL_KINDS = ['land', 'rule_accept', 'classifier_review'] as const;
export const HilKindSchema = z.enum(HIL_KINDS);
export type HilKind = z.infer<typeof HilKindSchema>;

export const AGENT_MESSAGE_KINDS = ['hil_request', 'hil_response'] as const;
export const AgentMessageKindSchema = z.enum(AGENT_MESSAGE_KINDS);
export type AgentMessageKind = z.infer<typeof AgentMessageKindSchema>;

/** How the hook delivers it: `urgent` denies the next call, `normal` is injected, `low` waits for `Stop`. */
export const MESSAGE_PRIORITIES = ['urgent', 'normal', 'low'] as const;
export const MessagePrioritySchema = z.enum(MESSAGE_PRIORITIES);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

export const AgentMessageSchema = z
  .object({
    id: UlidSchema,
    ts: z.string().min(1),
    from: AgentIdSchema,
    to: z.array(AgentIdSchema).min(1),
    kind: AgentMessageKindSchema,
    priority: MessagePrioritySchema,
    body: MessageBodySchema,
    refs: z.array(z.string().min(1)).default([]),
    hil_kind: HilKindSchema.optional(),
  })
  .strict()
  .superRefine((message, ctx) => {
    if (message.kind === 'hil_request' && message.hil_kind === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hil_kind'],
        message: 'hil_request messages must carry a hil_kind',
      });
    }
  });

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export function validateAgentMessage(input: unknown): AgentMessage {
  const result = AgentMessageSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('AgentMessage', result.error));
  }
  return result.data;
}
