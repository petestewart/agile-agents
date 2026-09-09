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
 * §13), and `skipped` alone does not force a reject when at least one OTHER
 * criterion actually ran (it's escalated to the architect via em as its own
 * finding — see `protocol.ts`'s `submit` — not silently treated as a
 * failure of the engineer's work).
 *
 * Round-2 review fix (opus blocker B1): when EVERY line is `skipped` —
 * nothing executed at all — `verdict` is forced to `reject` even though no
 * line technically `fail`ed. §13's contract is "accept a correct
 * implementation, reject one that fails a criterion"; an implementation
 * nothing was ever run against is neither, and the old "reject iff any
 * fail" rule silently `accept`ed it (round-1's fix that a denied/unplanned
 * command degrades to `skipped` instead of aborting the round made this
 * newly reachable). `qaAllSkipped` names the same check `protocol.ts`
 * reuses to also refuse the ticket transition, not just the report label.
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
  const anyFail = lines.some((l) => l.status === 'fail');
  const anyExecuted = lines.some((l) => l.status === 'pass' || l.status === 'flaky');
  const verdict = anyFail || !anyExecuted ? 'reject' : 'accept';
  return validateQaReport({ ticket: ticket.id, round, lines, verdict });
}

/** True when every line is `skipped` — no criterion was actually exercised. Shared by `protocol.ts`'s `submit` so the "refuse to accept/transition" rule and the report's own verdict computation can never drift apart. */
export function qaAllSkipped(report: QaReport): boolean {
  return report.lines.every((l) => l.status === 'skipped');
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
