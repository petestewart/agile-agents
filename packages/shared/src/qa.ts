/**
 * QaReport — the daemon-durable record of one QA round on a ticket
 * (design/agile-agents-design.md §13 "QA environment and protocol": "Output:
 * accept / reject plus one line per criterion — pass/fail, the command or
 * action used, and for failures observed vs expected via test_run").
 *
 * T017 scope grant: this is the one shared file this ticket may add (new
 * strict schema, exported from index) — every other `packages/shared/**`
 * file stays untouched.
 */

import { z } from 'zod';
import { TicketIdSchema, formatZodError } from './ids';

/**
 * Per-criterion outcome. `flaky` is its own status, distinct from `fail` —
 * §13 "Flakiness": "one rerun before calling a failure; two different
 * results is a flaky finding filed to the KB", i.e. a flaky criterion is
 * NOT a QA rejection, it's a KB fact plus a report line that says so.
 * `skipped` is "a criterion that can't be exercised from outside" (§13) —
 * a finding against the criterion (escalated to the architect via em),
 * not a pass or a fail.
 */
export const QA_CRITERION_STATUSES = ['pass', 'fail', 'flaky', 'skipped'] as const;
export const QaCriterionStatusSchema = z.enum(QA_CRITERION_STATUSES);
export type QaCriterionStatus = z.infer<typeof QaCriterionStatusSchema>;

/** Keeps a single report line well under the message-body cap even before the whole report is truncated for the `qa_verdict` body (CLAUDE.md: "message bodies capped ... signal over volume"). */
export const QA_REPORT_MAX_EVIDENCE_CHARS = 200;

export const QaReportLineSchema = z
  .object({
    /** The acceptance criterion text, verbatim from `ticket.contract.acceptance` — this IS the identity of the line, so "one line per criterion" is checkable by counting these. */
    criterion: z.string().min(1),
    /** The command or action used to exercise it — absent only for a `skipped` line (no command was ever supplied for it). */
    command: z.string().min(1).optional(),
    status: QaCriterionStatusSchema,
    /** Pass/fail detail, or for a failure: observed vs. expected — capped, pointer-not-payload (the full `test_run` output lives on disk via its own `raw_output` pointer). */
    evidence: z.string().max(QA_REPORT_MAX_EVIDENCE_CHARS),
  })
  .strict();
export type QaReportLine = z.infer<typeof QaReportLineSchema>;

export const QA_VERDICTS = ['accept', 'reject'] as const;
export const QaVerdictSchema = z.enum(QA_VERDICTS);
export type QaVerdict = z.infer<typeof QaVerdictSchema>;

export const QaReportSchema = z
  .object({
    ticket: TicketIdSchema,
    /** 1-based QA round for this ticket — a `reject` starts a new round on the same ticket once the engineer resubmits. */
    round: z.number().int().min(1),
    /** One entry per criterion in `ticket.contract.acceptance`, same order — never empty (a ticket with no acceptance criteria has nothing for QA to run). */
    lines: z.array(QaReportLineSchema).min(1),
    verdict: QaVerdictSchema,
  })
  .strict();
export type QaReport = z.infer<typeof QaReportSchema>;

export function validateQaReport(input: unknown): QaReport {
  const result = QaReportSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('QaReport', result.error));
  }
  return result.data;
}

/** `board/qa/<ticket>-r<round>.yaml` (§13 storage convention this ticket introduces, matching the sibling `board/halts/<id>.yaml`/`board/status/<ticket>.jsonl` layout — generic entity trio, not a dedicated store method). */
export function qaReportRelPath(ticket: string, round: number): string {
  return `board/qa/${ticket}-r${round}.yaml`;
}
