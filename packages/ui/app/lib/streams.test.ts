/**
 * T160: the stream tree's dot (cockpit design §9.2), its nesting, and the
 * inbox grouping. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { InboxItem, SessionRef } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import {
  buildStreamTree,
  diffLineKind,
  groupInbox,
  isLiveSession,
  isThinking,
  streamDot,
  threadAuthorLabel,
} from './streams';

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

describe('buildStreamTree', () => {
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

describe('stream page helpers (T161)', () => {
  const session = (
    id: string,
    role: SessionRef['role'],
    status: SessionRef['status'],
  ): SessionRef => ({ id, vendor: 'claude', model: 'opus', role, status });

  test('thinking means a worker or reviewer is mid-turn, not waiting on you', () => {
    expect(isThinking({ sessions: [] })).toBe(false);
    expect(isThinking({ sessions: [session('a', 'worker', 'running')] })).toBe(true);
    expect(isThinking({ sessions: [session('a', 'reviewer', 'starting')] })).toBe(true);
    expect(isThinking({ sessions: [session('a', 'worker', 'idle')] })).toBe(false);
    expect(isThinking({ sessions: [session('a', 'lessons', 'running')] })).toBe(false);
    expect(isLiveSession({ status: 'idle' })).toBe(true);
    expect(isLiveSession({ status: 'stopped' })).toBe(false);
  });

  test('thread authors read as you, daemon, or the session role and vendor', () => {
    const sessions = [session('01S', 'reviewer', 'running')];
    expect(threadAuthorLabel('human', sessions)).toBe('you');
    expect(threadAuthorLabel('daemon', sessions)).toBe('daemon');
    expect(threadAuthorLabel('agent:01S', sessions)).toBe('reviewer · claude');
    expect(threadAuthorLabel('agent:gone', sessions)).toBe('agent');
  });

  test('diff lines are classified for colouring', () => {
    expect(diffLineKind('+++ b/x')).toBe('meta');
    expect(diffLineKind('diff --git a/x b/x')).toBe('meta');
    expect(diffLineKind('@@ -1 +1 @@')).toBe('hunk');
    expect(diffLineKind('+added')).toBe('add');
    expect(diffLineKind('-gone')).toBe('del');
    expect(diffLineKind(' same')).toBe('ctx');
  });
});
