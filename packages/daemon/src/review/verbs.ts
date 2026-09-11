/**
 * Review MCP verbs (T016 Design note): `review_submit`, `review_get`,
 * `rules_list` (reviewer role), `review_dispute` (engineer role).
 *
 * Same wiring gap as `builtins.ts` — these are handlers of the exact shape
 * `tools/builtins.ts`'s built-ins use (`(deps, ctx, input) =>
 * Promise<unknown>`), ready to fold into `ToolService`'s dispatch once
 * `tools/service.ts` accepts an extra builtins list (see `builtins.ts`'s
 * header for the precise change).
 */

import {
  type AgentId,
  FindingSchema,
  type QaReport,
  type TicketId,
  qaReportRelPath,
  validateQaReport,
} from '@agile-agents/shared';
import { roleOf } from '../bus/routing';
import { NotFoundError } from '../store/store';
import type { StateStore } from '../store/store';
import type { ToolCallContext } from '../tools/types';
import { type ReviewProtocol, type SubmitVerdictInput, requiresSecurityPass } from './protocol';
import { type RuleDefinition, loadRules } from './rules';
import { type ReviewRecord, reviewRecordRelPath, validateReviewRecord } from './types';

export class ReviewVerbError extends Error {}

function requireObject(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ReviewVerbError('input must be an object');
  }
  return input as Record<string, unknown>;
}

function requireReviewerRole(ctx: ToolCallContext, verb: string): void {
  if (roleOf(ctx.agent) !== 'reviewer') {
    throw new ReviewVerbError(`${verb}: reviewer role only`);
  }
}

function requireEngineerRole(ctx: ToolCallContext, verb: string): void {
  if (roleOf(ctx.agent) !== 'engineer') {
    throw new ReviewVerbError(`${verb}: engineer role only`);
  }
}

function requireTicketContext(ctx: ToolCallContext, verb: string): TicketId {
  if (!ctx.ticket) throw new ReviewVerbError(`${verb}: this session has no ticket context`);
  return ctx.ticket as TicketId;
}

export interface ReviewVerbDeps {
  protocol: ReviewProtocol;
  store: StateStore;
  /** `.agile/` state root, for the rules loader. */
  stateRoot: string;
}

/**
 * `review_submit` — reviewer role only. Any `hunks` a caller includes in
 * `input` is ignored: `ReviewProtocol.submitVerdict` computes this round's
 * diff hunks itself, from the ticket's real worktree, precisely so a
 * reviewer session cannot lie about what a round's diff looked like (opus
 * review, blocker 1) — see `protocol.ts`'s `computeHunks`.
 */
export async function reviewSubmit(
  deps: ReviewVerbDeps,
  ctx: ToolCallContext,
  input: unknown,
): Promise<unknown> {
  requireReviewerRole(ctx, 'review_submit');
  const ticket = requireTicketContext(ctx, 'review_submit');
  const p = requireObject(input);
  if (p.ticket !== undefined && p.ticket !== ticket) {
    throw new ReviewVerbError(
      `review_submit: agent ${ctx.agent} may only submit for its own ticket (${ticket})`,
    );
  }
  const payload: SubmitVerdictInput = {
    ticket,
    round: Number(p.round),
    pass: p.pass as SubmitVerdictInput['pass'],
    findings: Array.isArray(p.findings) ? p.findings.map((f) => FindingSchema.parse(f)) : [],
    verdict: p.verdict as SubmitVerdictInput['verdict'],
  };
  return deps.protocol.submitVerdict(ctx.agent as AgentId, payload);
}

/** `review_get` — read one round's stored verdict. No role restriction: engineer, reviewer, and em all have a legitimate reason to read it. */
export async function reviewGet(
  deps: ReviewVerbDeps,
  ctx: ToolCallContext,
  input: unknown,
): Promise<ReviewRecord> {
  const ticket = requireTicketContext(ctx, 'review_get');
  const p = requireObject(input);
  const round = Number(p.round);
  if (!Number.isInteger(round) || round < 1) {
    throw new ReviewVerbError('review_get: "round" must be a positive integer');
  }
  const pass = p.pass === 'security' ? 'security' : 'primary';
  try {
    return deps.store.getEntity(reviewRecordRelPath(ticket, round, pass), validateReviewRecord);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new ReviewVerbError(
        `review_get: no ${pass} review record for ${ticket} round ${round}`,
      );
    }
    throw err;
  }
}

/**
 * `qa_get` — read one round's stored QA report for the caller's ticket. No
 * role restriction, like `review_get`. Twenty-seventh live run
 * (2026-09-11): the QA verdict message to the engineer was cut at the
 * 800-char body cap after three passing lines ("see board/qa/<ticket>-r1.yaml"),
 * that record lives outside the worktree where `read_summary` refuses it,
 * engineers cannot message QA, and there was no verb for it — the engineer
 * posted `blocked`, escalated to em, and the run idled to its abort.
 */
export async function qaGet(
  deps: ReviewVerbDeps,
  ctx: ToolCallContext,
  input: unknown,
): Promise<QaReport> {
  const ticket = requireTicketContext(ctx, 'qa_get');
  const p = requireObject(input);
  const round = Number(p.round);
  if (!Number.isInteger(round) || round < 1) {
    throw new ReviewVerbError('qa_get: "round" must be a positive integer');
  }
  try {
    return deps.store.getEntity(qaReportRelPath(ticket, round), validateQaReport);
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw new ReviewVerbError(`qa_get: no QA report for ${ticket} round ${round}`);
    }
    throw err;
  }
}

/** `rules_list` — reviewer role: the citation source a finding must name. */
export async function rulesList(
  deps: ReviewVerbDeps,
  ctx: ToolCallContext,
  _input: unknown,
): Promise<RuleDefinition[]> {
  requireReviewerRole(ctx, 'rules_list');
  return loadRules(deps.stateRoot);
}

/** `review_dispute` — engineer role: disputes one finding by round-trip identity (path/line + citation), not by free text. */
export async function reviewDispute(
  deps: ReviewVerbDeps,
  ctx: ToolCallContext,
  input: unknown,
): Promise<unknown> {
  requireEngineerRole(ctx, 'review_dispute');
  const ticket = requireTicketContext(ctx, 'review_dispute');
  const p = requireObject(input);
  const finding = FindingSchema.parse(p.finding);
  return deps.protocol.dispute(ctx.agent as AgentId, { ticket, finding });
}

/** Re-exported so a caller building the `requiresSecurityPass` UI/CLI note doesn't need a second import from `protocol.ts`. */
export { requiresSecurityPass };
