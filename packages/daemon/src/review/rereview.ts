/**
 * Re-review convergence rule (T016 — design §12 "Review protocol":
 * "Convergence: a reviewer may not raise on re-review a finding visible in
 * the first pass").
 *
 * "Visible" (session Design note): the finding's file+line range existed in
 * round-1's diff hunks, *and* that range is unchanged since (same hunk hash
 * in the current round's diff) — a reviewer who missed something in round 1
 * loses the chance to raise it later only as long as the engineer never
 * touched that code again; once a later round's diff shows a different hash
 * at that location, it's freshly-reviewable code again.
 *
 * DESIGN-GAP (opus review nit): the baseline is always round 1 specifically
 * — a location first visible in round 2's diff (not round 1's) is not
 * checked against by this rule and may be raised fresh in round 4. That is
 * the literal §12 wording ("visible in the first pass"), read here as
 * "round 1" rather than "any prior round", so it is intentional, not an
 * oversight — flagged because the rejection reason string below hard-codes
 * "round 1" and could otherwise read as a bug report.
 */

import type { Finding } from '@agile-agents/shared';
import type { DiffHunk } from './diff-summary';
import { findingWasRaisedBefore } from './findings';

export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

export interface ReReviewResult {
  allowed: Finding[];
  rejected: RejectedFinding[];
}

/** The hunk in `hunks` whose `[newStart, newEnd]` range contains `line` for `path`, if any. A finding with no `line` (file-scoped) never matches a hunk — it's never "visible" in the line-range sense, so it's always allowed through. */
function findCoveringHunk(
  hunks: readonly DiffHunk[],
  path: string,
  line: number,
): DiffHunk | undefined {
  return hunks.find((h) => h.path === path && line >= h.newStart && line <= h.newEnd);
}

/**
 * `previousRounds` — every prior round's findings, oldest first (used to
 * tell "the engineer disputed this exact finding again" — not new — from a
 * genuinely new finding). `diffThen` — round 1's `diff_summary` hunks (what
 * was visible on the very first pass). `diffNow` — the current round's
 * hunks (to check whether that location has since changed).
 */
export function validateReReview(
  previousRounds: readonly Finding[][],
  newFindings: readonly Finding[],
  diffThen: readonly DiffHunk[],
  diffNow: readonly DiffHunk[],
): ReReviewResult {
  const everRaised = previousRounds.flat();

  const allowed: Finding[] = [];
  const rejected: RejectedFinding[] = [];

  for (const finding of newFindings) {
    if (findingWasRaisedBefore(finding, everRaised)) {
      // Restating a finding already on the record isn't a *new* finding —
      // convergence only governs findings a reviewer is raising for the
      // first time on a re-review.
      allowed.push(finding);
      continue;
    }

    if (finding.location.line === undefined) {
      allowed.push(finding);
      continue;
    }

    const then = findCoveringHunk(diffThen, finding.location.path, finding.location.line);
    if (!then) {
      // Not part of round 1's diff at all — genuinely new surface area.
      allowed.push(finding);
      continue;
    }

    const now = findCoveringHunk(diffNow, finding.location.path, finding.location.line);
    const unchangedSinceRoundOne = now !== undefined && now.hash === then.hash;

    if (unchangedSinceRoundOne) {
      rejected.push({
        finding,
        reason: `${finding.location.path}:${finding.location.line} was visible in round 1's diff and is unchanged since — this finding should have been raised then`,
      });
    } else {
      allowed.push(finding);
    }
  }

  return { allowed, rejected };
}
