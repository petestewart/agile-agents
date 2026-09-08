/**
 * AgentRecord — bus agent registry entry (design/agile-agents-design.md §5
 * "Comms bus" → "Storage": "`agents/<agent>.yaml   # registry: vendor,
 * model, ticket, pid, last_seen`"; `last_seen` is the input to the
 * dead-agent path in §5 "Liveness": "`last_seen` older than N minutes with
 * ticket `in_progress` → daemon sends `escalate` to em, ticket back to
 * `ready`").
 *
 * DESIGN-GAP: no literal yaml block is given for this file anywhere in
 * §4–§5 (only the one-line directory-listing comment above); the schema is
 * the five named fields directly, nothing added.
 */

import { z } from 'zod';
import { TicketIdSchema, formatZodError } from './ids';

export const AgentRecordSchema = z
  .object({
    vendor: z.string().min(1),
    model: z.string().min(1),
    // An idle agent (just spawned, or between tickets) has none.
    ticket: TicketIdSchema.optional(),
    pid: z.number().int().positive(),
    last_seen: z.string().min(1),
  })
  .strict();

export type AgentRecord = z.infer<typeof AgentRecordSchema>;

export function validateAgentRecord(input: unknown): AgentRecord {
  const result = AgentRecordSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('AgentRecord', result.error));
  }
  return result.data;
}
