/**
 * T163, T366: the Knowledge screen's filter, sections, words and edit
 * patch. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import { type KnowledgeItem as Rule, validateKnowledgePatch } from '@agile-agents/shared';
import type { RuleReportRow } from './feed-types';
import {
  DEFAULT_RULES_FILTER,
  acceptBlocker,
  bandWords,
  categoryOf,
  createOf,
  draftCheck,
  draftOf,
  emptyDraft,
  evalDeadlineMs,
  evalSummary,
  examplesShort,
  filterRules,
  flagWords,
  formatFiredAt,
  isNarrowed,
  patchOf,
  patternSentence,
  patternWords,
  plainError,
  plainFinding,
  plainText,
  ruleScopes,
  scopeChoices,
  scopeWords,
  sectionOf,
  sectionsFor,
  sortRules,
  sourceFilterWords,
  sourceWords,
  statsWords,
  summaryOf,
  tabCounts,
  tabOf,
  titleOf,
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

const NODE = '01J8Z3K4M5N6P7Q8R9S0T1V2W3';
const NAMES = {
  projects: [{ id: `P-${NODE}`, name: 'Shop', root: NODE }],
  streams: [
    {
      id: NODE,
      title: 'Checkout',
      role: 'work' as const,
      agent_status: 'idle' as const,
      human_status: 'open' as const,
    },
  ],
};

describe('filterRules', () => {
  const rules = [
    rule('R-1', { source: { by: 'migration' } }),
    rule('R-2', {
      status: 'accepted',
      scope: { kind: 'repo', repo: 'demo' },
      name: 'money',
      text: 'store **cents**',
    }),
    rule('R-3', { source: { by: 'migration' }, status: 'retired', enforcement: 'action' }),
  ];

  test('the default keeps everything; the tab and status split it later', () => {
    expect(filterRules(rules, DEFAULT_RULES_FILTER).map((r) => r.id)).toEqual([
      'R-1',
      'R-2',
      'R-3',
    ]);
  });

  test('scope, source, enforcement and words narrow it', () => {
    expect(filterRules(rules, { status: 'all', scope: 'repo:demo' }).map((r) => r.id)).toEqual([
      'R-2',
    ]);
    expect(
      filterRules(rules, { status: 'proposed', scope: 'all', source: 'migration' }).map(
        (r) => r.id,
      ),
    ).toEqual(['R-1', 'R-3']);
    expect(
      filterRules(rules, { status: 'all', scope: 'all', enforcement: 'action' }).map((r) => r.id),
    ).toEqual(['R-3']);
    // Every word must appear, in the name or the text, any case.
    expect(filterRules(rules, { status: 'all', scope: 'all', query: 'MONEY cents' })).toHaveLength(
      1,
    );
    expect(filterRules(rules, { status: 'all', scope: 'all', query: 'money dollars' })).toEqual([]);
    expect(ruleScopes(rules)).toEqual(['global', 'repo:demo']);
  });

  test('isNarrowed says whether anything beyond the tab narrows the list', () => {
    expect(isNarrowed(DEFAULT_RULES_FILTER)).toBe(false);
    expect(isNarrowed({ ...DEFAULT_RULES_FILTER, tab: 'rules' })).toBe(false);
    expect(isNarrowed({ ...DEFAULT_RULES_FILTER, query: '  ' })).toBe(false);
    expect(isNarrowed({ ...DEFAULT_RULES_FILTER, query: 'x' })).toBe(true);
    expect(isNarrowed({ ...DEFAULT_RULES_FILTER, source: 'agent' })).toBe(true);
    expect(isNarrowed({ ...DEFAULT_RULES_FILTER, enforcement: 'all' })).toBe(false);
  });
});

describe('T366: sections and tabs', () => {
  const items = [
    rule('K-1'), // proposed standard
    rule('K-2', { status: 'accepted', enforcement: 'action', kind: 'decision' }),
    rule('K-3', { status: 'accepted', enforcement: 'ship' }),
    rule('K-4', { status: 'accepted' }),
    rule('K-5', { status: 'accepted', kind: 'architecture', enforcement: 'review' }),
    rule('K-6', { status: 'accepted', kind: 'decision' }),
    rule('K-7', { status: 'retired', enforcement: 'action' }),
    rule('K-8', { status: 'retired', kind: 'decision' }),
    rule('K-9', { enforcement: 'action' }), // proposed rule
  ];

  test('a rule is an enforced item whatever its kind; the rest go by kind', () => {
    expect(categoryOf(rule('x', { enforcement: 'action', kind: 'decision' }))).toBe('rules');
    expect(categoryOf(rule('x', { enforcement: 'ship' }))).toBe('rules');
    expect(categoryOf(rule('x', { enforcement: 'review', kind: 'architecture' }))).toBe(
      'architecture',
    );
    expect(categoryOf(rule('x', { enforcement: 'tell', kind: 'decision' }))).toBe('decision');
    expect(sectionOf(rule('x'))).toBe('review');
    expect(sectionOf(rule('x', { status: 'retired', enforcement: 'ship' }))).toBe('retired');
    expect(sectionOf(rule('x', { status: 'accepted', enforcement: 'ship' }))).toBe('rules');
  });

  test('All shows every section in order: To review first, Retired last', () => {
    const sections = sectionsFor(items, 'all');
    expect(sections.map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ['review', ['K-1', 'K-9']],
      ['rules', ['K-2', 'K-3']],
      ['standard', ['K-4']],
      ['architecture', ['K-5']],
      ['decision', ['K-6']],
      ['retired', ['K-7', 'K-8']],
    ]);
  });

  test('To review is the proposals alone; a category keeps its own proposals and retired items', () => {
    expect(sectionsFor(items, 'review').map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ['review', ['K-1', 'K-9']],
    ]);
    expect(sectionsFor(items, 'rules').map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ['review', ['K-9']],
      ['rules', ['K-2', 'K-3']],
      ['retired', ['K-7']],
    ]);
    expect(sectionsFor(items, 'decision').map((s) => [s.id, s.items.map((i) => i.id)])).toEqual([
      ['review', []],
      ['decision', ['K-6']],
      ['retired', ['K-8']],
    ]);
  });

  test('tab counts: proposals for To review, accepted items for the rest', () => {
    expect(tabCounts(items)).toEqual({
      all: 5,
      review: 2,
      rules: 2,
      standard: 1,
      architecture: 1,
      decision: 1,
    });
  });

  test('the inbox opens To review; an explicit tab wins', () => {
    expect(tabOf(DEFAULT_RULES_FILTER)).toBe('all');
    expect(tabOf({ status: 'proposed', scope: 'all', source: 'migration' })).toBe('review');
    expect(tabOf({ status: 'proposed', scope: 'all', tab: 'rules' })).toBe('rules');
    expect(tabOf({ status: 'retired', scope: 'all' })).toBe('all');
  });
});

describe('T366: words', () => {
  test('scopes read as places, by name', () => {
    expect(scopeWords({ kind: 'global' }, NAMES)).toBe('Everywhere');
    expect(scopeWords({ kind: 'repo', repo: 'ledger-lite' }, NAMES)).toBe('Repo ledger-lite');
    expect(scopeWords({ kind: 'project', project: `P-${NODE}` }, NAMES)).toBe('Project Shop');
    expect(scopeWords({ kind: 'subtree', node: NODE }, NAMES)).toBe('“Checkout” and below');
    // An id the cockpit does not know is never printed.
    expect(scopeWords({ kind: 'project', project: `P-${NODE}` }, undefined)).toBe('A project');
    expect(scopeWords({ kind: 'subtree', node: NODE }, undefined)).toBe('A node and below');
  });

  test('sources read as who proposed it', () => {
    expect(sourceWords({ by: 'human' }, NAMES)).toBe('Added by you');
    expect(sourceWords({ by: 'agent', node: NODE }, NAMES)).toBe(
      'Proposed by the agent on “Checkout”',
    );
    expect(sourceWords({ by: 'agent' }, NAMES)).toBe('Proposed by an agent');
    expect(sourceWords({ by: 'builtin' }, NAMES)).toBe('Built in');
    expect(sourceWords({ by: 'migration' }, NAMES)).toBe('Imported from the old rules');
    expect(sourceFilterWords('migration')).toBe('Showing items imported from the old rules');
    expect(sourceFilterWords('agent')).toBe('Showing items agents proposed');
    expect(sourceFilterWords('seed-x')).toBe('Showing items from seed-x');
  });

  test('patterns read as what they block', () => {
    expect(
      patternWords({ kind: 'command_deny', args: { patterns: ['rm -rf', 'git reset --hard'] } }),
    ).toEqual({ lead: 'Blocks commands matching', args: ['rm -rf', 'git reset --hard'] });
    expect(
      patternSentence({ kind: 'command_deny', args: { patterns: ['rm -rf', 'git reset --hard'] } }),
    ).toBe('Blocks commands matching "rm -rf", "git reset --hard"');
    expect(patternSentence({ kind: 'path_deny', args: { globs: [] } })).toBe(
      "Blocks writes outside the node's own worktree.",
    );
    expect(patternWords({ kind: 'path_deny', args: { globs: ['secrets/**'] } }).args).toEqual([
      'secrets/**',
    ]);
    expect(patternSentence({ kind: 'no_push', args: {} })).toBe('Blocks every git push.');
  });

  test('bands, eval summaries, stats and flags in words', () => {
    expect(bandWords('deny')).toBe('Block');
    expect(bandWords('route')).toBe('Ask you');
    expect(bandWords('allow')).toBe('Allow');
    expect(bandWords(undefined)).toBe('No answer');
    expect(evalSummary({ agreed: 2, total: 3, errors: 0 })).toBe('2 of 3 examples agree');
    expect(evalSummary({ agreed: 0, total: 1, errors: 1 })).toBe('0 of 1 example agree · 1 error');
    expect(statsWords({ fired: 1412, violated: 1, routed: 0 })).toBe('1,412 checks · 1 violation');
    expect(statsWords({ fired: 0, violated: 0, routed: 0 })).toBe('Not fired yet');
    expect(flagWords('never fired', 14)).toBe(
      'Never fired in 14 days: it may no longer be needed.',
    );
    expect(flagWords('-', 14)).toBeUndefined();
  });

  test('a title is the name, else the first sentence; markdown is plain', () => {
    expect(plainText('Use `bun test`, **never** [jest](http://x).\n\n- one')).toBe(
      'Use bun test, never jest. one',
    );
    const named = rule('x', { name: 'money', text: 'Store `cents`. Always.' });
    expect(titleOf(named)).toBe('money');
    expect(summaryOf(named)).toBe('Store cents. Always.');
    const unnamed = rule('x', { text: 'Store cents. Convert at the edges.' });
    expect(titleOf(unnamed)).toBe('Store cents.');
    expect(summaryOf(unnamed)).toBe('Convert at the edges.');
    expect(titleOf(rule('x', { text: 'a'.repeat(200) }))).toHaveLength(118);
  });

  test('findings and refusals lose their design references', () => {
    expect(
      plainFinding(
        'cockpit design §5.4, D8: this is the one action an agent can take that a human cannot cheaply undo',
      ),
    ).toBe('This is the one action an agent can take that a human cannot cheaply undo');
    expect(
      plainError(
        'invalid KnowledgeItem K-01J8Z3K4M5N6P7Q8R9S0T1V2W3: a classifier check needs at least 2 examples before it can be accepted (§5.6); it has 1',
      ),
    ).toBe('A classifier check needs at least 2 examples before it can be accepted; it has 1');
    expect(plainError('no answer within 12 s')).toBe('No answer within 12 s');
  });

  test('a classifier check with fewer than two examples cannot be accepted yet', () => {
    const one = rule('x', {
      enforcement: 'action',
      check: { by: 'classifier', examples: [{ action: 'a', violates: true }] },
    });
    expect(acceptBlocker(one)).toContain('one more example');
    expect(acceptBlocker({ ...one, check: { by: 'classifier', examples: [] } })).toContain(
      'two examples',
    );
    expect(acceptBlocker(rule('x'))).toBeUndefined();
    expect(
      acceptBlocker({
        ...one,
        check: {
          by: 'classifier',
          examples: [
            { action: 'a', violates: true },
            { action: 'b', violates: false },
          ],
        },
      }),
    ).toBeUndefined();
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
    const item = rule('R-1', {
      enforcement: 'ship',
      check: {
        by: 'classifier',
        question: 'Does this add a dependency?',
        criteria: { true: 'adds one', false: 'does not' },
        examples: [{ action: 'bun add x', violates: true }],
      },
    });
    const draft = draftOf(item);
    const built = patchOf(
      { ...draft, examples: [...draft.examples, { action: '  ', violates: false }] },
      item,
    );
    if ('error' in built) throw new Error(built.error);
    expect(validateKnowledgePatch(built.patch)).toEqual(built.patch);
    expect(built.patch.check).toEqual({
      by: 'classifier',
      question: 'Does this add a dependency?',
      criteria: { true: 'adds one', false: 'does not' },
      // Blank example rows are dropped.
      examples: [{ action: 'bun add x', violates: true }],
    });
    // Unchanged scope and criticality are not sent on an edit.
    expect('scope' in built.patch).toBe(false);
    expect('critical' in built.patch).toBe(false);
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
    expect(patchOf({ ...draft, enforcement: 'ship', criteriaTrue: 'yes' })).toEqual({
      error: 'Criteria need both halves: what yes means and what no means.',
    });
    expect(patchOf({ ...draft, text: ' ' })).toEqual({
      error: 'Write what agents should know: the text is empty.',
    });
  });

  test('T366: only the fields that apply are sent', () => {
    const draft = { ...emptyDraft(), text: 'no wipes' };
    // A pattern is an action check only: on a ship item the classifier checks.
    const ship = patchOf({
      ...draft,
      enforcement: 'ship',
      checkBy: 'pattern',
      patternKind: 'no_push',
    });
    if ('error' in ship) throw new Error(ship.error);
    expect(ship.patch.check?.by).toBe('classifier');
    const action = patchOf({
      ...draft,
      enforcement: 'action',
      checkBy: 'pattern',
      patternKind: 'command_deny',
      patternArgs: 'rm -rf\n\ngit reset --hard\n',
    });
    if ('error' in action) throw new Error(action.error);
    expect(action.patch.check).toEqual({
      by: 'pattern',
      pattern: { kind: 'command_deny', args: { patterns: ['rm -rf', 'git reset --hard'] } },
    });
    expect(
      patchOf({ ...draft, enforcement: 'action', checkBy: 'pattern', patternKind: 'command_deny' }),
    ).toEqual({ error: 'List at least one command to block, one per line.' });
    // Criteria typed for a pattern check (then hidden) do not block the save.
    expect(
      'patch' in
        patchOf({
          ...draft,
          enforcement: 'action',
          checkBy: 'pattern',
          patternKind: 'no_push',
          criteriaTrue: 'x',
        }),
    ).toBe(true);
    // Critical is the fail policy of a check: never sent for guidance.
    const tell = patchOf({ ...draft, critical: true });
    expect('patch' in tell && 'critical' in tell.patch).toBe(false);
    expect(draftCheck({ enforcement: 'action', checkBy: 'pattern' })).toEqual({
      checked: true,
      pattern: true,
      classifier: false,
    });
    expect(draftCheck({ enforcement: 'ship', checkBy: 'pattern' })).toEqual({
      checked: true,
      pattern: false,
      classifier: true,
    });
  });

  test('T366: an edit sends a changed scope or criticality', () => {
    const item = rule('R-1', { enforcement: 'action', check: { by: 'classifier', examples: [] } });
    const built = patchOf({ ...draftOf(item), scope: 'repo:api', critical: true }, item);
    if ('error' in built) throw new Error(built.error);
    expect(built.patch.scope).toEqual({ kind: 'repo', repo: 'api' });
    expect(built.patch.critical).toBe(true);
  });

  test('examplesShort counts what a classifier draft still needs', () => {
    const draft = { ...emptyDraft(), enforcement: 'ship' as const };
    expect(examplesShort(draft)).toBe(2);
    expect(
      examplesShort({
        ...draft,
        examples: [
          { action: 'a', violates: true },
          { action: ' ', violates: false },
        ],
      }),
    ).toBe(1);
    expect(examplesShort(emptyDraft())).toBe(0);
  });
});

test('evalDeadlineMs scales with the examples', () => {
  expect(evalDeadlineMs(3, 1000)).toBe(13_000);
  expect(evalDeadlineMs(0, 1000)).toBe(11_000);
});

describe('T169', () => {
  test('a rule filter shows that one rule, whatever else is set', () => {
    const rules = [rule('R-1'), rule('R-2')];
    expect(
      filterRules(rules, { ...DEFAULT_RULES_FILTER, rule: 'R-2', query: 'nothing matches' }).map(
        (r) => r.id,
      ),
    ).toEqual(['R-2']);
  });

  test('last fired shows date and minute', () => {
    expect(formatFiredAt('2026-09-23T14:02:33.123Z')).toBe('2026-09-23 14:02');
  });
});

describe('T338: New rule name and scope picker', () => {
  test('a name reaches the create body; an empty one is left out', () => {
    const named = createOf({ ...emptyDraft(), name: ' money ', text: 'cents' });
    expect('input' in named && named.input.name).toBe('money');
    const unnamed = createOf({ ...emptyDraft(), text: 'cents' });
    expect('input' in unnamed && 'name' in unnamed.input).toBe(false);
    expect('input' in unnamed && unnamed.input.scope).toEqual({ kind: 'global' });
    // Critical is sent for a new check only when ticked.
    const critical = createOf({
      ...emptyDraft(),
      text: 'x',
      enforcement: 'action',
      checkBy: 'pattern',
      patternKind: 'no_push',
      critical: true,
    });
    expect('input' in critical && critical.input.critical).toBe(true);
  });

  test('scopes are offered by name: everywhere, repos, projects, nodes', () => {
    const choices = scopeChoices({
      repos: [{ name: 'api', delivery: 'direct' }],
      projects: [{ id: `P-${NODE}`, name: 'Shop', root: NODE }],
      streams: [
        { id: NODE, title: 'Shop', role: 'project', agent_status: 'idle', human_status: 'open' },
      ],
    });
    expect(choices).toEqual([
      { value: 'global', label: 'Everywhere' },
      { value: 'repo:api', label: 'Repo: api' },
      { value: `project:P-${NODE}`, label: 'Project: Shop' },
      { value: `subtree:${NODE}`, label: 'Node and below: Shop' },
    ]);
  });
});
