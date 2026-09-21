/**
 * `AgentRecord` — the registry entry for one **attached session**
 * (`bus/agents/<session id>.yaml`).
 *
 * T130 re-keyed this from the ticket model to streams. The record is what
 * the hook path resolves a tool call's `cwd` to (design/cockpit-design.md
 * §8.1 step 1: "resolve the session → stream → repo. Unresolvable ⇒ DENY"),
 * so it carries exactly what that resolution needs: which stream, which
 * role, which worktree, plus the vendor/model/pid/last_seen the registry
 * has always had. `ticket` and the four ticket-era roles
 * (engineer/reviewer/qa/architect) are gone with the ticket model; `role`
 * is the two-role `SessionRole` (**D3**).
 *
 * `last_seen` is still the liveness input (`hook/service.ts` refuses to
 * resolve a stale record). `pid` stays optional and is never substituted
 * with the daemon's own pid — "no pid at all is a valid, honest
 * `AgentRecord`", so an operator's "kill the pid on record" can never point
 * at `agiled` itself.
 */

import { z } from 'zod';
import { UlidSchema, formatZodError } from './ids';
import { SessionRoleSchema } from './stream';

export const AgentRecordSchema = z
  .object({
    vendor: z.string().min(1),
    model: z.string().min(1),
    /** The stream this session is attached to. */
    stream: UlidSchema.optional(),
    /** Still a positive int whenever set; never a sentinel like 0/-1 for "unknown". */
    pid: z.number().int().positive().optional(),
    last_seen: z.string().min(1),
    role: SessionRoleSchema.optional(),
    worktree: z.string().min(1).optional(),
    /** The vendor's own ACP `session/new` id, for `session/load` recovery. */
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
