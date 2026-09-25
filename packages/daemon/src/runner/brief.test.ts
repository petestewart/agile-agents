import { describe, expect, test } from 'bun:test';
import type { KnowledgeItem, KnowledgeItemInput, Stream, ThreadEntry } from '@agile-agents/shared';
import { ulid, validateKnowledgeItem } from '@agile-agents/shared';
import {
  BRIEF_CHAR_CEILING,
  BRIEF_THREAD_ENTRIES,
  NAMES_HINT,
  buildBrief,
  coordinatorSection,
  readRoleBrief,
} from './brief';

/**
 * T140/T260: the brief takes real `KnowledgeItem` records and filters them
 * through `knowledge/service.ts`'s `knowledgeInScope`. Scope filtering itself
 * is tested there; these tests only assert what the brief *renders*.
 */
function makeRule(text: string, over: Partial<KnowledgeItemInput> = {}): KnowledgeItem {
  return validateKnowledgeItem({
    id: `K-${ulid()}`,
    kind: 'standard',
    text,
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'tell',
    critical: false,
    source: { by: 'human' },
    stats: {},
    created_at: '2026-09-21T00:00:00Z',
    ...over,
  });
}

function makeStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: ulid(),
    title: 'CSV parser',
    goal: 'decide the dialect and implement it',
    created_at: '2026-09-21T00:00:00Z',
    agent: { status: 'idle', updated_at: '2026-09-21T00:00:00Z' },
    human: { status: 'open' },
    sessions: [],
    ...overrides,
  };
}

function entry(body: string): ThreadEntry {
  return { ts: '2026-09-21T00:00:00Z', by: 'human', kind: 'line', body };
}

describe('buildBrief', () => {
  test('carries the role file, the goal, the ancestors and the thread tail', () => {
    const root = makeStream({ title: 'Cockpit', goal: 'one place to work from' });
    const stream = makeStream({ parent: root.id });
    const thread = Array.from({ length: BRIEF_THREAD_ENTRIES + 5 }, (_, i) => entry(`line ${i}`));

    const brief = buildBrief({
      role: 'worker',
      stream,
      ancestors: [root],
      thread,
      docs: [],
      rules: [],
    });

    expect(brief).toContain('# Worker brief');
    expect(brief).toContain('decide the dialect and implement it');
    expect(brief).toContain('Cockpit: one place to work from');
    // Only the tail: the oldest entries are dropped, the newest are kept.
    expect(brief).not.toContain('line 0');
    expect(brief).toContain(`line ${BRIEF_THREAD_ENTRIES + 4}`);
  });

  test('the worker brief is a snapshot of the assembled sections, in order', () => {
    const root = makeStream({ title: 'Cockpit', goal: 'one place to work from' });
    const stream = makeStream({ title: 'CSV parser', parent: root.id, repo: '/srv/repo' });

    const brief = buildBrief({
      role: 'worker',
      stream,
      ancestors: [root],
      thread: [entry('start with the dialect')],
      docs: [{ name: 'brief.md', body: 'the product is a cockpit\n' }],
      rules: [makeRule('never push to main', { scope: { kind: 'repo', repo: '/srv/repo' } })],
      briefsDir: '/no/such/dir',
    });

    expect(brief).toBe(
      [
        '## Stream',
        '',
        '**CSV parser**',
        '',
        'decide the dialect and implement it',
        '',
        '## Where this sits',
        '',
        '- Cockpit: one place to work from',
        '',
        '## Knowledge in scope',
        '',
        '- never push to main',
        '',
        'Before touching an unfamiliar area, call `lookup_knowledge` with its path for the items that apply there.',
        '',
        '## Docs',
        '',
        '### brief.md',
        '',
        'the product is a cockpit',
        '',
        '## Thread so far',
        '',
        '- **human** (line): start with the dialect',
        '',
      ].join('\n'),
    );
  });

  test('the reviewer brief is the same shape with the reviewer role file', () => {
    const brief = buildBrief({
      role: 'reviewer',
      stream: makeStream({ title: 'CSV parser' }),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
      briefsDir: '/no/such/dir',
    });

    expect(brief).toBe(
      [
        '## Stream',
        '',
        '**CSV parser**',
        '',
        'decide the dialect and implement it',
        '',
        '## Knowledge in scope',
        '',
        'none yet',
        '',
        'Before touching an unfamiliar area, call `lookup_knowledge` with its path for the items that apply there.',
        '',
      ].join('\n'),
    );

    const real = buildBrief({
      role: 'reviewer',
      stream: makeStream(),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
    });
    expect(real).toContain('# Reviewer brief');
    expect(real).toContain('read-only');
  });

  test('omits docs and the thread when empty, but always states the rules', () => {
    const stream = makeStream();
    const bare = buildBrief({
      role: 'worker',
      stream,
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
    });
    expect(bare).not.toContain('## Docs');
    expect(bare).not.toContain('## Thread so far');
    expect(bare).toContain('## Knowledge in scope\n\nnone yet');

    const full = buildBrief({
      role: 'worker',
      stream,
      ancestors: [],
      thread: [],
      docs: [{ name: 'brief.md', body: 'the product is a cockpit' }],
      rules: [makeRule('prefer zod schemas')],
    });
    expect(full).toContain('### brief.md');
    expect(full).toContain('the product is a cockpit');
    expect(full).toContain('- prefer zod schemas');
  });

  test('a missing role file is an empty section, not a throw', () => {
    expect(readRoleBrief('worker', '/no/such/dir')).toBe('');
    const brief = buildBrief({
      role: 'worker',
      stream: makeStream(),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
      briefsDir: '/no/such/dir',
    });
    expect(brief).toContain('## Stream');
  });

  test('a rule out of scope never appears in the brief', () => {
    const stream = makeStream({ repo: '/srv/repo', worktree: '/srv/repo/.worktrees/csv' });
    const brief = buildBrief({
      role: 'worker',
      stream,
      ancestors: [],
      thread: [],
      docs: [],
      rules: [
        makeRule('in scope by repo', { scope: { kind: 'repo', repo: '/srv/repo' } }),
        makeRule('global rule'),
        makeRule('still proposed', { status: 'proposed' }),
        makeRule('already retired', { status: 'retired' }),
        makeRule('other repo', { scope: { kind: 'repo', repo: '/srv/other' } }),
      ],
      briefsDir: '/no/such/dir',
    });

    expect(brief).toContain('in scope by repo');
    expect(brief).toContain('global rule');
    expect(brief).not.toContain('still proposed');
    expect(brief).not.toContain('already retired');
    expect(brief).not.toContain('other repo');
  });

  test('a stream-scoped rule reaches a nested stream through its ancestors (§5.3)', () => {
    const root = makeStream({ title: 'Cockpit' });
    const child = makeStream({ parent: root.id });
    const brief = buildBrief({
      role: 'worker',
      stream: child,
      ancestors: [root],
      thread: [],
      docs: [],
      rules: [
        makeRule('inherited from the parent', { scope: { kind: 'subtree', node: root.id } }),
        makeRule('someone else\u2019s stream', { scope: { kind: 'subtree', node: ulid() } }),
      ],
      briefsDir: '/no/such/dir',
    });
    expect(brief).toContain('inherited from the parent');
    expect(brief).not.toContain('someone else');
  });

  test('a tell item is its text and nothing else; a checked item names its checkpoint (§6)', () => {
    const brief = buildBrief({
      role: 'worker',
      stream: makeStream(),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [
        makeRule('prefer the repo scripts'),
        makeRule('never push to a protected branch', {
          enforcement: 'action',
          check: { by: 'pattern', pattern: { kind: 'no_push_protected' } },
          critical: true,
        }),
        makeRule('do not add a dependency without asking', {
          enforcement: 'ship',
          check: {
            by: 'classifier',
            examples: [
              { action: 'bun add lodash', violates: true },
              { action: 'read a file', violates: false },
            ],
          },
        }),
      ],
      briefsDir: '/no/such/dir',
    });
    expect(brief).toContain('- prefer the repo scripts\n');
    expect(brief).toContain('- never push to a protected branch (enforced: action, critical)');
    expect(brief).toContain('- do not add a dependency without asking (enforced: ship)');
  });
});

describe('the token ceiling', () => {
  test('trims thread entries oldest-first to fit, keeping goal and rules', () => {
    const stream = makeStream();
    const thread = Array.from({ length: BRIEF_THREAD_ENTRIES }, (_, i) =>
      entry(`${i}:${'x'.repeat(4000)}`),
    );

    const brief = buildBrief({
      role: 'worker',
      stream,
      ancestors: [],
      thread,
      docs: [],
      rules: [makeRule('never push to main')],
    });

    expect(brief.length).toBeLessThanOrEqual(BRIEF_CHAR_CEILING);
    expect(brief).toContain('decide the dialect and implement it');
    expect(brief).toContain('never push to main');
    // The newest entry survives; the oldest is the first to go.
    expect(brief).toContain(`${BRIEF_THREAD_ENTRIES - 1}:xxx`);
    expect(brief).not.toContain('0:xxx');
  });

  test('trims doc bodies once the thread is gone, and still fits', () => {
    const brief = buildBrief({
      role: 'worker',
      stream: makeStream(),
      ancestors: [],
      thread: [entry('a line')],
      docs: [
        { name: 'one.md', body: 'ONE-HEAD'.padEnd(60_000, 'a') },
        { name: 'two.md', body: 'TWO-HEAD'.padEnd(60_000, 'b') },
      ],
      rules: [makeRule('never push to main')],
    });

    expect(brief.length).toBeLessThanOrEqual(BRIEF_CHAR_CEILING);
    expect(brief).toContain('decide the dialect and implement it');
    expect(brief).toContain('never push to main');
    expect(brief).toContain('ONE-HEAD');
    expect(brief).toContain('truncated to fit the brief');
    expect(brief).not.toContain('a line');
  });

  test('an ordinary brief is left alone', () => {
    const brief = buildBrief({
      role: 'worker',
      stream: makeStream(),
      ancestors: [],
      thread: [entry('a line')],
      docs: [{ name: 'one.md', body: 'short doc' }],
      rules: [],
    });
    expect(brief.length).toBeLessThan(BRIEF_CHAR_CEILING);
    expect(brief).toContain('a line');
    expect(brief).toContain('short doc');
    expect(brief).not.toContain('truncated to fit the brief');
  });
});

describe('coordinator brief: children cards (T283)', () => {
  test("each child's card: state, doing, files count, relies_on; a corrupt one is named", () => {
    const api = makeStream({ title: 'api' });
    const web = makeStream({ title: 'web' });
    const out = coordinatorSection(
      [api, web],
      'run',
      undefined,
      [],
      new Map([
        [
          api.id,
          {
            node: api.id,
            doing: 'adding salePrice',
            state: 'working' as const,
            files: ['prices.ts', 'sale.ts'],
            exports_changed: [],
            relies_on: ['C-sale'],
            updated_at: new Date().toISOString(),
          },
        ],
        [web.id, { error: `corrupt card file /h/cards/${web.id}.yaml:3: bad` }],
      ]),
    );
    expect(out).toContain('card: working, 2 files, relies on C-sale — adding salePrice');
    expect(out).toContain(`card unreadable: corrupt card file /h/cards/${web.id}.yaml:3`);
  });

  test('T338: relies_on reads as contract titles, and the brief asks for names, not ids', () => {
    const api = makeStream({ title: 'api' });
    const contract = {
      id: 'C-01J00000000000000000000000',
      node: api.id,
      title: 'GET /price/:id',
      body: 'returns cents',
      parties: [api.id],
      version: 1,
      history: [],
    };
    const out = coordinatorSection(
      [api],
      'advise',
      undefined,
      [contract],
      new Map([
        [
          api.id,
          {
            node: api.id,
            doing: '',
            state: 'working' as const,
            files: [],
            exports_changed: [],
            relies_on: [contract.id],
            updated_at: new Date().toISOString(),
          },
        ],
      ]),
    );
    expect(out).toContain('relies on GET /price/:id');
    expect(out).toContain(NAMES_HINT);
  });
});

describe('the Checks section (T339)', () => {
  test('lists the repo check commands and says not to fetch tools', () => {
    const brief = buildBrief({
      role: 'worker',
      stream: makeStream(),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
      checks: ['bun run test', 'bun run typecheck'],
    });
    expect(brief).toContain('## Checks');
    expect(brief).toContain('- `bun run test`\n- `bun run typecheck`');
    expect(brief).toContain("Don't install or fetch tools");
  });

  test('is left out when there are no checks', () => {
    const input = {
      role: 'worker' as const,
      stream: makeStream(),
      ancestors: [],
      thread: [],
      docs: [],
      rules: [],
    };
    expect(buildBrief(input)).not.toContain('## Checks');
    expect(buildBrief({ ...input, checks: [] })).not.toContain('## Checks');
  });
});

describe('buildBrief — repos a worktree-less node can read (T330)', () => {
  const base = { role: 'worker' as const, ancestors: [], thread: [], docs: [], rules: [] };

  test('lists each readable repo by name and absolute path, and how code work starts', () => {
    const brief = buildBrief({
      ...base,
      stream: makeStream(),
      readableRepos: [
        { name: 'ledger-lite', path: '/src/ledger-lite' },
        { name: 'agile-test-repo', path: '/src/agile-test-repo' },
      ],
    });
    expect(brief).toContain('## Repos you can read');
    expect(brief).toContain('- ledger-lite: `/src/ledger-lite`');
    expect(brief).toContain('- agile-test-repo: `/src/agile-test-repo`');
    expect(brief).toContain('**+ Repo**');
  });

  test('a work node reads them beside its own worktree, with no + Repo hint', () => {
    const brief = buildBrief({
      ...base,
      stream: makeStream({ repo: 'agile-test-repo' }),
      readableRepos: [{ name: 'ledger-lite', path: '/src/ledger-lite' }],
      inWorktree: true,
    });
    expect(brief).toContain('Besides your own worktree');
    expect(brief).toContain('- ledger-lite: `/src/ledger-lite`');
    expect(brief).not.toContain('+ Repo');
  });

  test('says so when none are registered, and is absent when not given', () => {
    expect(buildBrief({ ...base, stream: makeStream(), readableRepos: [] })).toContain(
      'none registered yet',
    );
    expect(buildBrief({ ...base, stream: makeStream() })).not.toContain('Repos you can read');
  });
});

describe('buildBrief — a long agent line is quoted, not pasted (T330)', () => {
  test('the thread tail quotes at most the 800-char head of a 16k agent line', () => {
    const long: ThreadEntry = {
      ts: '2026-09-21T00:00:00Z',
      by: 'agent:01ARZ3NDEKTSV4RRFFQ69G5FAV',
      kind: 'line',
      body: `HEAD ${'z'.repeat(15_000)} TAIL-MARKER`,
    };
    const input = {
      role: 'worker' as const,
      stream: makeStream(),
      ancestors: [],
      docs: [],
      rules: [],
    };
    const brief = buildBrief({ ...input, thread: [long] });
    expect(brief).toContain('HEAD ');
    expect(brief).not.toContain('TAIL-MARKER');
    const without = buildBrief({ ...input, thread: [] });
    expect(brief.length - without.length).toBeLessThan(1000);
  });
});
