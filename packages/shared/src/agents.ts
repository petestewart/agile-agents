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
 *
 * `pid` (T012 review round 3, opus item 3): made optional. It used to be
 * `z.number().int().positive()` with every writer (`runner/session.ts`'s
 * registration, `StateStore.heartbeat`, `Bus.heartbeat`) falling back to
 * `process.pid` — the *daemon's own* pid — whenever a spawned agent's real
 * pid wasn't known yet. That silently pointed an operator's "kill -9 the
 * pid on record" recovery step at the daemon itself in exactly the case
 * (a spawn failure, or a fresh registration racing the child's first
 * scheduler tick) it's least safe to guess. Now: no pid at all is a valid,
 * honest `AgentRecord` — every writer omits the field (and logs a warning
 * event) rather than substituting the daemon's pid — and every reader
 * (the crash-recovery path included) must treat `pid: undefined` as "not
 * yet known", never as "assume the daemon".
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
    // Optional (T012 round 3) — see this file's header. Still a positive
    // int whenever it IS set; never a sentinel like 0/-1 for "unknown".
    pid: z.number().int().positive().optional(),
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
