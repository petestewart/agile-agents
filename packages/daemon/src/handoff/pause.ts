/**
 * Quota-driven pause (T024; design/agile-agents-design.md §10
 * "Quota-driven pause and handoff": "Pause: no candidate above the floor
 * for that tier → ticket status `paused`, `resume_at` = earliest `resets_at`
 * among candidates; daemon scheduler resumes it. Other tiers with live
 * candidates keep flowing."; §4 "Ticket" `paused`/`resume_at`).
 *
 * Deliberately separate from `em/assign.ts`'s `assignReady` (out of this
 * ticket's file ownership beyond the minimal seams the header names) rather
 * than folding pause detection into it: `pauseStuckReadyTickets` only ever
 * touches a ticket still in `ready` (never races `assignReady`'s own
 * ready -> assigned edge — whichever runs first in a tick claims the
 * ticket, and the other's `ticket.status !== 'ready'` guard then skips it
 * as a no-op), and `resumeDueTickets` only ever touches one already
 * `paused`. Callers (the daemon's ceremony tick, see the pipeline report's
 * wiring section) are expected to run `pauseStuckReadyTickets` *before*
 * `assignReady` each tick, so a ticket this function just paused doesn't
 * also get assigned to an exhausted candidate the same tick.
 */

import type { Ticket, TicketId, TicketTier } from '@agile-agents/shared';
import type { QuotaService } from '../quota/records';
import { type RoutingTable, routeCandidates } from '../quota/routing';
import type { StateStore } from '../store';

export interface PauseOptions {
  store: StateStore;
  quota: Pick<QuotaService, 'list'>;
  now?: () => Date;
  routing?: RoutingTable;
  floor?: number;
}

function tierOf(ticket: Ticket): TicketTier {
  return ticket.estimate?.tier ?? 'standard';
}

/** Earliest `resets_at` among every currently-known quota record — "resume_at = earliest resets_at among candidates" (§10). No known record with a `resets_at` at all falls back to one hour out, a v0 placeholder (CLAUDE.md names no pause-retry tunable) rather than never resuming. */
function earliestResumeAt(quotas: ReturnType<QuotaService['list']>, now: Date): string {
  let earliest: number | undefined;
  for (const q of quotas) {
    if (!q.resets_at) continue;
    const ms = Date.parse(q.resets_at);
    if (Number.isNaN(ms)) continue;
    if (earliest === undefined || ms < earliest) earliest = ms;
  }
  const FALLBACK_MS = 60 * 60 * 1000;
  return new Date(earliest ?? now.getTime() + FALLBACK_MS).toISOString();
}

export interface PauseResult {
  paused: TicketId[];
}

/**
 * For every `ready` ticket in `ticketIds`: if `routeCandidates('engineer',
 * tier, ...)` finds nothing above the floor, sets `resume_at` (a plain data
 * write — `store.putTicket`) then transitions `ready -> paused` (the
 * status-changing write, its own `state_transition` event) — two mutations,
 * matching "one event per mutation" rather than inventing a combined write
 * `StateStore` doesn't offer. A ticket with a live candidate is left
 * completely untouched (no write at all) — "other tiers with live
 * candidates keep flowing" (§10).
 */
export async function pauseStuckReadyTickets(
  ticketIds: readonly TicketId[],
  opts: PauseOptions,
): Promise<PauseResult> {
  const now = opts.now?.() ?? new Date();
  const paused: TicketId[] = [];

  for (const ticketId of ticketIds) {
    let ticket: Ticket;
    try {
      ticket = opts.store.getTicket(ticketId);
    } catch {
      continue;
    }
    if (ticket.status !== 'ready') continue;

    const quotas = opts.quota.list();
    const result = routeCandidates('engineer', tierOf(ticket), {
      vendors: opts.store.getVendors(),
      quotas,
      now,
      routing: opts.routing,
      floor: opts.floor,
    });
    if (!('none' in result)) continue;

    const resumeAt = earliestResumeAt(quotas, now);
    await opts.store.putTicket({ ...ticket, resume_at: resumeAt }, { by: 'daemon' });
    await opts.store.transitionTicket(ticketId, 'paused', { by: 'daemon', reason: result.reason });
    paused.push(ticketId);
  }

  return { paused };
}

export interface ResumeResult {
  resumed: TicketId[];
}

/**
 * Every `paused` ticket whose `resume_at` has arrived goes back to `ready`
 * — "daemon scheduler resumes it" (§10). `resume_at` is cleared first (a
 * `putTicket` data write) so the subsequent `transitionTicket`'s own fresh
 * read never carries a stale timestamp forward onto the re-readied ticket.
 * A `paused` ticket with no `resume_at` at all (shouldn't happen via
 * `pauseStuckReadyTickets`, but a hand-authored/manual pause might omit it)
 * is left alone — nothing says when to resume it, so nothing resumes it
 * automatically; a human/manual `resume_at` write is what unblocks it.
 */
export async function resumeDueTickets(
  store: StateStore,
  now: () => Date = () => new Date(),
): Promise<ResumeResult> {
  const nowMs = now().getTime();
  const resumed: TicketId[] = [];

  for (const ticket of store.listTickets()) {
    if (ticket.status !== 'paused') continue;
    if (!ticket.resume_at) continue;
    const ms = Date.parse(ticket.resume_at);
    if (Number.isNaN(ms) || ms > nowMs) continue;

    const { resume_at: _resumeAt, ...rest } = ticket;
    await store.putTicket(rest, { by: 'daemon' });
    await store.transitionTicket(ticket.id, 'ready', { by: 'daemon', reason: 'resume_at reached' });
    resumed.push(ticket.id);
  }

  return { resumed };
}
