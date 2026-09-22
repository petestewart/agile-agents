/**
 * T160: the stream tree's dot (cockpit design §9.2), its nesting, and the
 * inbox grouping. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { InboxItem } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import { buildStreamTree, groupInbox, streamDot, subtreeIds } from './streams';

function row(id: string, extra: Partial<CockpitStreamRow> = {}): CockpitStreamRow {
  return { id, title: id, agent_status: 'idle', human_status: 'open', ...extra };
}

describe('streamDot', () => {
  test('each §9.2 row maps to its colour', () => {
    expect(streamDot(row('a', { human_status: 'waiting_on_you', agent_status: 'question' }))).toBe(
      'amber',
    );
    expect(streamDot(row('a', { agent_status: 'working' }))).toBe('blue');
    expect(streamDot(row('a'))).toBe('grey');
    expect(streamDot(row('a', { human_status: 'landed', agent_status: 'done' }))).toBe('green');
    expect(streamDot(row('a', { agent_status: 'blocked' }))).toBe('red');
  });

  test('the human half wins over the agent half', () => {
    expect(streamDot(row('a', { human_status: 'waiting_on_you', agent_status: 'blocked' }))).toBe(
      'amber',
    );
    expect(streamDot(row('a', { human_status: 'closed', agent_status: 'working' }))).toBe('grey');
  });

  test('a finished worker with the human half open is the operator’s move', () => {
    expect(streamDot(row('a', { agent_status: 'done' }))).toBe('amber');
  });
});

describe('buildStreamTree / subtreeIds', () => {
  const rows = [
    row('root'),
    row('mid', { parent: 'root' }),
    row('leaf', { parent: 'mid' }),
    row('orphan', { parent: 'gone' }),
  ];

  test('nests children under parents; an orphan surfaces at the root', () => {
    const tree = buildStreamTree(rows);
    expect(tree.map((n) => n.row.id)).toEqual(['root', 'orphan']);
    expect(tree[0]?.children[0]?.row.id).toBe('mid');
    expect(tree[0]?.children[0]?.children[0]?.row.id).toBe('leaf');
  });

  test('a subtree covers every descendant', () => {
    expect([...subtreeIds(rows, 'root')].sort()).toEqual(['leaf', 'mid', 'root']);
    expect([...subtreeIds(rows, 'leaf')]).toEqual(['leaf']);
  });
});

describe('groupInbox', () => {
  const item = (id: string, stream: string | undefined, path: string[]): InboxItem => ({
    kind: stream ? 'question' : 'rule_accept',
    id,
    ...(stream ? { stream } : {}),
    stream_path: path,
    ts: '2026-09-22T00:00:00.000Z',
    context: id,
  });

  test('groups by stream in oldest-first order and labels by path', () => {
    const groups = groupInbox([
      item('Q-1', 'b', ['ledger', 'parser']),
      item('R-1', undefined, []),
      item('Q-2', 'a', ['ledger']),
      item('Q-3', 'b', ['ledger', 'parser']),
    ]);
    expect(groups.map((g) => g.label)).toEqual(['ledger / parser', 'No stream', 'ledger']);
    expect(groups[0]?.items.map((i) => i.id)).toEqual(['Q-1', 'Q-3']);
  });
});
