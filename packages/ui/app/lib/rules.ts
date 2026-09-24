/**
 * T163: the rules screen's pure half (cockpit design §5, §9) — the filter,
 * the pruning sort, and turning the edit form into a `RulePatch`. Plain
 * `bun test`, no DOM.
 */

import {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  RULE_EXAMPLES_MAX,
  RULE_STATUSES,
  type Rule,
  type RuleCreateInput,
  type RuleCriteria,
  type RuleEnforcement,
  type RuleExample,
  type RulePatch,
  type RulePattern,
  type RulePatternKind,
  type RuleStage,
  type RuleStatus,
  formatRuleScope,
  parseRuleScope,
  rulePatternArgs,
  rulePatternFromArgs,
} from '@agile-agents/shared';
import type { RuleReportRow } from './feed-types';

/** What the rules screen shows. `source` is a `provenance.by` — the inbox's seed card sets it. */
export interface RulesFilter {
  status: RuleStatus | 'all';
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
      (filter.scope === 'all' || formatRuleScope(rule.scope) === filter.scope) &&
      (filter.source === undefined || rule.provenance.by === filter.source) &&
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
  text: string;
  question: string;
  criteriaTrue: string;
  criteriaFalse: string;
  enforcement: RuleEnforcement;
  stage: RuleStage;
  /** T167: the pattern's kind, or `''` for none. */
  patternKind: RulePatternKind | '';
  /** T167: its arguments, one per line (globs for `path_deny`, tokens for `command_deny`). */
  patternArgs: string;
  examples: RuleExample[];
  /** T167, "New rule" only: `global` · `repo:<name>` · `stream:<id>`. */
  scope: string;
  /** T167, "New rule" only. */
  critical: boolean;
}

export function draftOf(rule: Rule): RuleDraft {
  return {
    text: rule.text,
    question: rule.question ?? '',
    criteriaTrue: rule.criteria?.true ?? '',
    criteriaFalse: rule.criteria?.false ?? '',
    enforcement: rule.enforcement,
    stage: rule.stage,
    patternKind: rule.pattern?.kind ?? '',
    patternArgs: rule.pattern ? rulePatternArgs(rule.pattern).join('\n') : '',
    examples: rule.examples.map((example) => ({ ...example })),
    scope: formatRuleScope(rule.scope),
    critical: rule.critical,
  };
}

/** T167: the "New rule" form's starting point. */
export function emptyDraft(): RuleDraft {
  return {
    text: '',
    question: '',
    criteriaTrue: '',
    criteriaFalse: '',
    enforcement: 'guidance',
    stage: 'action',
    patternKind: '',
    patternArgs: '',
    examples: [],
    scope: 'global',
    critical: false,
  };
}

function patternOf(draft: RuleDraft): { pattern?: RulePattern } | { error: string } {
  if (draft.patternKind === '') {
    if (draft.enforcement === 'pattern') {
      return { error: 'a pattern rule needs a pattern: pick its kind' };
    }
    return {};
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
  return {
    patch: {
      text,
      ...(question.length > 0 ? { question } : {}),
      ...(criteria ? { criteria } : {}),
      enforcement: draft.enforcement,
      stage: draft.stage,
      ...(pattern.pattern ? { pattern: pattern.pattern } : {}),
      examples,
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
