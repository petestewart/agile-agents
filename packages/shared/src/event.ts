/**
 * Event — one line of `<home>/log/events.jsonl` (cockpit design §7.4).
 *
 * "`log/events.jsonl` in the home, append-only, one writer, fsync on gate
 * and land events. Event kinds reduce to: stream · thread · session ·
 * question · gate · rule · hook · land."
 *
 * T123 prunes `EVENT_KINDS` to exactly the kinds a surviving emitter mints,
 * grouped by those eight families (plus the small home-config family the
 * store still writes). Two invariants are tested in `event.test.ts` and
 * `store/events.test.ts`: every kind in the enum has at least one emitter,
 * and every emitter uses a kind in the enum.
 *
 * The record is `{ts, kind, data}` plus three optional scopes: `stream`
 * (the ULID `agile tail --stream` filters on), `session` (the agent session
 * a runner/hook event came from) and `agent` (the pre-reshape agent id the
 * hook path and the agent registry still identify their caller by; it goes
 * when T130 replaces that registry with sessions). `ticket` is gone with
 * the ticket layer T122 deleted — a survivor that still knows a ticket id
 * puts it in `data`.
 */

import { z } from 'zod';
import { UlidSchema, formatZodError } from './ids';

export const EVENT_KINDS = [
  // -- stream (store.createStream / store.updateStream, via StreamService) --
  // data: {stream, agent_status, human_status, archived, parent?, repo?,
  // principal?} — the status pair is what makes `reconstructStreams` able to
  // rebuild every stream's state from the log alone (§7.4's reconstruction
  // test).
  'stream_created',
  'stream_updated',
  'stream_closed',
  'stream_archived',

  // -- thread (store.appendThreadEntry) --  data: {stream, by, entry_kind}
  'thread_appended',

  // -- session --
  // The runner's ACP observation (§8 adapter contract) and the agent
  // registry the runner registers itself in. T130 replaces the registry
  // with real session records and `session_started`/`session_ended`/
  // `session_error`; until then these three are what the runner actually
  // emits, so they stay.
  'tool_call',
  'agent_put',
  'agent_deleted',

  // -- question (QuestionService) --  data: {id, stream, text|answer}
  'question_raised',
  'question_answered',

  // -- gate (GateService) --  data: {id, gate, owner, decision?, note?}
  // `breaker_*` is part of the gate family: the breaker is the switch that
  // forces every gate to `human`, and `GateService.trip`/`clear` mint them.
  'gate_raised',
  'gate_resolved',
  'breaker_tripped',
  'breaker_cleared',

  // -- rule (StateStore.createRule / updateRule, via RulesService) --
  // data: {id, status, enforcement, scope, principal?} — `rule_decided` is
  // the human's accept/retire (the one write that moves `status`), and it is
  // split from `rule_put` so the audit trail shows a decision as a decision
  // rather than as another edit.
  'rule_put',
  'rule_decided',

  // -- hook (HookService + the ACP permission responder) --
  // data: {event, decision, reason, tool?, command?}
  'hook_decision',

  // -- land --  none yet; T141 adds `land_*` with its emitter.

  // -- home config + generic store writes --
  // `repos.yaml` / `vendors.yaml` / the permission policy, and the generic
  // entity trio every not-yet-dedicated record (question, gate, breaker,
  // bus message file) is written through.
  'repos_put',
  'vendors_put',
  'policy_put',
  'entity_put',
  'entity_deleted',

  // -- bus --  the one message event; T130 prunes it with the bus itself.
  'message',
] as const;
export const EventKindSchema = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKindSchema>;

export const EventSchema = z
  .object({
    ts: z.string().min(1),
    kind: EventKindSchema,
    /** The stream this event is about — what `agile tail --stream` filters on. */
    stream: UlidSchema.optional(),
    /** The agent session this event came from — `agile tail --session`. */
    session: z.string().min(1).optional(),
    /** Pre-reshape agent id (hook path + agent registry); goes with T130. */
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
