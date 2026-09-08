/**
 * KbFact — knowledge store entry (design/agile-agents-design.md §4 "Knowledge store").
 */

import { z } from 'zod';
import { KbIdSchema, TicketIdSchema, formatZodError } from './ids';

export const KB_KINDS = ['env', 'codebase', 'gotcha', 'perf'] as const;
export const KbKindSchema = z.enum(KB_KINDS);
export type KbKind = z.infer<typeof KbKindSchema>;

export const KB_CONFIDENCE_LEVELS = ['observed', 'verified'] as const;
export const KbConfidenceSchema = z.enum(KB_CONFIDENCE_LEVELS);
export type KbConfidence = z.infer<typeof KbConfidenceSchema>;

export const KbFactSchema = z.object({
  id: KbIdSchema,
  kind: KbKindSchema,
  scope: z.array(z.string().min(1)).min(1),
  confidence: KbConfidenceSchema,
  // "source: TKT-0198" — the design only shows a ticket source; other agent
  // notes (e.g. reviewer promotion) are still attributed via `confidence`.
  source: TicketIdSchema,
  // "expires: null  # date for env facts that rot"
  expires: z.string().min(1).nullable(),
});

export type KbFact = z.infer<typeof KbFactSchema>;

export function validateKbFact(input: unknown): KbFact {
  const result = KbFactSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('KbFact', result.error));
  }
  return result.data;
}
