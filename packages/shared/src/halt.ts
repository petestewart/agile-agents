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

export const HaltSchema = z
  .object({
    id: HaltIdSchema,
    scope: HaltScopeSchema,
    reason: z.string().min(1),
    raised_by: z.string().min(1),
    // "resolves_when: DEC-xxxx" — a decision id names the resolution condition.
    resolves_when: OracleIdSchema.optional(),
    quorum: HaltQuorumSchema,
    // DESIGN-GAP (T007 manager decision, quorum durability): §4 "Halts" only
    // names `quorum: pending | reached` on the file; §5 "Discovery ->
    // standup -> resume" step 4 ("Daemon marks halt quorum: reached once
    // every affected agent reports or times out on heartbeat") requires
    // tracking *which* agents must report and which already have, plus when
    // the halt was raised (for the quorum timeout). CLAUDE.md's "every
    // ceremony is reconstructible from .agile/" rules out process-local
    // bookkeeping, so that state is promoted onto the Halt file itself —
    // optional so a hand-written or pre-existing halt file without them
    // still validates (e.g. a `team:` scope halt with no resolvable
    // membership, or a halt authored before this field existed).
    affected: z.array(z.string().min(1)).optional(),
    reported: z.array(z.string().min(1)).optional(),
    raised_at: z.string().min(1).optional(),
  })
  .strict();

export type Halt = z.infer<typeof HaltSchema>;

export function validateHalt(input: unknown): Halt {
  const result = HaltSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Halt', result.error));
  }
  return result.data;
}
