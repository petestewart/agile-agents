/**
 * Report assembly (T017 — design/agile-agents-design.md §13: "Output: accept
 * / reject plus one line per criterion"). Two shapes: the durable
 * `QaReport` (`board/qa/<ticket>-r<n>.yaml`, the full record) and the
 * capped `qa_verdict` message body (§5/CLAUDE.md: message bodies ≤800
 * chars, signal over volume — the full report is a `refs` pointer, not the
 * body).
 */

import {
  MESSAGE_BODY_MAX_CHARS,
  type QaReport,
  type QaReportLine,
  type Ticket,
} from '@agile-agents/shared';
import { validateQaReport } from '@agile-agents/shared';
import type { QaCriterionResult } from './rerun';

/**
 * `verdict` is `reject` if any criterion `fail`ed; `accept` otherwise —
 * `flaky` counts as a pass-with-a-caveat (it's a KB fact, not a reject,
 * §13), and `skipped` alone does not force a reject (it's escalated to the
 * architect via em as its own finding — see `protocol.ts`'s `submit` — not
 * silently treated as a failure of the engineer's work).
 */
export function buildQaReport(
  ticket: Ticket,
  round: number,
  results: QaCriterionResult[],
): QaReport {
  const lines: QaReportLine[] = results.map((r) => ({
    criterion: r.criterion,
    ...(r.command !== undefined ? { command: r.command } : {}),
    status: r.status,
    evidence: r.evidence,
  }));
  const verdict = lines.some((l) => l.status === 'fail') ? 'reject' : 'accept';
  return validateQaReport({ ticket: ticket.id, round, lines, verdict });
}

const TRUNCATION_MARGIN_CHARS = 48;

/** One-line-per-criterion `qa_verdict` message body, truncated with a pointer to the full report file when it would exceed the shared 800-char cap. */
export function renderQaVerdictBody(report: QaReport, reportRefPath: string): string {
  const header = `QA ${report.verdict} for ${report.ticket} (round ${report.round}) — full report: ${reportRefPath}`;
  const lines = report.lines.map(
    (l) => `${l.status.toUpperCase()}: ${l.criterion} — ${l.evidence}`,
  );
  const full = [header, ...lines].join('\n');
  if (full.length <= MESSAGE_BODY_MAX_CHARS) return full;

  const kept: string[] = [header];
  let total = header.length;
  const budget = MESSAGE_BODY_MAX_CHARS - TRUNCATION_MARGIN_CHARS;
  for (const line of lines) {
    if (total + 1 + line.length > budget) break;
    kept.push(line);
    total += 1 + line.length;
  }
  kept.push(`[truncated — ${report.lines.length} criteria total, see ${reportRefPath}]`);
  return kept.join('\n');
}
