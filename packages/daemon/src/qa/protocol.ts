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
  MESSAGE_BODY_MAX_CHARS,
  type QaReport,
  type Ticket,
  type TicketId,
  qaReportRelPath,
  ulid,
  validateQaReport,
} from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import { decidePermission } from '../permissions';
import type { AcpPermissionOption, AcpPermissionRequestParams } from '../permissions';
import type { StateStore } from '../store/store';
import { isAllowedTestCommand } from '../tools/test-run';
import { type QaCriterion, parseCriteria } from './criteria';
import { resolveQaEnv } from './env';
import { buildQaReport, qaAllSkipped, renderQaVerdictBody } from './report';
import {
  type FlakyFinding,
  type QaCriterionResult,
  type RunTestRunFn,
  runCriterionWithRerun,
} from './rerun';

/** CLAUDE.md tunable: "max_attempts: 2" — used only when a ticket has no `routing` block at all (a ticket the architect never pointed, or a test fixture). */
export const DEFAULT_MAX_ATTEMPTS = 2;

/** Thrown by `QaProtocol.submit` when `bus.send`'s `qa_verdict` delivery is rejected (unknown/malformed recipient, a §5 routing violation, an over-cap body) — the ticket is NOT transitioned in this case (see `submit`'s doc comment). */
export class QaVerdictDeliveryError extends Error {}

/** Synthetic two-option menu, matching `hook/decide.ts`'s own `SYNTHETIC_OPTIONS` — `decidePermission` always needs an `allow_once`/`reject_once` pair to pick between, even for this preflight-only call (no real ACP request is ever answered with the chosen option). */
const SYNTHETIC_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'allow', kind: 'allow_once' },
  { optionId: 'deny', kind: 'reject_once' },
];

/**
 * Review round fix: `qa_plan` used to accept anything and only find out at
 * `qa_run` time (via `test_run`'s own `TestRunDeniedError`) that a planned
 * command was never going to execute — or, worse, would have executed
 * something the qa role table denies outright had it not gone through
 * `test_run`'s narrow allow-list at all. Validates BOTH: (1) `test_run`'s
 * own allow-list (`isAllowedTestCommand` — the actual execution boundary
 * `qa_run` uses), and (2) the general permissions classifier
 * (`decidePermission`, the same pipeline `hook/decide.ts`'s `roleToolVerdict`
 * runs a Claude `Bash` call through) for the qa role on this ticket/worktree
 * — so a command that would be denied for being a write, a never-without-
 * human command, etc. is rejected at plan time with the reason, not
 * silently attempted. Returns the problem string, or `undefined` if the
 * command is fine.
 */
function validatePlannedCommand(
  command: string,
  ticket: TicketId,
  worktreePath: string,
): string | undefined {
  if (!isAllowedTestCommand(command)) {
    return `"${command}" is not an allowed test_run command (only bun/npm/pnpm run|test|build, vitest, jest, pytest, or go test)`;
  }
  const request: AcpPermissionRequestParams = {
    toolCall: { kind: 'execute', title: 'Bash', rawInput: { command } },
    options: SYNTHETIC_OPTIONS,
  };
  const decision = decidePermission({ role: 'qa', ticket, worktreePath, request });
  if (decision.kind !== 'allow') {
    return `"${command}" would be denied by the qa permission policy: ${decision.reason}`;
  }
  return undefined;
}

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
    // Review round nit: `contract.acceptance` empty means nothing for QA to
    // run at all — refuse here with a QA-shaped error rather than letting
    // `submit()` die inside zod's `lines.min(1)` with an opaque message
    // once `run()` produces zero results.
    if (criteria.length === 0) {
      throw new Error(
        `qa protocol: ${ticket.id} has an empty contract.acceptance — nothing for QA to run`,
      );
    }
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

    // Review round fix: validate the WHOLE plan up front, before applying
    // any of it — `test_run`'s own allow-list plus the general permissions
    // classifier (`validatePlannedCommand`, above) — and reject naming
    // every offending criterion, rather than accepting each entry as it's
    // walked and only discovering a bad command at `qa_run` time.
    const errors: string[] = [];
    for (const [key, command] of Object.entries(mapping)) {
      const index = Number(key);
      const criterion = state.criteria.find((c) => c.index === index);
      if (!criterion) {
        throw new Error(`qa_plan: ${ticket} has no criterion at index ${index}`);
      }
      const problem = validatePlannedCommand(command, ticket, state.worktreePath);
      if (problem !== undefined) {
        errors.push(`criterion ${index} ("${criterion.text}"): ${problem}`);
      }
    }
    if (errors.length > 0) {
      throw new Error(`qa_plan rejected — ${errors.join('; ')}`);
    }

    for (const [key, command] of Object.entries(mapping)) {
      state.plan.set(Number(key), command);
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
    const body = `Criterion "${finding.criterion.text}" (command: \`${finding.command}\`) failed on the first run and passed on rerun during QA — flaky, not a real regression (§13 "Flakiness").\n\nFirst run: ${finding.first.summary}\nRerun: ${finding.second.summary}`;
    await this.deps.store.putKbFact(fact, body);
  }

  /**
   * `qa_submit` verb — assembles the `QaReport` from `run()`'s results,
   * writes it to `board/qa/<ticket>-r<round>.yaml` (generic entity trio),
   * sends the `qa_verdict` message to the engineer (+ em copy — §5 routing
   * "reviewer/qa → engineer (verdict), → em (copy)"), transitions the
   * ticket, and on reject bumps `routing.attempts` (escalating to em at
   * `max_attempts`). Clears this ticket's round state — a fresh `start()`
   * is required for the next round — in every case EXCEPT a failed
   * `qa_verdict` delivery, where the round is left intact for a retry.
   *
   * Round-2 review fix (opus blocker B1): when `buildQaReport` computed
   * `qaAllSkipped(report)` (every criterion `skipped` — nothing was ever
   * executed), this method refuses to transition the ticket at all,
   * `done` included — §13's contract is "accept a correct implementation,
   * reject one that fails a criterion", and an implementation nothing was
   * run against is neither. The ticket is left `in_qa` (not bounced back
   * to `in_progress` either — round-1's fix that a denied/unplanned
   * command degrades to `skipped` instead of aborting the round means this
   * can be the CONTRACT's fault, not the engineer's code, so bumping
   * `routing.attempts` and asking the engineer to "fix" something would be
   * wrong) and an urgent escalate reaches `em` (qa can't message the
   * architect directly — §5 routing) so a human/architect re-scopes the
   * contract or unblocks the round by hand.
   */
  async submit(ticket: TicketId, agent: AgentId): Promise<QaReport> {
    const state = this.requireState(ticket);
    if (!state.results) {
      throw new Error(`qa_submit: ${ticket} has no qa_run results yet — call run() first`);
    }

    const ticketObj = this.deps.store.getTicket(ticket);
    const report = buildQaReport(ticketObj, state.round, state.results);
    const relPath = qaReportRelPath(ticket, report.round);
    await this.deps.store.putEntity(relPath, validateQaReport, report);

    const recipients: string[] = ticketObj.assignee ? [ticketObj.assignee, 'em'] : ['em'];
    const verdictSend = await this.deps.bus.send({
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

    // Review round fix: `Bus.send` REJECTS rather than throwing (unknown/
    // malformed recipient, a routing-table violation, a body over the char
    // cap) — the return value must be checked. A verdict the engineer never
    // received must not silently transition the ticket as if it had: that
    // would move `TKT-...` to `done`/back to `in_progress` with nobody
    // actually told, losing the round. Best-effort escalate the delivery
    // failure itself to `em` (its own send is not re-checked — if that one
    // also fails there is nothing further to do but throw) and refuse to
    // transition at all; the round's in-memory state is intentionally left
    // in place (not cleared) so a retry of `qa_submit` can attempt delivery
    // again rather than losing `run()`'s results.
    if (!verdictSend.ok) {
      await this.deps.bus.send({
        id: ulid(),
        ts: this.now().toISOString(),
        from: agent,
        to: ['em'],
        kind: 'escalate',
        priority: 'urgent',
        ticket,
        body: `qa_verdict for ${ticket} (round ${report.round}) failed to deliver: ${verdictSend.reason}`.slice(
          0,
          MESSAGE_BODY_MAX_CHARS,
        ),
        refs: [relPath],
      });
      throw new QaVerdictDeliveryError(
        `qa_submit: qa_verdict delivery failed for ${ticket} — ${verdictSend.reason}`,
      );
    }

    // Review round 2 fix (nit): the skipped-criteria escalate now fires
    // only AFTER the qa_verdict has been confirmed delivered, and only
    // ONCE — previously it ran unconditionally before the send, so a
    // `QaVerdictDeliveryError` retry (which reaches this point again on a
    // second `submit()` call) re-sent it, duplicating the escalate in em's
    // inbox. `nothingExecuted` gets its own, stronger escalate below
    // instead of this informational one, so the two are never both sent.
    const skipped = state.results.filter((r) => r.status === 'skipped');
    const nothingExecuted = qaAllSkipped(report);
    if (skipped.length > 0 && !nothingExecuted) {
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
          MESSAGE_BODY_MAX_CHARS,
        ),
        refs: [relPath],
      });
    }

    if (nothingExecuted) {
      await this.deps.bus.send({
        id: ulid(),
        ts: this.now().toISOString(),
        from: agent,
        to: ['em'],
        kind: 'escalate',
        priority: 'urgent',
        ticket,
        body: `QA could not execute ANY criterion on ${ticket} (round ${report.round}) — refusing to accept an unverified implementation. Every criterion was unplannable or denied at run time; needs architect re-scoping of the contract (or a different exercise path) before QA can run again. Ticket left in_qa.`.slice(
          0,
          MESSAGE_BODY_MAX_CHARS,
        ),
        refs: [relPath],
      });
      this.rounds.delete(ticket);
      return report;
    }

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
            MESSAGE_BODY_MAX_CHARS,
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
