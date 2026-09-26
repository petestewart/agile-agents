/**
 * StatusCard — `~/.agile/cards/<node-id>.yaml` (projects-design §14.5, T283).
 *
 * The daemon writes the mechanical fields (`state`, `files`, `relies_on`,
 * `updated_at`); the agent writes `doing` through the `progress` verb.
 * Siblings, ancestors and the Director read it with `read_card`.
 */

import { z } from 'zod';
import { UlidSchema, formatZodError } from './ids';

export const CARD_DOING_MAX = 200;
export const CARD_FILES_MAX = 200;

export const CARD_STATES = ['working', 'blocked', 'done', 'idle'] as const;
export const CardStateSchema = z.enum(CARD_STATES);
export type CardState = z.infer<typeof CardStateSchema>;

export const StatusCardSchema = z
  .object({
    node: UlidSchema,
    doing: z.string().max(CARD_DOING_MAX),
    state: CardStateSchema,
    /** Changed vs merge-base, including uncommitted; ≤ 200, then one "+N more" line. */
    files: z.array(z.string().min(1)).max(CARD_FILES_MAX + 1),
    /** "prices.ts:salePrice", from the import index (§14.6, T284). */
    exports_changed: z.array(z.string().min(1)),
    relies_on: z.array(z.string().min(1)),
    updated_at: z.string().datetime(),
  })
  .strict();
export type StatusCard = z.infer<typeof StatusCardSchema>;

export function validateStatusCard(raw: unknown): StatusCard {
  const result = StatusCardSchema.safeParse(raw);
  if (!result.success) throw new Error(formatZodError('StatusCard', result.error));
  return result.data;
}
