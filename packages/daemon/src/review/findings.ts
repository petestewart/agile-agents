/**
 * Findings/verdict validation (T016 — design §12 "Review protocol").
 *
 * The schemas themselves live in `@agile-agents/shared`'s `review.ts` (this
 * ticket's one grant outside `src/review/`) — this module re-exports them
 * plus the daemon-side helpers that operate on them: equality (for the
 * re-review "was this finding already raised?" check) and a convenience
 * validator for a whole findings array.
 */

import type { Finding } from '@agile-agents/shared';

export {
  FINDING_SEVERITIES,
  FindingSchema,
  FindingSeveritySchema,
  REVIEW_PASSES,
  REVIEW_VERDICTS,
  ReviewPassSchema,
  ReviewVerdictKindSchema,
  VerdictSchema,
  validateFinding,
  validateVerdict,
  type Finding,
  type FindingLocation,
  type FindingSeverity,
  type ReviewPass,
  type ReviewVerdictKind,
  type Verdict,
} from '@agile-agents/shared';

/**
 * Two findings are "the same finding" when they cite the same rule/oracle
 * ref at the same location — the identity the re-review rule needs to tell
 * "the engineer disputed this exact finding again" from "a new finding
 * happens to land nearby". Message text is intentionally excluded: a
 * reviewer restating the same citation+location in different words is still
 * the same finding, not a new one.
 */
export function sameFinding(a: Finding, b: Finding): boolean {
  return (
    a.rule === b.rule &&
    a.oracle_ref === b.oracle_ref &&
    a.location.path === b.location.path &&
    a.location.line === b.location.line
  );
}

/** True when `finding` matches something already present in `previous`. */
export function findingWasRaisedBefore(finding: Finding, previous: readonly Finding[]): boolean {
  return previous.some((p) => sameFinding(finding, p));
}

/** Stable string identity for a finding — the dispute-tracking key (`review_dispute`'s finding is looked up by this, not by array index, since findings get re-sent across rounds). */
export function findingKey(finding: Finding): string {
  const citation = finding.rule ?? finding.oracle_ref ?? '';
  return `${finding.location.path}:${finding.location.line ?? ''}:${citation}`;
}
