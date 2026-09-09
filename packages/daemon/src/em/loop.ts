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
 *  2. Process `em`'s inbox: `standup_report` folded into halts
 *     (`processStandupReports`); `discovery` stanzas/messages and open
 *     halts get a `standup_call` (`standupCall`) if one hasn't gone out yet
 *     for that halt this tick; halts whose quorum just reached get handed
 *     to the architect (`handToArchitect`) once; halts that are both
 *     quorum-reached and decision-published get released + `resume`
 *     (`releaseIfResolved`). `qa_verdict`/`review_verdict` messages
 *     (ticket text: "just log/route") are acked and otherwise ignored here —
 *     the reviewer/QA modules (T016/T017) own reacting to their own
 *     verdicts; the EM's inbox copy is routing noise, not a decision point.
 *  3. Sprint review check: if every ticket in the live sprint is `done` and
 *     review hasn't already fired for it (`sprint.review_at` still unset),
 *     run `sprintReview`.
 *
 * Every step is a pure daemon-side function under `em/*` — `tick()` is the
 * orchestration glue an actual EM *model* turn's MCP verbs
 * (`verbs.ts`) call into piecemeal, and what a fully daemon-driven
 * (no model turn at all) EM could call wholesale, per the ticket's "no
 * vendor login here" constraint.
 */

import type { Halt, Message, Sprint } from '@agile-agents/shared';
import type { Bus } from '../bus';
import type { GateService } from '../gates';
import type { Runner } from '../runner';
import type { StateStore } from '../store';
import { type AssignReadyOptions, assignReady } from './assign';
import { type SprintReviewOptions, type SprintReviewResult, sprintReview } from './review';
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
  standupsCalled: string[];
  reportsProcessed: Awaited<ReturnType<typeof processStandupReports>>;
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

  /** Every halt currently active (global, or scoping a live ticket), deduped by id. */
  private activeHalts(sprint: Sprint | undefined): Halt[] {
    const all = new Map<string, Halt>();
    for (const halt of this.store.listHalts()) all.set(halt.id, halt);
    void sprint; // Reserved: a future cut could scope this to sprint tickets only; `listHalts()` is small enough in v0 not to need it (activeHaltsFor exists for the per-ticket case).
    return [...all.values()];
  }

  private async runStandups(): Promise<{
    standupsCalled: string[];
    reportsProcessed: Awaited<ReturnType<typeof processStandupReports>>;
    handedToArchitect: string[];
    released: string[];
  }> {
    const standupsCalled: string[] = [];
    const handedToArchitect: string[] = [];
    const released: string[] = [];

    const halts = this.activeHalts(undefined);
    for (const halt of halts) {
      if (halt.quorum !== 'reached' && !this.calledHalts.has(halt.id)) {
        await standupCall(this.bus, halt, () => this.now());
        this.calledHalts.add(halt.id);
        standupsCalled.push(halt.id);
      }
    }

    const reportsProcessed = await processStandupReports(this.store, this.bus, () =>
      this.now().getTime(),
    );

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

    return { standupsCalled, reportsProcessed, handedToArchitect, released };
  }

  /** Acks every `qa_verdict`/`review_verdict` copy sitting in `em`'s inbox — "just log/route" (ticket text); the reviewer/QA modules own reacting to their own verdicts. */
  private async drainVerdictCopies(): Promise<void> {
    const inbox = this.bus.poll('em');
    for (const message of inbox) {
      if (isVerdictCopy(message)) await this.bus.ack('em', message.id);
    }
  }

  async tick(): Promise<EmTickResult> {
    const sprint = currentSprint(this.store);

    const assigned = sprint
      ? await assignReady(this.store, this.bus, this.opts.runner, sprint, this.opts.assign)
      : [];

    const { standupsCalled, reportsProcessed, handedToArchitect, released } =
      await this.runStandups();
    await this.drainVerdictCopies();

    let review: SprintReviewResult | undefined;
    if (sprint && sprint.review_at === undefined && sprint.tickets.length > 0) {
      const tickets = sprint.tickets.map((id) => {
        try {
          return this.store.getTicket(id);
        } catch {
          return undefined;
        }
      });
      const allDone = tickets.every((t) => t !== undefined && t.status === 'done');
      if (allDone) {
        review = await sprintReview(this.store, this.opts.gateService, sprint, {
          ...this.opts.sprintReview,
          now: () => this.now(),
        });
      }
    }

    return {
      assigned,
      standupsCalled,
      reportsProcessed,
      handedToArchitect,
      released,
      sprintReview: review,
    };
  }
}

function isVerdictCopy(message: Message): boolean {
  return message.kind === 'qa_verdict' || message.kind === 'review_verdict';
}
