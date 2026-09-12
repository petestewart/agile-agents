/**
 * The Sprints pane's data (T042 — §17 "Control room v2": "Sprints pane lists
 * every sprint: finished ones with review and report links, the next one
 * settled, later ones projected from the graph. Rows show a blocked/blocker
 * pill only, never the ticket lists; the ticket detail panel carries
 * blocked-by/blocks.").
 *
 * Pure over an in-memory ticket/sprint list — **nothing here mutates state**
 * (the ticket says so explicitly: "compute projection with the existing
 * `planSprint` frontier logic ... without mutating state"). The settled next
 * sprint is `computeFrontier` itself, the same function `planSprint` calls,
 * so the projection and the sprint that Start Sprint N actually creates can
 * never disagree.
 *
 * Later layers extend that rule one hop at a time: a ticket belongs to the
 * first layer by which all of its `depends` are either already done or
 * scheduled in an earlier layer. Layer 1 is `ready`-only (that is what
 * `planSprint` will take); later layers include `draft` stubs, which is the
 * whole point of the pane — S-2 in the mockup is one stub waiting on two
 * Sprint-1 tickets.
 */

import type { Sprint, Ticket, TicketId } from '@agile-agents/shared';
import { computeFrontier } from '../em/sprint';

export interface SprintRowTicket {
  id: TicketId;
  title: string;
  status: string;
  /** Not-done tickets this one waits on (`depends`). */
  blocked_by: TicketId[];
  /** Not-done tickets that wait on this one. */
  blocks: TicketId[];
  stub: boolean;
}

export interface FinishedSprintRow {
  id: string;
  goal: string;
  state: 'finished';
  tickets: SprintRowTicket[];
  done: number;
  total: number;
  started: string;
  review_at?: string;
  /** `runs/<sprint>.md`, the run story §17 names ("the same text goes to `runs/*.md`"). Relative to the repo root; the pane links it. */
  report: string;
}

export interface LiveSprintRow {
  id: string;
  goal: string;
  state: 'running';
  tickets: SprintRowTicket[];
  done: number;
  total: number;
  started: string;
  review_at?: string;
}

export interface PlannedSprintRow {
  /** `S-<n>` the sprint *would* get — minted from the existing sprint files, never written. */
  id: string;
  goal: string;
  state: 'next' | 'projected';
  tickets: SprintRowTicket[];
  done: 0;
  total: number;
}

export type SprintRow = FinishedSprintRow | LiveSprintRow | PlannedSprintRow;

function rowTicket(
  ticket: Ticket,
  byId: Map<TicketId, Ticket>,
  all: readonly Ticket[],
): SprintRowTicket {
  const blockedBy = ticket.depends.filter((dep) => byId.get(dep)?.status !== 'done');
  const blocks = all
    .filter((t) => t.status !== 'done' && t.depends.includes(ticket.id))
    .map((t) => t.id);
  return {
    id: ticket.id,
    title: ticket.title,
    status: ticket.status,
    blocked_by: blockedBy,
    blocks,
    stub: ticket.status === 'draft' && ticket.contract.acceptance.length === 0,
  };
}

/** Layers after the settled frontier: every remaining not-done, unclaimed ticket, in dependency order. */
export function projectLayers(
  tickets: readonly Ticket[],
  firstLayer: readonly TicketId[],
): TicketId[][] {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const scheduled = new Set<TicketId>([
    ...tickets.filter((t) => t.status === 'done').map((t) => t.id),
    ...firstLayer,
  ]);
  // A ticket already claimed by a live sprint is that sprint's row, not a
  // projected one; it still counts as scheduled so its dependents can land.
  for (const t of tickets) if (t.sprint !== undefined) scheduled.add(t.id);

  let remaining = tickets.filter(
    (t) => t.status !== 'done' && t.sprint === undefined && !scheduled.has(t.id),
  );
  const layers: TicketId[][] = [];
  while (remaining.length > 0) {
    const layer = remaining
      .filter((t) => t.depends.every((dep) => scheduled.has(dep) || byId.get(dep) === undefined))
      .map((t) => t.id)
      .sort((a, b) => a.localeCompare(b));
    // A dependency cycle (or a ticket depending on something unreachable)
    // would loop forever: stop and let the remainder show as one last layer
    // rather than hanging the pane.
    if (layer.length === 0) {
      layers.push(remaining.map((t) => t.id).sort((a, b) => a.localeCompare(b)));
      break;
    }
    for (const id of layer) scheduled.add(id);
    layers.push(layer);
    remaining = remaining.filter((t) => !scheduled.has(t.id));
  }
  return layers;
}

/** The `S-<n>` id the nth *future* sprint would get, given the sprints that already exist. Mirrors `em/sprint.ts`'s `nextSprintId` without touching the store. */
function futureSprintId(sprints: readonly Sprint[], offset: number): string {
  const finite = sprints
    .map((s) => Number(s.id.slice('S-'.length)))
    .filter((n) => Number.isFinite(n));
  const next = finite.length > 0 ? Math.max(...finite) + 1 : 1;
  return `S-${next + offset}`;
}

export interface SprintBoard {
  rows: SprintRow[];
  /** The sprint id `POST /api/sprint/start` would mint next, and how many tickets it would carry. */
  next?: { id: string; tickets: TicketId[] };
  /** A sprint whose tickets are not all done — the one Start Sprint is disabled behind. */
  running?: string;
}

/**
 * Every sprint, in one list: finished, running, the settled next one, then
 * the projected layers. Read-only.
 */
export function buildSprintBoard(
  tickets: readonly Ticket[],
  sprints: readonly Sprint[],
): SprintBoard {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const rows: SprintRow[] = [];
  let running: string | undefined;

  const ordered = [...sprints].sort(
    (a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)) || a.id.localeCompare(b.id),
  );
  for (const sprint of ordered) {
    const members = sprint.tickets.map((id) => byId.get(id)).filter((t): t is Ticket => !!t);
    const done = members.filter((t) => t.status === 'done').length;
    // Review round 1 (nit 2): a sprint with no members left (its tickets
    // deleted, or an empty frontier) is *not* running — otherwise it would
    // sit at the head of the board forever and block Start Sprint.
    const finished = done === members.length;
    const rowTickets = members.map((t) => rowTicket(t, byId, tickets));
    if (finished) {
      rows.push({
        id: sprint.id,
        goal: sprint.goal,
        state: 'finished',
        tickets: rowTickets,
        done,
        total: members.length,
        started: sprint.started,
        ...(sprint.review_at !== undefined ? { review_at: sprint.review_at } : {}),
        report: `runs/${sprint.id}.md`,
      });
    } else {
      running = sprint.id;
      rows.push({
        id: sprint.id,
        goal: sprint.goal,
        state: 'running',
        tickets: rowTickets,
        done,
        total: members.length,
        started: sprint.started,
        ...(sprint.review_at !== undefined ? { review_at: sprint.review_at } : {}),
      });
    }
  }

  const frontier = computeFrontier(tickets);
  const layers = projectLayers(tickets, frontier);
  const planned: PlannedSprintRow[] = [];
  if (frontier.length > 0) {
    planned.push({
      id: futureSprintId(sprints, 0),
      goal: 'Next — every ticket with nothing left to wait on',
      state: 'next',
      tickets: frontier.map((id) => rowTicket(byId.get(id) as Ticket, byId, tickets)),
      done: 0,
      total: frontier.length,
    });
  }
  layers.forEach((layer, i) => {
    planned.push({
      id: futureSprintId(sprints, (frontier.length > 0 ? 1 : 0) + i),
      goal: 'Projected from the dependency graph',
      state: 'projected',
      tickets: layer.map((id) => rowTicket(byId.get(id) as Ticket, byId, tickets)),
      done: 0,
      total: layer.length,
    });
  });
  rows.push(...planned);

  return {
    rows,
    ...(frontier.length > 0
      ? { next: { id: futureSprintId(sprints, 0), tickets: [...frontier] } }
      : {}),
    ...(running !== undefined ? { running } : {}),
  };
}
