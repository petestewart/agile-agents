/**
 * T128: the printed shapes of `agile stream list` and `agile stream show`.
 * `streamRows`/`showFields` are the data the printers take, so these assert
 * the shape without a daemon.
 */
import { describe, expect, test } from 'bun:test';
import type { Stream } from '@agile-agents/shared';
import { STREAM_HEADERS, showFields, streamRows } from './stream';

function stream(over: Partial<Stream> = {}): Stream {
  return {
    id: '01ABCDEFGHJKMNPQRSTVWXYZ00',
    title: 'Ship the cockpit',
    goal: 'do the thing',
    agent: { status: 'idle' },
    human: { status: 'open' },
    archived: false,
    sessions: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  } as Stream;
}

describe('stream list rows (T128)', () => {
  test('carry the id/title/agent-human header', () => {
    expect(STREAM_HEADERS).toEqual(['id', 'title', 'agent/human']);
  });

  test('flatten the tree with the indent in the id cell', () => {
    const root = stream();
    const child = stream({ id: '01CHILD0000000000000000000', title: 'Design the tree' });
    const rows = streamRows([{ stream: root, children: [{ stream: child, children: [] }] }]);
    expect(rows).toEqual([
      [root.id, 'Ship the cockpit', 'idle/open'],
      [`  ${child.id}`, 'Design the tree', 'idle/open'],
    ]);
  });

  test('mark an archived stream in the status cell', () => {
    const rows = streamRows([{ stream: stream({ archived: true }), children: [] }]);
    expect(rows[0]?.[2]).toBe('idle/open (archived)');
  });
});

describe('stream show fields (T128)', () => {
  test('a repo-less stream prints `repo -` and no branch/worktree lines', () => {
    const fields = showFields(stream());
    expect(fields).toContainEqual(['repo', '-']);
    expect(fields.map(([k]) => k)).not.toContain('branch');
    expect(fields.map(([k]) => k)).not.toContain('worktree');
  });

  test('a stream with a repo keeps all three lines', () => {
    const fields = showFields(stream({ repo: 'alpha' }));
    expect(fields).toContainEqual(['repo', 'alpha']);
    expect(fields).toContainEqual(['branch', '- (created on first attach)']);
    expect(fields).toContainEqual(['worktree', '- (created on first attach)']);
  });
});
