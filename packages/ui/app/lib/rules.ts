/**
 * T163: the rules screen's pure half (cockpit design §5, §9) — the filter,
 * the pruning sort, and turning the edit form into a `RulePatch`. Plain
 * `bun test`, no DOM.
 */

import {
  DEFAULT_CLASSIFIER_TIMEOUT_MS,
  RULE_STATUSES,
  type Rule,
  type RuleCriteria,
  type RuleEnforcement,
  type RuleExample,
  type RulePatch,
  type RuleStage,
  type RuleStatus,
  formatRuleScope,
} from '@agile-agents/shared';
import type { RuleReportRow } from './feed-types';

/** What the rules screen shows. `source` is a `provenance.by` — the inbox's seed card sets it. */
export interface RulesFilter {
  status: RuleStatus | 'all';
  /** A `formatRuleScope` value, or `all`. */
  scope: string;
  source?: string;
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
      (filter.source === undefined || rule.provenance.by === filter.source),
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
  examples: RuleExample[];
}

export function draftOf(rule: Rule): RuleDraft {
  return {
    text: rule.text,
    question: rule.question ?? '',
    criteriaTrue: rule.criteria?.true ?? '',
    criteriaFalse: rule.criteria?.false ?? '',
    enforcement: rule.enforcement,
    stage: rule.stage,
    examples: rule.examples.map((example) => ({ ...example })),
  };
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
  const criteria: RuleCriteria | undefined =
    whenTrue.length > 0 ? { true: whenTrue, false: whenFalse } : undefined;
  return {
    patch: {
      text,
      ...(question.length > 0 ? { question } : {}),
      ...(criteria ? { criteria } : {}),
      enforcement: draft.enforcement,
      stage: draft.stage,
      examples,
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
