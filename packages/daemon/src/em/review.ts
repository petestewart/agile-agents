/**
 * Sprint review (T015; design/agile-agents-design.md §9 "Sprints as
 * dependency layers", §16 "HIL gates policy").
 *
 * Fires once every ticket in a sprint is `done`. Resolves the
 * `sprint_review` gate via `GateService.request` (most-specific-wins:
 * sprint override -> repo default, §16): a delegated (`em`/`architect`)
 * outcome merges `integration -> main` (via an injected callback — T019
 * owns the real merge, this ticket only calls it) and plans the next layer
 * immediately; a `human`-owned (or still-`pending` `human_timeout`) outcome
 * leaves the gate open and only *pre-plans* — computes the next frontier
 * without writing a sprint file, so "one approval unblocks both" (§9) once
 * the human answers.
 *
 * DESIGN-GAP: the session brief offers two readings of "pre-plan": "compute
 * next frontier without writing it, or write as a `draft` sprint —
 * document." The latter would be a new persisted-artifact shape (a sprint
 * file with no real `id` history yet) with no sibling precedent, which
 * CLAUDE.md's "no new codebase conventions without explicit approval" rules
 * out without a manager decision — so this module takes the former: the
 * pre-plan is returned in-memory (`SprintReviewResult.preplannedFrontier`),
 * not written to `.agile/`. `Sprint.review_at`, the schema's own"<HIL
 * demo>" placeholder field, is stamped with the request's `requested_at` on
 * the reviewed sprint so `Sprint.review_at` starts recording actual review
 * timestamps.
 */

import type { GateOwner, HilRequest, Sprint, Ticket, TicketId } from '@agile-agents/shared';
import { validateSprint } from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { StateStore } from '../store';
import { type PlanSprintOptions, computeFrontier, planSprint } from './sprint';

export type MergeIntegrationToMain = () => Promise<void> | void;

export interface SprintReviewOptions {
  mergeIntegrationToMain: MergeIntegrationToMain;
  /** Forwarded to `planSprint` for the next layer (delegated path only). */
  nextSprint?: Omit<PlanSprintOptions, 'now'>;
  now?: () => Date;
}

export type SprintReviewOutcome = 'delegated' | 'human' | 'denied';

export interface SprintReviewResult {
  outcome: SprintReviewOutcome;
  gateOwner: GateOwner;
  hilRequest: HilRequest;
  /** Set only on the delegated path — the merge ran and this is the freshly-planned next layer. */
  nextSprint?: Sprint;
  /** Set only on the human/pending path — the frontier as it stands right now, not yet written. */
  preplannedFrontier?: TicketId[];
}

export class SprintNotDoneError extends Error {
  constructor(
    public readonly sprint: Sprint['id'],
    public readonly pending: TicketId[],
  ) {
    super(`sprintReview: ${sprint} has tickets not yet done: ${pending.join(', ')}`);
    this.name = 'SprintNotDoneError';
  }
}

/** Every ticket in the sprint, in `sprint.tickets` order (missing tickets are skipped, not thrown on — same tolerance `readBoard` gives a vanished ticket). */
function sprintTickets(store: StateStore, sprint: Sprint): Ticket[] {
  const tickets: Ticket[] = [];
  for (const id of sprint.tickets) {
    try {
      tickets.push(store.getTicket(id));
    } catch {
      // Ticket vanished — nothing to check against "every ticket done".
    }
  }
  return tickets;
}

/**
 * Runs sprint review for `sprint`. Throws `SprintNotDoneError` if any ticket
 * in it isn't `done` yet — callers (`loop.ts`) are expected to check first,
 * but this is the enforced invariant either way.
 */
export async function sprintReview(
  store: StateStore,
  gateService: GateService,
  sprint: Sprint,
  opts: SprintReviewOptions,
): Promise<SprintReviewResult> {
  const tickets = sprintTickets(store, sprint);
  const pending = tickets.filter((t) => t.status !== 'done').map((t) => t.id);
  if (pending.length > 0) throw new SprintNotDoneError(sprint.id, pending);

  const now = opts.now ?? (() => new Date());
  const policy = store.getPolicy();
  const hilRequest = await gateService.request('sprint_review', {
    policy,
    sprint: sprint.gates,
    hilKind: 'demo',
  });

  await store.putSprint(validateSprint({ ...sprint, review_at: now().toISOString() }));

  if (hilRequest.status === 'resolved' && hilRequest.decision === 'approve') {
    await opts.mergeIntegrationToMain();
    const nextSprint = await planSprint(store, { ...opts.nextSprint, now });
    return { outcome: 'delegated', gateOwner: hilRequest.owner, hilRequest, nextSprint };
  }

  if (hilRequest.status === 'resolved' && hilRequest.decision === 'deny') {
    // No sibling precedent for a denied sprint review (§16 never names this
    // path) — surfaced distinctly rather than silently treated as either a
    // merge or a normal pending-human wait; no merge, no pre-plan.
    return { outcome: 'denied', gateOwner: hilRequest.owner, hilRequest };
  }

  const preplannedFrontier = computeFrontier(store.listTickets(), { cap: opts.nextSprint?.cap });
  return { outcome: 'human', gateOwner: hilRequest.owner, hilRequest, preplannedFrontier };
}
