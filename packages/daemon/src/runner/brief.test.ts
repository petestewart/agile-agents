import { describe, expect, test } from 'bun:test';
import type { Stream, ThreadEntry } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import {
  BRIEF_CHAR_CEILING,
  BRIEF_THREAD_ENTRIES,
  type BriefRule,
  buildBrief,
  readRoleBrief,
  rulesInScope,
} from './brief';

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
      rules: [{ text: 'never push to main', scope: '/srv/repo' }],
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
        '## Rules in scope',
        '',
        '- (/srv/repo) never push to main',
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
        '## Rules in scope',
        '',
        'none yet',
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
    expect(bare).toContain('## Rules in scope\n\nnone yet');

    const full = buildBrief({
      role: 'worker',
      stream,
      ancestors: [],
      thread: [],
      docs: [{ name: 'brief.md', body: 'the product is a cockpit' }],
      rules: [{ text: 'prefer zod schemas' }],
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
        { text: 'in scope by repo', scope: '/srv/repo' },
        { text: 'in scope by glob', scope: '/srv/repo/.worktrees/*' },
        { text: 'global rule' },
        { text: 'other repo', scope: '/srv/other' },
        { text: 'sibling glob', scope: '/srv/other/**' },
      ],
      briefsDir: '/no/such/dir',
    });

    expect(brief).toContain('in scope by repo');
    expect(brief).toContain('in scope by glob');
    expect(brief).toContain('global rule');
    expect(brief).not.toContain('other repo');
    expect(brief).not.toContain('sibling glob');
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
      rules: [{ text: 'never push to main' }],
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
      rules: [{ text: 'never push to main' }],
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

describe('rulesInScope', () => {
  const rules: BriefRule[] = [
    { text: 'global, no scope' },
    { text: 'global, named', scope: 'global' },
    { text: 'repo prefix', scope: '/srv/repo' },
    { text: 'repo prefix with slash', scope: '/srv/repo/' },
    { text: 'nested path', scope: '/srv/repo/packages' },
    { text: 'single-star glob', scope: '/srv/repo/.worktrees/*' },
    { text: 'double-star glob', scope: '/srv/**' },
    { text: 'other repo', scope: '/srv/other' },
  ];

  test('a stream with no repo sees only global rules', () => {
    expect(rulesInScope(rules, {}).map((rule) => rule.text)).toEqual([
      'global, no scope',
      'global, named',
    ]);
  });

  test('a repo scope matches the repo itself and paths under it', () => {
    const texts = rulesInScope(rules, { repo: '/srv/repo' }).map((rule) => rule.text);
    expect(texts).toContain('repo prefix');
    expect(texts).toContain('repo prefix with slash');
    expect(texts).toContain('double-star glob');
    expect(texts).not.toContain('nested path');
    expect(texts).not.toContain('other repo');
  });

  test('a glob scope matches the worktree path, and `*` does not cross a slash', () => {
    const texts = rulesInScope(rules, {
      repo: '/srv/repo',
      worktree: '/srv/repo/.worktrees/csv',
    }).map((rule) => rule.text);
    expect(texts).toContain('single-star glob');
    expect(texts).toContain('double-star glob');
    expect(texts).not.toContain('other repo');

    expect(
      rulesInScope([{ text: 'one segment', scope: '/srv/*' }], {
        repo: '/srv/repo/deep',
      }),
    ).toEqual([]);
  });
});
