/**
 * Rule — the system's memory of decisions (design/cockpit-design.md §5).
 *
 * Rules replace the oracle, its decision graph, the ripple walk and the
 * retro. One record per rule at `<home>/rules/R-<ulid>.yaml`, written only
 * through the daemon's store (`packages/daemon/src/rules/service.ts` is the
 * one writer).
 *
 * The record is §5.1 verbatim, and the two structural checks that are not
 * schema-level live here beside it as pure functions, exactly as
 * `stream.ts` keeps `assertStreamWrite`:
 *
 *  - `assertRuleWrite` — the principal split of §2.2/§5.1 (**D4**): an
 *    agent may *create* a `proposed` rule, but `status`, `decided_at` and
 *    `decided_by` are human-only.
 *  - `assertRuleAcceptable` — §5.1's "a classifier rule with fewer than two
 *    examples cannot be accepted; the store refuses it", plus the pattern
 *    tier's requirement that a `pattern` rule actually carries a `pattern`.
 *
 * Scope *filtering* is deliberately not here: §5.3's `rulesInScope` needs a
 * stream and its ancestors, which is daemon state, so it lives once in
 * `daemon/src/rules/service.ts` and is imported by its two callers (the
 * brief assembler and the hook).
 */

import { z } from 'zod';
import { ULID_PATTERN, UlidSchema, formatZodError } from './ids';

/**
 * `R-<ulid>` — same shape and rationale as `Q-<ulid>` and `HIL-<ulid>`:
 * minted by daemon-internal code at whatever rate agents propose, so a
 * sortable, collision-free ulid beats a hand-assigned number.
 */
export const RULE_ID_PATTERN = new RegExp(`^R-${ULID_PATTERN.source.slice(1, -1)}$`);
export const RuleIdSchema = z.string().regex(RULE_ID_PATTERN, 'must look like R-<ulid>');
export type RuleId = z.infer<typeof RuleIdSchema>;

/** Rule text and example actions share the 800-char body cap (CLAUDE.md "signal over volume"). */
export const RULE_TEXT_MAX_CHARS = 800;

export const RULE_SCOPE_KINDS = ['global', 'repo', 'stream'] as const;
export const RuleScopeKindSchema = z.enum(RULE_SCOPE_KINDS);
export type RuleScopeKind = z.infer<typeof RuleScopeKindSchema>;

/**
 * §5.3: `global` has no `ref`; `repo` refs a `repos.yaml` key and `stream`
 * refs a stream ULID. The `ref`-is-required-for-a-scoped-rule rule is a
 * schema refinement; whether the ref *exists* is a store check (it needs
 * the home), applied in `RulesService`.
 */
export const RuleScopeSchema = z
  .object({
    kind: RuleScopeKindSchema,
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
export type RuleScope = z.infer<typeof RuleScopeSchema>;

/** §5.1: "a proposal is not a rule" — the gap is where the human's authority lives. */
export const RULE_STATUSES = ['proposed', 'accepted', 'retired'] as const;
export const RuleStatusSchema = z.enum(RULE_STATUSES);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

/** §5.2's three tiers: a deterministic check, a classifier question, or brief text. */
export const RULE_ENFORCEMENTS = ['pattern', 'classifier', 'guidance'] as const;
export const RuleEnforcementSchema = z.enum(RULE_ENFORCEMENTS);
export type RuleEnforcement = z.infer<typeof RuleEnforcementSchema>;

/** Where the rule is checked: the tool call (§8.1), the diff (§8.2), or both. */
export const RULE_STAGES = ['action', 'diff', 'both'] as const;
export const RuleStageSchema = z.enum(RULE_STAGES);
export type RuleStage = z.infer<typeof RuleStageSchema>;

/** §5.4's built-in pattern detectors. `args` is free-form per kind. */
export const RULE_PATTERN_KINDS = [
  'no_push',
  'no_push_protected',
  'path_deny',
  'command_deny',
] as const;
export const RulePatternKindSchema = z.enum(RULE_PATTERN_KINDS);
export type RulePatternKind = z.infer<typeof RulePatternKindSchema>;

/**
 * T143: `args` is typed per kind rather than a free-form record, so a rule
 * that claims a deterministic check cannot carry arguments its checker
 * will never read. `no_push`/`no_push_protected` take none (the protected
 * branches come from the stream's repo entry at check time, never frozen
 * into the rule); `path_deny` takes optional `globs` on top of its
 * always-on "outside the session's worktree" check; `command_deny` takes
 * the token patterns it matches on the parsed atoms.
 */
const NoPatternArgsSchema = z.object({}).strict().default({});

export const RulePatternSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('no_push'), args: NoPatternArgsSchema }).strict(),
  z.object({ kind: z.literal('no_push_protected'), args: NoPatternArgsSchema }).strict(),
  z
    .object({
      kind: z.literal('path_deny'),
      args: z
        .object({ globs: z.array(z.string().min(1)).default([]) })
        .strict()
        .default({}),
    })
    .strict(),
  z
    .object({
      kind: z.literal('command_deny'),
      args: z
        .object({ patterns: z.array(z.string().min(1)).default([]) })
        .strict()
        .default({}),
    })
    .strict(),
]);
export type RulePattern = z.infer<typeof RulePatternSchema>;

/**
 * §5.6: an example is documentation for the human *and* an eval for the
 * classifier. Two of them are mandatory before a classifier rule can be
 * accepted (`assertRuleAcceptable`).
 */
export const RuleExampleSchema = z
  .object({
    action: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
    violates: z.boolean(),
  })
  .strict();
export type RuleExample = z.infer<typeof RuleExampleSchema>;

/** §5.1: "six months later, 'why does this rule exist' must be answerable". */
export const RuleProvenanceSchema = z
  .object({
    stream: UlidSchema.optional(),
    session: z.string().min(1).optional(),
    /** The finding (or lesson) the proposal came out of. */
    finding: z.string().min(1).optional(),
    /** `human` · `seed:PLAN-v1` · `agent:<session>` — who proposed it. */
    by: z.string().min(1),
  })
  .strict();
export type RuleProvenance = z.infer<typeof RuleProvenanceSchema>;

/** §5.7's pruning input, counted by the hook path and the diff check. */
export const RuleStatsSchema = z
  .object({
    fired: z.number().int().nonnegative().default(0),
    violated: z.number().int().nonnegative().default(0),
    routed: z.number().int().nonnegative().default(0),
    last_fired_at: z.string().min(1).optional(),
  })
  .strict();
export type RuleStats = z.infer<typeof RuleStatsSchema>;

/** `<home>/rules/R-<ulid>.yaml` — §5.1's record, field for field. */
export const RuleSchema = z
  .object({
    id: RuleIdSchema,
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
    scope: RuleScopeSchema,
    status: RuleStatusSchema,
    enforcement: RuleEnforcementSchema,
    stage: RuleStageSchema.default('action'),
    pattern: RulePatternSchema.optional(),
    critical: z.boolean(),
    examples: z.array(RuleExampleSchema).default([]),
    provenance: RuleProvenanceSchema,
    stats: RuleStatsSchema,
    created_at: z.string().min(1),
    decided_at: z.string().min(1).optional(),
    decided_by: z.string().min(1).optional(),
  })
  .strict();
export type Rule = z.infer<typeof RuleSchema>;
/** Pre-validation shape: `stage`, `examples` and the `stats` counters default. */
export type RuleInput = z.input<typeof RuleSchema>;

/**
 * What a caller may supply when *proposing* a rule. Everything the daemon
 * owns — `id`, `created_at`, `status`, `stats`, `decided_*` — is absent on
 * purpose: the service mints them, so no caller (human or agent) can forge
 * a rule that arrives already accepted.
 */
export const RuleProposalSchema = z
  .object({
    text: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
    question: z.string().min(1).max(RULE_TEXT_MAX_CHARS).optional(),
    scope: RuleScopeSchema.optional(),
    enforcement: RuleEnforcementSchema.optional(),
    stage: RuleStageSchema.optional(),
    pattern: RulePatternSchema.optional(),
    critical: z.boolean().optional(),
    examples: z.array(RuleExampleSchema).optional(),
    provenance: RuleProvenanceSchema.optional(),
  })
  .strict();
export type RuleProposal = z.infer<typeof RuleProposalSchema>;

/**
 * What a human may *edit* on an existing rule (§3.1's "edit-then-accept"):
 * the proposal's fields minus `provenance` (immutable — it is the answer to
 * "why does this rule exist"), all optional. `status`, `decided_at` and
 * `decided_by` are absent here by construction, so an edit can never carry
 * a decision: that goes through accept/retire.
 */
export const RulePatchSchema = RuleProposalSchema.omit({ provenance: true }).partial().strict();
export type RulePatch = z.infer<typeof RulePatchSchema>;

export function validateRule(input: unknown): Rule {
  const result = RuleSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('Rule', result.error));
  }
  return result.data;
}

export function validateRuleProposal(input: unknown): RuleProposal {
  const result = RuleProposalSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('RuleProposal', result.error));
  }
  return result.data;
}

export function validateRulePatch(input: unknown): RulePatch {
  const result = RulePatchSchema.safeParse(input);
  if (!result.success) {
    throw new Error(formatZodError('RulePatch', result.error));
  }
  return result.data;
}

/**
 * `global` · `repo:<name>` · `stream:<ulid>` — the one wire/CLI spelling of
 * a scope, parsed back into the record's `{kind, ref}`. Both the `agile
 * rules` CLI and the `propose_rule` verb take a scope as this string, so
 * the grammar is written once.
 */
export function parseRuleScope(text: string): RuleScope {
  const trimmed = text.trim();
  if (trimmed === 'global') return { kind: 'global' };
  const separator = trimmed.indexOf(':');
  const kind = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const ref = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
  if ((kind === 'repo' || kind === 'stream') && ref.length > 0) return { kind, ref };
  throw new Error(
    `invalid rule scope "${text}": must be "global", "repo:<name>" or "stream:<stream id>"`,
  );
}

/** `global` / `repo:alpha` / `stream:<ulid>` — the inverse of `parseRuleScope`. */
export function formatRuleScope(scope: RuleScope): string {
  return scope.ref === undefined ? scope.kind : `${scope.kind}:${scope.ref}`;
}

/** §5.1: "defaults to 'Does this action violate: <text>?'". */
export function classifierQuestion(rule: Pick<Rule, 'text' | 'question'>): string {
  return rule.question ?? `Does this action violate: ${rule.text}?`;
}

/** Minimum examples a classifier rule needs before it may be accepted (§5.6). */
export const CLASSIFIER_MIN_EXAMPLES = 2;

/**
 * A rule write a principal was not allowed to make, or a record that is not
 * acceptable in the tier it claims. A distinct class so the RPC edge maps
 * it to `invalid params` (-32602) — like `StreamCycleError`, it is bad
 * caller input, not a daemon fault.
 */
export class RuleWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleWriteError';
  }
}

/** Who may write a rule record — the same three principals as a stream (§2.2). */
export type RulePrincipal = 'agent' | 'human' | 'daemon';

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

/** The three human-only fields of §5.1 (**D4**). */
const HUMAN_ONLY_FIELDS = ['status', 'decided_at', 'decided_by'] as const;

/**
 * The principal split for rules (§5.1, **D4**), enforced on every write.
 *
 * - an `agent` principal may create only a `proposed` rule, and may never
 *   change `status`, `decided_at` or `decided_by`;
 * - `human` and `daemon` may write everything (the daemon's own writes are
 *   its stats counters and the built-ins of §5.4);
 * - nothing may change a rule's `id`.
 *
 * `before` is `undefined` for a create. Throws `RuleWriteError`; returns
 * `after` when the write is allowed.
 */
export function assertRuleWrite(
  principal: RulePrincipal,
  before: Rule | undefined,
  after: Rule,
): Rule {
  if (before !== undefined && before.id !== after.id) {
    throw new RuleWriteError(`invalid Rule write: id ${before.id} may not change to ${after.id}`);
  }
  if (principal !== 'agent') return after;
  if (before === undefined) {
    if (after.status !== 'proposed') {
      throw new RuleWriteError(
        `invalid Rule write: an agent principal may only create a proposed rule, not "${after.status}"`,
      );
    }
    if (after.decided_at !== undefined || after.decided_by !== undefined) {
      throw new RuleWriteError(
        'invalid Rule write: decided_at/decided_by are human-only fields (D4)',
      );
    }
    return after;
  }
  for (const field of HUMAN_ONLY_FIELDS) {
    if (changed(before[field], after[field])) {
      throw new RuleWriteError(
        `invalid Rule write: an agent principal may not change ${field} (human-only, D4)`,
      );
    }
  }
  return after;
}

/**
 * §5.1/§5.2's tier invariants, checked on every write rather than only on
 * accept, so a malformed record never reaches disk:
 *
 *  - a `pattern` rule must carry a `pattern` — "a rule that cannot say how
 *    it is enforced is a wish";
 *  - an **accepted** `classifier` rule must carry at least two examples,
 *    "because without them the rule cannot be evaluated, and an unevaluated
 *    probabilistic gate is a rule that will start misfiring silently"
 *    (§5.6). A *proposed* classifier rule with one example is fine — it
 *    just cannot be accepted until it has two.
 */
export function assertRuleAcceptable(rule: Rule): Rule {
  if (rule.enforcement === 'pattern' && rule.pattern === undefined) {
    throw new RuleWriteError(
      `invalid Rule ${rule.id}: a pattern rule must carry a pattern {kind, args}`,
    );
  }
  if (
    rule.enforcement === 'classifier' &&
    rule.status === 'accepted' &&
    rule.examples.length < CLASSIFIER_MIN_EXAMPLES
  ) {
    throw new RuleWriteError(
      `invalid Rule ${rule.id}: a classifier rule needs at least ${CLASSIFIER_MIN_EXAMPLES} examples before it can be accepted (§5.6); it has ${rule.examples.length}`,
    );
  }
  return rule;
}
