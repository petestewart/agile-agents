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
import { PI_ENGINEER_CANDIDATES, PI_REVIEWER_CANDIDATES } from './pi-route-candidates';

/** CLAUDE.md tunable: "max_attempts 2" — the default when a ticket has no `routing` block yet. */
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface RouteCandidate {
  vendor: string;
  /** Vendor account id (`.agile/vendors.yaml`'s per-vendor `accounts[].id`) — optional because the v0 single-Claude stub never named one; T022 (Pi) is the first candidate set that does. */
  account?: string;
  model: string;
  reasoning?: TicketReasoning;
}

export interface RouteContext {
  // T022 widens this from 'engineer'-only so `pi-route-candidates.ts` can
  // name reviewer candidates too (design/agile-agents-design.md §22 scope:
  // "candidates for engineer and reviewer"); `defaultRoute` below still
  // ignores `role` entirely, so this is purely additive — no behaviour
  // change for the existing engineer-only v0 default.
  role: 'engineer' | 'reviewer';
  tier: TicketTier;
}

export type RouteFn = (ctx: RouteContext) => RouteCandidate;

/** The v0 single entry — still first in every ordered list below, so `defaultRoute`'s actual behavior is unchanged by T022 (CLAUDE.md "v0 defaults": "Claude for every role"). */
const CLAUDE_CANDIDATE: RouteCandidate = { vendor: 'claude', model: 'claude' };

/**
 * v0 routing table: `(role, tier) -> ordered candidates`, Claude first, Pi
 * after (T022 round 2 review, N1: "wire the candidates into defaultRoute").
 * `defaultRoute` itself still always returns the first entry — Claude — so
 * this is genuinely additive: no scheduling behaviour changes for the
 * existing demo path, but the candidate lists are no longer dead code, and
 * a caller wanting the Pi path today can inject its own `route` (e.g.
 * `() => PI_ENGINEER_CANDIDATES[0]`) through `AssignReadyOptions.route`
 * without this module changing at all — exactly the seam this file's
 * header describes for T023's real policy. `tier` is intentionally unused
 * by every entry here still (no per-tier ordering exists in v0); kept on
 * `RouteContext` for the same forward-compatibility reason it already was.
 */
function orderedCandidates(role: RouteContext['role']): readonly RouteCandidate[] {
  return role === 'engineer'
    ? [CLAUDE_CANDIDATE, ...PI_ENGINEER_CANDIDATES]
    : [CLAUDE_CANDIDATE, ...PI_REVIEWER_CANDIDATES];
}

export const defaultRoute: RouteFn = (ctx) => {
  const [first] = orderedCandidates(ctx.role);
  // `orderedCandidates` always starts with `CLAUDE_CANDIDATE`, so `first`
  // is never undefined — `noUncheckedIndexedAccess` just can't see that
  // through the ternary above.
  return first ?? CLAUDE_CANDIDATE;
};

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
    if (
      ticket.routing?.model !== candidate.model ||
      ticket.routing?.vendor !== candidate.vendor ||
      ticket.routing?.account !== candidate.account
    ) {
      await store.putTicket(
        {
          ...ticket,
          routing: {
            attempts: ticket.routing?.attempts ?? 0,
            max_attempts: ticket.routing?.max_attempts ?? DEFAULT_MAX_ATTEMPTS,
            escalation: ticket.routing?.escalation ?? [],
            model: candidate.model,
            // T022 round 2 (N1): recorded so `Runner.spawn` can actually
            // select the routed provider (`runner.ts`'s `resolveAcpProvider`
            // call) instead of always defaulting to Claude — see this
            // file's header and `runner.ts`'s own doc comment on `spawn`.
            vendor: candidate.vendor,
            ...(candidate.account !== undefined ? { account: candidate.account } : {}),
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
