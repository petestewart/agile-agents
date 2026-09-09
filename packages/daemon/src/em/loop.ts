/**
 * `EmLoop` — the EM session's daemon-side tick (T015; design/
 * agile-agents-design.md §4 "Sprint" (team, gates block, retro block), §5
 * "Comms bus", §9 "Sprints as dependency layers").
 *
 * Liveness/dead-agent handling is the runner's own periodic sweep
 * (`Runner.runSweep`/`startSweep`, T012) — `tick()` deliberately does not
 * duplicate it. What `tick()` does, in order, every call:
 *
 *  1. Assign newly `ready` tickets in the live sprint (`assignReady`).
 *  2. Triage `discovery` messages/stanzas to the architect
 *     (`triageDiscoveries` — review-round fix; previously never called).
 *  3. Process `em`'s inbox: `standup_report` folded into halts
 *     (`processStandupReports`); every halt not yet quorum-`reached` gets
 *     its quorum re-evaluated (`evaluateQuorum` — review-round fix:
 *     previously never called, so a halt could only reach quorum via every
 *     affected agent reporting, never via the 10-minute timeout, meaning one
 *     silent/dead agent deadlocked it forever); open halts get a
 *     `standup_call` if one hasn't gone out yet for that halt this process's
 *     lifetime; halts whose quorum just reached get handed to the architect
 *     (`handToArchitect`) once; halts that are both quorum-reached and
 *     decision-published get released + `resume` (`releaseIfResolved`).
 *     `qa_verdict`/`review_verdict` messages (ticket text: "just log/route")
 *     are acked and otherwise ignored here — the reviewer/QA modules
 *     (T016/T017) own reacting to their own verdicts.
 *  4. Sprint review: a state machine across ticks (review-round fix — see
 *     `review.ts`'s header for why a single call can't do this). If every
 *     ticket in the live sprint is `done` and no review has been requested
 *     for it yet, `requestSprintReview` opens the gate; every tick after
 *     that (while the sprint's review is still `pending`) re-checks it via
 *     `resolveSprintReview` until it resolves. `'approved'` merges + plans
 *     the next layer; `'denied'` posts a `decision` message instead (no
 *     merge, no next layer).
 *
 * Every step is a pure daemon-side function under `em/*` — `tick()` is the
 * orchestration glue an actual EM *model* turn's MCP verbs
 * (`verbs.ts`) call into piecemeal, and what a fully daemon-driven
 * (no model turn at all) EM could call wholesale, per the ticket's "no
 * vendor login here" constraint.
 */

import type { HilId, Message, Sprint, SprintId } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import { evaluateQuorum } from '../halts';
import type { Runner } from '../runner';
import type { StateStore } from '../store';
import { type AssignReadyOptions, assignReady } from './assign';
import { postDecision } from './board';
import { type TriageDiscoveriesResult, triageDiscoveries } from './discovery';
import {
  type SprintReviewOptions,
  type SprintReviewResult,
  requestSprintReview,
  resolveSprintReview,
} from './review';
import { handToArchitect, processStandupReports, releaseIfResolved, standupCall } from './standup';

export interface EmLoopOptions {
  store: StateStore;
  bus: Bus;
  runner: Pick<Runner, 'spawn'>;
  gateService: GateService;
  sprintReview: SprintReviewOptions;
  assign?: AssignReadyOptions;
  now?: () => Date;
}

export interface EmTickResult {
  assigned: Awaited<ReturnType<typeof assignReady>>;
  discoveries: TriageDiscoveriesResult;
  standupsCalled: string[];
  reportsProcessed: Awaited<ReturnType<typeof processStandupReports>>;
  quorumsEvaluated: string[];
  handedToArchitect: string[];
  released: string[];
  sprintReview?: SprintReviewResult;
}

/** The live sprint — the most recently created one with an unset `review_at` (mirrors `nextSprintId`'s own `S-<n>` ordering). `undefined` before any sprint exists. */
export function currentSprint(store: StateStore): Sprint | undefined {
  const sprints = store.listSprints();
  if (sprints.length === 0) return undefined;
  const open = sprints.filter((s) => s.review_at === undefined);
  const pool = open.length > 0 ? open : sprints;
  return [...pool].sort(
    (a, b) => Number(b.id.slice('S-'.length)) - Number(a.id.slice('S-'.length)),
  )[0];
}

export class EmLoop {
  /** Halt ids this process instance has already sent a `standup_call` for — avoids re-blasting urgent messages every tick while quorum is still pending. Process-local only (a daemon restart re-sends once, harmless per §5 "Ordering/failure": idempotent consumers). */
  private readonly calledHalts = new Set<string>();
  /** Halt ids already handed to the architect — same idempotency rationale. */
  private readonly escalatedHalts = new Set<string>();
  /** `discovery` board-stanza keys already forwarded — see `discovery.ts`'s header. */
  private readonly seenDiscoveryStanzas = new Set<string>();
  /** Sprint id -> the in-flight `sprint_review` `HilRequest` id, while `resolveSprintReview` still reads it as `pending`. Removed once resolved. Process-local — see `review.ts`'s header: a restart mid-pending-review re-requests via `requestSprintReview`, opening a second `HilRequest` (the first is simply abandoned, not double-resolved) rather than silently losing the review. */
  private readonly pendingReviews = new Map<SprintId, HilId>();

  constructor(private readonly opts: EmLoopOptions) {}

  private get store(): StateStore {
    return this.opts.store;
  }

  private get bus(): Bus {
    return this.opts.bus;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private async runStandups(): Promise<{
    standupsCalled: string[];
    reportsProcessed: Awaited<ReturnType<typeof processStandupReports>>;
    quorumsEvaluated: string[];
    handedToArchitect: string[];
    released: string[];
  }> {
    const standupsCalled: string[] = [];
    const quorumsEvaluated: string[] = [];
    const handedToArchitect: string[] = [];
    const released: string[] = [];

    for (const halt of this.store.listHalts()) {
      if (halt.quorum !== 'reached' && !this.calledHalts.has(halt.id)) {
        await standupCall(this.bus, halt, () => this.now());
        this.calledHalts.add(halt.id);
        standupsCalled.push(halt.id);
      }
    }

    const reportsProcessed = await processStandupReports(this.store, this.bus, () =>
      this.now().getTime(),
    );

    // Review-round fix (blocker 3): re-evaluate every still-pending halt's
    // quorum so the 10-minute timeout can flip it to `reached` even when one
    // affected agent never reports — previously nothing ever called this.
    for (const halt of this.store.listHalts()) {
      if (halt.quorum !== 'reached') {
        await evaluateQuorum(this.store, halt.id, () => this.now().getTime());
        quorumsEvaluated.push(halt.id);
      }
    }

    for (const halt of this.store.listHalts()) {
      if (halt.quorum === 'reached' && !this.escalatedHalts.has(halt.id)) {
        await handToArchitect(this.bus, halt, () => this.now());
        this.escalatedHalts.add(halt.id);
        handedToArchitect.push(halt.id);
      }
    }

    for (const halt of this.store.listHalts()) {
      const wasReleased = await releaseIfResolved(this.store, this.bus, halt, () => this.now());
      if (wasReleased) {
        released.push(halt.id);
        this.calledHalts.delete(halt.id);
        this.escalatedHalts.delete(halt.id);
      }
    }

    return { standupsCalled, reportsProcessed, quorumsEvaluated, handedToArchitect, released };
  }

  /** Acks every `qa_verdict`/`review_verdict` copy sitting in `em`'s inbox — "just log/route" (ticket text); the reviewer/QA modules own reacting to their own verdicts. */
  private async drainVerdictCopies(): Promise<void> {
    const inbox = this.bus.poll('em');
    for (const message of inbox) {
      if (isVerdictCopy(message)) await this.bus.ack('em', message.id);
    }
  }

  /** The sprint-review state machine's one step for `sprint` this tick — see the file header and `review.ts`'s own header for the full shape. `undefined` when there's nothing to do (no sprint, or its tickets aren't all `done` yet and no review is in flight). */
  private async runSprintReview(
    sprint: Sprint | undefined,
  ): Promise<SprintReviewResult | undefined> {
    if (!sprint || sprint.review_at !== undefined) return undefined;

    const now = () => this.now();
    const inFlight = this.pendingReviews.get(sprint.id);

    if (inFlight === undefined) {
      if (sprint.tickets.length === 0) return undefined;
      const tickets = sprint.tickets.map((id) => {
        try {
          return this.store.getTicket(id);
        } catch {
          return undefined;
        }
      });
      const allDone = tickets.every((t) => t !== undefined && t.status === 'done');
      if (!allDone) return undefined;

      const hilRequest = await requestSprintReview(this.store, this.opts.gateService, sprint);
      const result = await resolveSprintReview(this.store, sprint, hilRequest, {
        ...this.opts.sprintReview,
        now,
      });
      if (result.outcome === 'pending') {
        this.pendingReviews.set(sprint.id, hilRequest.id);
      } else {
        await this.onSprintReviewResolved(sprint, result);
      }
      return result;
    }

    const hilRequest = this.opts.gateService.get(inFlight);
    const result = await resolveSprintReview(this.store, sprint, hilRequest, {
      ...this.opts.sprintReview,
      now,
    });
    if (result.outcome !== 'pending') {
      this.pendingReviews.delete(sprint.id);
      await this.onSprintReviewResolved(sprint, result);
    }
    return result;
  }

  /** `'denied'` gets a `decision` message onto the bus so the outcome is visible, not silently absorbed (review-round fix's own wording: "sprint stays open with a decision message"). `'approved'` needs nothing further here — `resolveSprintReview` already ran the merge and planned the next layer. */
  private async onSprintReviewResolved(sprint: Sprint, result: SprintReviewResult): Promise<void> {
    if (result.outcome !== 'denied') return;
    await postDecision(this.bus, {
      to: ['human'],
      body: `sprint ${sprint.id} review denied by ${result.hilRequest.decided_by ?? result.hilRequest.owner} — no merge, sprint stays open`,
      refs: [result.hilRequest.id],
      now: () => this.now(),
    });
  }

  async tick(): Promise<EmTickResult> {
    const sprint = currentSprint(this.store);

    const assigned = sprint
      ? await assignReady(this.store, this.bus, this.opts.runner, sprint, {
          ...this.opts.assign,
          now: () => this.now(),
        })
      : [];

    const discoveries = await triageDiscoveries(
      this.store,
      this.bus,
      sprint?.tickets ?? [],
      this.seenDiscoveryStanzas,
      () => this.now(),
    );

    const { standupsCalled, reportsProcessed, quorumsEvaluated, handedToArchitect, released } =
      await this.runStandups();
    await this.drainVerdictCopies();

    const review = await this.runSprintReview(sprint);

    return {
      assigned,
      discoveries,
      standupsCalled,
      reportsProcessed,
      quorumsEvaluated,
      handedToArchitect,
      released,
      sprintReview: review,
    };
  }
}

function isVerdictCopy(message: Message): boolean {
  return message.kind === 'qa_verdict' || message.kind === 'review_verdict';
}
