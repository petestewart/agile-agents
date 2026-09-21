/**
 * The sprint review narrative (T044 — §17 "Control room v2" Review tab, and
 * the mockup's `#s4`: "What was asked / What was built / What went wrong /
 * Where the code is", "Per ticket", "Decisions made without you", "What the
 * EM proposes next").
 *
 * ONE function builds it and ONE function renders it, and both the Review
 * tab (`GET /api/sprint/review`) and the run report file (`runs/<ts>.md`,
 * written by `packages/cli/src/commands/run.ts`) go through them — which is
 * what makes the ticket's acceptance criterion ("the Review tab's narrative
 * equals the `runs/*.md` body") true by construction rather than by two
 * implementations agreeing. Before this, `run.ts` rendered its own
 * line-per-event dump and the UI had no narrative at all.
 *
 * Everything is derived from daemon state that already exists — tickets and
 * their history, `board/reviews/`, `board/qa/`, `board/merges/`,
 * `board/hil/`, `board/halts/`, the sprint file and the ledger. No agent has
 * to write a report, and no new artifact is stored: the *file* under
 * `runs/` is the run harness's own output, exactly as it was before.
 *
 * The EM's own proposal for what comes next is read where the EM already
 * puts it (the pending `sprint_review` gate's summary, and the EM half of
 * the chat thread) rather than invented here — this module narrates state,
 * it does not have opinions.
 */

import {
  type HilRequest,
  type MergeRecord,
  type QaReport,
  type Sprint,
  type Ticket,
  type TicketId,
  qaReportRelPath,
  validateMergeRecord,
  validateQaReport,
} from '@agile-agents/shared';
import { pickCurrentSprint } from '../feed/snapshot';
import type { GateService } from '../gates';
import { mergeRecordPath } from '../merge/owner';
import { type ReviewRecord, reviewRecordRelPath, validateReviewRecord } from '../review/types';
import { NotFoundError, type StateStore } from '../store';

/** Review/QA rounds are 1-based and contiguous — the same walk `feed/stories.ts` does. */
const MAX_ROUNDS = 20;

/** One row of the mockup's "Decisions made without you" table. */
export interface ReportDecision {
  /** ISO-8601 — when it was decided. */
  at: string;
  gate: string;
  ticket?: string;
  decided_by: string;
  /** "Allowed once. \"…\"" — the decision plus whatever note came with it. */
  outcome: string;
}

export interface ReportTicketLine {
  ticket: TicketId;
  status: Ticket['status'];
  merged: boolean;
  review_rounds: number;
  review_verdicts: string[];
  qa_verdict?: string;
  /** The mockup's `dl.kv` value: one sentence covering what it does and how it went. */
  text: string;
}

export type SprintPhase = 'running' | 'review_pending' | 'reviewed';

/**
 * T050: the decision that closed a sprint review, for the read-only
 * retrospective the Review tab keeps showing afterwards. Read off the
 * resolved `sprint_review` gate — the same record `delegatedDecisions`
 * walks — so nothing new is stored.
 */
export interface ReportReviewDecision {
  /** ISO-8601 — when it was decided. */
  at: string;
  decision: 'approve' | 'deny';
  decided_by: string;
  note?: string;
}

/**
 * The whole narrative. The four `asked`/`built`/`went_wrong`/`where`
 * paragraphs are the ones the Review tab renders verbatim and the markdown
 * below prints verbatim — they are the same strings in both places.
 */
export interface SprintReport {
  sprint?: string;
  /**
   * T050: which of the three states this narrative describes. `running` is
   * the one that used to be indistinguishable from a finished sprint —
   * "0 of 3 finished", "nothing went wrong" and "carry all three into the
   * next sprint" were produced 1m27s into a live sprint and offered to the
   * operator as a review. The phase is derived from state the top bar
   * already reads (`sprint_review` gates + `sprint.review_at`/`retro`), so
   * bar and tab cannot disagree, and the running phrasing and the empty
   * `proposes_next` below are enforced here, once, for both the tab and
   * `runs/*.md`.
   */
  phase: SprintPhase;
  /** Set only in the `reviewed` phase — the decision that was taken. */
  decision?: ReportReviewDecision;
  goal: string;
  asked: string;
  built: string;
  went_wrong: string;
  where: string;
  per_ticket: ReportTicketLine[];
  decisions: ReportDecision[];
  proposes_next: string[];
  /** Token spend per ledger kind — the operator-facing diagnostic the run report has always carried. */
  spend: string[];
  /** Extra run-harness diagnostics (ceremony ticks, the oversized-read hook check) — supplied by `agile run`, empty for the UI. */
  diagnostics: string[];
  /** ISO-8601 — when this report was built. */
  generated_at: string;
}

function listReviewRecords(store: StateStore, ticket: TicketId): ReviewRecord[] {
  const records: ReviewRecord[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    try {
      records.push(
        store.getEntity(reviewRecordRelPath(ticket, round, 'primary'), validateReviewRecord),
      );
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      break;
    }
  }
  return records;
}

function listQaReports(store: StateStore, ticket: TicketId): QaReport[] {
  const reports: QaReport[] = [];
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    try {
      reports.push(store.getEntity(qaReportRelPath(ticket, round), validateQaReport));
    } catch (err) {
      if (!(err instanceof NotFoundError)) throw err;
      break;
    }
  }
  return reports;
}

function mergeRecordFor(store: StateStore, ticket: TicketId): MergeRecord | undefined {
  try {
    return store.getEntity(mergeRecordPath(ticket), validateMergeRecord);
  } catch (err) {
    if (err instanceof NotFoundError) return undefined;
    throw err;
  }
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function list(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] as string;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function ticketLine(store: StateStore, ticket: Ticket): ReportTicketLine {
  const reviews = listReviewRecords(store, ticket.id);
  const qa = listQaReports(store, ticket.id);
  const merge = mergeRecordFor(store, ticket.id);
  const lastQa = qa[qa.length - 1];
  const parts: string[] = [];
  parts.push(ticket.title);
  if (reviews.length > 0) {
    parts.push(
      `Review ${plural(reviews.length, 'round')}: ${reviews.map((r) => r.verdict).join(' then ')}.`,
    );
  } else {
    parts.push('Not reviewed yet.');
  }
  if (lastQa) {
    const passed = lastQa.lines.filter((l) => l.status === 'pass').length;
    parts.push(`QA ${lastQa.verdict}ed after ${passed}/${lastQa.lines.length} criteria passed.`);
  }
  if (merge?.status === 'merged') {
    parts.push(`Merged onto integration at ${merge.at}.`);
  } else if (merge?.summary) {
    parts.push(`Merge ${merge.status}: ${merge.summary}.`);
  } else {
    parts.push('Not merged.');
  }
  return {
    ticket: ticket.id,
    status: ticket.status,
    merged: merge?.status === 'merged',
    review_rounds: reviews.length,
    review_verdicts: reviews.map((r) => r.verdict),
    ...(lastQa ? { qa_verdict: lastQa.verdict } : {}),
    text: parts.join(' '),
  };
}

/** "Decisions made without you" — every gate this sprint that an `em`/`architect` delegate decided. */
export function delegatedDecisions(gates: GateService | undefined): ReportDecision[] {
  return (gates?.list() ?? [])
    .filter((r: HilRequest) => r.status === 'resolved' && r.delegated === true)
    .sort((a, b) => (a.resolved_at ?? '').localeCompare(b.resolved_at ?? ''))
    .map((r) => ({
      at: r.resolved_at ?? r.requested_at,
      gate: r.summary ? `${r.gate} · ${r.summary}` : r.gate,

      decided_by: r.decided_by ?? 'em',
      outcome: `${r.decision === 'approve' ? 'Allowed' : 'Denied'}${r.note ? `. "${r.note}"` : ''}${
        r.reason ? ` (${r.reason})` : ''
      }`,
    }));
}

export interface SprintReportInputs {
  /** Resolves "Decisions made without you" and the pending `sprint_review` gate's proposal. */
  gates?: GateService;
  /** Restrict the report to these tickets (the run harness's seeded set); default: every ticket in the store. */
  tickets?: TicketId[];
  /** Extra run-harness diagnostics, printed under their own heading. */
  diagnostics?: string[];
  now?: () => Date;
}

export function buildSprintReport(
  store: StateStore,
  inputs: SprintReportInputs = {},
): SprintReport {
  const now = inputs.now ?? (() => new Date());
  const sprint: Sprint | undefined = pickCurrentSprint(store.listSprints());

  /**
   * T050 — the phase. `review_pending` is exactly what the top bar's
   * `status.sprint_review_pending` reads (an open `sprint_review` gate);
   * `reviewed` is a resolved one, or a sprint the review already stamped
   * (`em/review.ts` writes `review_at` + `retro` when it resolves).
   * Everything else is a sprint that is still running, and a running sprint
   * gets no review narrative and no proposal.
   */
  // T121: `sprint_review` is a deleted gate kind; T122 deletes this module.
  const sprintReviewGates: HilRequest[] = [];
  const pendingReview = sprintReviewGates.find((r) => r.status === 'pending');
  const resolvedReview = sprintReviewGates
    .filter((r) => r.status === 'resolved')
    .sort((a, b) => (a.resolved_at ?? '').localeCompare(b.resolved_at ?? ''))
    .pop();
  const phase: SprintPhase = pendingReview
    ? 'review_pending'
    : resolvedReview || sprint?.review_at !== undefined || sprint?.retro !== undefined
      ? 'reviewed'
      : 'running';
  const running = phase === 'running';
  const decision: ReportReviewDecision | undefined = resolvedReview
    ? {
        at: resolvedReview.resolved_at ?? resolvedReview.requested_at,
        decision: resolvedReview.decision === 'approve' ? 'approve' : 'deny',
        decided_by: resolvedReview.decided_by ?? 'human',
        ...(resolvedReview.note ? { note: resolvedReview.note } : {}),
      }
    : undefined;
  const all = store.listTickets();
  const selected = inputs.tickets
    ? all.filter((t) => inputs.tickets?.includes(t.id))
    : sprint && sprint.tickets.length > 0
      ? all.filter((t) => sprint.tickets.includes(t.id))
      : all;
  const tickets = [...selected].sort((a, b) => a.id.localeCompare(b.id));
  const lines = tickets.map((ticket) => ticketLine(store, ticket));

  const merged = lines.filter((l) => l.merged);
  const done = tickets.filter((t) => t.status === 'done');
  const asked =
    tickets.length === 0
      ? 'Nothing was on the board for this sprint.'
      : `${sprint?.goal ?? 'No sprint goal was recorded'}. ${plural(tickets.length, 'ticket')}: ${list(
          tickets.map((t) => `${t.id} (${t.title})`),
        )}.`;

  const reviewRounds = lines.reduce((sum, l) => sum + l.review_rounds, 0);
  const qaAccepted = lines.filter((l) => l.qa_verdict === 'accept').length;
  const inFlight = tickets.filter((t) => t.status !== 'done').length;
  const built =
    tickets.length === 0
      ? running
        ? 'Nothing is on the board yet.'
        : 'Nothing was built.'
      : running
        ? `In progress: ${done.length} of ${tickets.length} finished so far, ${merged.length} merged onto integration, ` +
          `${plural(inFlight, 'ticket')} still in flight. ${plural(reviewRounds, 'review round')} so far; QA accepted ${qaAccepted}.`
        : `${done.length} of ${tickets.length} ticket(s) finished and ${merged.length} merged onto integration. ` +
          `${plural(reviewRounds, 'review round')} in total; QA accepted ${qaAccepted}.`;

  const troubles: string[] = [];
  for (const line of lines) {
    if (line.review_verdicts.some((v) => v !== 'approve')) {
      troubles.push(
        `${line.ticket} needed ${plural(line.review_rounds, 'review round')} (${line.review_verdicts.join(' then ')})`,
      );
    }
    if (line.qa_verdict === 'reject') troubles.push(`${line.ticket} was rejected by QA`);
    if (!line.merged && line.status === 'done')
      troubles.push(`${line.ticket} finished but never merged`);
  }
  // Halts: a released halt's file is deleted (`StateStore.deleteHalt`), so
  // "the team halted, then resumed" — the mockup's own example — is only
  // visible in `log/events.jsonl`. Open halts are read from the store for
  // their `reason`; released ones are counted off their events.
  const openHalts = new Map(store.listHalts().map((h) => [h.id, h]));
  const releasedHalts = new Set<string>();
  const createdHalts: string[] = [];
  for (const event of store.listEvents()) {
    const id = typeof event.data.id === 'string' ? event.data.id : undefined;
    if (event.kind === 'halt_created' && id !== undefined) createdHalts.push(id);
    if (event.kind === 'halt_released' && id !== undefined) releasedHalts.add(id);
  }
  for (const id of createdHalts) {
    const open = openHalts.get(id);
    if (open) {
      troubles.push(`a halt raised by ${open.raised_by} is still open: ${open.reason}`);
    } else if (releasedHalts.has(id)) {
      troubles.push(`a halt (${id}) stopped the team and was released`);
    }
  }
  const went_wrong =
    troubles.length === 0
      ? running
        ? 'Nothing has gone wrong so far: no halts and no rejected rounds. The sprint is still running.'
        : 'Nothing went wrong: no halts, no rejected rounds, no unmerged work.'
      : `${list(troubles)}.`;

  const where =
    merged.length > 0
      ? running
        ? `On the integration branch so far (${list(merged.map((l) => l.ticket))}); the rest is still on each ticket’s own branch under .worktrees/.`
        : `On the integration branch (${list(merged.map((l) => l.ticket))}). Accepting this review merges integration into main.`
      : 'Nothing has reached the integration branch yet; the work is on each ticket’s own branch under .worktrees/.';

  const spendByKind = new Map<string, { in: number; out: number; cost: number }>();
  for (const s of store.listSprints()) {
    for (const line of store.listLedger(s.id)) {
      const cur = spendByKind.get(line.kind) ?? { in: 0, out: 0, cost: 0 };
      cur.in += line.in_tokens;
      cur.out += line.out_tokens;
      cur.cost += line.cost_usd;
      spendByKind.set(line.kind, cur);
    }
  }
  const spend =
    spendByKind.size === 0
      ? ['(no ledger lines — fake-agent sessions default to a single `usage_update`; see notes)']
      : [...spendByKind.entries()].map(
          ([kind, s]) => `${kind}: ${s.in} in / ${s.out} out tokens, $${s.cost.toFixed(4)}`,
        );

  /**
   * T050: only a sprint that has actually stopped gets a proposal. While it
   * runs, "carry all three into the next sprint — 3 tickets did not finish"
   * is not a proposal, it is a description of a sprint that is 90 seconds
   * old, so there is nothing to say and the Review tab renders no section.
   */
  const proposes_next: string[] = [];
  if (!running) {
    if (pendingReview?.summary) proposes_next.push(pendingReview.summary);
    const carried = tickets.filter((t) => t.status !== 'done');
    if (carried.length > 0) {
      proposes_next.push(
        `Carry ${list(carried.map((t) => t.id))} into the next sprint — ${plural(carried.length, 'ticket')} did not finish.`,
      );
    }
    if (merged.length > 0) proposes_next.push('Accept this review to merge integration into main.');
    if (proposes_next.length === 0)
      proposes_next.push('No proposal on record — ask the EM in the chat.');
  }

  return {
    ...(sprint ? { sprint: sprint.id } : {}),
    phase,
    ...(decision ? { decision } : {}),
    goal: sprint?.goal ?? '(no sprint goal recorded)',
    asked,
    built,
    went_wrong,
    where,
    per_ticket: lines,
    decisions: delegatedDecisions(inputs.gates),
    proposes_next,
    spend,
    diagnostics: inputs.diagnostics ?? [],
    generated_at: now().toISOString(),
  };
}

/**
 * The `runs/<ts>.md` body — and the same text, section for section, that the
 * Review tab renders. The `## Per-ticket outcome` / `## Review rounds per
 * ticket` headings are kept from the pre-T044 report: `agile run`'s own e2e
 * asserts on them, and they are the operator's machine-greppable summary
 * under the prose.
 */
export function renderSprintReportMarkdown(report: SprintReport): string {
  const lines: string[] = [
    `# Sprint ${report.phase === 'running' ? 'progress' : 'review'}${
      report.sprint ? ` — ${report.sprint}` : ''
    } — ${report.generated_at}`,
    '',
    // T050: a report built mid-sprint (an aborted `agile run`) says so on
    // its first line rather than reading like a sprint that ended.
    ...(report.phase === 'running'
      ? [
          '**Status:** the sprint is still running — this is a progress report, not a sprint review.',
          '',
        ]
      : []),
    ...(report.decision
      ? [
          `**Decision:** ${report.decision.decision === 'approve' ? 'accepted' : 'sent back'} by ${
            report.decision.decided_by
          } at ${report.decision.at}${report.decision.note ? ` — “${report.decision.note}”` : ''}.`,
          '',
        ]
      : []),
    `**What was asked:** ${report.asked}`,
    '',
    `**What was built:** ${report.built}`,
    '',
    `**What went wrong:** ${report.went_wrong}`,
    '',
    `**Where the code is:** ${report.where}`,
    '',
    '## Per ticket',
    ...report.per_ticket.map((l) => `- ${l.ticket}: ${l.text}`),
    '',
    '## Decisions made without you',
    ...(report.decisions.length === 0
      ? ['- (none — every gate this sprint came to you)']
      : report.decisions.map(
          (d) => `- ${d.at} · ${d.gate} · decided by ${d.decided_by} · ${d.outcome}`,
        )),
    '',
    // Only a stopped sprint has a proposal (T050), so the heading goes with it.
    ...(report.proposes_next.length > 0
      ? ['## What the EM proposes next', ...report.proposes_next.map((p) => `- ${p}`), '']
      : []),
    '## Per-ticket outcome',
    ...report.per_ticket.map(
      (l) => `- ${l.ticket}: status=${l.status}, merged=${l.merged ? 'yes' : 'no'}`,
    ),
    '',
    '## Review rounds per ticket',
    ...report.per_ticket.map(
      (l) =>
        `- ${l.ticket}: ${plural(l.review_rounds, 'round')}${
          l.review_verdicts.length > 0 ? ` (${l.review_verdicts.join(' then ')})` : ''
        }`,
    ),
    '',
    '## Token spend per role (ledger)',
    ...report.spend.map((s) => `- ${s}`),
  ];
  if (report.diagnostics.length > 0) {
    lines.push('', '## Run diagnostics', ...report.diagnostics.map((d) => `- ${d}`));
  }
  lines.push('');
  return lines.join('\n');
}
