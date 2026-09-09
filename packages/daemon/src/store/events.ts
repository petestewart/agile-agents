/**
 * Event construction (T005 — design agile-agents-design.md §3 "Concepts
 * beyond the original brief": "append-only event log of every message, hook
 * decision, and state transition"; §4 layout `log/events.jsonl`).
 *
 * T005 owns exactly one of the three named event sources: `state_transition`
 * (ticket status changes, via `StateStore.transitionTicket`). `message` and
 * `hook_decision` events are emitted by the bus (T006) and hook endpoint
 * (T008+) respectively — this module only builds the shape, `appendEvent`
 * in store.ts writes it.
 *
 * Ticket acceptance criterion "every mutation produces exactly one event" is
 * scoped to ticket transitions (matching the Validation Steps: "property
 * test over random legal transition sequences" asserting `events count ==
 * transitions"). Non-transition mutations (oracle/KB/ledger/stanza writes)
 * still get their own git commit each (§4 "What this buys" — the audit
 * trail is the commit log), but do not each mint a `log/events.jsonl` line;
 * none of them is a message, a hook decision, or a state transition.
 */

import { type Event, type TicketId, type TicketStatus, validateEvent } from '@agile-agents/shared';

export interface StateTransitionEventInput {
  ticket: TicketId;
  agent: string;
  from: TicketStatus;
  to: TicketStatus;
  reason?: string;
}

/** Builds (and validates) the one `state_transition` event for a ticket transition. */
export function buildStateTransitionEvent(input: StateTransitionEventInput): Event {
  return validateEvent({
    ts: new Date().toISOString(),
    kind: 'state_transition',
    ticket: input.ticket,
    agent: input.agent,
    data: {
      from: input.from,
      to: input.to,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
}
