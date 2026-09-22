/**
 * §6.3's three bands, in one place.
 *
 * ```
 * probability >= deny_at            → DENY, with the rule named in the reason
 * probability <  allow_below        → ALLOW
 * otherwise                         → ROUTE to the inbox
 * ```
 *
 * **D14**: `probability` is the raw Noul value, which is the answer and its
 * certainty in one. There is no second confidence axis; the route band is
 * the low-confidence case.
 *
 * The thresholds are read from `classifier.bands` in `<home>/config.yaml`
 * (T150), never hard-coded here: "the numbers live in config precisely so
 * moving them is not a code change". Both callers of the classifier tier —
 * the per-action hook band (§8.1) and the diff-level check at landing
 * (§8.2) — band their answers through this function, so the two can never
 * disagree about what 0.8 means.
 */

import type { ClassifierBands } from '@agile-agents/shared';
import type { Answer } from './types';

/** What a banded answer says to do. */
export type ClassifierBand = 'deny' | 'allow' | 'route';

/** The band for one answer, on its raw Noul value only. */
export function bandFor(
  answer: Pick<Answer, 'probability'>,
  bands: ClassifierBands,
): ClassifierBand {
  if (answer.probability >= bands.deny_at) return 'deny';
  if (answer.probability < bands.allow_below) return 'allow';
  return 'route';
}
