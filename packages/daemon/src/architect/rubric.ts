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

/** Pure four-question pointing (§11). Deterministic — no store/clock access, so the architect's MCP verb layer supplies `pointed_by`/`pointed_at` when it writes the result onto a ticket's `estimate` block. */
export function pointTicket(answers: FourQuestionAnswers): PointingResult {
  const worstOfThree = Math.max(
    ambiguityLevel(answers.ambiguity),
    blastRadiusLevel(answers.blastRadius),
    verifiabilityLevel(answers.verifiability),
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
      answers.precedent === 'exact_pattern'
        ? 'trivial'
        : answers.precedent === 'similar_pattern'
          ? 'standard'
          : 'hard';
  }

  const reasoning = answers.reasoningOverride ?? REASONING_BY_TIER[tier];
  const reasoningNotes = [
    `ambiguity=${answers.ambiguity}`,
    `blast_radius=${answers.blastRadius}`,
    `verifiability=${answers.verifiability}`,
    `precedent=${answers.precedent}`,
    `-> tier=${tier}, reasoning=${reasoning}${answers.reasoningOverride ? ' (overridden)' : ''}`,
  ].join('; ');

  return { points: answers.points, tier, reasoning, reasoningNotes };
}
