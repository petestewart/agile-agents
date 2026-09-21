/**
 * Plan screen back end (T042 — design/agile-agents-design.md §17 "Control
 * room v2" → "Plan screen = the documents + the EM chat", and the mockup's
 * Plan tab). One service behind the `/api/plan/*` routes, so every pane is
 * backed by daemon data and every edit goes through the validating store
 * (and therefore `log/events.jsonl`) rather than
 * through the browser writing files.
 *
 * Panes → data:
 *
 *   Brief        `oracle/product.md`        `store.getDoc`/`putDoc`
 *   Rules        `oracle/specs/SPEC-*.md`   oracle index + write guard
 *   Questions    `questions/Q-*.yaml` `QuestionService` (T040)
 *   Decisions    `oracle/decisions/DEC-*.md` oracle index + write guard
 *   Tickets      `tickets/TKT-*.yaml`       store + living-plan rules
 *   Sprints      `sprints/S-*.yaml`         `projection.ts` (pure, read-only)
 *   Knowledge    `knowledge/facts/*.md`     `store.putKbFact`/`getKbFact`
 *   Who decides  `policy.yaml`              `store.getPolicy` (read-only here —
 *                                           the editor is Settings, T043)
 *
 * Two rules are enforced here rather than in the UI, per the ticket:
 *
 *   - **living plan** — see `living.ts` (`applyPlanTicketEdit`);
 *   - **rule edits that tickets already depend on become a proposed
 *     decision** — a `decision` bus message to the architect, the same path
 *     `POST /api/oracle/propose` (T025) already uses, never a silent rewrite
 *     of a rule live tickets are being judged against.
 */

import {
  type KbFact,
  type KbId,
  type OracleEntry,
  type OracleId,
  type Policy,
  type Sprint,
  type Ticket,
  type TicketId,
  ulid,
  validateKbFact,
} from '@agile-agents/shared';
import { nextTicketId } from '../architect/refine';
import type { Bus } from '../bus';
import { planSprint } from '../em/sprint';
import type { GateService } from '../gates';
import { PRODUCT_MD_STUB } from '../init';
import { oracleWrite } from '../oracle';
import type { QuestionService } from '../questions';
import type { StateStore } from '../store';
import { type TicketEditPatch, type TicketEditResult, applyPlanTicketEdit } from './living';
import { type SprintBoard, buildSprintBoard } from './projection';
import { type ReexamineRecord, type Reexaminer, reexamineAfterDecision } from './reexamine';
import { isStub } from './stub';

export class PlanRefused extends Error {
  /**
   * HTTP status the route should answer with. 409 (the default) is the
   * "the state says no" family — editing a rule live tickets cite, moving a
   * stub that still has blockers. 400 is for a request that is simply not
   * startable as asked: an empty frontier, or a second Start Sprint while one
   * is running or already waiting on `approve_plan` (T043 review's two
   * guards on this route).
   */
  constructor(
    reason: string,
    readonly status: 400 | 409 = 409,
  ) {
    super(`plan: ${reason}`);
    this.name = 'PlanRefused';
  }
}

export const PRODUCT_BRIEF_PATH = 'oracle/product.md';

export interface PlanServiceDeps {
  store: StateStore;
  bus?: Bus;
  gates?: GateService;
  questions?: QuestionService;
  /** The architect's judgment for the post-decision re-examination pass (`reexamine.ts`). */
  reexaminer?: Reexaminer;
  now?: () => Date;
}

export interface BriefView {
  path: string;
  body: string;
  /** True while `oracle/product.md` is still the placeholder `agile init` wrote — what "the repo has no plan yet" means for the first-goal routing. */
  stub: boolean;
}

export interface OracleDoc {
  entry: OracleEntry;
  body: string;
  /** Not-done tickets whose `oracle_refs` cite this entry — why an edit may become a proposal instead of a write. */
  cited_by: TicketId[];
}

export interface RuleWriteResult {
  /** `true` when live tickets cite the rule, so the edit went to the architect as a proposed decision instead of being written. */
  proposed: boolean;
  entry?: OracleEntry;
  cited_by?: TicketId[];
}

export interface DecisionPublishResult {
  entry: OracleEntry;
  /** Ticket ids the §4 ripple walk marked `stale`. */
  stale: TicketId[];
  /** One record per not-done ticket from the re-examination pass (§17 v2). */
  reexamined: ReexamineRecord[];
}

/** What Start Sprint would start — computed from the ticket graph, never written. */
export interface SprintProposal {
  /** The `S-<n>` this would be minted as. */
  id: string;
  tickets: TicketId[];
  goal: string;
}

export interface StartSprintResult {
  /** `false` when the gate is still pending, or was denied — in which case **nothing** was written. */
  started: boolean;
  /** Present only when `started` — the persisted sprint. */
  sprint?: Sprint;
  /** What was put to the gate. */
  proposal: SprintProposal;
  /** The `approve_plan` gate — always raised, even when the click itself resolves it, so the start is in the log (§16). */
  gate: { id: string; owner: string; status: string; decision?: string };
  /** Why nothing started, when `started` is false. */
  reason?: string;
}

export class PlanService {
  constructor(private readonly deps: PlanServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // ------------------------------------------------------------- Brief

  brief(): BriefView {
    let body: string;
    try {
      body = this.deps.store.getDoc(PRODUCT_BRIEF_PATH);
    } catch {
      body = '';
    }
    return { path: PRODUCT_BRIEF_PATH, body, stub: body.trim() === PRODUCT_MD_STUB.trim() };
  }

  async putBrief(body: string, by = 'human'): Promise<BriefView> {
    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new PlanRefused('the brief may not be empty');
    }
    await this.deps.store.putDoc(PRODUCT_BRIEF_PATH, body.endsWith('\n') ? body : `${body}\n`, {
      by,
    });
    return this.brief();
  }

  // --------------------------------------------------- Rules / Decisions

  /** Active oracle entries of one family, newest id last. The index holds active entries only (§4), which is what both panes show. */
  private listOracle(prefix: 'SPEC-' | 'DEC-'): OracleDoc[] {
    const index = this.deps.store.listOracleIndex();
    return Object.keys(index)
      .filter((id) => id.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b))
      .map((id) => this.getOracle(id as OracleId));
  }

  listRules(): OracleDoc[] {
    return this.listOracle('SPEC-');
  }

  listDecisions(): OracleDoc[] {
    return this.listOracle('DEC-');
  }

  getOracle(id: OracleId): OracleDoc {
    const { entry, body } = this.deps.store.getOracleEntry(id);
    return { entry, body, cited_by: this.citedBy(id) };
  }

  /** Not-done tickets citing `id`. A rule with any of these may not be rewritten in place — the edit becomes a proposed decision. */
  citedBy(id: OracleId): TicketId[] {
    return this.deps.store
      .listTickets()
      .filter((t) => t.status !== 'done' && t.oracle_refs.includes(id))
      .map((t) => t.id);
  }

  /** `SPEC-<slug>-<nnn>` for a new rule (§4's own id shape; `ids.ts` fixes the grammar). */
  private nextSpecId(title: string): OracleId {
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .split('-')
        .filter(Boolean)
        .slice(0, 2)
        .join('-') || 'rule';
    const index = this.deps.store.listOracleIndex();
    let n = 1;
    while (Object.keys(index).includes(`SPEC-${slug}-${String(n).padStart(3, '0')}`)) n++;
    return `SPEC-${slug}-${String(n).padStart(3, '0')}` as OracleId;
  }

  /**
   * Writes (or proposes) a rule. A brand-new rule, or one no live ticket
   * cites, is written straight through the oracle write guard (`oracleWrite`
   * — graph validation + ripple walk, actor `architect`, `by` recording who
   * actually decided). A rule some not-done ticket already `oracle_refs`
   * becomes a **proposed decision**: a `decision` message to the architect,
   * because those tickets are being judged against the current wording.
   */
  async putRule(
    input: { id?: OracleId; title: string; body: string; rationale?: string },
    by = 'human',
  ): Promise<RuleWriteResult> {
    if (!input.title?.trim()) throw new PlanRefused('a rule needs a title');
    if (!input.body?.trim()) throw new PlanRefused('a rule needs a body');
    const id = input.id ?? this.nextSpecId(input.title);
    const cited = input.id ? this.citedBy(id) : [];
    if (cited.length > 0) {
      if (!this.deps.bus) {
        throw new PlanRefused(
          `${id} is cited by ${cited.join(', ')} and the bus is not wired — refusing to rewrite a rule live tickets depend on`,
        );
      }
      const result = await this.deps.bus.send({
        id: ulid(),
        ts: this.now().toISOString(),
        from: 'human',
        to: ['architect'],
        kind: 'decision',
        priority: 'normal',
        body: `Proposed edit to ${id} (${input.title}), cited by ${cited.join(', ')}: ${input.body}`.slice(
          0,
          800,
        ),
        refs: [id],
      });
      if (!result.ok) throw new PlanRefused(`proposal rejected by the bus: ${result.reason}`);
      return { proposed: true, cited_by: cited };
    }

    const existing = (() => {
      try {
        return this.deps.store.getOracleEntry(id).entry;
      } catch {
        return undefined;
      }
    })();
    const entry: OracleEntry = {
      id,
      title: input.title.trim(),
      status: 'active',
      supersedes: existing?.supersedes ?? [],
      depends: existing?.depends ?? [],
      affects: existing?.affects ?? [],
      decided: this.now().toISOString(),
      by: by === 'human' ? 'human' : 'architect',
      rationale: (input.rationale ?? input.body).trim().slice(0, 800),
    };
    const written = await oracleWrite(this.deps.store, {
      actor: 'architect',
      entry,
      body: input.body,
    });
    return { proposed: false, entry: written.entry };
  }

  /** Next `DEC-####` — same rule (and same reason) as `questions/service.ts`'s own minting: the index holds active entries only, so step past any id with a file. */
  private nextDecisionId(): OracleId {
    const index = this.deps.store.listOracleIndex();
    let next =
      Object.keys(index).reduce((acc, id) => {
        const n = Number(/^DEC-(\d+)$/.exec(id)?.[1] ?? '0');
        return Number.isFinite(n) ? Math.max(acc, n) : acc;
      }, 0) + 1;
    const exists = (id: string) => {
      try {
        this.deps.store.getOracleEntry(id as OracleId);
        return true;
      } catch {
        return false;
      }
    };
    while (exists(`DEC-${String(next).padStart(4, '0')}`)) next++;
    return `DEC-${String(next).padStart(4, '0')}` as OracleId;
  }

  /**
   * Publishes a decision through the existing write guard, then runs the
   * re-examination pass over every not-done ticket (§17 v2 — the ripple walk
   * alone cannot reach a stub, which cites nothing).
   */
  async publishDecision(
    input: { title: string; body: string; rationale?: string; affects?: OracleId[] },
    by = 'human',
  ): Promise<DecisionPublishResult> {
    if (!input.title?.trim()) throw new PlanRefused('a decision needs a title');
    if (!input.body?.trim()) throw new PlanRefused('a decision needs a body');
    const entry: OracleEntry = {
      id: this.nextDecisionId(),
      title: input.title.trim().slice(0, 120),
      status: 'active',
      supersedes: [],
      depends: [],
      affects: input.affects ?? [],
      decided: this.now().toISOString(),
      by: by === 'human' ? 'human' : 'architect',
      rationale: (input.rationale ?? input.body).trim().slice(0, 800),
    };
    const written = await oracleWrite(this.deps.store, {
      actor: 'architect',
      entry,
      body: input.body,
    });
    const reexamined = await reexamineAfterDecision(
      {
        store: this.deps.store,
        ...(this.deps.bus ? { bus: this.deps.bus } : {}),
        nextTicketId: () => nextTicketId(this.deps.store),
        ...(this.deps.reexaminer ? { reexaminer: this.deps.reexaminer } : {}),
        ...(this.deps.now ? { now: this.deps.now } : {}),
      },
      written.entry,
      input.body,
      written.stale,
    );
    return { entry: written.entry, stale: written.stale, reexamined };
  }

  // ----------------------------------------------------------- Tickets

  listTickets(): Array<Ticket & { stub: boolean }> {
    return this.deps.store
      .listTickets()
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => ({ ...t, stub: isStub(t) }));
  }

  /** "Add ticket" — created as a stub (`stub.ts`): title, one-line summary, dependencies; the architect refines it when its layer is next. */
  async createTicket(
    input: { title: string; description?: string; depends?: TicketId[] },
    by = 'human',
  ): Promise<Ticket> {
    if (!input.title?.trim()) throw new PlanRefused('a ticket needs a title');
    return this.deps.store.putTicket(
      {
        id: nextTicketId(this.deps.store),
        title: input.title.trim(),
        ...(input.description ? { description: input.description.trim() } : {}),
        status: 'draft',
        depends: input.depends ?? [],
        oracle_refs: [],
        kb_refs: [],
        contract: { inputs: [], outputs: [], acceptance: [], done: [], env: 'clone' },
        history: [],
        security: false,
      },
      { by },
    );
  }

  async editTicket(id: TicketId, patch: TicketEditPatch, by = 'human'): Promise<TicketEditResult> {
    return applyPlanTicketEdit(
      {
        store: this.deps.store,
        ...(this.deps.bus ? { bus: this.deps.bus } : {}),
        nextTicketId: () => nextTicketId(this.deps.store),
        ...(this.deps.now ? { now: this.deps.now } : {}),
      },
      id,
      patch,
      by,
    );
  }

  // ----------------------------------------------------------- Sprints

  sprints(): SprintBoard {
    return buildSprintBoard(this.deps.store.listTickets(), this.deps.store.listSprints());
  }

  /**
   * The Sprints pane's one row action (§17 v2: "One row action, **move**",
   * replacing pull-out/force-in). Sprints after the running one are
   * *computed*, not stored, so "move" cannot edit a sprint file — it edits
   * the one thing the computation reads: whether the ticket is on the
   * frontier.
   *
   * DESIGN-GAP: `ready -> draft` is not a legal edge (§4 — a ticket only
   * leaves `draft` forwards), so "move later" uses `paused`, the existing
   * "eligible again later, nothing lost" state (`ready -> paused ->
   * ready`, §10), with the reason recorded in the ticket's history. "Move
   * to next" is the same edge back. A stub is refused: an empty contract is
   * not something to hand an engineer — it needs the architect first.
   */
  async moveTicket(id: TicketId, to: 'next' | 'later', by = 'human'): Promise<Ticket> {
    const ticket = this.deps.store.getTicket(id);
    if (ticket.sprint !== undefined) {
      throw new PlanRefused(`${id} is already in ${ticket.sprint} — halt the sprint to change it`);
    }
    if (to === 'later') {
      if (ticket.status !== 'ready') {
        throw new PlanRefused(`${id} is ${ticket.status}; only a ready ticket can be moved later`);
      }
      return this.deps.store.transitionTicket(id, 'paused', {
        by,
        reason: 'moved out of the next sprint from the Plan screen',
      });
    }
    if (isStub(ticket)) {
      throw new PlanRefused(
        `${id} is a stub — the architect refines it (title, contract, points) before it can be started`,
      );
    }
    if (ticket.status !== 'paused' && ticket.status !== 'draft') {
      throw new PlanRefused(`${id} is ${ticket.status}, not waiting for a later layer`);
    }
    const blocked = ticket.depends.filter((dep) => {
      try {
        return this.deps.store.getTicket(dep).status !== 'done';
      } catch {
        return true;
      }
    });
    if (blocked.length > 0) {
      throw new PlanRefused(`${id} still waits on ${blocked.join(', ')}`);
    }
    return this.deps.store.transitionTicket(id, 'ready', {
      by,
      reason: 'moved into the next sprint from the Plan screen',
    });
  }

  // --------------------------------------------------------- Knowledge

  listKnowledge(): Array<{ fact: KbFact; body: string }> {
    const index = this.deps.store.listKbIndex();
    return Object.keys(index)
      .sort((a, b) => a.localeCompare(b))
      .map((id) => this.deps.store.getKbFact(id as KbId));
  }

  /**
   * Adds or edits a knowledge fact (§4 "Knowledge store"). `kind`/`scope`/
   * `confidence` default to the narrowest honest values for a human-entered
   * fact: `codebase`, repo-wide scope, and `observed` (a human saying so is
   * an observation, not a verified measurement).
   */
  async putKnowledge(
    input: {
      id?: KbId;
      kind?: KbFact['kind'];
      scope?: string[];
      body: string;
      confidence?: KbFact['confidence'];
    },
    by = 'human',
  ): Promise<KbFact> {
    if (!input.body?.trim()) throw new PlanRefused('a fact needs a body');
    const existing = (() => {
      if (!input.id) return undefined;
      try {
        return this.deps.store.getKbFact(input.id).fact;
      } catch {
        return undefined;
      }
    })();
    const fact = validateKbFact({
      id: input.id ?? this.nextKbId(),
      kind: input.kind ?? existing?.kind ?? 'codebase',
      scope: input.scope ?? existing?.scope ?? ['repo'],
      confidence: input.confidence ?? existing?.confidence ?? 'observed',
      source: existing?.source ?? `human:${by}`,
      expires: existing?.expires ?? null,
    });
    return this.deps.store.putKbFact(fact, input.body);
  }

  private nextKbId(): KbId {
    const index = this.deps.store.listKbIndex();
    const next =
      Object.keys(index).reduce((acc, id) => {
        const n = Number(/^KB-(\d+)$/.exec(id)?.[1] ?? '0');
        return Number.isFinite(n) ? Math.max(acc, n) : acc;
      }, 0) + 1;
    return `KB-${String(next).padStart(4, '0')}` as KbId;
  }

  // ------------------------------------------------------ Who decides

  policy(): Policy {
    return this.deps.store.getPolicy();
  }

  // ------------------------------------------------------ Start Sprint

  /**
   * What Start Sprint *would* start: the settled frontier, the `S-<n>` it
   * would be minted as, and the goal — computed, never written. This is the
   * same `computeFrontier` the Sprints pane's "next" row shows and the same
   * one `planSprint` will take, so the proposal, the gate summary and the
   * sprint that eventually lands cannot disagree.
   */
  proposeSprint(options: { cap?: number; goal?: string } = {}): SprintProposal | undefined {
    const board = this.sprints();
    if (board.running !== undefined || !board.next) return undefined;
    const tickets =
      options.cap !== undefined ? board.next.tickets.slice(0, options.cap) : board.next.tickets;
    return { id: board.next.id, tickets, goal: options.goal ?? this.sprintGoal() };
  }

  /**
   * The gate's `summary`, and — because a `HilRequest` has no field of its
   * own to bind a decision to a proposal — the *identity* of what was
   * approved. `startApprovedSprint` below re-derives the current proposal and
   * only starts a sprint when a resolved-approve `approve_plan` request
   * carries exactly this string, so a stale approval from an earlier sprint
   * can never start a later one (its ticket list, and its `S-<n>`, differ).
   */
  private static summaryFor(proposal: SprintProposal): string {
    return `Start ${proposal.id}: ${proposal.tickets.join(', ') || 'no tickets'} — ${proposal.goal}`;
  }

  /**
   * The one top-bar action (§17 v2: "No plan approval. Documents are edited,
   * sprints are started. The `approve_plan` gate is raised at sprint start
   * and means 'start this frontier with these tickets and rules as they
   * stand'").
   *
   * Order matters, and round-1 review got it the other way round: **nothing
   * is persisted until the gate is approved.** `planSprint` writes
   * `sprints/S-<n>.yaml` and stamps `sprint: S-<n>` onto every frontier
   * ticket, and `EmLoop.currentSprint()` treats any sprint without a
   * `review_at` as live — so planning first would have the EM assigning
   * engineers on the next ceremony tick while an `em`/`architect`-owned gate
   * was still pending (or pending forever with no delegate), with no
   * rollback on a denial.
   *
   * So: propose (pure) → raise `approve_plan` carrying the proposal →
   * - `human` owner: **the click is the approval** (§17 v2, "no second
   *   approval step") — resolved here, by `by`, and the sprint is planned in
   *   this same call;
   * - a delegate that answers synchronously: same, one call;
   * - a delegate still deciding, or no delegate at all: nothing is written.
   *   The request stays pending in `board/hil/` and the daemon's ceremony
   *   tick picks it up through `startApprovedSprint()` once it resolves;
   * - denied: nothing is written, and the denial is already on the record as
   *   the gate's own `hil_resolved` event.
   */
  async startSprint(
    options: { by?: string; cap?: number; goal?: string } = {},
  ): Promise<StartSprintResult> {
    const by = options.by ?? 'human';
    const board = this.sprints();
    // Guard 1 (T043 review): one sprint at a time.
    if (board.running !== undefined) {
      throw new PlanRefused(`${board.running} is still running — finish or halt it first`, 400);
    }
    if (!this.deps.gates) {
      throw new PlanRefused('gate service not wired — cannot raise approve_plan');
    }
    // Guard 2 (T043 review): a proposal already waiting on `approve_plan` is
    // not re-raised. Without this, every click on a top bar that has not
    // refreshed yet opens another pending request for the same frontier, and
    // whichever is approved first starts it twice as far as the log is
    // concerned.
    const pending = this.pendingApprovePlan();
    if (pending) {
      throw new PlanRefused(
        `approve_plan ${pending.id} is already waiting on ${pending.owner} for this frontier`,
        400,
      );
    }
    // Guard 3 (T043 review): an empty frontier is a 400, not a sprint with no
    // tickets — `computeFrontier` returning nothing means every ready ticket
    // still waits on something (or there are no tickets at all).
    const proposal = this.proposeSprint(options);
    if (!proposal || proposal.tickets.length === 0) {
      throw new PlanRefused(
        'nothing is ready to start: no ticket has all of its dependencies done',
        400,
      );
    }

    // T121: the `approve_plan` gate is deleted (cockpit design §3.1 — "there
    // is no planning turn that needs approving ... the human writes the goal
    // themselves"), so the click that got here *is* the approval and no HIL
    // request is opened. T122 deletes this module.
    const gateView = {
      id: `approve_plan-deleted-${by}`,
      owner: 'human',
      status: 'resolved' as const,
      decision: 'approve' as const,
    };

    const sprint = await this.planProposal(proposal, options.cap);
    return { started: true, sprint, proposal, gate: gateView };
  }

  /**
   * Ceremony-tick pickup for an `approve_plan` a delegate resolved *after*
   * `startSprint` returned (an async EM delegate, or a human answering a
   * pending request through `agile approve`). Idempotent by construction:
   * it starts a sprint only while none is running, only when the *current*
   * proposal is still exactly what an approved request named, and starting
   * one stamps those tickets (so the next call's proposal no longer
   * matches). Returns the sprint it started, if any.
   */
  /** T121: `approve_plan` is a deleted gate kind, so nothing is ever waiting on one. T122 deletes this module. */
  pendingApprovePlan(): { id: string; owner: string; summary?: string } | undefined {
    return undefined;
  }

  async startApprovedSprint(): Promise<Sprint | undefined> {
    if (!this.deps.gates) return undefined;
    const board = this.sprints();
    if (board.running !== undefined) return undefined;
    // T121: there is no `approve_plan` gate to pick up any more — a sprint
    // is started by `startSprint` alone. T122 deletes this module.
    return undefined;
  }

  /** Persists the approved proposal. The only caller of `planSprint` in this module. */
  private async planProposal(proposal: SprintProposal, cap?: number): Promise<Sprint> {
    return planSprint(this.deps.store, {
      goal: proposal.goal,
      ...(cap !== undefined ? { cap } : {}),
      now: () => this.now(),
    });
  }

  /** The sprint goal, taken from the brief's "Current goal" section when it has one (T046 defect 2 did the same for the run story) — never a hard-coded string. */
  private sprintGoal(): string {
    const { body, stub } = this.brief();
    if (!stub) {
      const lines = body.split('\n');
      const heading = lines.findIndex((line) => /^#{1,6}\s*current goal\s*$/i.test(line.trim()));
      if (heading >= 0) {
        const text = lines
          .slice(heading + 1)
          .find((line) => line.trim().length > 0 && !line.trim().startsWith('#'));
        if (text) return text.trim().slice(0, 200);
      }
    }
    const frontier = this.sprints().next?.tickets ?? [];
    return frontier.length > 0
      ? `Deliver ${frontier.join(', ')}`
      : 'Next layer of the dependency graph';
  }

  // ----------------------------------------------------- Whole screen

  /** Everything the Plan screen renders, in one round trip — the panes are small and always shown together. */
  overview(): {
    brief: BriefView;
    rules: OracleDoc[];
    decisions: OracleDoc[];
    tickets: Array<Ticket & { stub: boolean }>;
    sprints: SprintBoard;
    knowledge: Array<{ fact: KbFact; body: string }>;
    policy: Policy | undefined;
    questions: ReturnType<QuestionService['list']> | [];
  } {
    let policy: Policy | undefined;
    try {
      policy = this.policy();
    } catch {
      policy = undefined;
    }
    return {
      brief: this.brief(),
      rules: this.listRules(),
      decisions: this.listDecisions(),
      tickets: this.listTickets(),
      sprints: this.sprints(),
      knowledge: this.listKnowledge(),
      policy,
      questions: this.deps.questions?.list() ?? [],
    };
  }
}
