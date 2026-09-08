/**
 * LedgerLine (design/agile-agents-design.md §4 "Ledger").
 *
 * One line per model call, emitted by adapters, appended to `ledger/<sprint>.jsonl`.
 */

import { z } from 'zod';
import { formatZodError } from './ids';

export const LEDGER_KINDS = ['engineer', 'review', 'qa', 'reader', 'ceremony'] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/**
 * DESIGN-GAP: the §4 "Ledger" example is a structure sketch with empty-string
 * placeholders (`"ts":"","sprint":"","ticket":""`), which would fail a
 * `SprintIdSchema`/`TicketIdSchema`/min-length check. `sprint`/`ticket`/`ts`/
 * `agent`/`model` are kept as plain (possibly-empty) strings rather than the
 * stricter ID formats used elsewhere, so the literal example still parses;
 * `ceremony`-kind lines also plausibly have no ticket at all.
 */
export const LedgerLineSchema = z.object({
  ts: z.string(),
  sprint: z.string(),
  ticket: z.string(),
  agent: z.string(),
  model: z.string(),
  in_tokens: z.number().int().min(0),
  out_tokens: z.number().int().min(0),
  cost_usd: z.number().min(0),
  kind: LedgerKindSchema,
});

export type LedgerLine = z.infer<typeof LedgerLineSchema>;

export function validateLedgerLine(input: unknown): LedgerLine {
  const result = LedgerLineSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('LedgerLine', result.error));
  }
  return result.data;
}
