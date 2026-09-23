/**
 * Effort — the closed enum a session is attached with (PLAN.md **D12**:
 * "Sessions carry `vendor`, `model` and `effort` chosen at attach time …
 * Effort is a closed enum mapped per vendor by the provider registry and
 * ignored with a thread note where the vendor has no equivalent").
 *
 * Its own module because three schemas need it — `SessionRef` (the chosen
 * level), `RepoEntry` (a repo's default) and `HomeConfig` (the home's
 * default) — and none of those three should have to import each other.
 */

import { z } from 'zod';
import { formatZodError } from './ids';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max'] as const;
export const EffortSchema = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof EffortSchema>;

export function validateEffort(input: unknown): Effort {
  const result = EffortSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Effort', result.error));
  }
  return result.data;
}
