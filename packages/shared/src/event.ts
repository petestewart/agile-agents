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
  // DESIGN-GAP (T007 manager decision): `putHalt` previously minted
  // `halt_created` for every put, including a quorum-tracking update to an
  // existing halt file — indistinguishable from an actual creation in the
  // event/commit log. `halt_updated` covers every non-creating `putHalt`
  // (e.g. `recordStandupReport`/timeout evaluation flipping `quorum` to
  // `reached`), named after the store method exactly like the other
  // store-mutation kinds above (`ticket_put`, `oracle_put`, ...).
  'halt_updated',
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
  // T040 (§17 "Control room v2" — "Questions vs Decisions"): a `Question`
  // (`board/questions/Q-*.yaml`) is opened and answered through the generic
  // entity trio, which mints only `entity_put`. These two semantic kinds are
  // minted alongside it for exactly the reason `hil_requested`/`hil_resolved`
  // are — so a `log/events.jsonl` consumer (and the feed) can filter on "a
  // question was raised/answered" without grepping generic-entity payloads
  // for a `board/questions/` path prefix.
  'question_raised',
  'question_answered',
  'breaker_tripped',
  'breaker_cleared',
  // DESIGN-GAP (T012 QA round): §8 "Adapter contract" has the daemon
  // observing every ACP `tool_call`/`tool_call_update` off the `tool_call`
  // stream (§6 tier 3 "observation"), but no event kind exists to log one —
  // T012 had been filing these under the generic `entity_put` bucket for
  // lack of a granted `event.ts` change. Named directly after the ACP
  // `session/update` discriminant it observes, matching this file's own
  // convention of naming a kind after what produced it.
  'tool_call',
  // "usage_update arrived before any sprint existed to file its ledger line
  // under" (T012 QA round finding) — the ledger line still gets written
  // (under the `nosprint` fallback file `runner/session.ts` already used
  // elsewhere for exactly this), but the daemon also logs this event so the
  // gap is visible in `log/events.jsonl`, not just silently absorbed.
  'ledger_no_sprint',
  // DESIGN-GAP (T019 merge/integration owner, manager-granted follow-up):
  // §15 "Git model and teams" names the merge cadence ("ticket -> integration
  // on done ... conflicts bounce to the ticket owner as a scoped halt ...
  // integration -> main at sprint review") but, like every other mutation
  // kind above, never names an event kind for it — these were previously
  // filed under the generic `entity_put`/`halt_created` kinds alone for lack
  // of a granted `event.ts` change (same situation `tool_call` documents
  // just above). Four kinds, not five: a `merge_started` kind was
  // considered and dropped — `packages/daemon/src/merge/owner.ts` has no
  // durable intermediate state between "asked to merge a done ticket" and
  // one of these four outcomes to log a start event against (unlike, say,
  // a `HilRequest`'s `pending` status), so it would only ever appear
  // immediately followed by its own outcome in the same log, carrying no
  // information the outcome event doesn't already carry with its own `ts`.
  //  - `merge_completed`: a ticket's branch landed on `integration`.
  //  - `merge_conflict` / `merge_tests_failed`: the two ways `onTicketDone`
  //    instead raises a scoped halt (§15's "conflicts bounce ... as a
  //    scoped halt") — mirrors `halt_created`'s own event, one level up.
  //  - `integration_merged_to_main`: `integration -> main` at sprint review
  //    (§16 "HIL gates policy").
  'merge_completed',
  'merge_conflict',
  'merge_tests_failed',
  'integration_merged_to_main',
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
