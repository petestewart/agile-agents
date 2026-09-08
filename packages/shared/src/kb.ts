/**
 * KbFact — knowledge store entry (design/agile-agents-design.md §4 "Knowledge store").
 */

import { z } from 'zod';
import { KbIdSchema, formatZodError } from './ids';

export const KB_KINDS = ['env', 'codebase', 'gotcha', 'perf'] as const;
export const KbKindSchema = z.enum(KB_KINDS);
export type KbKind = z.infer<typeof KbKindSchema>;

export const KB_CONFIDENCE_LEVELS = ['observed', 'verified'] as const;
export const KbConfidenceSchema = z.enum(KB_CONFIDENCE_LEVELS);
export type KbConfidence = z.infer<typeof KbConfidenceSchema>;

export const KbFactSchema = z
  .object({
    id: KbIdSchema,
    kind: KbKindSchema,
    scope: z.array(z.string().min(1)).min(1),
    confidence: KbConfidenceSchema,
    // "source: TKT-0198" is the one example, but §7 has tool-summary
    // proposals and §13 files a `flaky` finding to the KB from QA — neither
    // is obviously a ticket id, so this is a plain non-empty string rather
    // than `TicketIdSchema` (nit from the independent review: the one
    // example value was being read as a type).
    source: z.string().min(1),
    // "expires: null  # date for env facts that rot"
    expires: z.string().min(1).nullable(),
  })
  .strict();

export type KbFact = z.infer<typeof KbFactSchema>;

export function validateKbFact(input: unknown): KbFact {
  const result = KbFactSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('KbFact', result.error));
  }
  return result.data;
}
