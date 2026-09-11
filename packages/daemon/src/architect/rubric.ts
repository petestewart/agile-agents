/**
 * Pointing rubric (T014 — design/agile-agents-design.md §11 "Pointing rubric
 * and routing calibration").
 *
 * Points (Fibonacci 1/2/3/5/8) measure work; the architect sets them by
 * judgment, same as any estimator — nothing in §11 derives `points` from the
 * four-question rubric, so `pointTicket` takes the architect's own points
 * judgment as an input alongside the four answers and returns it unchanged
 * (kept on the same result object because a ticket's `estimate` block wants
 * points/tier/reasoning together — see `packages/shared/src/ticket.ts`'s
 * `TicketEstimateSchema`).
 *
 * Tier is "the worst answer" across four questions. Three of the four
 * columns (Ambiguity, Blast radius, Verifiability) merge trivial and
 * standard into one cell — "contract fully specified by oracle refs" reads
 * the same whether the ticket ends up trivial or standard-pointed — so
 * those three only discriminate {low, hard, novel}; only Precedent has a
 * distinct trivial-vs-standard cell ("pattern to copy" vs "similar
 * pattern"). Tier is therefore computed as:
 *
 * 1. If any of Ambiguity/Blast radius/Verifiability is at `hard` or
 *    `novel`, tier is the worst of those three, full stop — Precedent
 *    cannot lower it (its own hard/novel cells both read "none", i.e. it
 *    never claims a ticket is *easier* than the other three say).
 * 2. Otherwise (all three are in the merged low cell), tier comes from
 *    Precedent alone: `exact_pattern` → trivial, `similar_pattern` →
 *    standard, `none` → **hard** — DESIGN-GAP: the table's Precedent row
 *    reads "none" for both its hard and novel columns, so "no precedent at
 *    all, but otherwise a fully-specified, one-module, testable ticket" is
 *    genuinely ambiguous between hard and novel from the table alone. Read
 *    conservatively: Precedent by itself never claims `novel` (novel
 *    requires an ambiguity/blast-radius/verifiability answer that itself
 *    says so — "choices that would themselves be decisions" etc.), so this
 *    case settles at `hard`.
 */

import type { TicketEstimate, TicketReasoning, TicketTier } from '@agile-agents/shared';
import { formatZodError } from '@agile-agents/shared';
import { z } from 'zod';

export type AmbiguityAnswer =
  /** "contract fully specified by oracle refs" (trivial/standard cell). */
  | 'contract_specified'
  /** "requires choices the oracle doesn't make" (hard). */
  | 'requires_choices'
  /** "choices that would themselves be decisions" (novel). */
  | 'choices_are_decisions';

export type BlastRadiusAnswer =
  /** "one module" (trivial/standard cell). */
  | 'one_module'
  /** "crosses a bounded context" (hard). */
  | 'bounded_context'
  /** "public interface or data model" (novel). */
  | 'public_interface_or_data_model';

export type VerifiabilityAnswer =
  /** "executable acceptance tests" (trivial/standard cell). */
  | 'executable_tests'
  /** "needs judgment to evaluate" (hard). */
  | 'needs_judgment'
  /** "can't be written until done → it's a spike" (novel). */
  | 'cant_be_written_until_done';

export type PrecedentAnswer =
  /** "pattern to copy in KB/codebase" (trivial). */
  | 'exact_pattern'
  /** "similar pattern" (standard). */
  | 'similar_pattern'
  /** "none" (hard/novel cell — see file header). */
  | 'none';

export interface FourQuestionAnswers {
  /** Architect's own work-size judgment — Fibonacci, orthogonal to tier (§11). */
  points: TicketEstimate['points'];
  ambiguity: AmbiguityAnswer;
  blastRadius: BlastRadiusAnswer;
  verifiability: VerifiabilityAnswer;
  precedent: PrecedentAnswer;
  /** "architect may override" the tier-derived default (§11). */
  reasoningOverride?: TicketReasoning;
}

/**
 * Independent review fix (opus blocker 1): the four answers arrive from an
 * MCP call as untyped JSON — a bad/unrecognised value (a typo, a value from
 * a different vendor's own vocabulary) must not silently fall through the
 * `? :` chains below. Those chains only ever compare against known literals,
 * so anything else previously landed in the final `else` branch of each
 * ternary — i.e. coerced to the *worst* answer (`novel`/`hard`) with no
 * error raised. `FourQuestionAnswersSchema` closes that off: every field is
 * a strict enum, `points` is the closed Fibonacci set `TicketEstimateSchema`
 * itself uses, and the object is `.strict()` so an unrecognised extra key
 * (not just an unrecognised value) is refused too.
 */
export const FourQuestionAnswersSchema = z
  .object({
    points: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5), z.literal(8)]),
    ambiguity: z.enum(['contract_specified', 'requires_choices', 'choices_are_decisions']),
    blastRadius: z.enum(['one_module', 'bounded_context', 'public_interface_or_data_model']),
    verifiability: z.enum(['executable_tests', 'needs_judgment', 'cant_be_written_until_done']),
    precedent: z.enum(['exact_pattern', 'similar_pattern', 'none']),
    reasoningOverride: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();

export function validateFourQuestionAnswers(input: unknown): FourQuestionAnswers {
  const result = FourQuestionAnswersSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('FourQuestionAnswers', result.error));
  }
  return result.data;
}

export interface PointingResult {
  points: TicketEstimate['points'];
  tier: TicketTier;
  reasoning: TicketReasoning;
  /** One line per question, for the oracle/ticket history — not persisted by a schema anywhere, just handed back for a caller to log. */
  reasoningNotes: string;
}

/** 0 = trivial/standard-cell, 2 = hard, 3 = novel — see file header for why there's no distinct "1" here (only Precedent has one). */
function ambiguityLevel(a: AmbiguityAnswer): number {
  return a === 'contract_specified' ? 0 : a === 'requires_choices' ? 2 : 3;
}
function blastRadiusLevel(a: BlastRadiusAnswer): number {
  return a === 'one_module' ? 0 : a === 'bounded_context' ? 2 : 3;
}
function verifiabilityLevel(a: VerifiabilityAnswer): number {
  return a === 'executable_tests' ? 0 : a === 'needs_judgment' ? 2 : 3;
}

/** "Seed by judgment: trivial → ... low reasoning ... novel → ... high" (§11) — standard/hard left to fill the ordering; DESIGN-GAP, no literal table given for the middle two. */
const REASONING_BY_TIER: Record<TicketTier, TicketReasoning> = {
  trivial: 'low',
  standard: 'low',
  hard: 'medium',
  novel: 'high',
};

/**
 * Pure four-question pointing (§11). Deterministic — no store/clock access,
 * so the architect's MCP verb layer supplies `pointed_by`/`pointed_at` when
 * it writes the result onto a ticket's `estimate` block. Validates `answers`
 * against `FourQuestionAnswersSchema` first (review fix, opus blocker 1) —
 * `pointTicket` is called both from `verbs.ts` (MCP input, genuinely
 * untrusted) and directly from tests/other daemon code, so the validation
 * lives here rather than being the MCP layer's problem alone.
 */
export function pointTicket(answers: unknown): PointingResult {
  const validated = validateFourQuestionAnswers(answers);
  const worstOfThree = Math.max(
    ambiguityLevel(validated.ambiguity),
    blastRadiusLevel(validated.blastRadius),
    verifiabilityLevel(validated.verifiability),
  );

  let tier: TicketTier;
  if (worstOfThree === 3) {
    tier = 'novel';
  } else if (worstOfThree === 2) {
    tier = 'hard';
  } else {
    // All three at the merged low cell — Precedent alone decides trivial vs
    // standard vs hard (never novel by itself; see file header).
    tier =
      validated.precedent === 'exact_pattern'
        ? 'trivial'
        : validated.precedent === 'similar_pattern'
          ? 'standard'
          : 'hard';
  }

  const reasoning = validated.reasoningOverride ?? REASONING_BY_TIER[tier];
  const reasoningNotes = [
    `ambiguity=${validated.ambiguity}`,
    `blast_radius=${validated.blastRadius}`,
    `verifiability=${validated.verifiability}`,
    `precedent=${validated.precedent}`,
    `-> tier=${tier}, reasoning=${reasoning}${validated.reasoningOverride ? ' (overridden)' : ''}`,
  ].join('; ');

  return { points: validated.points, tier, reasoning, reasoningNotes };
}
