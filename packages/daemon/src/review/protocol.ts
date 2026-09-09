/**
 * `ReviewProtocol` — orchestrates the reviewer over store+bus+runner (T016,
 * design §12 "Review protocol").
 *
 * `start(ticket)` spawns the reviewer; `submitVerdict(agent, input)`
 * validates findings, applies the re-review convergence rule, persists the
 * round's `ReviewRecord`, notifies engineer+em, and drives the ticket
 * transition/attempts/escalation side effects the verdict implies.
 * `dispute(agent, input)` is the engineer's side of "Convergence": a second
 * disagreement on one finding routes a `question` to the architect, via em
 * (routing.ts: reviewer/engineer can't address architect directly — only
 * `em -> anyone` can).
 */

import {
  type AgentId,
  type Finding,
  MessageSchema,
  type ReviewPass,
  type ReviewVerdictKind,
  type Ticket,
  type TicketId,
  ulid,
  validateVerdict,
} from '@agile-agents/shared';
import type { Bus } from '../bus/bus';
import { agentIdFor } from '../runner/runner';
import { INTEGRATION_BRANCH, ticketBranchName } from '../runner/worktrees';
import { NotFoundError } from '../store/store';
import type { StateStore } from '../store/store';
import { type DiffHunk, runDiffSummary } from './diff-summary';
import { findingKey } from './findings';
import { type ReReviewResult, validateReReview } from './rereview';
import {
  type DisputeRecord,
  type ReviewRecord,
  disputeRecordRelPath,
  reviewRecordRelPath,
  validateDisputeRecord,
  validateReviewRecord,
} from './types';

export class ReReviewViolationError extends Error {
  constructor(public readonly result: ReReviewResult) {
    super(`re-review rejected: ${result.rejected.map((r) => r.reason).join('; ')}`);
    this.name = 'ReReviewViolationError';
  }
}

/**
 * The one `Runner` capability `ReviewProtocol` needs — narrowed to a
 * structural interface (rather than importing the `Runner` class type
 * directly) so a unit test can pass a fake spawner without standing up a
 * real ACP session; the real `Runner` (`runner/runner.ts`) satisfies this
 * interface as-is.
 */
export interface ReviewRunner {
  spawn(role: 'reviewer', ticket: TicketId): Promise<{ agentId: AgentId; worktree: string }>;
}

export interface ReviewProtocolOptions {
  store: StateStore;
  bus: Bus;
  runner: ReviewRunner;
  now?: () => Date;
}

export interface StartReviewResult {
  agentId: AgentId;
  round: number;
  worktree: string;
}

export interface SubmitVerdictInput {
  ticket: TicketId;
  round: number;
  pass?: ReviewPass;
  findings: Finding[];
  verdict: ReviewVerdictKind;
  /** This round's `diff_summary` hunks (§7) — persisted for future rounds' re-review check. */
  hunks: DiffHunk[];
}

export type SubmitVerdictOutcome =
  | { status: 'in_qa' }
  | { status: 'in_progress'; attempts: number; escalated: boolean }
  | { status: 'escalated_by_reviewer' }
  | { status: 'security_pass_required' };

export interface DisputeInput {
  ticket: TicketId;
  finding: Finding;
}

export interface DisputeOutcome {
  count: number;
  routedToArchitect: boolean;
}

/** "the architect tags `security: true` or tier is hard/novel" (§12). */
export function requiresSecurityPass(ticket: Ticket): boolean {
  return (
    ticket.security === true ||
    ticket.estimate?.tier === 'hard' ||
    ticket.estimate?.tier === 'novel'
  );
}

export class ReviewProtocol {
  private readonly store: StateStore;
  private readonly bus: Bus;
  private readonly runner: ReviewRunner;
  private readonly now: () => Date;

  constructor(opts: ReviewProtocolOptions) {
    this.store = opts.store;
    this.bus = opts.bus;
    this.runner = opts.runner;
    this.now = opts.now ?? (() => new Date());
  }

  private async getReviewRecord(
    ticket: TicketId,
    round: number,
    pass: ReviewPass,
  ): Promise<ReviewRecord | undefined> {
    try {
      return this.store.getEntity(reviewRecordRelPath(ticket, round, pass), validateReviewRecord);
    } catch (err) {
      if (err instanceof NotFoundError) return undefined;
      throw err;
    }
  }

  /** Every prior *primary* round's record, oldest (round 1) first — security-pass rounds don't take a round slot of their own and don't participate in re-review convergence (they're a different reviewer, reviewing for a different mandate). */
  private async priorPrimaryRounds(ticket: TicketId, beforeRound: number): Promise<ReviewRecord[]> {
    const records: ReviewRecord[] = [];
    for (let round = 1; round < beforeRound; round++) {
      const record = await this.getReviewRecord(ticket, round, 'primary');
      if (record) records.push(record);
    }
    return records;
  }

  private async nextPrimaryRound(ticket: TicketId): Promise<number> {
    let round = 1;
    while ((await this.getReviewRecord(ticket, round, 'primary')) !== undefined) {
      round++;
    }
    return round;
  }

  private async hasApprovedSecurityPass(ticket: TicketId, round: number): Promise<boolean> {
    const record = await this.getReviewRecord(ticket, round, 'security');
    return record?.verdict === 'approve';
  }

  /**
   * Places the reviewer on `ticket`, transitioning it into `in_review` if
   * it isn't already there (an engineer submit lands it `in_progress`; a
   * re-review after `request_changes` returns it there too — either way
   * `start` is the edge into `in_review`, §12/§4's `TICKET_TRANSITIONS`).
   */
  async start(ticketId: TicketId): Promise<StartReviewResult> {
    const ticket = this.store.getTicket(ticketId);
    if (ticket.status === 'in_progress') {
      await this.store.transitionTicket(ticketId, 'in_review', { by: 'daemon' });
    }
    const round = await this.nextPrimaryRound(ticketId);
    const spawned = await this.runner.spawn('reviewer', ticketId);
    return { agentId: spawned.agentId, round, worktree: spawned.worktree };
  }

  /**
   * Runs the `diff_summary` tool for `ticket`'s worktree against
   * `integration` (§7) — a convenience wrapper so a caller assembling a
   * `submitVerdict` payload doesn't have to know the branch-naming
   * convention (`runner/worktrees.ts`'s `ticketBranchName`/`INTEGRATION_BRANCH`).
   */
  diffSummary(ticket: Ticket, worktree: string, repoRoot: string) {
    return runDiffSummary({
      worktree,
      base: INTEGRATION_BRANCH,
      head: ticketBranchName(ticket),
      repoRoot,
    });
  }

  async submitVerdict(agent: AgentId, input: SubmitVerdictInput): Promise<SubmitVerdictOutcome> {
    const pass: ReviewPass = input.pass ?? 'primary';
    const validated = validateVerdict({
      ticket: input.ticket,
      round: input.round,
      pass,
      findings: input.findings,
      verdict: input.verdict,
    });

    if (pass === 'primary' && validated.round > 1) {
      const priorRounds = await this.priorPrimaryRounds(input.ticket, validated.round);
      const round1 = priorRounds[0];
      if (round1) {
        const reReview = validateReReview(
          priorRounds.map((r) => r.findings),
          validated.findings,
          round1.hunks,
          input.hunks,
        );
        if (reReview.rejected.length > 0) {
          throw new ReReviewViolationError(reReview);
        }
      }
    }

    const record: ReviewRecord = {
      ticket: input.ticket,
      round: validated.round,
      pass,
      agent,
      ts: this.now().toISOString(),
      findings: validated.findings,
      verdict: validated.verdict,
      hunks: input.hunks,
    };
    await this.store.putEntity(
      reviewRecordRelPath(input.ticket, validated.round, pass),
      validateReviewRecord,
      record,
    );

    const engineer = agentIdFor('engineer', input.ticket);
    await this.sendMessage({
      from: agent,
      to: [engineer, 'em'],
      kind: 'review_verdict',
      ticket: input.ticket,
      body: `round ${validated.round}${pass === 'security' ? ' (security)' : ''}: ${validated.verdict} (${validated.findings.length} finding(s))`,
      refs: [reviewRecordRelPath(input.ticket, validated.round, pass)],
    });

    if (validated.verdict === 'approve') {
      return this.applyApprove(input.ticket, validated.round, pass);
    }
    if (validated.verdict === 'request_changes') {
      return this.applyRequestChanges(agent, input.ticket);
    }
    // escalate: "the ticket/contract is wrong, not the code -> EM as a
    // discovery" (§12) — no ticket transition here; EM decides next steps.
    await this.sendMessage({
      from: agent,
      to: ['em'],
      kind: 'escalate',
      ticket: input.ticket,
      body: `reviewer escalates round ${validated.round}: ticket/contract issue, not the code`,
      refs: [reviewRecordRelPath(input.ticket, validated.round, pass)],
    });
    return { status: 'escalated_by_reviewer' };
  }

  private async applyApprove(
    ticketId: TicketId,
    round: number,
    pass: ReviewPass,
  ): Promise<SubmitVerdictOutcome> {
    const ticket = this.store.getTicket(ticketId);
    if (pass === 'primary' && requiresSecurityPass(ticket)) {
      const securityApproved = await this.hasApprovedSecurityPass(ticketId, round);
      if (!securityApproved) {
        // DESIGN-GAP (see this ticket's report): actually spawning the
        // second reviewer session with the security brief needs
        // `runner/brief.ts`'s `assembleBrief` (and `src/briefs/index.ts`) to
        // accept a `pass` and select `briefs/reviewer-security.md` — outside
        // this ticket's file ownership (`src/runner/**`, `src/briefs/**`).
        // Best-effort today: reuse the primary reviewer brief for the
        // security pass so the gate is still real (a second `submitVerdict`
        // call with `pass: 'security'` is still required before `in_qa`),
        // just not yet security-brief-specific.
        await this.runner.spawn('reviewer', ticketId);
        return { status: 'security_pass_required' };
      }
    }
    await this.store.transitionTicket(ticketId, 'in_qa', { by: 'daemon' });
    return { status: 'in_qa' };
  }

  private async applyRequestChanges(
    reviewer: AgentId,
    ticketId: TicketId,
  ): Promise<SubmitVerdictOutcome> {
    await this.store.transitionTicket(ticketId, 'in_progress', { by: reviewer });
    const ticket = this.store.getTicket(ticketId);
    const routing = ticket.routing;
    const attempts = (routing?.attempts ?? 0) + 1;
    const maxAttempts = routing?.max_attempts ?? Number.POSITIVE_INFINITY;
    await this.store.putTicket(
      { ...ticket, routing: routing ? { ...routing, attempts } : routing },
      { by: reviewer },
    );

    const escalated = attempts >= maxAttempts;
    if (escalated) {
      // "escalation gate ... resolve next tier from routing.escalation" —
      // v0's tier ladder is a one-model no-op (CLAUDE.md), so this logs the
      // would-be next tier rather than actually re-routing to it.
      const currentTier = ticket.estimate?.tier;
      const escalationLadder = routing?.escalation ?? [];
      const currentIdx = currentTier ? escalationLadder.indexOf(currentTier) : -1;
      const nextTier = currentIdx >= 0 ? escalationLadder[currentIdx + 1] : undefined;
      await this.sendMessage({
        from: reviewer,
        to: ['em'],
        kind: 'escalate',
        ticket: ticketId,
        body: `attempts (${attempts}) reached max_attempts (${routing?.max_attempts ?? '?'}) — would escalate ${currentTier ?? 'unknown'} -> ${nextTier ?? '(no next tier configured)'} (tier ladder is a v0 no-op)`,
      });
    }

    return { status: 'in_progress', attempts, escalated };
  }

  private async getDisputeRecord(ticket: TicketId): Promise<DisputeRecord> {
    try {
      return this.store.getEntity(disputeRecordRelPath(ticket), validateDisputeRecord);
    } catch (err) {
      if (err instanceof NotFoundError) return { ticket, disputes: {} };
      throw err;
    }
  }

  /**
   * Engineer disputes one finding. "Engineer and reviewer disagree twice on
   * one finding -> daemon routes it to the architect as a `question`" (§12)
   * — sent `from: 'em'` since routing.ts has no reviewer/engineer ->
   * architect edge, only `em -> anyone` ("via em", this ticket's Session
   * override).
   */
  async dispute(agent: AgentId, input: DisputeInput): Promise<DisputeOutcome> {
    const key = findingKey(input.finding);
    const record = await this.getDisputeRecord(input.ticket);
    const count = (record.disputes[key] ?? 0) + 1;
    const updated: DisputeRecord = {
      ticket: input.ticket,
      disputes: { ...record.disputes, [key]: count },
    };
    await this.store.putEntity(disputeRecordRelPath(input.ticket), validateDisputeRecord, updated);

    const routedToArchitect = count >= 2;
    if (routedToArchitect) {
      await this.sendMessage({
        from: 'em',
        to: ['architect'],
        kind: 'question',
        ticket: input.ticket,
        body: `${agent} and the reviewer disagree twice on one finding (${input.finding.location.path}${
          input.finding.location.line !== undefined ? `:${input.finding.location.line}` : ''
        }): ${input.finding.message}`,
        refs: [disputeRecordRelPath(input.ticket)],
      });
    }

    return { count, routedToArchitect };
  }

  private async sendMessage(input: {
    from: AgentId | 'em';
    to: Array<AgentId | 'em' | 'architect'>;
    kind: string;
    ticket: TicketId;
    body: string;
    refs?: string[];
  }): Promise<void> {
    const message = MessageSchema.parse({
      id: ulid(this.now().getTime()),
      ts: this.now().toISOString(),
      from: input.from,
      to: input.to,
      kind: input.kind,
      priority: 'normal',
      ticket: input.ticket,
      body: input.body,
      refs: input.refs ?? [],
    });
    const result = await this.bus.send(message);
    if (!result.ok) {
      throw new Error(`ReviewProtocol.sendMessage: ${result.reason}`);
    }
  }
}
