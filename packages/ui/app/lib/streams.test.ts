/**
 * T160: the stream tree's dot (cockpit design §9.2), its nesting, and the
 * inbox grouping. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { InboxItem, SessionRef } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import {
  activityDelivery,
  ancestorTitles,
  buildStreamTree,
  dependencyEdges,
  diffLineKind,
  eventTime,
  filterStreamRows,
  groupByRepo,
  groupInbox,
  isLiveSession,
  isThinking,
  parseCollapsed,
  projectForNew,
  rowsInProject,
  ruleHitOf,
  runningRows,
  streamDot,
  subtreeNeedsYou,
  threadAuthorLabel,
} from './streams';

function row(id: string, extra: Partial<CockpitStreamRow> = {}): CockpitStreamRow {
  return { id, title: id, role: 'work', agent_status: 'idle', human_status: 'open', ...extra };
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

  test('T341: a finished coordinator, root or project conversation has nothing to land', () => {
    expect(streamDot(row('a', { agent_status: 'done', role: 'coordinating' }))).toBe('grey');
    expect(streamDot(row('a', { agent_status: 'done', role: 'project', project: 'P-1' }))).toBe(
      'grey',
    );
    expect(
      streamDot(row('a', { agent_status: 'done', role: 'conversation', project: 'P-1' })),
    ).toBe('grey');
    expect(streamDot(row('a', { agent_status: 'done', pr_open: true }))).toBe('grey');
    // A question still is the operator's move.
    expect(streamDot(row('a', { agent_status: 'question', role: 'coordinating' }))).toBe('amber');
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

describe('rail collapse (T331)', () => {
  test('subtreeNeedsYou sees an amber dot anywhere below, not on the node itself', () => {
    const quiet = buildStreamTree([
      row('root', { agent_status: 'question' }),
      row('a', { parent: 'root' }),
    ]);
    expect(quiet[0] && subtreeNeedsYou(quiet[0])).toBe(false);
    const deep = buildStreamTree([
      row('root'),
      row('mid', { parent: 'root', agent_status: 'working' }),
      row('leaf', { parent: 'mid', human_status: 'waiting_on_you' }),
    ]);
    expect(deep[0] && subtreeNeedsYou(deep[0])).toBe(true);
  });

  test('parseCollapsed keeps string ids and shrugs off anything malformed', () => {
    expect([...parseCollapsed('["a","b",3]')]).toEqual(['a', 'b']);
    expect(parseCollapsed('{"a":1}').size).toBe(0);
    expect(parseCollapsed('not json').size).toBe(0);
    expect(parseCollapsed(null).size).toBe(0);
  });
});

describe('filterStreamRows (T162)', () => {
  const rows = [
    row('root', { title: 'ledger-lite' }),
    row('mid', { title: 'import CSV', parent: 'root' }),
    row('leaf', { title: 'Parser', parent: 'mid' }),
    row('other', { title: 'docs' }),
  ];

  test('an empty query keeps every row', () => {
    expect(filterStreamRows(rows, '  ')).toBe(rows);
  });

  test('keeps case-insensitive matches and their ancestors', () => {
    expect(filterStreamRows(rows, 'parser').map((r) => r.id)).toEqual(['root', 'mid', 'leaf']);
    expect(filterStreamRows(rows, 'DOC').map((r) => r.id)).toEqual(['other']);
    expect(filterStreamRows(rows, 'nothing')).toEqual([]);
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

describe('ruleHitOf (T169)', () => {
  const id = 'K-01ARZ3NDEKTSV4RRFFQ69G5FAV';
  test('a daemon rule_hit event with a rule ref is a hit', () => {
    expect(
      ruleHitOf({ by: 'daemon', kind: 'event', body: `rule_hit: ${id} denied`, ref: id }),
    ).toBe(id);
  });
  test('anything else is not', () => {
    expect(
      ruleHitOf({ by: 'daemon', kind: 'event', body: 'hook_deny: denied `x`' }),
    ).toBeUndefined();
    expect(
      ruleHitOf({ by: 'human', kind: 'event', body: `rule_hit: ${id}`, ref: id }),
    ).toBeUndefined();
    expect(
      ruleHitOf({ by: 'daemon', kind: 'event', body: 'rule_hit: x', ref: 'questions/Q-1.yaml' }),
    ).toBeUndefined();
  });
});

describe('T208: projects in the rail', () => {
  const rows = [row('a', { project: 'P1' }), row('b', { project: 'P2' }), row('c')];
  const projects = [
    { id: 'P1', name: 'one', root: 'r1' },
    { id: 'P2', name: 'two', root: 'r2' },
  ];

  test('rowsInProject keeps one project, or everything for "All"', () => {
    expect(rowsInProject(rows, 'P1').map((r) => r.id)).toEqual(['a']);
    expect(rowsInProject(rows, undefined)).toHaveLength(3);
  });

  test('projectForNew: the switcher, then the open stream, then the only project', () => {
    expect(projectForNew('P2', 'a', rows, projects)).toBe('P2');
    expect(projectForNew(undefined, 'a', rows, projects)).toBe('P1');
    expect(projectForNew(undefined, 'c', rows, projects)).toBeUndefined();
    expect(projectForNew(undefined, undefined, rows, projects.slice(0, 1))).toBe('P1');
  });
});

describe('repo view and lenses (T209)', () => {
  const rows = [
    row('P1', { title: 'Shop', role: 'project' }),
    row('F', { title: 'Show sale prices', role: 'coordinating', parent: 'P1' }),
    row('A', { title: 'api: salePrice', parent: 'F', repo: 'api', live: true }),
    row('P2', { title: 'Blog', role: 'project' }),
    row('B', { title: 'api: posts', parent: 'P2', repo: 'api', waits_on: ['A', 'GONE'] }),
    row('L', { title: 'landed', parent: 'P2', repo: 'api', human_status: 'landed' }),
    row('W', { title: 'web: x', parent: 'P1', repo: 'web' }),
  ];

  test('ancestors run root first', () => {
    expect(ancestorTitles(rows[2] as CockpitStreamRow, rows)).toEqual(['Shop', 'Show sale prices']);
    expect(ancestorTitles(rows[0] as CockpitStreamRow, rows)).toEqual([]);
  });

  test('live work nodes group by repo across projects, with the delivery mode', () => {
    const groups = groupByRepo(rows, [
      { name: 'api', delivery: 'pr' },
      { name: 'empty', delivery: 'direct' },
    ]);
    expect(groups.map((g) => [g.repo, g.delivery, g.rows.map((r) => r.id)])).toEqual([
      ['api', 'pr', ['A', 'B']],
      ['empty', 'direct', []],
      ['web', 'direct', ['W']],
    ]);
  });

  test('running is only nodes with a live session', () => {
    expect(runningRows(rows).map((r) => r.id)).toEqual(['A']);
  });

  test('dependencies list every open edge', () => {
    const edges = dependencyEdges(rows);
    expect(edges.map((e) => [e.from.id, typeof e.on === 'string' ? e.on : e.on.id])).toEqual([
      ['B', 'A'],
      ['B', 'GONE'],
    ]);
  });
});

describe('T341: an Activity row reads without raw ids', () => {
  const sessions = [
    { id: '01ARZ3NDEKTSV4RRFFQ69GE001', role: 'worker' as const },
    { id: '01ARZ3NDEKTSV4RRFFQ69GE002', role: 'coordinator' as const },
  ];
  test('the session by its role, a digest as a word', () => {
    expect(
      activityDelivery(
        { status: 'delivered', session: '01ARZ3NDEKTSV4RRFFQ69GE002', digest: 'D-1' },
        sessions,
      ),
    ).toBe('delivered to the coordinator session in a digest');
    expect(
      activityDelivery({ status: 'delivered', session: '01ARZ3NDEKTSV4RRFFQ69GE001' }, sessions),
    ).toBe('delivered to the worker session');
    expect(activityDelivery({ status: 'pending' }, sessions)).toBe('pending');
    expect(activityDelivery({ status: 'delivered', session: 'gone' }, sessions)).toBe(
      'delivered to the agent session',
    );
    expect(activityDelivery({ status: 'delivered', session: 'x' }, [], 'Director')).toBe(
      'delivered to the Director session',
    );
  });
  test('the time to the minute', () => {
    expect(eventTime('2026-09-25T15:06:06.920Z')).toBe('2026-09-25 15:06');
  });
});
