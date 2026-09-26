import { describe, expect, test } from 'bun:test';
import type { InboxItem } from '@agile-agents/shared';
import {
  applyFilter,
  branchName,
  cardTitle,
  choicesOf,
  cleanChoice,
  filterCounts,
  filterOf,
  fold,
  gateView,
  groupNeedsMe,
  isFirstRun,
  isLandGate,
  knowledgeView,
  parseChoices,
  planView,
  proposalOf,
  questionView,
  scopeWords,
  setupSteps,
  statusText,
} from './inbox';

const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FA1';
const NODE_B = '01ARZ3NDEKTSV4RRFFQ69G5FA2';
const ROOT = '01ARZ3NDEKTSV4RRFFQ69G5FA0';

function item(fields: Partial<InboxItem> & Pick<InboxItem, 'kind'>): InboxItem {
  return {
    id: `Q-${Math.random().toString(36).slice(2)}`,
    stream: NODE,
    stream_path: ['ledger-lite', 'parser'],
    ts: '2026-09-26T10:00:00.000Z',
    context: 'something',
    ...fields,
  } as InboxItem;
}

describe('parseChoices (T364): choices written into a question', () => {
  test('inline (A) … (B) … (C) … after a question', () => {
    expect(
      parseChoices(
        'Should amounts be integer cents or floats? (A) integer cents everywhere (B) floats, round on export (C) decimal strings',
      ),
    ).toEqual({
      stem: 'Should amounts be integer cents or floats?',
      choices: ['integer cents everywhere', 'floats, round on export', 'decimal strings'],
    });
  });

  test('inline choices joined with commas and "or", ending the question', () => {
    expect(parseChoices('Should I use (A) CSV, (B) JSON, or (C) YAML?')?.choices).toEqual([
      'CSV',
      'JSON',
      'YAML',
    ]);
    expect(parseChoices('Which dialect: (a) comma or (b) semicolon?')?.choices).toEqual([
      'comma',
      'semicolon',
    ]);
  });

  test('bare inline letters: A) … B) …', () => {
    expect(parseChoices('Which one should ship first? A) the parser B) the exporter')).toEqual({
      stem: 'Which one should ship first?',
      choices: ['the parser', 'the exporter'],
    });
  });

  test('the last inline choice stops at a sentence end', () => {
    expect(
      parseChoices('Which format? (A) CSV (B) JSON. Either is quick to write.')?.choices,
    ).toEqual(['CSV', 'JSON']);
  });

  test('a lettered list on its own lines, after the question', () => {
    expect(
      parseChoices(
        'I can go two ways. Which do you prefer?\n\nA) keep the old API\nB) break it and bump the major',
      ),
    ).toEqual({
      stem: 'I can go two ways. Which do you prefer?',
      choices: ['keep the old API', 'break it and bump the major'],
    });
    expect(parseChoices('Pick one:\n(A) Postgres\n(B) SQLite\n(C) files')?.choices).toEqual([
      'Postgres',
      'SQLite',
      'files',
    ]);
    expect(parseChoices('Which parser?\na. papaparse\nb. csv-parse')?.choices).toEqual([
      'papaparse',
      'csv-parse',
    ]);
  });

  test('a numbered list whose question asks for an alternative', () => {
    expect(
      parseChoices('Which parser should I use?\n1. papaparse\n2. csv-parse\n3. by hand'),
    ).toEqual({
      stem: 'Which parser should I use?',
      choices: ['papaparse', 'csv-parse', 'by hand'],
    });
    expect(parseChoices('What should the timeout be?\n1) 30s\n2) 60s')?.choices).toEqual([
      '30s',
      '60s',
    ]);
  });

  test('markdown emphasis and code ticks come off the button text', () => {
    expect(
      parseChoices('Which one?\n1. **Integer cents** everywhere\n2. keep `float` and round')
        ?.choices,
    ).toEqual(['Integer cents everywhere', 'keep float and round']);
    expect(cleanChoice('  **bold**  and `code` ')).toBe('bold and code');
  });

  test('blank lines between listed choices are fine', () => {
    expect(parseChoices('Which?\n\nA) one\n\nB) two\n')?.choices).toEqual(['one', 'two']);
  });

  describe('not choices', () => {
    test('a sentence that merely contains (a)', () => {
      expect(parseChoices('Should I follow step (a) of the migration guide?')).toBeUndefined();
      expect(parseChoices('Use option (a) and then (b) of the RFC.')).toBeUndefined();
    });

    test('labels in a statement, not after a question', () => {
      expect(
        parseChoices('I looked at (a) the parser and (b) the lexer. Which should I fix first?'),
      ).toBeUndefined();
    });

    test('a label inside code', () => {
      expect(parseChoices('Does `f(a)` handle (b)?')).toBeUndefined();
      expect(parseChoices('Is `(A) x (B) y` the right syntax?')).toBeUndefined();
    });

    test('a text with a code block', () => {
      expect(
        parseChoices('Which one?\n```\n(A) first\n(B) second\n```\n(A) first\n(B) second'),
      ).toBeUndefined();
    });

    test('long paragraphs are not buttons', () => {
      const long = 'x '.repeat(60).trim();
      expect(parseChoices(`Which approach? (A) ${long} (B) ${long}`)).toBeUndefined();
      expect(parseChoices(`Which approach?\nA) ${long}\nB) short`)).toBeUndefined();
    });

    test('one choice, or too many', () => {
      expect(parseChoices('Which one? (A) only this')).toBeUndefined();
      expect(parseChoices('Which one?\n1. a\n2. b\n3. c\n4. d\n5. e\n6. f\n7. g')).toBeUndefined();
    });

    test('labels out of order, mixed, or not from the first', () => {
      expect(parseChoices('Which one? (A) x (C) y')).toBeUndefined();
      expect(parseChoices('Which one? (B) x (C) y')).toBeUndefined();
      expect(parseChoices('Which one? (A) x (b) y')).toBeUndefined();
      expect(parseChoices('Which one?\nA) x\n2) y')).toBeUndefined();
    });

    test('duplicate or empty choices', () => {
      expect(parseChoices('Which one? (A) same (B) same')).toBeUndefined();
      expect(parseChoices('Is it (a) or (b)?')).toBeUndefined();
    });

    test('a numbered list of steps under a yes/no question', () => {
      expect(parseChoices('Is this plan OK?\n1. write the tests\n2. implement')).toBeUndefined();
      expect(parseChoices("Here's what I did:\n1. ran the tests\n2. fixed lint")).toBeUndefined();
    });

    test('a list that does not end the question', () => {
      expect(
        parseChoices('I found two approaches:\n1. X\n2. Y\nShould I go ahead with both?'),
      ).toBeUndefined();
    });

    test('a list with no question before it', () => {
      expect(parseChoices('A) one\nB) two')).toBeUndefined();
      expect(parseChoices('Notes:\nA) one\nB) two')).toBeUndefined();
    });

    test('plain questions', () => {
      expect(parseChoices('comma or semicolon for the CSV dialect?')).toBeUndefined();
      expect(parseChoices('Should `export --json` print pretty JSON or one line?')).toBeUndefined();
    });
  });
});

describe('choicesOf / questionView (T364)', () => {
  test("the agent's options win, and the text stays whole", () => {
    const q = item({
      kind: 'question',
      context: 'Which? (A) x (B) y',
      options: ['Integer cents', 'Floats'],
    });
    expect(choicesOf(q)).toEqual(['Integer cents', 'Floats']);
    expect(questionView(q).text).toBe('Which? (A) x (B) y');
  });

  test('parsed from the full text (detail), and the text loses the choices', () => {
    const q = item({
      kind: 'question',
      context: 'clipped…',
      detail: 'Should amounts be integer cents or floats? (A) integer cents (B) floats',
    });
    expect(questionView(q)).toEqual({
      text: 'Should amounts be integer cents or floats?',
      choices: ['integer cents', 'floats'],
    });
  });

  test('none: a plain question, and every other kind', () => {
    expect(choicesOf(item({ kind: 'question', context: 'which branch?' }))).toEqual([]);
    expect(choicesOf(item({ kind: 'blocked', context: 'Which? (A) x (B) y' }))).toEqual([]);
  });
});

describe('fold (T364)', () => {
  test('a short text is whole', () => {
    expect(fold('short\ntext')).toEqual({ short: 'short\ntext' });
  });

  test('a long text is clipped to one line with Show more', () => {
    const long = `${'word '.repeat(60)}TAIL`;
    const folded = fold(long);
    expect(folded.long).toBe(long);
    expect(folded.short.endsWith('…')).toBe(true);
    expect(folded.short).not.toContain('TAIL');
  });
});

describe('card titles and text (T364)', () => {
  test('a title in words for every kind', () => {
    expect(cardTitle(item({ kind: 'question' }))).toBe('Question');
    expect(cardTitle(item({ kind: 'gate', context: 'classifier_review: edit x — why' }))).toBe(
      'Allow this action?',
    );
    expect(cardTitle(item({ kind: 'gate', context: 'land: land stream/a into main' }))).toBe(
      'Approve this merge?',
    );
    expect(cardTitle(item({ kind: 'rule_accept', knowledge_kind: 'decision' }))).toBe(
      'Decision proposed',
    );
    expect(cardTitle(item({ kind: 'rule_batch' }))).toBe('Knowledge to review');
    expect(cardTitle(item({ kind: 'plan_approve' }))).toBe('Plan to approve');
    expect(cardTitle(item({ kind: 'plan_waiting' }))).toBe('Waiting for the plan');
    expect(cardTitle(item({ kind: 'proposal', context: 'coordinator proposes: x' }))).toBe(
      'Coordinator proposal',
    );
    expect(cardTitle(item({ kind: 'proposal', context: 'director proposes: x' }))).toBe(
      'Director proposal',
    );
    expect(cardTitle(item({ kind: 'done' }))).toBe('Ready to merge');
    expect(cardTitle(item({ kind: 'blocked' }))).toBe('Blocked');
  });

  test('a classifier gate: the call and why', () => {
    const gate = item({
      kind: 'gate',
      context:
        'classifier_review: edit /tmp/wt/package.json — editing a dependency manifest is never automatic',
    });
    expect(isLandGate(gate)).toBe(false);
    expect(gateView(gate)).toEqual({
      land: false,
      action: 'edit /tmp/wt/package.json',
      reason: 'editing a dependency manifest is never automatic',
    });
    expect(
      gateView(item({ kind: 'gate', context: 'classifier_review: needs your decision' })),
    ).toEqual({ land: false, reason: 'needs your decision' });
  });

  test('a land gate: the branch and its target', () => {
    const gate = item({ kind: 'gate', context: 'land: land stream/01-parser into main' });
    expect(isLandGate(gate)).toBe(true);
    expect(gateView(gate)).toEqual({
      land: true,
      reason: 'land stream/01-parser into main',
      branch: 'stream/01-parser',
      target: 'main',
    });
  });

  test('a node branch reads without its id prefix', () => {
    expect(branchName('stream/01m3ex211kqv9k5tpbgt1des7e-add-csv-import')).toBe('add-csv-import');
    expect(branchName('feature/x')).toBe('feature/x');
  });

  test('knowledge: name, scope and text; the scope in words', () => {
    expect(
      knowledgeView(
        item({
          kind: 'rule_accept',
          context: 'money-in-cents · project:P-01: Store money as cents',
        }),
      ),
    ).toEqual({ name: 'money-in-cents', scope: 'project:P-01', text: 'Store money as cents' });
    expect(
      knowledgeView(
        item({ kind: 'rule_accept', context: `subtree:${NODE}: run the repo scripts` }),
      ),
    ).toEqual({ scope: `subtree:${NODE}`, text: 'run the repo scripts' });
    expect(knowledgeView(item({ kind: 'rule_accept', context: 'global: a standard' }))).toEqual({
      scope: 'global',
      text: 'a standard',
    });
    expect(knowledgeView(item({ kind: 'rule_accept', context: 'odd text' }))).toEqual({
      text: 'odd text',
    });
    const names = {
      node: (id: string) => (id === NODE ? 'parser' : undefined),
      project: (id: string) => (id === 'P-01' ? 'Shop' : undefined),
    };
    expect(scopeWords('global', names)).toBe('everywhere');
    expect(scopeWords('repo:web-app', names)).toBe('the web-app repo');
    expect(scopeWords('project:P-01', names)).toBe('the Shop project');
    expect(scopeWords(`subtree:${NODE}`, names)).toBe('parser and the nodes under it');
    expect(scopeWords(`subtree:${NODE_B}`, names)).toBe('one node and the nodes under it');
    expect(scopeWords(undefined, names)).toBeUndefined();
  });

  test('a proposal: who proposes, and what', () => {
    expect(proposalOf({ context: 'coordinator proposes: web waits on api' })).toEqual({
      principal: 'coordinator',
      summary: 'web waits on api',
    });
    expect(proposalOf({ context: 'something else' })).toEqual({ summary: 'something else' });
  });

  test('a plan: its parts and contracts', () => {
    expect(
      planView(
        item({
          kind: 'plan_approve',
          context: 'clipped',
          detail:
            'Approve the plan for Sale prices: api owns `prices.ts`; web owns `shop.html`. Contracts: GET /price/:id: returns { cents } | Events: one per sale',
        }),
      ),
    ).toEqual({
      node: 'Sale prices',
      revised: false,
      owners: ['api owns `prices.ts`', 'web owns `shop.html`'],
      contracts: ['GET /price/:id: returns { cents }', 'Events: one per sale'],
    });
    expect(
      planView(
        item({
          kind: 'plan_approve',
          context: 'Approve the revised plan (approved v1) for X: a owns nothing (was `a.ts`)',
        }),
      ),
    ).toEqual({ node: 'X', revised: true, owners: ['a owns nothing (was `a.ts`)'], contracts: [] });
    expect(planView(item({ kind: 'plan_approve', context: 'unexpected' }))).toBeUndefined();
  });

  test("the daemon's stock lines read in the UI's words", () => {
    expect(
      statusText(item({ kind: 'done', context: 'worker finished — merge or close the stream' })),
    ).not.toMatch(/\bstream\b|\bland\b/);
    expect(statusText(item({ kind: 'blocked', context: 'blocked' }))).toContain('stuck');
    expect(statusText(item({ kind: 'done', context: 'Added the CSV import.' }))).toBe(
      'Added the CSV import.',
    );
  });
});

describe('the filter (T364)', () => {
  const items = [
    item({ kind: 'question', id: 'q' }),
    item({ kind: 'blocked', id: 'b' }),
    item({ kind: 'gate', id: 'g', context: 'classifier_review: x' }),
    item({ kind: 'gate', id: 'l', context: 'land: land a into b' }),
    item({ kind: 'done', id: 'd' }),
    item({ kind: 'rule_accept', id: 'r' }),
    item({ kind: 'plan_approve', id: 'p' }),
  ];

  test('questions want words, merges want Merge, the rest are decisions', () => {
    expect(items.map(filterOf)).toEqual([
      'questions',
      'questions',
      'decisions',
      'merges',
      'merges',
      'decisions',
      'decisions',
    ]);
    expect(filterCounts(items)).toEqual({ all: 7, questions: 2, decisions: 3, merges: 2 });
    expect(applyFilter(items, 'merges').map((i) => i.id)).toEqual(['l', 'd']);
    expect(applyFilter(items, 'all')).toHaveLength(7);
  });
});

describe('groupNeedsMe (T364): project, then node, oldest first', () => {
  const rows = [{ id: ROOT, project: 'P-shop' }, { id: NODE, project: 'P-shop' }, { id: NODE_B }];
  const projects = [{ id: 'P-shop', name: 'Shop', root: ROOT }];

  test('sections by project; nodes under their project read without the root', () => {
    const sections = groupNeedsMe(
      [
        item({
          kind: 'question',
          id: 'q2',
          ts: '2026-09-26T10:05:00.000Z',
          stream_path: ['Shop', 'parser'],
        }),
        item({
          kind: 'done',
          id: 'd',
          stream: NODE_B,
          stream_path: ['ledger-lite', 'import CSV'],
          ts: '2026-09-26T09:00:00.000Z',
        }),
        item({
          kind: 'question',
          id: 'q1',
          ts: '2026-09-26T10:01:00.000Z',
          stream_path: ['Shop', 'parser'],
        }),
        item({
          kind: 'plan_approve',
          id: ROOT,
          stream: ROOT,
          stream_path: ['Shop'],
          ts: '2026-09-26T11:00:00.000Z',
        }),
        item({
          kind: 'rule_batch',
          id: 'seed',
          stream: undefined,
          stream_path: [],
          ts: '2026-09-26T12:00:00.000Z',
        }),
      ],
      rows,
      projects,
    );
    expect(sections.map((s) => [s.key, s.label, s.count])).toEqual([
      ['none', 'Not in a project', 1],
      ['project:P-shop', 'Shop', 3],
      ['knowledge', 'Knowledge', 1],
    ]);
    const shop = sections[1];
    expect(shop?.groups.map((g) => [g.key, g.path.join(' / ')])).toEqual([
      [NODE, 'parser'],
      [ROOT, 'Shop'],
    ]);
    // Oldest first inside a node, whatever order the items came in.
    expect(shop?.groups[0]?.items.map((i) => i.id)).toEqual(['q1', 'q2']);
    expect(sections[0]?.groups[0]?.path).toEqual(['ledger-lite', 'import CSV']);
    expect(sections[2]?.groups[0]).toMatchObject({ key: '', path: ['Knowledge'] });
  });

  test('a node the frame does not know yet sits in no project', () => {
    const sections = groupNeedsMe([item({ kind: 'question', stream: NODE_B })], [], projects);
    expect(sections.map((s) => s.kind)).toEqual(['none']);
    expect(sections[0]?.groups[0]?.path).toEqual(['ledger-lite', 'parser']);
  });

  test('empty in, empty out', () => {
    expect(groupNeedsMe([], rows, projects)).toEqual([]);
  });
});

describe('setupSteps / isFirstRun (T364)', () => {
  const row = (role: 'project' | 'work') => ({ role }) as never;

  test('nothing yet: every step open, first run', () => {
    const steps = setupSteps({ repos: [], projects: [], streams: [] });
    expect(steps.map((s) => [s.id, s.done])).toEqual([
      ['repo', false],
      ['project', false],
      ['node', false],
    ]);
    expect(isFirstRun(steps)).toBe(true);
    expect(isFirstRun(setupSteps(undefined))).toBe(true);
  });

  test("a project's root is not a node you started", () => {
    const steps = setupSteps({
      repos: [{ name: 'a', delivery: 'direct' }],
      projects: [{ id: 'P', name: 'Shop', root: ROOT }],
      streams: [row('project')],
    });
    expect(steps.map((s) => s.done)).toEqual([true, true, false]);
    expect(isFirstRun(steps)).toBe(false);
  });

  test('a repo and nodes but no project is still first run', () => {
    const steps = setupSteps({
      repos: [{ name: 'a', delivery: 'direct' }],
      projects: [],
      streams: [row('work')],
    });
    expect(steps.map((s) => [s.id, s.done, s.count])).toEqual([
      ['repo', true, 1],
      ['project', false, 0],
      ['node', true, 1],
    ]);
    expect(isFirstRun(steps)).toBe(true);
  });
});
