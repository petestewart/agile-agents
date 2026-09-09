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
 *
 * T024 round 3 review-fix (opus blocker 1): round 1/2's `earliestResumeAt`
 * looked at *every* `Quota` record on file and only at `resets_at` — on
 * the shipped Claude-only single-account config, a 30s 429 (`cooldown_until`
 * = now+30s) paused the ticket with `resume_at` set to the *window*
 * `resets_at` (often ~24h out), stalling all work for up to a full window
 * over a 30-second rate limit; the same shape made a 4h manual cooldown
 * resume early (at whatever unrelated `resets_at` happened to be soonest)
 * and then re-pause past its own real expiry. Fixed two ways:
 *
 *  1. `earliestResumeAt` now scores only the `(role, tier)`'s own routed
 *     candidates (`quota/routing.ts`'s `candidatesFor` — the exact set
 *     `routeCandidates` itself would have scored), and per candidate takes
 *     whichever of `cooldown_until`/`resets_at` is *sooner* when a cooldown
 *     is active ("min(cooldown_until, resets_at) when the pause is
 *     cooldown-driven, resets_at only when it is countdown-driven" per the
 *     review) — never a resets_at borrowed from some other account this
 *     ticket isn't even routed to.
 *  2. `resumeDueTickets` no longer trusts a stale `resume_at` at face
 *     value: once it arrives, the ticket's actual routability is
 *     re-evaluated (the exact same `routeCandidates` call `pause` and
 *     `assignReady` use) before ever flipping the ticket back to `ready`.
 *     Still not routable (a cooldown recomputed since, an early/optimistic
 *     `resume_at`, a manual cooldown mid-window) -> `resume_at` is simply
 *     recomputed and the ticket stays `paused`, never bounced to `ready`
 *     just to be immediately re-paused next tick ("no flapping").
 */

import type { Ticket, TicketId, TicketTier } from '@agile-agents/shared';
import type { QuotaService } from '../quota/records';
import {
  type RoutingCandidate,
  type RoutingTable,
  candidatesFor,
  routeCandidates,
} from '../quota/routing';
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

/** No candidate resolves to *any* usable timestamp at all (shouldn't normally arise — see `earliestResumeAt`'s own doc comment) — a v0 placeholder (CLAUDE.md names no pause-retry tunable) rather than never resuming. */
const FALLBACK_RESUME_MS = 60 * 60 * 1000;

/**
 * Earliest instant any of `candidates` could plausibly become routable
 * again (T024 round 3 review-fix, opus blocker 1 — see file header).
 * Per candidate:
 *
 *  - No `Quota` record at all -> already fully available (never observed
 *    = never spent, `records.ts`'s own convention) -> `now`. Shouldn't
 *    actually arise here in practice: if a candidate were already
 *    routable, `routeCandidates` would have picked it and this function
 *    is only ever called after `routeCandidates` returned `none` for
 *    every candidate — kept as a defined, immediate fallback rather than
 *    silently skipping the candidate.
 *  - An active (still-future) `cooldown_until` -> that candidate's own
 *    next chance is `cooldown_until` — `routing.ts`'s own `coolingDown`
 *    check excludes purely on `cooldown_until` regardless of `resets_at`
 *    (a window reset never clears an independently-active cooldown —
 *    `quota/records.ts`'s `applyWindowReset` explicitly leaves
 *    `cooldown_until` untouched, "left exactly as existing had them"), so
 *    a `resets_at` that happens to land *before* `cooldown_until` (a
 *    multi-hour manual cooldown outliving one window boundary, say) must
 *    never be read as an earlier release — that reading would resume-then-
 *    immediately-re-pause on the very next tick, the flap this fix exists
 *    to remove. In the overwhelmingly common case (`resets_at` further out
 *    than `cooldown_until` — true for every real 429, whose backoff ladder
 *    caps at 15 minutes against an hours-plus window) this is exactly
 *    "min(cooldown_until, resets_at)" per the review, since `cooldown_until`
 *    IS the minimum of the two then; it only stops being a literal `min()`
 *    in the one case that formula would have gotten *wrong*.
 *  - No active cooldown (purely countdown-excluded, below the floor) ->
 *    `resets_at` alone — "resets_at only when it is countdown-driven".
 *
 * Returns the minimum across every candidate that resolves to *something*;
 * `undefined` (no candidate resolves to anything at all — e.g. an
 * account with neither a cooldown nor any `resets_at` recorded) falls
 * back to `FALLBACK_RESUME_MS` out.
 */
function earliestResumeAt(
  candidates: readonly RoutingCandidate[],
  quotas: ReturnType<QuotaService['list']>,
  now: Date,
): string {
  const nowMs = now.getTime();
  let earliest: number | undefined;

  for (const candidate of candidates) {
    const quota = quotas.find(
      (q) => q.vendor === candidate.vendor && q.account === candidate.account,
    );

    let candidateNext: number | undefined;
    if (!quota) {
      candidateNext = nowMs;
    } else {
      const cooldownMs =
        quota.cooldown_until != null ? Date.parse(quota.cooldown_until) : undefined;
      const activeCooldownMs =
        cooldownMs !== undefined && !Number.isNaN(cooldownMs) && cooldownMs > nowMs
          ? cooldownMs
          : undefined;

      if (activeCooldownMs !== undefined) {
        // Cooldown-driven: `resets_at` cannot make this candidate routable
        // any sooner (see this function's own doc comment) — ignored here,
        // not folded into a `min()` that could read a sooner-but-irrelevant
        // window boundary as the release instant.
        candidateNext = activeCooldownMs;
      } else {
        const resetsMs = quota.resets_at != null ? Date.parse(quota.resets_at) : undefined;
        candidateNext = resetsMs !== undefined && !Number.isNaN(resetsMs) ? resetsMs : undefined;
      }
    }

    if (candidateNext === undefined) continue;
    if (earliest === undefined || candidateNext < earliest) earliest = candidateNext;
  }

  return new Date(earliest ?? nowMs + FALLBACK_RESUME_MS).toISOString();
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

    const tier = tierOf(ticket);
    const vendors = opts.store.getVendors();
    const quotas = opts.quota.list();
    const result = routeCandidates('engineer', tier, {
      vendors,
      quotas,
      now,
      routing: opts.routing,
      floor: opts.floor,
    });
    if (!('none' in result)) continue;

    const candidates = candidatesFor('engineer', tier, { vendors, routing: opts.routing });
    const resumeAt = earliestResumeAt(candidates, quotas, now);
    await opts.store.putTicket({ ...ticket, resume_at: resumeAt }, { by: 'daemon' });
    await opts.store.transitionTicket(ticketId, 'paused', { by: 'daemon', reason: result.reason });
    paused.push(ticketId);
  }

  return { paused };
}

export interface ResumeOptions {
  store: StateStore;
  quota: Pick<QuotaService, 'list'>;
  now?: () => Date;
  routing?: RoutingTable;
  floor?: number;
}

export interface ResumeResult {
  resumed: TicketId[];
}

/**
 * Every `paused` ticket whose `resume_at` has arrived is re-checked for
 * *actual* routability (T024 round 3 review-fix, opus blocker 1 — "the
 * resume check must re-evaluate routability rather than trusting a stale
 * `resume_at`") before it goes back to `ready` — "daemon scheduler resumes
 * it" (§10). Still not routable (the recomputed `earliestResumeAt` from
 * round 1/2 could still be optimistic in an edge case, or a fresh
 * cooldown/429 landed since) -> `resume_at` is simply recomputed and
 * rewritten, the ticket stays `paused`, and it is *not* counted as
 * resumed — no `paused -> ready -> paused` flap within (or across) ticks.
 *
 * `resume_at` is cleared before the `ready` transition (a `putTicket` data
 * write) so the subsequent `transitionTicket`'s own fresh read never
 * carries a stale timestamp forward onto the re-readied ticket. A `paused`
 * ticket with no `resume_at` at all (shouldn't happen via
 * `pauseStuckReadyTickets`, but a hand-authored/manual pause might omit it)
 * is left alone — nothing says when to even *check* it, so it is never
 * auto-resumed; a human/manual `resume_at` write is what unblocks it.
 */
export async function resumeDueTickets(opts: ResumeOptions): Promise<ResumeResult> {
  const now = opts.now?.() ?? new Date();
  const nowMs = now.getTime();
  const resumed: TicketId[] = [];

  for (const ticket of opts.store.listTickets()) {
    if (ticket.status !== 'paused') continue;
    if (!ticket.resume_at) continue;
    const ms = Date.parse(ticket.resume_at);
    if (Number.isNaN(ms) || ms > nowMs) continue;

    const tier = tierOf(ticket);
    const vendors = opts.store.getVendors();
    const quotas = opts.quota.list();
    const result = routeCandidates('engineer', tier, {
      vendors,
      quotas,
      now,
      routing: opts.routing,
      floor: opts.floor,
    });

    if ('none' in result) {
      // Still not actually routable — recompute rather than resume-then-repause.
      const candidates = candidatesFor('engineer', tier, { vendors, routing: opts.routing });
      const resumeAt = earliestResumeAt(candidates, quotas, now);
      if (resumeAt !== ticket.resume_at) {
        await opts.store.putTicket({ ...ticket, resume_at: resumeAt }, { by: 'daemon' });
      }
      continue;
    }

    const { resume_at: _resumeAt, ...rest } = ticket;
    await opts.store.putTicket(rest, { by: 'daemon' });
    await opts.store.transitionTicket(ticket.id, 'ready', {
      by: 'daemon',
      reason: 'resume_at reached',
    });
    resumed.push(ticket.id);
  }

  return { resumed };
}
