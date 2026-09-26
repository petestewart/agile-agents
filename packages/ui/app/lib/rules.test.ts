/**
 * T163: the rules screen's filter, pruning sort and edit patch. Plain
 * `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import { type KnowledgeItem as Rule, validateKnowledgePatch } from '@agile-agents/shared';
import type { RuleReportRow } from './feed-types';
import {
  DEFAULT_RULES_FILTER,
  draftOf,
  evalDeadlineMs,
  filterRules,
  formatFiredAt,
  patchOf,
  ruleScopes,
  sortRules,
} from './rules';

function rule(id: string, over: Partial<Rule> = {}): Rule {
  return {
    id,
    kind: 'standard',
    text: `rule ${id}`,
    scope: { kind: 'global' },
    status: 'proposed',
    enforcement: 'tell',
    critical: false,
    source: { by: 'human' },
    stats: { fired: 0, violated: 0, routed: 0 },
    created_at: '2026-09-23T00:00:00.000Z',
    ...over,
  };
}

function row(id: string): RuleReportRow {
  return {
    id,
    tier: 'tell',
    status: 'accepted',
    fired: 0,
    violated: 0,
    routed: 0,
    flag: '-',
    flag_detail: '-',
  };
}

describe('filterRules', () => {
  const rules = [
    rule('R-1', { source: { by: 'migration' } }),
    rule('R-2', { status: 'accepted', scope: { kind: 'repo', repo: 'demo' } }),
    rule('R-3', { source: { by: 'migration' }, status: 'retired' }),
  ];

  test('the default shows everything', () => {
    expect(filterRules(rules, DEFAULT_RULES_FILTER).map((r) => r.id)).toEqual([
      'R-1',
      'R-2',
      'R-3',
    ]);
  });

  test('status, scope and source narrow it', () => {
    expect(filterRules(rules, { status: 'accepted', scope: 'all' }).map((r) => r.id)).toEqual([
      'R-2',
    ]);
    expect(filterRules(rules, { status: 'all', scope: 'repo:demo' }).map((r) => r.id)).toEqual([
      'R-2',
    ]);
    expect(
      filterRules(rules, { status: 'proposed', scope: 'all', source: 'migration' }).map(
        (r) => r.id,
      ),
    ).toEqual(['R-1']);
    expect(ruleScopes(rules)).toEqual(['global', 'repo:demo']);
  });
});

test('sortRules keeps the report order, or puts the most routed first', () => {
  const rules = [
    rule('R-1', { stats: { fired: 9, violated: 0, routed: 1 } }),
    rule('R-2', { stats: { fired: 9, violated: 0, routed: 5 } }),
    rule('R-3'),
  ];
  const rows = [row('R-3'), row('R-1'), row('R-2')];
  expect(sortRules(rules, rows, 'report').map((r) => r.id)).toEqual(['R-3', 'R-1', 'R-2']);
  expect(sortRules(rules, rows, 'routed').map((r) => r.id)).toEqual(['R-2', 'R-1', 'R-3']);
});

describe('patchOf', () => {
  test('a draft round-trips into a patch the strict schema takes', () => {
    const draft = draftOf(
      rule('R-1', {
        enforcement: 'ship',
        check: {
          by: 'classifier',
          question: 'Does this add a dependency?',
          criteria: { true: 'adds one', false: 'does not' },
          examples: [{ action: 'bun add x', violates: true }],
        },
      }),
    );
    const built = patchOf({
      ...draft,
      examples: [...draft.examples, { action: '  ', violates: false }],
    });
    if ('error' in built) throw new Error(built.error);
    expect(validateKnowledgePatch(built.patch)).toEqual(built.patch);
    expect(built.patch.check).toEqual({
      by: 'classifier',
      question: 'Does this add a dependency?',
      criteria: { true: 'adds one', false: 'does not' },
      // Blank example rows are dropped.
      examples: [{ action: 'bun add x', violates: true }],
    });
  });

  test('an empty question is left out; half the criteria is refused', () => {
    const draft = draftOf(rule('R-1'));
    const built = patchOf(draft);
    if ('error' in built) throw new Error(built.error);
    // A tell item carries no check at all.
    expect('check' in built.patch).toBe(false);
    const ship = patchOf({ ...draft, enforcement: 'ship' });
    if ('error' in ship) throw new Error(ship.error);
    expect(ship.patch.check).toEqual({ by: 'classifier', examples: [] });
    expect(patchOf({ ...draft, enforcement: 'ship', patternKind: 'no_push' })).toEqual({
      error: 'a pattern check is an action check only',
    });
    expect(patchOf({ ...draft, criteriaTrue: 'yes' })).toEqual({
      error: 'criteria need both halves: what yes means and what no means',
    });
    expect(patchOf({ ...draft, text: ' ' })).toEqual({ error: 'the rule needs its text' });
  });
});

test('evalDeadlineMs scales with the examples', () => {
  expect(evalDeadlineMs(3, 1000)).toBe(13_000);
  expect(evalDeadlineMs(0, 1000)).toBe(11_000);
});

describe('T169', () => {
  test('a rule filter shows that one rule', () => {
    const rules = [rule('R-1'), rule('R-2')];
    expect(filterRules(rules, { ...DEFAULT_RULES_FILTER, rule: 'R-2' }).map((r) => r.id)).toEqual([
      'R-2',
    ]);
  });

  test('last fired shows date and minute', () => {
    expect(formatFiredAt('2026-09-23T14:02:33.123Z')).toBe('2026-09-23 14:02');
  });
});
