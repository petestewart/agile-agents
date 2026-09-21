import { describe, expect, test } from 'bun:test';
import type { Stream, ThreadEntry } from '@agile-agents/shared';
import { ulid } from '@agile-agents/shared';
import { BRIEF_THREAD_ENTRIES, buildBrief, readRoleBrief } from './brief';

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

  test('renders docs and rules as plain sections, and omits them when empty', () => {
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
    expect(bare).not.toContain('## Rules in scope');
    expect(bare).not.toContain('## Thread so far');

    const full = buildBrief({
      role: 'worker',
      stream,
      ancestors: [],
      thread: [],
      docs: [{ name: 'brief.md', body: 'the product is a cockpit' }],
      rules: [{ text: 'never push to main', scope: 'repo' }],
    });
    expect(full).toContain('### brief.md');
    expect(full).toContain('the product is a cockpit');
    expect(full).toContain('- (repo) never push to main');
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
});
