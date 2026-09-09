/**
 * Feed snapshot (T020 — design agile-agents-design.md §17 "Human UI": "Sprint
 * strip: goal, tickets done, ... global halt count"; "Feed: event log tailed
 * live"; "Attention queue: every open `hil_request`"). Assembled fresh from
 * the `StateStore`/`GateService` on every `GET /api/snapshot` and on every
 * new `/ws` connection, so a client that just opened the page (or just
 * reconnected after a drop) gets caught up without replaying the whole
 * event log itself.
 */

import type { Event, Halt, HilRequest, Sprint, Ticket } from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { StateStore } from '../store';

/** Default cap on how many recent events a snapshot carries (ticket: "last N (e.g. 200)"). */
export const DEFAULT_SNAPSHOT_EVENT_LIMIT = 200;

/** Ticket statuses counted as "in-flight" for the sprint strip (assigned through in_qa). */
const IN_FLIGHT_STATUSES: ReadonlySet<Ticket['status']> = new Set([
  'assigned',
  'in_progress',
  'in_review',
  'in_qa',
]);

export interface TicketsSummary {
  done: number;
  in_flight: number;
  stale: number;
  total: number;
}

export interface FeedSprintInfo {
  /**
   * The "current" sprint, if any. DESIGN-GAP: §4 "Sprint" describes one
   * sprint file per id but the design never says which sprint is "current"
   * when several exist (e.g. a closed one and its successor) — picked here
   * as the one with the latest `started` timestamp (ties broken by id, both
   * lexically comparable: ISO-8601 timestamps and `S-###` ids alike).
   */
  sprint?: Sprint;
  tickets: TicketsSummary;
}

export interface FeedSnapshot {
  type: 'snapshot';
  events: Event[];
  sprint: FeedSprintInfo;
  halts: Halt[];
  hil: HilRequest[];
}

function summarizeTickets(tickets: Ticket[]): TicketsSummary {
  let done = 0;
  let inFlight = 0;
  let stale = 0;
  for (const ticket of tickets) {
    if (ticket.status === 'done') done++;
    else if (ticket.status === 'stale') stale++;
    else if (IN_FLIGHT_STATUSES.has(ticket.status)) inFlight++;
  }
  return { done, in_flight: inFlight, stale, total: tickets.length };
}

/**
 * Exported (T011 review fix): the tool framework's `ToolService` needs the
 * same "which sprint is current" answer to resolve `ledger/<sprint>.jsonl`
 * and the cache's sprint-TTL scoping — re-deriving the DESIGN-GAP'd
 * "latest `started`, ties by id" rule a second time would just as surely
 * drift from this one.
 */
export function pickCurrentSprint(sprints: Sprint[]): Sprint | undefined {
  if (sprints.length === 0) return undefined;
  return sprints.reduce((latest, candidate) => {
    if (candidate.started > latest.started) return candidate;
    if (candidate.started < latest.started) return latest;
    return candidate.id > latest.id ? candidate : latest;
  });
}

export function buildSnapshot(
  store: StateStore,
  gates: GateService,
  eventLimit: number = DEFAULT_SNAPSHOT_EVENT_LIMIT,
): FeedSnapshot {
  const events = store.listEvents().slice(-eventLimit);
  const tickets = store.listTickets();
  const sprint = pickCurrentSprint(store.listSprints());
  const halts = store.listHalts();
  // "the open hil_request list" (T020 scope) — resolved requests are history,
  // not attention-queue items, so the snapshot only ships pending ones.
  const hil = gates.list().filter((request) => request.status === 'pending');

  return {
    type: 'snapshot',
    events,
    sprint: { sprint, tickets: summarizeTickets(tickets) },
    halts,
    hil,
  };
}
