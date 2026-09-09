/**
 * Assignment — spawn engineers for a sprint's `ready` tickets and notify
 * them (T015; design/agile-agents-design.md §9, §5 "Comms bus" `assign`
 * kind, §11 "Pointing rubric and routing calibration" for the routing
 * table).
 *
 * The routing table is a single-Claude-entry stub in v0 (CLAUDE.md "v0
 * defaults"; §18): `route()` is injectable so T023 can drop in the real
 * `(role, tier) -> candidates` policy later without touching this module.
 * Its result is recorded onto `ticket.routing.model` (§4 "Ticket":
 * "`routing.model`: <resolved by daemon from tier at assignment>") — the
 * actual vendor/model the spawned session runs under is still fixed by
 * `session.ts`'s `ACP_PROVIDERS.claude` default (out of this ticket's file
 * ownership); recording the routing decision here is what makes it visible
 * on the ticket/ledger today and swappable later.
 */

import type {
  AgentId,
  Sprint,
  Ticket,
  TicketId,
  TicketReasoning,
  TicketTier,
} from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { Runner, SpawnResult } from '../runner';
import type { StateStore } from '../store';

/** CLAUDE.md tunable: "max_attempts 2" — the default when a ticket has no `routing` block yet. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface RouteCandidate {
  vendor: string;
  model: string;
  reasoning?: TicketReasoning;
}

export interface RouteContext {
  role: 'engineer';
  tier: TicketTier;
}

export type RouteFn = (ctx: RouteContext) => RouteCandidate;

/** v0 routing table: `(role, tier) -> [claude]`, one candidate, no fallback (CLAUDE.md, §18). */
export const defaultRoute: RouteFn = () => ({ vendor: 'claude', model: 'claude' });

export interface AssignReadyOptions {
  route?: RouteFn;
  now?: () => Date;
}

export interface AssignedTicket {
  ticket: TicketId;
  agentId: AgentId;
}

function tierOf(ticket: Ticket): TicketTier {
  return ticket.estimate?.tier ?? 'standard';
}

/**
 * For each `ready` ticket in `sprint.tickets`: records the routed
 * model onto `ticket.routing`, spawns an engineer (`runner.spawn` itself
 * advances `ready -> assigned -> in_progress` and sets `worktree`/
 * `assignee` — see `runner.ts`'s own doc comment), and sends an `assign`
 * message to the resulting agent id. A ticket that isn't `ready` (already
 * picked up, blocked, done, ...) is skipped — idempotent against a `tick()`
 * that re-scans the whole sprint every time.
 */
export async function assignReady(
  store: StateStore,
  bus: Bus,
  runner: Pick<Runner, 'spawn'>,
  sprint: Sprint,
  opts: AssignReadyOptions = {},
): Promise<AssignedTicket[]> {
  const route = opts.route ?? defaultRoute;
  const now = opts.now ?? (() => new Date());
  const assigned: AssignedTicket[] = [];

  for (const ticketId of sprint.tickets) {
    let ticket: Ticket;
    try {
      ticket = store.getTicket(ticketId);
    } catch {
      continue; // Ticket vanished — nothing to assign.
    }
    if (ticket.status !== 'ready') continue;

    const candidate = route({ role: 'engineer', tier: tierOf(ticket) });
    if (ticket.routing?.model !== candidate.model) {
      await store.putTicket(
        {
          ...ticket,
          routing: {
            attempts: ticket.routing?.attempts ?? 0,
            max_attempts: ticket.routing?.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
            escalation: ticket.routing?.escalation ?? [],
            model: candidate.model,
          },
        },
        { by: 'em' },
      );
    }

    let spawned: SpawnResult;
    try {
      spawned = await runner.spawn('engineer', ticketId);
    } catch (err) {
      // Review-round nit: only swallow the one expected race (`runner.spawn`
      // / `fakeRunner`'s own "<agentId> is already running" — a fix cycle
      // already mid-flight, nothing new to do); any other spawn failure
      // (worktree setup, brief assembly, ...) is a real problem and should
      // surface, not vanish silently.
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('already running')) continue;
      throw err;
    }

    const result = await bus.send({
      id: ulid(now().getTime()),
      ts: now().toISOString(),
      from: 'em',
      to: [spawned.agentId],
      kind: 'assign',
      priority: 'normal',
      ticket: ticketId,
      body: `assigned to ${spawned.agentId} (${candidate.vendor}/${candidate.model})`,
      requires_ack: false,
    });
    if (!result.ok) {
      throw new Error(
        `assignReady: assign message to ${spawned.agentId} rejected: ${result.reason}`,
      );
    }

    assigned.push({ ticket: ticketId, agentId: spawned.agentId });
  }

  return assigned;
}
