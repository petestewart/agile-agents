/**
 * Event (design/agile-agents-design.md §3 "Concepts beyond the original
 * brief" — "Observability: append-only event log of every message, hook
 * decision, and state transition" — and §4 layout, `log/events.jsonl`).
 *
 * DESIGN-GAP: no yaml/json example is given for an event line anywhere in
 * §4–§5 (unlike every other entity). The shape below is the minimal
 * superset implied by the three named event sources: a kind discriminator,
 * a timestamp, optional ticket/agent scoping (every source names one or
 * both), and a free-form payload for the source-specific detail (the
 * message itself, the hook's allow/deny + reason, or the from/to status).
 */

import { z } from 'zod';
import { TicketIdSchema, formatZodError } from './ids';

/**
 * `quota_low` / `quota_exhausted` are added alongside the three prose-named
 * sources: §4 "Quota" / §10 "Quota-driven pause and handoff" name them as
 * "Bus events" that drive daemon-side routing/reassignment decisions, which
 * is exactly the kind of state transition this log exists to record.
 */
export const EVENT_KINDS = [
  'message',
  'hook_decision',
  'state_transition',
  'quota_low',
  'quota_exhausted',
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventSchema = z
  .object({
    ts: z.string().min(1),
    kind: EventKindSchema,
    ticket: TicketIdSchema.optional(),
    agent: z.string().min(1).optional(),
    data: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type Event = z.infer<typeof EventSchema>;

export function validateEvent(input: unknown): Event {
  const result = EventSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Event', result.error));
  }
  return result.data;
}
