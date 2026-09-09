/**
 * `QaProtocol` — the daemon-side state machine behind the QA role's MCP
 * verbs (T017 — design/agile-agents-design.md §13 "QA environment and
 * protocol", §4 "Ticket" `contract.acceptance`/`routing.attempts`, §5
 * routing "reviewer / qa → engineer (verdict), → em (copy)").
 *
 * Everything here is daemon-side and fixture-tested (this ticket's Session
 * overrides: "no vendor login here ... the model turn only supplies command
 * choices per criterion via verbs"): the QA agent's own model turn only
 * ever calls three verbs (`qa_plan`, `qa_run`, `qa_submit`, exposed as MCP
 * tools by `tools.ts` in this same directory) — every rule (rerun policy,
 * flaky→KB, report shape, verdict routing, attempts) lives in this class,
 * not in a prompt.
 *
 * One `QaProtocol` instance is shared across every ticket the daemon runs
 * QA on (same lifetime as `Runner`/`Bus`/`StateStore`) — `rounds` keys its
 * in-memory per-ticket working state (parsed criteria + the `qa_plan`
 * mapping) by `TicketId`; only `start()` -> `run()` -> `submit()` in that
 * order is a legal sequence per ticket, matching the ordering `Runner`
 * itself already enforces one-agent-per-(role,ticket) (`runner.ts`'s
 * `agentIdFor`).
 */

import {
  type AgentId,
  type KbFact,
  type KbId,
  type Ticket,
  type TicketId,
  ulid,
  validateQaReport,
  type QaReport,
} from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import type { StateStore } from '../store/store';
import { type QaCriterion, parseCriteria } from './criteria';
import { resolveQaEnv } from './env';
import { buildQaReport, renderQaVerdictBody } from './report';
import { type FlakyFinding, type QaCriterionResult, type RunTestRunFn, runCriterionWithRerun } from './rerun';

/** CLAUDE.md tunable: "max_attempts: 2" — used only when a ticket has no `routing` block at all (a ticket the architect never pointed, or a test fixture). */
export const DEFAULT_MAX_ATTEMPTS = 2;

export interface QaProtocolDeps {
  store: StateStore;
  bus: Bus;
  /** Repo root — passed through to `runTestRun` for its host-local raw-output cache path. */
  repoRoot: string;
  now?: () => Date;
  /** Test seam — defaults to the real `runTestRun` (`../tools/test-run.ts`). */
  runTestRun?: RunTestRunFn;
}

interface QaRoundState {
  ticket: TicketId;
  round: number;
  worktreePath: string;
  criteria: QaCriterion[];
  plan: Map<number, string>;
  results?: QaCriterionResult[];
}

export interface QaStatus {
  round: number;
  criteriaCount: number;
  plannedCount: number;
  ranCount: number;
}

export class QaProtocol {
  private readonly rounds = new Map<TicketId, QaRoundState>();
  private readonly now: () => Date;

  constructor(private readonly deps: QaProtocolDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private requireState(ticket: TicketId): QaRoundState {
    const state = this.rounds.get(ticket);
    if (!state) {
      throw new Error(`qa protocol: no active QA round for ${ticket} — call start() first`);
    }
    return state;
  }

  /** How many QA rounds `ticket` has already had a report for — the next `start()` gets `count + 1` (a `reject` starts a fresh round on the engineer's resubmission). */
  private nextRound(ticket: TicketId): number {
    const existing = this.deps.store
      .listEntities<QaReport>('board/qa', validateQaReport)
      .filter((r) => r.ticket === ticket);
    return existing.length + 1;
  }

  /**
   * Starts a QA round on `ticket` — `Runner.spawn('qa', ticket)` has
   * already created the fresh clone at `worktreePath` (§13 "env: clone");
   * this validates the ticket's `contract.env` (throws for `compose:`, see
   * `env.ts`) and parses `contract.acceptance` into criteria.
   */
  start(ticket: Ticket, worktreePath: string): QaStatus {
    resolveQaEnv(ticket, worktreePath);
    const criteria = parseCriteria(ticket);
    const state: QaRoundState = {
      ticket: ticket.id,
      round: this.nextRound(ticket.id),
      worktreePath,
      criteria,
      plan: new Map(),
    };
    this.rounds.set(ticket.id, state);
    return this.status(ticket.id) as QaStatus;
  }

  /** `qa_plan` verb — the QA model turn's per-criterion command mapping (criterion index -> command), §13 "Executable criteria preferred". A criterion with no entry here is `skipped`, not denied — see `rerun.ts`. */
  plan(ticket: TicketId, mapping: Record<number, string>): void {
    const state = this.requireState(ticket);
    for (const [key, command] of Object.entries(mapping)) {
      const index = Number(key);
      if (!state.criteria.some((c) => c.index === index)) {
        throw new Error(`qa_plan: ${ticket} has no criterion at index ${index}`);
      }
      state.plan.set(index, command);
    }
  }

  /** `qa_run` verb — executes every criterion (one rerun on failure; a flaky pass-on-rerun files a KB fact and does not by itself reject). */
  async run(ticket: TicketId): Promise<QaCriterionResult[]> {
    const state = this.requireState(ticket);
    const results: QaCriterionResult[] = [];
    for (const criterion of state.criteria) {
      const { result, flaky } = await runCriterionWithRerun({
        criterion,
        command: state.plan.get(criterion.index),
        worktree: state.worktreePath,
        repoRoot: this.deps.repoRoot,
        runTestRun: this.deps.runTestRun,
      });
      results.push(result);
      if (flaky) await this.fileFlakyKbFact(ticket, flaky);
    }
    state.results = results;
    return results;
  }

  private nextKbId(): KbId {
    const index = this.deps.store.listKbIndex();
    const max = Object.keys(index).reduce((acc, id) => {
      const n = Number(/^KB-(\d+)$/.exec(id)?.[1] ?? '0');
      return Number.isFinite(n) ? Math.max(acc, n) : acc;
    }, 0);
    return `KB-${String(max + 1).padStart(4, '0')}` as KbId;
  }

  private async fileFlakyKbFact(ticket: TicketId, finding: FlakyFinding): Promise<void> {
    const fact: KbFact = {
      id: this.nextKbId(),
      kind: 'gotcha',
      scope: [ticket],
      confidence: 'observed',
      source: ticket,
      expires: null,
    };
    const body =
      `Criterion "${finding.criterion.text}" (command: \`${finding.command}\`) failed on the first ` +
      `run and passed on rerun during QA — flaky, not a real regression (§13 "Flakiness").\n\n` +
      `First run: ${finding.first.summary}\nRerun: ${finding.second.summary}`;
    await this.deps.store.putKbFact(fact, body);
  }

  /**
   * `qa_submit` verb — assembles the `QaReport` from `run()`'s results,
   * writes it to `board/qa/<ticket>-r<round>.yaml` (generic entity trio),
   * sends the `qa_verdict` message to the engineer (+ em copy — §5 routing
   * "reviewer/qa → engineer (verdict), → em (copy)"), transitions the
   * ticket, and on reject bumps `routing.attempts` (escalating to em at
   * `max_attempts`). Clears this ticket's round state either way — a fresh
   * `start()` is required for the next round.
   */
  async submit(ticket: TicketId, agent: AgentId): Promise<QaReport> {
    const state = this.requireState(ticket);
    if (!state.results) {
      throw new Error(`qa_submit: ${ticket} has no qa_run results yet — call run() first`);
    }

    const ticketObj = this.deps.store.getTicket(ticket);
    const report = buildQaReport(ticketObj, state.round, state.results);
    const relPath = `board/qa/${ticket}-r${report.round}.yaml`;
    await this.deps.store.putEntity(relPath, validateQaReport, report);

    const skipped = state.results.filter((r) => r.status === 'skipped');
    if (skipped.length > 0) {
      await this.deps.bus.send({
        id: ulid(),
        ts: this.now().toISOString(),
        from: agent,
        to: ['em'],
        kind: 'escalate',
        priority: 'normal',
        ticket,
        body: `${skipped.length} criterion(s) on ${ticket} can't be exercised from outside — a finding against the criterion, not the code (§13). Architect should re-scope the contract.`.slice(
          0,
          800,
        ),
        refs: [relPath],
      });
    }

    const recipients: string[] = ticketObj.assignee ? [ticketObj.assignee, 'em'] : ['em'];
    await this.deps.bus.send({
      id: ulid(),
      ts: this.now().toISOString(),
      from: agent,
      to: recipients,
      kind: 'qa_verdict',
      priority: 'normal',
      ticket,
      body: renderQaVerdictBody(report, relPath),
      refs: [relPath],
    });

    if (report.verdict === 'accept') {
      await this.deps.store.transitionTicket(ticket, 'done', { by: agent });
    } else {
      const afterTransition = await this.deps.store.transitionTicket(ticket, 'in_progress', {
        by: agent,
        reason: `QA reject — ${relPath}`,
      });
      const maxAttempts = afterTransition.routing?.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
      const attempts = (afterTransition.routing?.attempts ?? 0) + 1;
      const routing = afterTransition.routing
        ? { ...afterTransition.routing, attempts }
        : { attempts, max_attempts: maxAttempts, escalation: [] };
      await this.deps.store.putTicket({ ...afterTransition, routing }, { by: agent });

      if (attempts >= maxAttempts) {
        await this.deps.bus.send({
          id: ulid(),
          ts: this.now().toISOString(),
          from: agent,
          to: ['em'],
          kind: 'escalate',
          priority: 'normal',
          ticket,
          body: `${ticket} rejected by QA ${attempts} time(s) (max_attempts=${maxAttempts}) — escalating (§4 routing.attempts).`.slice(
            0,
            800,
          ),
          refs: [relPath],
        });
      }
    }

    this.rounds.delete(ticket);
    return report;
  }

  /** `qa.status` RPC — the in-flight round's shape, or `undefined` if none is active for `ticket`. */
  status(ticket: TicketId): QaStatus | undefined {
    const state = this.rounds.get(ticket);
    if (!state) return undefined;
    return {
      round: state.round,
      criteriaCount: state.criteria.length,
      plannedCount: state.plan.size,
      ranCount: state.results?.length ?? 0,
    };
  }
}
