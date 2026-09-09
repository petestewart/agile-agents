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
 *
 * DESIGN-GAP (T012): `role`/`worktree`/`session_id` are additive optional
 * fields granted to this ticket for the agent runner (design/
 * agile-agents-design.md §8 "Adapter contract" needs to record which role a
 * registered agent is playing, which worktree it's running in, and the live
 * ACP `session/new` id for `session/load` recovery). All three are optional
 * so every pre-T012 `AgentRecord` (and every write through
 * `StateStore.heartbeat`/`Bus.heartbeat`, which reconstruct the record from
 * only the five original fields and do not thread these three through) still
 * validates — `packages/daemon/src/runner/session.ts` documents how it keeps
 * them from being silently dropped by an intervening heartbeat rewrite.
 */

import { z } from 'zod';
import { TicketIdSchema, formatZodError } from './ids';

/** Roles T012's runner spawns a session for. Architect/EM registration is out of this ticket's scope (§8 names engineer/reviewer/qa as the spawned role sessions). */
export const AGENT_RUNNER_ROLES = ['engineer', 'reviewer', 'qa'] as const;
export const AgentRunnerRoleSchema = z.enum(AGENT_RUNNER_ROLES);
export type AgentRunnerRole = z.infer<typeof AgentRunnerRoleSchema>;

export const AgentRecordSchema = z
  .object({
    vendor: z.string().min(1),
    model: z.string().min(1),
    // An idle agent (just spawned, or between tickets) has none.
    ticket: TicketIdSchema.optional(),
    pid: z.number().int().positive(),
    last_seen: z.string().min(1),
    role: AgentRunnerRoleSchema.optional(),
    worktree: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
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
