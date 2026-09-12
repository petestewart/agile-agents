/**
 * Plan screen back end (T042 — design/agile-agents-design.md §17 "Control
 * room v2" → "Plan screen = the documents + the EM chat", and the mockup's
 * Plan tab). One service behind the `/api/plan/*` routes, so every pane is
 * backed by daemon data and every edit goes through the validating store
 * (and therefore `log/events.jsonl` + the `agile-state` commit) rather than
 * through the browser writing files.
 *
 * Panes → data:
 *
 *   Brief        `oracle/product.md`        `store.getDoc`/`putDoc`
 *   Rules        `oracle/specs/SPEC-*.md`   oracle index + write guard
 *   Questions    `board/questions/Q-*.yaml` `QuestionService` (T040)
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
  constructor(reason: string) {
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

export interface StartSprintResult {
  sprint: Sprint;
  /** The `approve_plan` gate this raised — always raised, even when the click itself resolves it, so the start is in the log (§16). */
  gate: { id: string; owner: string; status: string; decision?: string };
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
   * The one top-bar action (§17 v2: "No plan approval. Documents are edited,
   * sprints are started. The `approve_plan` gate is raised at sprint start
   * and means 'start this frontier with these tickets and rules as they
   * stand'").
   *
   * Order matters: the frontier is planned first (so the gate records what
   * was actually started), then `approve_plan` is raised through the
   * `GateService` so the start is in `board/hil/` and `events.jsonl` like
   * every other gate. When policy resolves the gate to `human`, **the click
   * is the approval** — the request is resolved immediately, by `by`, with a
   * note saying so; there is no second approval step (ticket AC). An
   * `em`/`architect`-owned gate is left to its delegate exactly as it would
   * be anywhere else.
   */
  async startSprint(
    options: { by?: string; cap?: number; goal?: string } = {},
  ): Promise<StartSprintResult> {
    const by = options.by ?? 'human';
    const board = this.sprints();
    if (board.running !== undefined) {
      throw new PlanRefused(`${board.running} is still running — finish or halt it first`);
    }
    if (!board.next) {
      throw new PlanRefused(
        'nothing is ready to start: no ticket has all of its dependencies done',
      );
    }
    const goal = options.goal ?? this.sprintGoal();
    const sprint = await planSprint(this.deps.store, {
      goal,
      ...(options.cap !== undefined ? { cap: options.cap } : {}),
      now: () => this.now(),
    });

    if (!this.deps.gates) {
      throw new PlanRefused('gate service not wired — cannot raise approve_plan');
    }
    const request = await this.deps.gates.request('approve_plan', {
      policy: this.policy(),
      ...(sprint.gates ? { sprint: sprint.gates } : {}),
      hilKind: 'approve_decision',
      summary: `Start ${sprint.id}: ${sprint.tickets.join(', ') || 'no tickets'} — ${goal}`,
    });
    let gate = request;
    if (gate.status === 'pending' && gate.owner === 'human') {
      gate = await this.deps.gates.respond(
        gate.id,
        'approve',
        by,
        'Start Sprint clicked in the control room — the click is the approval (§17 v2).',
      );
    }
    return {
      sprint,
      gate: {
        id: gate.id,
        owner: gate.owner,
        status: gate.status,
        ...(gate.decision !== undefined ? { decision: gate.decision } : {}),
      },
    };
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
