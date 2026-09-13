/**
 * Feed snapshot (T020 — design agile-agents-design.md §17 "Human UI": "Sprint
 * strip: goal, tickets done, ... global halt count"; "Feed: event log tailed
 * live"; "Attention queue: every open `hil_request`"). Assembled fresh from
 * the `StateStore`/`GateService` on every `GET /api/snapshot` and on every
 * new `/ws` connection, so a client that just opened the page (or just
 * reconnected after a drop) gets caught up without replaying the whole
 * event log itself.
 */

import { basename } from 'node:path';
import type {
  AgentRecord,
  Event,
  Halt,
  HilRequest,
  Question,
  Sprint,
  SprintId,
  Ticket,
} from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { QuestionService } from '../questions';
import { quotaFraction } from '../quota/records';
import type { QuotaService } from '../quota/records';
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

/**
 * T023 addition: §17 "Human UI" → "Sprint strip": "the vendor barometer —
 * per-vendor gauge, resets-in, confidence dot"; §4 "Quota" for the fields
 * themselves. Additive — `buildSnapshot`'s new `quota` parameter is
 * optional, so every pre-T023 caller still gets a valid `FeedSnapshot`
 * (with an empty `quota` array) unchanged.
 */
export interface FeedQuotaInfo {
  vendor: string;
  account: string;
  remaining_fraction: number;
  cooldown_until: string | null;
  confidence: 'reported' | 'estimated' | 'low';
  spend_usd?: number;
}

/**
 * T043 (§17 "Control room v2" — "Top bar is identical on every view"): the
 * project the daemon is driving. `name` is what the bar shows, `path` is
 * what it shows on hover. Derived from the daemon's own state root
 * (`<repoRoot>/.agile`), never from anything a browser sends.
 */
export interface FeedProjectInfo {
  name: string;
  path: string;
}

/**
 * T043: everything the always-on top bar renders, in one place, so the bar
 * costs exactly one read the control room already makes (§17 "Status must
 * never cost tokens; it is read straight from daemon state").
 *
 * DESIGN-GAP: `Sprint` (§4) has no `state` field — it records `started` and,
 * once closed, a computed `retro` block (`em/retro.ts` is its only writer).
 * So the mockup's "running 4m 12s" vs "finished in 7m 09s" is derived here:
 * a sprint with no `retro` is `running`, one with a `retro` is `finished`,
 * and no sprint at all is `none`. `finished_at` has no field to come from —
 * the bar shows "finished" without a duration in that state.
 */
export interface FeedStatusInfo {
  sprint_id?: SprintId;
  sprint_state: 'none' | 'running' | 'finished';
  /** ISO-8601 `sprint.started` — the top bar's running timer counts up from this. */
  sprint_started_at?: string;
  /** The number the "Start Sprint N" button names: the next `S-<n>` that `planSprint` would mint. */
  next_sprint_number: number;
  /**
   * Registered agents currently holding a ticket (`AgentRecord.ticket` set)
   * — the mockup's "3 agents working". Liveness is deliberately not part of
   * it: `last_seen` staleness is the daemon's own escalation path (§5
   * "Liveness"), and a bar that silently stopped counting a wedged agent
   * would hide exactly the state an operator needs to see.
   */
  agents_working: number;
  /** Open HIL requests + open questions — the count on the Sprint tab (§17 "Sprint carries the Needs-you count"). */
  needs_you: number;
  /**
   * A `sprint_review` gate is open (review round 1 blocker 1; mockup `#s4`:
   * "Sprint 1 · finished in 7m 09s · review pending" with a *disabled*
   * "Start Sprint 2" and `title="Review Sprint 1 first"`). §16's
   * `sprint_review` gate is "integration → main"; until it is decided the
   * next sprint must not be startable.
   *
   * DESIGN-GAP: `HilRequest` carries no sprint id (only an optional
   * `ticket`), so this is "some `sprint_review` gate is pending", not
   * "*this* sprint's is" — with one sprint reviewed at a time, which is what
   * §9's layers describe, they are the same thing. A finished sprint whose
   * review gate was never raised leaves this `false`, i.e. the button is
   * enabled: the bar reports state, it does not invent a gate nobody asked
   * for.
   */
  sprint_review_pending: boolean;
}

export interface FeedSnapshot {
  type: 'snapshot';
  events: Event[];
  sprint: FeedSprintInfo;
  halts: Halt[];
  hil: HilRequest[];
  /**
   * T040 (§17 "Control room v2" — "Questions vs Decisions"): the *open*
   * questions, which are attention-queue items exactly like a pending
   * `hil_request` — "a pending question is a Needs-you card" (ticket scope).
   * Answered ones are history and stay out, same rule as `hil` above.
   * Empty when no `QuestionService` is wired (every pre-T040 call site).
   */
  questions: Question[];
  quota: FeedQuotaInfo[];
  /** T043: the top bar's project name/path. Absent only when no project root was supplied (pre-T043 call sites). */
  project?: FeedProjectInfo;
  /** T043: the top bar's sprint status, agents-working and Needs-you counts. */
  status: FeedStatusInfo;
}

/** `S-<n>` -> `n`, for the "Start Sprint N" button. Non-numeric ids (impossible today — `SprintIdSchema` is `S-\d+`) are skipped rather than producing `NaN`. */
function sprintNumber(id: SprintId): number | undefined {
  const n = Number(id.slice('S-'.length));
  return Number.isFinite(n) ? n : undefined;
}

function countAgentsWorking(agents: Array<{ record: AgentRecord }>): number {
  return agents.filter((a) => a.record.ticket !== undefined).length;
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
  /** T023: optional so every existing call site (no `QuotaService` wired yet) keeps building a valid snapshot with an empty `quota` array. */
  quota?: QuotaService,
  /** T040: optional for the same reason — without it the snapshot carries an empty `questions` array. */
  questions?: QuestionService,
  /** T043: the repo root the daemon is driving (`<repoRoot>`, i.e. the state root's parent). Optional — without it the snapshot carries no `project` and the top bar falls back to a generic name. */
  projectRoot?: string,
): FeedSnapshot {
  const events = store.listEvents().slice(-eventLimit);
  const tickets = store.listTickets();
  const sprint = pickCurrentSprint(store.listSprints());
  const halts = store.listHalts();
  // "the open hil_request list" (T020 scope) — resolved requests are history,
  // not attention-queue items, so the snapshot only ships pending ones.
  const hil = gates.list().filter((request) => request.status === 'pending');
  const quotaInfo: FeedQuotaInfo[] = (quota?.list() ?? []).map((q) => ({
    vendor: q.vendor,
    account: q.account,
    remaining_fraction: quotaFraction(q),
    cooldown_until: q.cooldown_until,
    confidence: q.confidence,
    spend_usd: q.spend_usd,
  }));

  const openQuestions = questions?.listOpen() ?? [];
  const sprints = store.listSprints();
  const highestSprint = sprints.reduce<number>((max, s) => {
    const n = sprintNumber(s.id);
    return n !== undefined && n > max ? n : max;
  }, 0);

  const status: FeedStatusInfo = {
    ...(sprint ? { sprint_id: sprint.id, sprint_started_at: sprint.started } : {}),
    sprint_state:
      sprint === undefined ? 'none' : sprint.retro === undefined ? 'running' : 'finished',
    // A running sprint's button offers to start *it* again is nonsense, so
    // the number is always "the next one `planSprint` would mint" — which
    // is the current sprint's own number only while none exists yet.
    next_sprint_number: highestSprint + 1,
    agents_working: countAgentsWorking(store.listAgents()),
    needs_you: hil.length + openQuestions.length,
    sprint_review_pending: hil.some((request) => request.gate === 'sprint_review'),
  };

  return {
    type: 'snapshot',
    events,
    sprint: { sprint, tickets: summarizeTickets(tickets) },
    halts,
    hil,
    questions: openQuestions,
    quota: quotaInfo,
    ...(projectRoot
      ? { project: { name: basename(projectRoot) || projectRoot, path: projectRoot } }
      : {}),
    status,
  };
}
