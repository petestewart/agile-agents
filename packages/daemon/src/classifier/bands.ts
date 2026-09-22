/**
 * §6.3's three bands, in one place.
 *
 * ```
 * probability >= deny_at            → DENY, with the rule named in the reason
 * probability <  allow_below        → ALLOW
 * otherwise                         → ROUTE to the inbox
 * confidence  <  confidence_floor   → ROUTE, whatever the probability
 * ```
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

/**
 * The band for one answer. The confidence floor is checked first because it
 * overrides the probability entirely: "a probability of 0.9 with confidence
 * 0.2 is not a 0.9; it is a shrug".
 */
export function bandFor(
  answer: Pick<Answer, 'probability' | 'confidence'>,
  bands: ClassifierBands,
): ClassifierBand {
  if (answer.confidence < bands.confidence_floor) return 'route';
  if (answer.probability >= bands.deny_at) return 'deny';
  if (answer.probability < bands.allow_below) return 'allow';
  return 'route';
}
