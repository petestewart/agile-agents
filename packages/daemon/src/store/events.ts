/**
 * Event construction (T005 — design agile-agents-design.md §3 "Concepts
 * beyond the original brief": "append-only event log of every message, hook
 * decision, and state transition"; §4 layout `log/events.jsonl`).
 *
 * Review fix (manager decision B1): the acceptance criterion "every
 * mutation produces exactly one event" is honored literally now — every
 * `StateStore` mutation method builds one `Event` (via `buildEvent` below)
 * and commits it through `StateStore`'s private `commitEvent` with
 * `message = event.kind`, so the commit log and the event log share one
 * vocabulary. `message` and `hook_decision` (the two named sources T005
 * doesn't itself produce) are written by future callers — T006 (bus),
 * T008/T009 (hook endpoint) — through the now-public `StateStore.appendEvent`.
 */

import {
  type Event,
  type EventKind,
  type TicketId,
  type TicketStatus,
  validateEvent,
} from '@agile-agents/shared';

export interface BuildEventInput {
  ticket?: TicketId;
  agent?: string;
  data?: Record<string, unknown>;
}

/** Builds (and validates) an `Event` of the given kind, ts stamped now. */
export function buildEvent(kind: EventKind, input: BuildEventInput = {}): Event {
  return validateEvent({
    ts: new Date().toISOString(),
    kind,
    ...(input.ticket !== undefined ? { ticket: input.ticket } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    data: input.data ?? {},
  });
}

export interface StateTransitionEventInput {
  ticket: TicketId;
  agent: string;
  from: TicketStatus;
  to: TicketStatus;
  reason?: string;
}

/** Builds the one `state_transition` event for a ticket transition. */
export function buildStateTransitionEvent(input: StateTransitionEventInput): Event {
  return buildEvent('state_transition', {
    ticket: input.ticket,
    agent: input.agent,
    data: {
      from: input.from,
      to: input.to,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    },
  });
}
