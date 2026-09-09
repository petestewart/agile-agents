/**
 * Review findings/verdict (design/agile-agents-design.md §12 "Review
 * protocol": "Report = findings with severity, each tied to a rule
 * (`RULE-012`) or an oracle ref (`violates DEC-0042`)"; "Verdicts: approve ·
 * request_changes (findings to address) · escalate (the ticket/contract is
 * wrong, not the code)").
 *
 * T016 grant (no existing shared entity covers a reviewer's structured
 * findings/verdict — `message.ts`'s `review_verdict` is a bus envelope with
 * a free-form `body`/`refs`, not this shape): a NEW schema file, additive
 * only — no existing shared file is touched by this ticket except the one
 * `export *` line in `index.ts`.
 */

import { z } from 'zod';
import { OracleIdSchema, RuleIdSchema, TicketIdSchema, formatZodError } from './ids';

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

/** `path:line` — "every finding carries ... a location (`path:line`)" (briefs/reviewer.md). `line` is optional: a finding can be file-scoped (e.g. "missing test file") with no single line. */
export const FindingLocationSchema = z
  .object({
    path: z.string().min(1),
    line: z.number().int().positive().optional(),
  })
  .strict();
export type FindingLocation = z.infer<typeof FindingLocationSchema>;

/**
 * "each tied to a rule (`RULE-012`) or an oracle ref (`violates DEC-0042`)"
 * (§12) — exactly one of the two, enforced below (a finding with both or
 * neither has nothing checkable behind it).
 */
export const FindingSchema = z
  .object({
    severity: FindingSeveritySchema,
    rule: RuleIdSchema.optional(),
    oracle_ref: OracleIdSchema.optional(),
    location: FindingLocationSchema,
    message: z.string().min(1),
  })
  .strict()
  .superRefine((finding, ctx) => {
    const hasRule = finding.rule !== undefined;
    const hasOracleRef = finding.oracle_ref !== undefined;
    if (hasRule === hasOracleRef) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rule'],
        message:
          'a finding must cite exactly one of "rule" or "oracle_ref" (§12 "Review protocol")',
      });
    }
  });
export type Finding = z.infer<typeof FindingSchema>;

export function validateFinding(input: unknown): Finding {
  const result = FindingSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Finding', result.error));
  }
  return result.data;
}

/** "Verdicts: approve · request_changes ... · escalate" (§12). */
export const REVIEW_VERDICTS = ['approve', 'request_changes', 'escalate'] as const;
export const ReviewVerdictKindSchema = z.enum(REVIEW_VERDICTS);
export type ReviewVerdictKind = z.infer<typeof ReviewVerdictKindSchema>;

/**
 * "A second, security-mandate reviewer when ... the architect tags
 * `security: true` or tier is hard/novel" (§12) — `pass` distinguishes that
 * second session's verdict record from the primary one on the same round.
 */
export const REVIEW_PASSES = ['primary', 'security'] as const;
export const ReviewPassSchema = z.enum(REVIEW_PASSES);
export type ReviewPass = z.infer<typeof ReviewPassSchema>;

/**
 * One reviewer verdict for one round. `findings` holds only problems raised
 * ("no findings" narrative — "what was checked" — is prose, carried in the
 * bus message body / the review record's own file, not part of this
 * schema); `request_changes` with an empty findings array has nothing to
 * act on and is rejected below.
 */
export const VerdictSchema = z
  .object({
    ticket: TicketIdSchema,
    round: z.number().int().positive(),
    pass: ReviewPassSchema.default('primary'),
    findings: z.array(FindingSchema).default([]),
    verdict: ReviewVerdictKindSchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.verdict === 'request_changes' && v.findings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findings'],
        message: 'request_changes must cite at least one finding',
      });
    }
  });
export type Verdict = z.infer<typeof VerdictSchema>;

export function validateVerdict(input: unknown): Verdict {
  const result = VerdictSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Verdict', result.error));
  }
  return result.data;
}
