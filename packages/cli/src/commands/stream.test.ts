/**
 * T128: the printed shapes of `agile stream list` and `agile stream show`.
 * `streamRows`/`showFields` are the data the printers take, so these assert
 * the shape without a daemon.
 */
import { describe, expect, test } from 'bun:test';
import type { Stream, ThreadEntry } from '@agile-agents/shared';
import {
  STREAM_HEADERS,
  STREAM_STATUS_VALUES,
  filterStreamTree,
  formatThreadEntry,
  showFields,
  streamRows,
  streamStatusMatches,
} from './stream';

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

describe('stream show thread entries (T137)', () => {
  const entry = (over: Partial<ThreadEntry> = {}): ThreadEntry =>
    ({
      ts: '2026-01-01T00:00:00.000Z',
      by: 'agent:01SESSION0000000000000000',
      kind: 'line',
      body: 'one line',
      ...over,
    }) as ThreadEntry;

  test('a single-line body is one line, with the ref on it', () => {
    expect(formatThreadEntry(entry({ ref: '/tmp/output.log' }))).toEqual([
      '  2026-01-01T00:00:00.000Z  agent:01SESSION0000000000000000  line  one line  [/tmp/output.log]',
    ]);
  });

  test('a two-line body is one entry with the continuation indented under it', () => {
    const lines = formatThreadEntry(entry({ body: 'Plan:\n- read the parser' }));
    expect(lines).toEqual([
      '  2026-01-01T00:00:00.000Z  agent:01SESSION0000000000000000  line  Plan:',
      '    - read the parser',
    ]);
  });
});

describe('stream list --status/--landed filtering (T136)', () => {
  test('matches either half of the agent/human pair', () => {
    const landed = stream({ human: { status: 'landed' } });
    expect(streamStatusMatches(landed, 'landed')).toBe(true);
    expect(streamStatusMatches(landed, 'idle')).toBe(true);
    expect(streamStatusMatches(landed, 'done')).toBe(false);
    expect(STREAM_STATUS_VALUES).toContain('landed');
    expect(STREAM_STATUS_VALUES).toContain('done');
  });

  test('keeps a non-matching parent when a descendant matches', () => {
    const parent = stream({ id: '01PARENT000000000000000000' });
    const child = stream({ id: '01CHILD0000000000000000000', human: { status: 'landed' } });
    const kept = filterStreamTree(
      [{ stream: parent, children: [{ stream: child, children: [] }] }],
      'landed',
    );
    expect(kept.length).toBe(1);
    expect(kept[0]?.stream.id).toBe(parent.id);
    expect(kept[0]?.children[0]?.stream.id).toBe(child.id);
  });

  test('drops a subtree with no match anywhere', () => {
    const parent = stream({ id: '01PARENT000000000000000000' });
    const child = stream({ id: '01CHILD0000000000000000000' });
    expect(
      filterStreamTree([{ stream: parent, children: [{ stream: child, children: [] }] }], 'landed'),
    ).toEqual([]);
  });
});
