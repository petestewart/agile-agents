/**
 * Halt (design/agile-agents-design.md §4 "Halts", §15 "Git model and teams"
 * for the `team:` scope variant).
 *
 * `board/halts/<id>.yaml`: presence of the file = halt active; delete to release.
 */

import { z } from 'zod';
import { HaltIdSchema, OracleIdSchema, TicketIdSchema, formatZodError } from './ids';

/**
 * "scope: global | [TKT-...]" (§4) plus "Halt scope gains team: alongside
 * global and ticket lists" (§15).
 */
export const HaltScopeSchema = z.union([
  z.literal('global'),
  z.string().regex(/^team:.+/, 'must look like team:<name>'),
  z.array(TicketIdSchema).min(1),
]);
export type HaltScope = z.infer<typeof HaltScopeSchema>;

export const HaltQuorumSchema = z.enum(['pending', 'reached']);
export type HaltQuorum = z.infer<typeof HaltQuorumSchema>;

export const HaltSchema = z.object({
  id: HaltIdSchema,
  scope: HaltScopeSchema,
  reason: z.string().min(1),
  raised_by: z.string().min(1),
  // "resolves_when: DEC-xxxx" — a decision id names the resolution condition.
  resolves_when: OracleIdSchema.optional(),
  quorum: HaltQuorumSchema,
});

export type Halt = z.infer<typeof HaltSchema>;

export function validateHalt(input: unknown): Halt {
  const result = HaltSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Halt', result.error));
  }
  return result.data;
}
