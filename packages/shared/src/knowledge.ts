/**
 * KnowledgeItem — what agents need to know, and how strongly it is
 * enforced (projects-design §5, §6, §14.3). Replaces the cockpit `Rule`:
 * "rule" is no longer a kind of knowledge, it is the enforcement setting.
 *
 * One record per item at `<home>/knowledge/K-<ulid>.yaml`, written only
 * through the daemon's store (`packages/daemon/src/knowledge/service.ts`
 * is the one writer). A migrated rule keeps its ulid: `R-X` becomes `K-X`
 * (§17.1 step 2, `migrateRuleRecord` in `./rule`).
 *
 * The parts of the old rule record — `RulePattern`, `RuleExample`,
 * `RuleCriteria`, `RuleStats` — are kept here as parts, unchanged (§17).
 *
 * The two structural checks that are not schema-level live beside the
 * record as pure functions, as `stream.ts` keeps `assertStreamWrite`:
 *
 *  - `assertKnowledgeWrite` — the principal split (**D4**): an agent may
 *    *create* a `proposed` item, but `status`, `decided_at` and
 *    `decided_by` are human-only.
 *  - `assertKnowledgeAcceptable` — §14.3's `check` rules (required for
 *    `action`/`ship`, forbidden for `tell`/`review`, a pattern is an
 *    `action` check only) and "an accepted classifier check has ≥ 2
 *    examples" (cockpit §5.6).
 */

import { z } from 'zod';
import { ULID_PATTERN, UlidSchema, formatZodError } from './ids';
import { ProjectIdSchema } from './project';

/** `K-<ulid>`; a migrated `R-X` keeps its ulid as `K-X`. */
export const KNOWLEDGE_ID_PATTERN = new RegExp(`^K-${ULID_PATTERN.source.slice(1, -1)}$`);
export const KnowledgeIdSchema = z.string().regex(KNOWLEDGE_ID_PATTERN, 'must look like K-<ulid>');
export type KnowledgeId = z.infer<typeof KnowledgeIdSchema>;

/** Rule text and example actions share the 800-char body cap (CLAUDE.md "signal over volume"). */
export const RULE_TEXT_MAX_CHARS = 800;

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
 * T167: a pattern from its kind and a flat list of arguments — the CLI's
 * `--pattern <kind> [--pattern-arg …]` and the rules screen's editor both
 * speak this shape. `path_deny`'s arguments are globs, `command_deny`'s are
 * token patterns, and the two push kinds take none (an argument there is
 * refused rather than dropped). Validated by `RulePatternSchema`.
 */
export function rulePatternFromArgs(kind: string, args: readonly string[] = []): RulePattern {
  const values = args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
  let candidate: unknown;
  if (kind === 'path_deny') candidate = { kind, args: { globs: values } };
  else if (kind === 'command_deny') candidate = { kind, args: { patterns: values } };
  else if (kind === 'no_push' || kind === 'no_push_protected') {
    if (values.length > 0) throw new Error(`pattern ${kind} takes no arguments`);
    candidate = { kind, args: {} };
  } else {
    throw new Error(
      `invalid pattern kind "${kind}": must be one of ${RULE_PATTERN_KINDS.join(', ')}`,
    );
  }
  const result = RulePatternSchema.safeParse(candidate);
  if (!result.success) throw new Error(formatZodError('RulePattern', result.error));
  return result.data;
}

/** T167: the flat argument list of a pattern — the inverse of `rulePatternFromArgs`. */
export function rulePatternArgs(pattern: RulePattern): string[] {
  if (pattern.kind === 'path_deny') return [...pattern.args.globs];
  if (pattern.kind === 'command_deny') return [...pattern.args.patterns];
  return [];
}

/** T167: `command_deny: "rm -rf", "git reset --hard"` · `no_push` — one line for a human. */
export function formatRulePattern(pattern: RulePattern): string {
  const args = rulePatternArgs(pattern);
  if (args.length === 0) return pattern.kind;
  return `${pattern.kind}: ${args.map((arg) => JSON.stringify(arg)).join(', ')}`;
}

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

/**
 * T167: most examples one rule may carry. Every example is one classifier
 * call when "Test examples" / `agile rules test` runs, and all of them are
 * shown on the rules screen, so an unbounded list is both a cost and a
 * wall of text. Twenty is several times the two §5.6 requires and leaves
 * room for the edge cases a subtle rule needs; past that, split the rule.
 */
export const RULE_EXAMPLES_MAX = 20;
export const RuleExamplesSchema = z
  .array(RuleExampleSchema)
  .max(RULE_EXAMPLES_MAX, `a rule carries at most ${RULE_EXAMPLES_MAX} examples`);

/**
 * T156 (**D14**): what "yes" and "no" mean for a rule's classifier question,
 * for a line too subtle for the question alone. Passed through to the Noul
 * request as the TypeSafe docs describe; `true` describes a state where the
 * rule is broken (the question's "yes"), `false` one where it holds.
 */
export const RuleCriteriaSchema = z
  .object({
    true: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
    false: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
  })
  .strict();
export type RuleCriteria = z.infer<typeof RuleCriteriaSchema>;

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

/** §5: standard (how we work), architecture (what exists where), decision (a choice with a reason). */
export const KNOWLEDGE_KINDS = ['standard', 'architecture', 'decision'] as const;
export const KnowledgeKindSchema = z.enum(KNOWLEDGE_KINDS);
export type KnowledgeKind = z.infer<typeof KnowledgeKindSchema>;

/** §6: instructions only, or a check at the action, ship or review checkpoint. */
export const KNOWLEDGE_ENFORCEMENTS = ['tell', 'action', 'ship', 'review'] as const;
export const KnowledgeEnforcementSchema = z.enum(KNOWLEDGE_ENFORCEMENTS);
export type KnowledgeEnforcement = z.infer<typeof KnowledgeEnforcementSchema>;

/** A proposal is not knowledge: nothing applies until a human accepts it (§5). */
export const KNOWLEDGE_STATUSES = ['proposed', 'accepted', 'retired'] as const;
export const KnowledgeStatusSchema = z.enum(KNOWLEDGE_STATUSES);
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;

export const KNOWLEDGE_SCOPE_KINDS = ['global', 'repo', 'project', 'subtree'] as const;
export type KnowledgeScopeKind = (typeof KNOWLEDGE_SCOPE_KINDS)[number];

/**
 * §14.3's four scopes. `subtree` is the node and all its descendants (the
 * old `stream` scope). Whether a ref exists is a store check, applied in
 * `KnowledgeService`.
 */
export const KnowledgeScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('global') }).strict(),
  z.object({ kind: z.literal('repo'), repo: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('project'), project: ProjectIdSchema }).strict(),
  z.object({ kind: z.literal('subtree'), node: UlidSchema }).strict(),
]);
export type KnowledgeScope = z.infer<typeof KnowledgeScopeSchema>;

/**
 * How an `action` or `ship` item is checked: a deterministic pattern
 * (action only) or a classifier question with its examples.
 */
export const KnowledgeCheckSchema = z.discriminatedUnion('by', [
  z.object({ by: z.literal('pattern'), pattern: RulePatternSchema }).strict(),
  z
    .object({
      by: z.literal('classifier'),
      question: z.string().min(1).max(RULE_TEXT_MAX_CHARS).optional(),
      criteria: RuleCriteriaSchema.optional(),
      examples: RuleExamplesSchema.default([]),
    })
    .strict(),
]);
export type KnowledgeCheck = z.infer<typeof KnowledgeCheckSchema>;
export type KnowledgeCheckInput = z.input<typeof KnowledgeCheckSchema>;

/**
 * Who proposed it. §14.3's five, plus `builtin` for the daemon's own
 * pattern items (their idempotence key, as `provenance.by: builtin` was).
 */
export const KNOWLEDGE_SOURCES = [
  'human',
  'agent',
  'lessons',
  'director',
  'migration',
  'builtin',
] as const;
export const KnowledgeSourceSchema = z
  .object({
    by: z.enum(KNOWLEDGE_SOURCES),
    node: UlidSchema.optional(),
    session: z.string().min(1).optional(),
    /** The finding (or lesson, or design paragraph) the item came out of. */
    finding: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;

/** `paths`: globs relative to the repo root; empty or absent means all paths. */
export const KnowledgePathsSchema = z.array(z.string().min(1)).max(50);

/** `<home>/knowledge/K-<ulid>.yaml` — §14.3's record. */
export const KnowledgeItemSchema = z
  .object({
    id: KnowledgeIdSchema,
    /** Short label for cards (`agile knowledge add --name`); built-ins carry their §5.4 name. */
    name: z.string().min(1).max(64).optional(),
    kind: KnowledgeKindSchema,
    text: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
    scope: KnowledgeScopeSchema,
    paths: KnowledgePathsSchema.optional(),
    enforcement: KnowledgeEnforcementSchema,
    check: KnowledgeCheckSchema.optional(),
    critical: z.boolean(),
    source: KnowledgeSourceSchema,
    status: KnowledgeStatusSchema,
    stats: RuleStatsSchema,
    created_at: z.string().min(1),
    decided_at: z.string().min(1).optional(),
    /** Who accepted or retired it (the D4 human-only trio, kept from the rule record). */
    decided_by: z.string().min(1).optional(),
  })
  .strict();
export type KnowledgeItem = z.infer<typeof KnowledgeItemSchema>;
/** Pre-validation shape: the `stats` counters and check examples default. */
export type KnowledgeItemInput = z.input<typeof KnowledgeItemSchema>;

/**
 * What a caller may supply when *proposing* an item. Everything the daemon
 * owns — `id`, `created_at`, `status`, `stats`, `decided_*` — is absent on
 * purpose. Omitted: `kind` is `standard`, `enforcement` is `tell`, and an
 * `action`/`ship` item with no `check` gets an empty classifier check.
 */
const KnowledgeProposalFields = z
  .object({
    name: z.string().min(1).max(64).optional(),
    kind: KnowledgeKindSchema.optional(),
    text: z.string().min(1).max(RULE_TEXT_MAX_CHARS),
    scope: KnowledgeScopeSchema.optional(),
    paths: KnowledgePathsSchema.optional(),
    enforcement: KnowledgeEnforcementSchema.optional(),
    check: KnowledgeCheckSchema.optional(),
    critical: z.boolean().optional(),
    source: KnowledgeSourceSchema.optional(),
  })
  .strict();

export const KnowledgeProposalSchema = KnowledgeProposalFields;
export type KnowledgeProposal = z.infer<typeof KnowledgeProposalSchema>;

/** The cockpit's create form: a proposal without `source` (the daemon stamps `human`). */
export const KnowledgeCreateInputSchema = KnowledgeProposalFields.omit({ source: true }).strict();
export type KnowledgeCreateInput = z.infer<typeof KnowledgeCreateInputSchema>;

/**
 * What a human may *edit* on an existing item: the proposal's fields minus
 * `source` (immutable), all optional. Decisions go through accept/retire.
 */
export const KnowledgePatchSchema = KnowledgeProposalFields.omit({ source: true })
  .partial()
  .strict();
export type KnowledgePatch = z.infer<typeof KnowledgePatchSchema>;

/** "Test examples": the one item whose examples to run through the classifier. */
export const KnowledgeTestInputSchema = z.object({ id: KnowledgeIdSchema }).strict();
export type KnowledgeTestInput = z.infer<typeof KnowledgeTestInputSchema>;

export function validateKnowledgeItem(input: unknown): KnowledgeItem {
  const result = KnowledgeItemSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('KnowledgeItem', result.error));
  return result.data;
}

export function validateKnowledgeProposal(input: unknown): KnowledgeProposal {
  const result = KnowledgeProposalSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('KnowledgeProposal', result.error));
  return result.data;
}

export function validateKnowledgePatch(input: unknown): KnowledgePatch {
  const result = KnowledgePatchSchema.safeParse(input);
  if (!result.success) throw new Error(formatZodError('KnowledgePatch', result.error));
  return result.data;
}

/**
 * `global` · `repo:<name>` · `project:<P-id>` · `subtree:<node id>` — the
 * one wire/CLI spelling of a scope. `stream:<id>` is read as `subtree`
 * (the old rule scope), so `agile rules … --scope stream:<id>` still works.
 */
export function parseKnowledgeScope(text: string): KnowledgeScope {
  const trimmed = text.trim();
  if (trimmed === 'global') return { kind: 'global' };
  const separator = trimmed.indexOf(':');
  const kind = separator === -1 ? trimmed : trimmed.slice(0, separator);
  const ref = separator === -1 ? '' : trimmed.slice(separator + 1).trim();
  if (ref.length > 0) {
    let candidate: unknown;
    if (kind === 'repo') candidate = { kind, repo: ref };
    else if (kind === 'project') candidate = { kind, project: ref };
    else if (kind === 'subtree' || kind === 'stream') candidate = { kind: 'subtree', node: ref };
    if (candidate !== undefined) {
      const result = KnowledgeScopeSchema.safeParse(candidate);
      if (result.success) return result.data;
    }
  }
  throw new Error(
    `invalid knowledge scope "${text}": must be "global", "repo:<name>", "project:<P-id>" or "subtree:<node id>"`,
  );
}

/** The inverse of `parseKnowledgeScope`. */
export function formatKnowledgeScope(scope: KnowledgeScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'repo':
      return `repo:${scope.repo}`;
    case 'project':
      return `project:${scope.project}`;
    case 'subtree':
      return `subtree:${scope.node}`;
  }
}

/** The classifier check of an item, when it has one. */
export function classifierCheckOf(
  item: Pick<KnowledgeItem, 'check'>,
): Extract<KnowledgeCheck, { by: 'classifier' }> | undefined {
  return item.check?.by === 'classifier' ? item.check : undefined;
}

/** The pattern of an item, when it is a pattern check. */
export function patternOf(item: Pick<KnowledgeItem, 'check'>): RulePattern | undefined {
  return item.check?.by === 'pattern' ? item.check.pattern : undefined;
}

/** The examples an item carries (a classifier check's; none otherwise). */
export function examplesOf(item: Pick<KnowledgeItem, 'check'>): RuleExample[] {
  return classifierCheckOf(item)?.examples ?? [];
}

/** Cockpit §5.1: "defaults to 'Does this action violate: <text>?'". */
export function classifierQuestion(item: Pick<KnowledgeItem, 'text' | 'check'>): string {
  return classifierCheckOf(item)?.question ?? `Does this action violate: ${item.text}?`;
}

/**
 * `action:pattern!` · `ship:classifier` · `tell` — an item's enforcement
 * and check in one cell, `!`-marked when critical (the CLI's `tier`).
 */
export function formatEnforcement(
  item: Pick<KnowledgeItem, 'enforcement' | 'check' | 'critical'>,
): string {
  const check = item.check === undefined ? '' : `:${item.check.by}`;
  return `${item.enforcement}${check}${item.critical ? '!' : ''}`;
}

/**
 * A `tell`/`review` item carries no check, so examples proposed with one
 * (the old `propose_knowledge` verb, a migrated guidance rule) are kept where the
 * human deciding it sees them: in `source.finding`, one line each. Turning
 * the item into a check later means re-entering them with `--example`.
 */
export function examplesNote(examples: readonly RuleExample[]): string | undefined {
  if (examples.length === 0) return undefined;
  return `proposed examples: ${examples
    .map((e) => `${e.violates ? 'violates' : 'allowed'}: ${e.action}`)
    .join(' | ')}`;
}

/** `finding` plus the examples note, whichever exist. */
export function withExamplesNote(
  finding: string | undefined,
  examples: readonly RuleExample[],
): string | undefined {
  const note = examplesNote(examples);
  if (note === undefined) return finding;
  return finding === undefined ? note : `${finding} · ${note}`;
}

/** Minimum examples a classifier check needs before its item may be accepted (cockpit §5.6). */
export const CLASSIFIER_MIN_EXAMPLES = 2;

/**
 * A knowledge write a principal was not allowed to make, or a record whose
 * check does not fit its enforcement. The RPC edge maps it to -32602.
 */
export class KnowledgeWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeWriteError';
  }
}

/** Who may write a knowledge record — the same three principals as a stream (§2.2). */
export type KnowledgePrincipal = 'agent' | 'human' | 'daemon';

function changed(before: unknown, after: unknown): boolean {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null);
}

const HUMAN_ONLY_FIELDS = ['status', 'decided_at', 'decided_by'] as const;

/**
 * The principal split (D4), enforced on every write: an `agent` may create
 * only a `proposed` item and never change `status`/`decided_*`; nothing
 * may change an item's `id`. `before` is `undefined` for a create.
 */
export function assertKnowledgeWrite(
  principal: KnowledgePrincipal,
  before: KnowledgeItem | undefined,
  after: KnowledgeItem,
): KnowledgeItem {
  if (before !== undefined && before.id !== after.id) {
    throw new KnowledgeWriteError(
      `invalid KnowledgeItem write: id ${before.id} may not change to ${after.id}`,
    );
  }
  if (principal !== 'agent') return after;
  if (before === undefined) {
    if (after.status !== 'proposed') {
      throw new KnowledgeWriteError(
        `invalid KnowledgeItem write: an agent principal may only create a proposed item, not "${after.status}"`,
      );
    }
    if (after.decided_at !== undefined || after.decided_by !== undefined) {
      throw new KnowledgeWriteError(
        'invalid KnowledgeItem write: decided_at/decided_by are human-only fields (D4)',
      );
    }
    return after;
  }
  for (const field of HUMAN_ONLY_FIELDS) {
    if (changed(before[field], after[field])) {
      throw new KnowledgeWriteError(
        `invalid KnowledgeItem write: an agent principal may not change ${field} (human-only, D4)`,
      );
    }
  }
  return after;
}

/**
 * §14.3's check invariants, on every write so a malformed record never
 * reaches disk:
 *  - `action` and `ship` need a `check`; `tell` and `review` may not carry one;
 *  - a `pattern` check is an `action` check only;
 *  - an **accepted** classifier check has at least two examples (cockpit
 *    §5.6). A proposed one with fewer is fine; it just cannot be accepted.
 */
export function assertKnowledgeAcceptable(item: KnowledgeItem): KnowledgeItem {
  const needsCheck = item.enforcement === 'action' || item.enforcement === 'ship';
  if (needsCheck && item.check === undefined) {
    throw new KnowledgeWriteError(
      `invalid KnowledgeItem ${item.id}: an ${item.enforcement} item needs a check (a pattern or a classifier question with examples)`,
    );
  }
  if (!needsCheck && item.check !== undefined) {
    throw new KnowledgeWriteError(
      `invalid KnowledgeItem ${item.id}: a ${item.enforcement} item carries no check`,
    );
  }
  if (item.check?.by === 'pattern' && item.enforcement !== 'action') {
    throw new KnowledgeWriteError(
      `invalid KnowledgeItem ${item.id}: a pattern check is an action check only`,
    );
  }
  const examples = examplesOf(item);
  if (
    item.check?.by === 'classifier' &&
    item.status === 'accepted' &&
    examples.length < CLASSIFIER_MIN_EXAMPLES
  ) {
    throw new KnowledgeWriteError(
      `invalid KnowledgeItem ${item.id}: a classifier check needs at least ${CLASSIFIER_MIN_EXAMPLES} examples before it can be accepted (§5.6); it has ${examples.length}`,
    );
  }
  return item;
}
