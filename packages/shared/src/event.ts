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
 *
 * DESIGN-GAP (T005 review fix, manager decision B1): the acceptance
 * criterion "every mutation produces exactly one event", read literally,
 * means every `StateStore` write mints a `log/events.jsonl` line, not only
 * ticket transitions. The design never enumerates a kind per mutation kind
 * (only the three prose sources above), so the remaining kinds below are
 * named directly after the store method that produces them — one per
 * distinct mutation shape T005/T005-fix wires up, snake_case, short:
 * `ticket_put` (`StateStore.putTicket`), `stanza_appended` (`appendStanza`),
 * `oracle_put` (`putOracleEntry`), `kb_put` (`putKbFact`),
 * `ledger_appended` (`appendLedgerLine`), `halt_created`/`halt_released`
 * (`putHalt`/`deleteHalt` — §4 "Halts": presence of the file is the active
 * state, so create/delete are the two meaningful mutations), `sprint_put`,
 * `quota_put`, `agent_put`/`agent_deleted` (bus `agents/<agent>.yaml`
 * registry, §5 "Storage"), `policy_put`, `vendors_put`, and the two generic
 * kinds `entity_put`/`entity_deleted` minted by the generic
 * `putEntity`/`deleteEntity` trio (T006's message/thread files, or any
 * future entity with no dedicated helper yet).
 *
 * DESIGN-GAP (T018 review fix): `hil_requested`/`hil_resolved`/
 * `breaker_tripped`/`breaker_cleared` are added for §16 "HIL gates policy".
 * Every generic `putEntity` write to `board/hil/**`/`board/breaker.yaml`
 * already mints an `entity_put`/`entity_deleted` event on its own, but these
 * four semantic kinds are minted alongside it (one HIL mutation now yields
 * two log lines, same as `state_transition` already coexists with
 * `ticket_put` for a ticket transition), so a `log/events.jsonl` consumer
 * can filter on "a HIL request opened/resolved" or "a breaker
 * tripped/cleared" without grepping generic-entity payloads for a
 * `board/hil/` path prefix.
 */
export const EVENT_KINDS = [
  'message',
  'hook_decision',
  'state_transition',
  'quota_low',
  'quota_exhausted',
  'ticket_put',
  'stanza_appended',
  'oracle_put',
  'kb_put',
  'ledger_appended',
  'halt_created',
  'halt_released',
  'sprint_put',
  'quota_put',
  'agent_put',
  'agent_deleted',
  'policy_put',
  'vendors_put',
  'entity_put',
  'entity_deleted',
  'hil_requested',
  'hil_resolved',
  'breaker_tripped',
  'breaker_cleared',
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
