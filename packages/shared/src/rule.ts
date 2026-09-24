/**
 * The legacy cockpit `Rule` record (cockpit design §5.1), read-only.
 *
 * Knowledge items replaced rules (projects-design §14.3, T260). This file
 * keeps only what reads the old `<home>/rules/R-<ulid>.yaml` files for the
 * one-shot migration (§17.1 step 2), and the old enforcement vocabulary
 * the `propose_rule` verb still speaks until `propose_knowledge` replaces
 * it (T264). `rules/` stays on disk, untouched, for one phase.
 */

import { z } from 'zod';
import { ULID_PATTERN, UlidSchema, formatZodError } from './ids';
import {
  type KnowledgeEnforcement,
  type KnowledgeItemInput,
  type KnowledgeSource,
  RULE_TEXT_MAX_CHARS,
  RuleCriteriaSchema,
  RuleExamplesSchema,
  RulePatternSchema,
  RuleStatsSchema,
} from './knowledge';

export const LEGACY_RULE_ID_PATTERN = new RegExp(`^R-${ULID_PATTERN.source.slice(1, -1)}$`);
export const LegacyRuleIdSchema = z
  .string()
  .regex(LEGACY_RULE_ID_PATTERN, 'must look like R-<ulid>');
export type LegacyRuleId = z.infer<typeof LegacyRuleIdSchema>;

export const LEGACY_RULE_SCOPE_KINDS = ['global', 'repo', 'stream'] as const;
export const LegacyRuleScopeKindSchema = z.enum(LEGACY_RULE_SCOPE_KINDS);
export type LegacyRuleScopeKind = z.infer<typeof LegacyRuleScopeKindSchema>;

/**
 * §5.3: `global` has no `ref`; `repo` refs a `repos.yaml` key and `stream`
 * refs a stream ULID. The `ref`-is-required-for-a-scoped-rule rule is a
 * schema refinement; whether the ref *exists* is a store check (it needs
 * the home), applied in `RulesService`.
 */
export const LegacyRuleScopeSchema = z
  .object({
    kind: LegacyRuleScopeKindSchema,
    ref: z.string().min(1).optional(),
  })
  .strict()
  .refine((scope) => scope.kind === 'global' || scope.ref !== undefined, {
    message: 'a repo- or stream-scoped rule must name its ref',
    path: ['ref'],
  })
  .refine((scope) => scope.kind !== 'global' || scope.ref === undefined, {
    message: 'a global rule has no ref',
    path: ['ref'],
  });
export type LegacyRuleScope = z.infer<typeof LegacyRuleScopeSchema>;

/** §5.1: "a proposal is not a rule" — the gap is where the human's authority lives. */
export const LEGACY_RULE_STATUSES = ['proposed', 'accepted', 'retired'] as const;
export const LegacyRuleStatusSchema = z.enum(LEGACY_RULE_STATUSES);
export type LegacyRuleStatus = z.infer<typeof LegacyRuleStatusSchema>;

/** §5.2's three tiers: a deterministic check, a classifier question, or brief text. */
export const LEGACY_RULE_ENFORCEMENTS = ['pattern', 'classifier', 'guidance'] as const;
export const LegacyRuleEnforcementSchema = z.enum(LEGACY_RULE_ENFORCEMENTS);
export type LegacyRuleEnforcement = z.infer<typeof LegacyRuleEnforcementSchema>;

/** Where the rule is checked: the tool call (§8.1), the diff (§8.2), or both. */
export const LEGACY_RULE_STAGES = ['action', 'diff', 'both'] as const;
export const LegacyRuleStageSchema = z.enum(LEGACY_RULE_STAGES);
export type LegacyRuleStage = z.infer<typeof LegacyRuleStageSchema>;

/** §5.1: "six months later, 'why does this rule exist' must be answerable". */
export const LegacyRuleProvenanceSchema = z
  .object({
    stream: UlidSchema.optional(),
    session: z.string().min(1).optional(),
    /** The finding (or lesson) the proposal came out of. */
    finding: z.string().min(1).optional(),
    /** `human` · `seed:PLAN-v1` · `agent:<session>` — who proposed it. */
    by: z.string().min(1),
  })
  .strict();
export type LegacyRuleProvenance = z.infer<typeof LegacyRuleProvenanceSchema>;

/** `<home>/rules/R-<ulid>.yaml` — §5.1's record, field for field. */
export const LegacyRuleSchema = z
  .object({
    id: LegacyRuleIdSchema,
    /**
     * T145: the stable short name of a built-in (`no_push_protected`, …),
     * set only by the daemon when it creates §5.4's rules. A rule a human
     * or an agent wrote has no name — `R-<ulid>` is its only identity, and
     * the CLI prints `-` for it.
     */
    name: z.string().min(1).max(64).optional(),
    text: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
    /** The classifier question; `classifierQuestion` supplies the default. */
    question: z.string().min(1).max(RULE_TEXT_MAX_CHARS).optional(),
    /** T156: optional true/false descriptions sent with the question (D14). */
    criteria: RuleCriteriaSchema.optional(),
    scope: LegacyRuleScopeSchema,
    status: LegacyRuleStatusSchema,
    enforcement: LegacyRuleEnforcementSchema,
    stage: LegacyRuleStageSchema.default('action'),
    pattern: RulePatternSchema.optional(),
    critical: z.boolean(),
    examples: RuleExamplesSchema.default([]),
    provenance: LegacyRuleProvenanceSchema,
    stats: RuleStatsSchema,
    created_at: z.string().min(1),
    decided_at: z.string().min(1).optional(),
    decided_by: z.string().min(1).optional(),
  })
  .strict();
export type LegacyRule = z.infer<typeof LegacyRuleSchema>;
/** Pre-validation shape: `stage`, `examples` and the `stats` counters default. */
export type LegacyRuleInput = z.input<typeof LegacyRuleSchema>;

export function validateLegacyRule(input: unknown): LegacyRule {
  const result = LegacyRuleSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Rule', result.error));
  }
  return result.data;
}

/**
 * The old tier + stage as §6's enforcement (§17.1 step 2): a pattern is an
 * action check; a classifier at `action` is `action`, at `diff` is `ship`
 * (`both` is split by `migrateRuleRecord`, P6); `guidance` is `tell`.
 */
export function legacyEnforcement(
  enforcement: LegacyRuleEnforcement,
  stage: LegacyRuleStage = 'action',
): KnowledgeEnforcement {
  if (enforcement === 'guidance') return 'tell';
  if (enforcement === 'pattern') return 'action';
  return stage === 'diff' ? 'ship' : 'action';
}

/** `provenance.by` (free text) → `source.by` (§14.3's enum). */
function legacySource(provenance: LegacyRuleProvenance): KnowledgeSource {
  const by = provenance.by;
  const kind: KnowledgeSource['by'] =
    by === 'human' || by === 'builtin' || by === 'lessons'
      ? by
      : by === 'agent' || by.startsWith('agent:')
        ? 'agent'
        : by.startsWith('lessons')
          ? 'lessons'
          : 'migration';
  return {
    by: kind,
    ...(provenance.stream !== undefined ? { node: provenance.stream } : {}),
    ...(provenance.session !== undefined ? { session: provenance.session } : {}),
    ...(provenance.finding !== undefined ? { finding: provenance.finding } : {}),
  };
}

/**
 * §17.1 step 2: one legacy rule as knowledge items, `kind: standard`. The
 * first keeps the rule's ulid (`R-X` → `K-X`); a classifier rule at stage
 * `both` also yields a second `ship` item with `shipId` (P6).
 */
export function migrateRuleRecord(rule: LegacyRule, shipId: string): KnowledgeItemInput[] {
  const enforcement = legacyEnforcement(rule.enforcement, rule.stage);
  const base: KnowledgeItemInput = {
    id: `K-${rule.id.slice(2)}`,
    ...(rule.name !== undefined ? { name: rule.name } : {}),
    kind: 'standard',
    text: rule.text,
    scope:
      rule.scope.kind === 'global' || rule.scope.ref === undefined
        ? { kind: 'global' }
        : rule.scope.kind === 'repo'
          ? { kind: 'repo', repo: rule.scope.ref }
          : { kind: 'subtree', node: rule.scope.ref },
    enforcement,
    ...(rule.enforcement === 'pattern' && rule.pattern !== undefined
      ? { check: { by: 'pattern' as const, pattern: rule.pattern } }
      : {}),
    ...(rule.enforcement === 'classifier'
      ? {
          check: {
            by: 'classifier' as const,
            ...(rule.question !== undefined ? { question: rule.question } : {}),
            ...(rule.criteria !== undefined ? { criteria: rule.criteria } : {}),
            examples: rule.examples,
          },
        }
      : {}),
    critical: rule.critical,
    source: legacySource(rule.provenance),
    status: rule.status,
    stats: rule.stats,
    created_at: rule.created_at,
    ...(rule.decided_at !== undefined ? { decided_at: rule.decided_at } : {}),
    ...(rule.decided_by !== undefined ? { decided_by: rule.decided_by } : {}),
  };
  if (rule.enforcement !== 'classifier' || rule.stage !== 'both') return [base];
  const source = legacySource(rule.provenance);
  return [
    base,
    {
      ...base,
      id: shipId,
      enforcement: 'ship',
      // The split twin starts its own counters; the rule's stay on the action item.
      stats: {},
      source: { ...source, finding: `split from ${rule.id} (stage both, P6)` },
    },
  ];
}
