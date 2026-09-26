/**
 * T163: the rules screen's pure half (cockpit design §5, §9) — the filter,
 * the pruning sort, and turning the edit form into a `RulePatch`. Plain
 * `bun test`, no DOM.
 */

import {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  type KnowledgeCheck,
  type KnowledgeKind,
  RULE_EXAMPLES_MAX,
  KNOWLEDGE_STATUSES as RULE_STATUSES,
  type KnowledgeItem as Rule,
  type KnowledgeCreateInput as RuleCreateInput,
  type RuleCriteria,
  type KnowledgeEnforcement as RuleEnforcement,
  type RuleExample,
  type KnowledgePatch as RulePatch,
  type RulePattern,
  type RulePatternKind,
  type KnowledgeStatus as RuleStatus,
  classifierCheckOf,
  examplesOf,
  formatKnowledgeScope as formatRuleScope,
  patternOf as itemPattern,
  parseKnowledgeScope as parseRuleScope,
  rulePatternArgs,
  rulePatternFromArgs,
} from '@agile-agents/shared';
import type { CockpitFrame, RuleReportRow } from './feed-types';

/** What the rules screen shows. `source` is a `source.by` — the inbox's migration card sets it. */
export interface RulesFilter {
  status: RuleStatus | 'all';
  /** T266: standard · architecture · decision, or `all`. */
  kind?: KnowledgeKind | 'all';
  /** T266: tell · review · action · ship, or `all`. */
  enforcement?: RuleEnforcement | 'all';
  /** A `formatRuleScope` value, or `all`. */
  scope: string;
  source?: string;
  /** T169: one rule by id — a "blocked by rule" card on the stream page opens the screen on it. */
  rule?: string;
}

export const DEFAULT_RULES_FILTER: RulesFilter = { status: 'all', scope: 'all' };

export const RULE_STATUS_FILTERS: ReadonlyArray<RuleStatus | 'all'> = ['all', ...RULE_STATUSES];

/** §5.7's two pruning orders beside the report's own (flagged first, then most fired). */
export type RulesSort = 'report' | 'routed';

export function filterRules(rules: readonly Rule[], filter: RulesFilter): Rule[] {
  return rules.filter(
    (rule) =>
      (filter.status === 'all' || rule.status === filter.status) &&
      (filter.kind === undefined || filter.kind === 'all' || rule.kind === filter.kind) &&
      (filter.enforcement === undefined ||
        filter.enforcement === 'all' ||
        rule.enforcement === filter.enforcement) &&
      (filter.scope === 'all' || formatRuleScope(rule.scope) === filter.scope) &&
      (filter.source === undefined || rule.source.by === filter.source) &&
      (filter.rule === undefined || rule.id === filter.rule),
  );
}

/** Every scope the rules name, for the scope filter. */
export function ruleScopes(rules: readonly Rule[]): string[] {
  return [...new Set(rules.map((rule) => formatRuleScope(rule.scope)))].sort();
}

/**
 * The report's order (flagged first, then fired), or "most routed" — the
 * rules the human keeps being asked about, which are the ones whose wording
 * most needs work (D14). Rules the report does not know sort last.
 */
export function sortRules(
  rules: readonly Rule[],
  rows: readonly RuleReportRow[],
  sort: RulesSort,
): Rule[] {
  const rank = new Map(rows.map((row, index) => [row.id, index]));
  const byReport = (a: Rule, b: Rule): number =>
    (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  return [...rules].sort((a, b) =>
    sort === 'routed' ? b.stats.routed - a.stats.routed || byReport(a, b) : byReport(a, b),
  );
}

/** The edit form's fields, as typed. */
export interface RuleDraft {
  /** T338: the item's short name (≤ 64); empty leaves it unnamed (or unchanged on an edit). */
  name: string;
  text: string;
  question: string;
  criteriaTrue: string;
  criteriaFalse: string;
  /** T260: standard · architecture · decision. */
  kind: KnowledgeKind;
  enforcement: RuleEnforcement;
  /** T167: the pattern's kind, or `''` for none. */
  patternKind: RulePatternKind | '';
  /** T167: its arguments, one per line (globs for `path_deny`, tokens for `command_deny`). */
  patternArgs: string;
  examples: RuleExample[];
  /** T266: the item's path globs, one per line; empty means all paths. */
  paths: string;
  /** T167, "New rule" only: `global` · `repo:<name>` · `project:<id>` · `subtree:<id>`. */
  scope: string;
  /** T167, "New rule" only. */
  critical: boolean;
}

export function draftOf(rule: Rule): RuleDraft {
  const classifier = classifierCheckOf(rule);
  const pattern = itemPattern(rule);
  return {
    name: rule.name ?? '',
    text: rule.text,
    question: classifier?.question ?? '',
    criteriaTrue: classifier?.criteria?.true ?? '',
    criteriaFalse: classifier?.criteria?.false ?? '',
    kind: rule.kind,
    enforcement: rule.enforcement,
    patternKind: pattern?.kind ?? '',
    patternArgs: pattern ? rulePatternArgs(pattern).join('\n') : '',
    examples: examplesOf(rule).map((example) => ({ ...example })),
    paths: (rule.paths ?? []).join('\n'),
    scope: formatRuleScope(rule.scope),
    critical: rule.critical,
  };
}

/** T167: the "New rule" form's starting point. */
export function emptyDraft(): RuleDraft {
  return {
    name: '',
    text: '',
    question: '',
    criteriaTrue: '',
    criteriaFalse: '',
    kind: 'standard',
    enforcement: 'tell',
    patternKind: '',
    patternArgs: '',
    examples: [],
    paths: '',
    scope: 'global',
    critical: false,
  };
}

function patternOf(draft: RuleDraft): { pattern?: RulePattern } | { error: string } {
  if (draft.patternKind === '') return {};
  if (draft.enforcement !== 'action') {
    return { error: 'a pattern check is an action check only' };
  }
  try {
    return { pattern: rulePatternFromArgs(draft.patternKind, draft.patternArgs.split('\n')) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The patch `rule.update` gets, or the reason there is none. An empty
 * question or pair of criteria is left out (the patch cannot clear a field),
 * and criteria are both-or-neither, as the schema requires.
 */
export function patchOf(draft: RuleDraft): { patch: RulePatch } | { error: string } {
  const text = draft.text.trim();
  if (text.length === 0) return { error: 'the rule needs its text' };
  const question = draft.question.trim();
  const whenTrue = draft.criteriaTrue.trim();
  const whenFalse = draft.criteriaFalse.trim();
  if ((whenTrue.length === 0) !== (whenFalse.length === 0)) {
    return { error: 'criteria need both halves: what yes means and what no means' };
  }
  const examples = draft.examples
    .map((example) => ({ action: example.action.trim(), violates: example.violates }))
    .filter((example) => example.action.length > 0);
  if (examples.length > RULE_EXAMPLES_MAX) {
    return { error: `a rule carries at most ${RULE_EXAMPLES_MAX} examples` };
  }
  const pattern = patternOf(draft);
  if ('error' in pattern) return pattern;
  const criteria: RuleCriteria | undefined =
    whenTrue.length > 0 ? { true: whenTrue, false: whenFalse } : undefined;
  // §14.3: `action`/`ship` carry a check (the pattern, else a classifier
  // question with its examples); `tell`/`review` carry none.
  const checked = draft.enforcement === 'action' || draft.enforcement === 'ship';
  const check: KnowledgeCheck | undefined = !checked
    ? undefined
    : pattern.pattern
      ? { by: 'pattern', pattern: pattern.pattern }
      : {
          by: 'classifier',
          ...(question.length > 0 ? { question } : {}),
          ...(criteria ? { criteria } : {}),
          examples,
        };
  const paths = draft.paths
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const name = draft.name.trim();
  return {
    patch: {
      ...(name.length > 0 ? { name } : {}),
      text,
      kind: draft.kind,
      paths,
      enforcement: draft.enforcement,
      ...(check ? { check } : {}),
    },
  };
}

/** T167: the "New rule" form's `POST /api/rules` body — the patch plus scope and criticality. */
export function createOf(draft: RuleDraft): { input: RuleCreateInput } | { error: string } {
  const built = patchOf(draft);
  if ('error' in built) return built;
  let scope: RuleCreateInput['scope'];
  try {
    scope = parseRuleScope(draft.scope);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  const { text, ...rest } = built.patch;
  return {
    input: {
      text: text ?? draft.text.trim(),
      ...rest,
      scope,
      ...(draft.critical ? { critical: true } : {}),
    },
  };
}

/** T338: one choice of the "New rule" scope picker: the wire spelling and what it reads as. */
export interface ScopeChoice {
  value: string;
  label: string;
}

/** T338: every scope a new item can take, named: global, each repo, each project, each node. */
export function scopeChoices(
  cockpit: Pick<CockpitFrame, 'streams' | 'projects' | 'repos'> | undefined,
): ScopeChoice[] {
  return [
    { value: 'global', label: 'Global' },
    ...(cockpit?.repos ?? []).map((r) => ({ value: `repo:${r.name}`, label: `Repo: ${r.name}` })),
    ...(cockpit?.projects ?? []).map((p) => ({
      value: `project:${p.id}`,
      label: `Project: ${p.name}`,
    })),
    ...(cockpit?.streams ?? []).map((s) => ({
      value: `subtree:${s.id}`,
      label: `Node and below: ${s.title}`,
    })),
  ];
}

/**
 * How long "Test examples" waits: one classifier call per example (T155),
 * each up to the classifier's timeout, plus slack for the round trip.
 */
export function evalDeadlineMs(examples: number, timeoutMs?: number): number {
  return Math.max(1, examples) * (timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS) + 10_000;
}

/** T169: "2026-09-23 14:02" (UTC) — the date alone hid whether a rule fired a minute or a day ago. */
export function formatFiredAt(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}
