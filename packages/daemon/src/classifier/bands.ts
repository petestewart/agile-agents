/**
 * §6.3's bands: `probability >= deny_at` ⇒ deny, `< allow_below` ⇒ allow,
 * otherwise route. D14: the raw Noul value is answer and certainty in one;
 * the route band is the low-confidence case. Thresholds come from
 * `classifier.bands` in config, and both callers (the hook, §8.1, and the
 * diff check, §8.2) band through here, so they agree on what 0.8 means.
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
