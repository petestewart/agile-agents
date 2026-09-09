/**
 * Sprint review (T015; design/agile-agents-design.md §9 "Sprints as
 * dependency layers", §16 "HIL gates policy").
 *
 * Fires once every ticket in a sprint is `done`. Resolves the
 * `sprint_review` gate via `GateService.request` (most-specific-wins:
 * sprint override -> repo default, §16). This is a **state machine across
 * ticks**, not a single call (review-round fix — a `human`-owned gate has
 * no synchronous answer, so the caller can't just decide "delegated vs
 * human" once and be done):
 *
 *  - `requestSprintReview` opens the `HilRequest` (throws
 *    `SprintNotDoneError` if any ticket isn't `done` yet). A delegated
 *    (`em`/`architect`) owner with a configured `GateService` delegate
 *    resolves synchronously, right here; a `human`/`human_timeout` owner
 *    comes back `pending` and stays that way until something else calls
 *    `GateService.respond`/`tick`.
 *  - `resolveSprintReview` is called again on every subsequent tick (with
 *    the same `HilRequest`, re-read fresh via `GateService.get`) until it
 *    stops returning `'pending'`. Only once `hilRequest.status ===
 *    'resolved'` does it stamp `Sprint.review_at` and the retro block
 *    (`computeRetro`/`withRetro`, review-round fix — previously had no
 *    caller): `'approve'` runs the merge callback and plans the next layer;
 *    `'deny'` does neither — the sprint stays exactly as it is (no merge, no
 *    next layer), and the caller (`loop.ts`) posts a `decision` message so
 *    the denial is visible on the bus, not just silently absorbed.
 *
 * `loop.ts` owns the map from sprint id -> in-flight `HilId` between ticks
 * (see its own header) — this module is intentionally stateless per call.
 */

import type {
  Event,
  GateOwner,
  HilRequest,
  LedgerLine,
  Sprint,
  SprintRetro,
  Ticket,
  TicketId,
} from '@agile-agents/shared';
import { validateSprint } from '@agile-agents/shared';
import type { GateService } from '../gates';
import type { StateStore } from '../store';
import { computeRetro } from './retro';
import { type PlanSprintOptions, computeFrontier, planSprint } from './sprint';

export type MergeIntegrationToMain = () => Promise<void> | void;

export interface SprintReviewOptions {
  mergeIntegrationToMain: MergeIntegrationToMain;
  /** Forwarded to `planSprint` for the next layer (approved path only). */
  nextSprint?: Omit<PlanSprintOptions, 'now'>;
  now?: () => Date;
}

/**
 * `'pending'`: the `HilRequest` hasn't resolved yet — call
 * `resolveSprintReview` again next tick. `'approved'`/`'denied'`: terminal —
 * `review_at` and `retro` are now stamped on the sprint file either way.
 */
export type SprintReviewOutcome = 'pending' | 'approved' | 'denied';

export interface SprintReviewResult {
  outcome: SprintReviewOutcome;
  gateOwner: GateOwner;
  hilRequest: HilRequest;
  /** Set only once `outcome === 'approved'` — the merge ran and this is the freshly-planned next layer. */
  nextSprint?: Sprint;
  /** Set only while `outcome === 'pending'` — the frontier as it stands right now, not yet written (see the module header's `computeFrontier` note). */
  preplannedFrontier?: TicketId[];
  /** Set once resolved (`'approved'` or `'denied'`) — the same block persisted onto `sprint.retro`. */
  retro?: SprintRetro;
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

/** `store.listLedger`/`store.listEvents` scoped to this sprint: the ledger file is already per-sprint; the event log is global, filtered to `ts >= sprint.started` (ISO-8601 timestamps sort lexically) so a prior sprint's halts/escalations don't bleed into this one's retro. */
function retroInputsFor(
  store: StateStore,
  sprint: Sprint,
): { ledgerLines: LedgerLine[]; events: Event[] } {
  const ledgerLines = store.listLedger(sprint.id);
  const events = store.listEvents().filter((e) => e.ts >= sprint.started);
  return { ledgerLines, events };
}

/**
 * Opens the `sprint_review` gate for `sprint`. Throws `SprintNotDoneError`
 * if any ticket in it isn't `done` yet. Does **not** stamp `review_at` or
 * touch the retro block — call `resolveSprintReview` (possibly on a later
 * tick) with the returned request to do that once it actually resolves.
 */
export async function requestSprintReview(
  store: StateStore,
  gateService: GateService,
  sprint: Sprint,
): Promise<HilRequest> {
  const tickets = sprintTickets(store, sprint);
  const pending = tickets.filter((t) => t.status !== 'done').map((t) => t.id);
  if (pending.length > 0) throw new SprintNotDoneError(sprint.id, pending);

  const policy = store.getPolicy();
  return gateService.request('sprint_review', {
    policy,
    sprint: sprint.gates,
    hilKind: 'demo',
  });
}

/**
 * Re-checks `hilRequest` (re-read fresh by the caller via
 * `gateService.get(id)` on every tick after the first — this function takes
 * it as a parameter rather than re-fetching itself so a caller that already
 * has the freshest copy, e.g. straight from `requestSprintReview`, never
 * pays for a second read). Still `pending` -> returns the in-memory
 * pre-plan and does nothing else. Resolved -> stamps `review_at` + `retro`
 * once, then branches on the decision.
 */
export async function resolveSprintReview(
  store: StateStore,
  sprint: Sprint,
  hilRequest: HilRequest,
  opts: SprintReviewOptions,
): Promise<SprintReviewResult> {
  if (hilRequest.status !== 'resolved') {
    const preplannedFrontier = computeFrontier(store.listTickets(), { cap: opts.nextSprint?.cap });
    return { outcome: 'pending', gateOwner: hilRequest.owner, hilRequest, preplannedFrontier };
  }

  const now = opts.now ?? (() => new Date());
  const retro = computeRetro({
    ...retroInputsFor(store, sprint),
    tickets: sprintTickets(store, sprint),
  });
  const reviewed = validateSprint({ ...sprint, review_at: now().toISOString(), retro });
  await store.putSprint(reviewed);

  if (hilRequest.decision === 'approve') {
    await opts.mergeIntegrationToMain();
    const nextSprint = await planSprint(store, { ...opts.nextSprint, now });
    return { outcome: 'approved', gateOwner: hilRequest.owner, hilRequest, nextSprint, retro };
  }

  // 'deny': no design precedent for this path (§16 never describes a denied
  // sprint review) — no merge, no next layer; `sprint` simply stays as the
  // last-planned layer (review_at/retro are stamped so this function won't
  // re-run for it, but nothing else advances). `loop.ts` posts a `decision`
  // message so the denial is visible, not silently absorbed.
  return { outcome: 'denied', gateOwner: hilRequest.owner, hilRequest, retro };
}
