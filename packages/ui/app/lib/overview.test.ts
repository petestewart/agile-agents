/**
 * T387: a project's Overview — counts, groups, paths, age and its events.
 * Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import { type RoutedEvent, ulid } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import {
  OVERVIEW_ORDER,
  type OverviewStatus,
  createdAt,
  isProjectEvent,
  lastChange,
  openNodesOn,
  overviewCounts,
  overviewGroupOf,
  overviewGroups,
  overviewStatus,
  overviewSummary,
  pathUnder,
  projectNodes,
  projectRepoNames,
  recentProjectEvents,
} from './overview';
import { LEGEND_ORDER } from './tree';

function row(id: string, extra: Partial<CockpitStreamRow> = {}): CockpitStreamRow {
  return {
    id,
    title: id,
    role: 'work',
    project: 'P-1',
    agent_status: 'idle',
    human_status: 'open',
    ...extra,
  };
}

const ROOT = row('root', { role: 'project' });

/** One row per status the Overview tells apart, under the root. */
const needs = row('needs', { parent: 'root', agent_status: 'question' });
const blocked = row('blocked', { parent: 'root', agent_status: 'blocked' });
const ready = row('ready', {
  parent: 'root',
  agent_status: 'done',
  human_status: 'waiting_on_you',
});
const empty = row('empty', {
  parent: 'root',
  agent_status: 'done',
  human_status: 'waiting_on_you',
  nothing_to_merge: true,
});
const working = row('working', { parent: 'root', agent_status: 'working', live: true });
const pr = row('pr', { parent: 'root', agent_status: 'done', pr_open: true });
const fresh = row('fresh', { parent: 'root', never_started: true });
const replied = row('replied', { parent: 'root', role: 'conversation', agent_status: 'done' });
const merged = row('merged', { parent: 'root', human_status: 'landed' });
const closed = row('closed', { parent: 'root', human_status: 'closed' });
const finished = row('finished', { parent: 'root', role: 'coordinating', agent_status: 'done' });

describe('statuses', () => {
  test('each node is one status key, with a replied conversation told apart from finished work', () => {
    expect(overviewStatus(needs)).toBe('needs_you');
    expect(overviewStatus(blocked)).toBe('blocked');
    expect(overviewStatus(empty)).toBe('no_changes');
    expect(overviewStatus(ready)).toBe('ready');
    expect(overviewStatus(working)).toBe('working');
    expect(overviewStatus(pr)).toBe('pr_open');
    expect(overviewStatus(fresh)).toBe('not_started');
    // A conversation that replied goes on: open, not finished.
    expect(overviewStatus(replied)).toBe('replied');
    expect(overviewStatus(merged)).toBe('merged');
    expect(overviewStatus(closed)).toBe('closed');
    expect(overviewStatus(finished)).toBe('done');
  });

  test('every status key sits in exactly one group, in one order', () => {
    const keys: OverviewStatus[] = [...LEGEND_ORDER, 'replied'];
    expect([...OVERVIEW_ORDER].sort()).toEqual([...keys].sort());
    expect(new Set(OVERVIEW_ORDER).size).toBe(OVERVIEW_ORDER.length);
    expect(overviewGroupOf(needs)).toBe('you');
    expect(overviewGroupOf(blocked)).toBe('you');
    expect(overviewGroupOf(empty)).toBe('you');
    expect(overviewGroupOf(ready)).toBe('you');
    expect(overviewGroupOf(working)).toBe('in_progress');
    expect(overviewGroupOf(pr)).toBe('in_progress');
    expect(overviewGroupOf(fresh)).toBe('not_running');
    expect(overviewGroupOf(replied)).toBe('not_running');
    expect(overviewGroupOf(merged)).toBe('finished');
    expect(overviewGroupOf(closed)).toBe('finished');
    expect(overviewGroupOf(finished)).toBe('finished');
  });
});

describe('counts', () => {
  test('one per status, your move first, only what is there, in the status’s own words', () => {
    const nodes = [merged, working, needs, ready, closed, fresh, blocked, pr];
    expect(overviewCounts(nodes).map((c) => [c.status, c.count])).toEqual([
      ['needs_you', 1],
      ['blocked', 1],
      ['ready', 1],
      ['working', 1],
      ['pr_open', 1],
      ['not_started', 1],
      ['merged', 1],
      ['closed', 1],
    ]);
    expect(overviewSummary(nodes)).toBe(
      '1 needs you · 1 blocked · 1 ready to merge · 1 working · 1 PR open · 1 not started · 1 merged · 1 closed',
    );
  });

  test('T424: the audit’s project — no count mixes two statuses', () => {
    // Needs you and Blocked were "2 need you"; Closed was "1 done"; three Not started and an Idle were "4 idle".
    const idle = row('idle', { parent: 'root', live: true });
    const fresh2 = row('fresh2', { parent: 'root', never_started: true });
    const fresh3 = row('fresh3', { parent: 'root', role: 'coordinating', never_started: true });
    const nodes = [needs, blocked, ready, working, idle, fresh, fresh2, fresh3, closed];
    expect(overviewSummary(nodes)).toBe(
      '1 needs you · 1 blocked · 1 ready to merge · 1 working · 1 idle · 3 not started · 1 closed',
    );
  });

  test('plural words; one reads "needs you"; none reads "No nodes yet"', () => {
    const needs2 = row('needs2', { parent: 'root', agent_status: 'question' });
    const pr2 = row('pr2', { parent: 'root', agent_status: 'done', pr_open: true });
    const empty2 = row('empty2', {
      parent: 'root',
      agent_status: 'done',
      human_status: 'waiting_on_you',
      nothing_to_merge: true,
    });
    const replied2 = row('replied2', {
      parent: 'root',
      role: 'conversation',
      agent_status: 'done',
    });
    expect(overviewSummary([needs, needs2, pr, pr2, empty, empty2, replied, replied2])).toBe(
      '2 need you · 2 with no changes · 2 PRs open · 2 replied',
    );
    expect(overviewSummary([needs, working])).toBe('1 needs you · 1 working');
    expect(overviewSummary([])).toBe('No nodes yet');
    expect(overviewCounts([])).toEqual([]);
  });

  test('the counts are the list’s grouping: each count is exactly its rows, in the list’s order', () => {
    const nodes = [
      merged,
      fresh,
      working,
      ready,
      needs,
      replied,
      pr,
      blocked,
      closed,
      empty,
      finished,
    ];
    const groups = overviewGroups(nodes);
    const counts = overviewCounts(nodes);
    expect(counts).toEqual(groups.flatMap((g) => g.counts));
    for (const group of groups) {
      expect(group.rows).toEqual(group.counts.flatMap((c) => c.rows));
      for (const c of group.counts) {
        expect(c.count).toBe(c.rows.length);
        expect(c.rows.every((r) => overviewStatus(r) === c.status)).toBe(true);
        expect(c.group).toBe(group.key);
        // A count's filter shows exactly its rows.
        expect(overviewGroups(nodes, c.status).flatMap((g) => g.rows)).toEqual(c.rows);
      }
    }
    expect(counts.reduce((n, c) => n + c.count, 0)).toBe(nodes.length);
  });
});

describe('groups', () => {
  const nodes = [merged, fresh, working, ready, needs, replied, pr, blocked, closed, empty];

  test('your move, in progress, not running, finished; the most pressing first, then the tree order', () => {
    const groups = overviewGroups(nodes);
    expect(groups.map((g) => [g.key, g.title])).toEqual([
      ['you', 'Your move'],
      ['in_progress', 'In progress'],
      ['not_running', 'Not running'],
      ['finished', 'Finished'],
    ]);
    expect(groups.map((g) => g.rows.map((r) => r.id))).toEqual([
      ['needs', 'blocked', 'empty', 'ready'],
      ['working', 'pr'],
      ['replied', 'fresh'],
      ['merged', 'closed'],
    ]);
  });

  test('the same status keeps the tree order', () => {
    const a = row('a', { parent: 'root', agent_status: 'working' });
    const b = row('b', { parent: 'root', agent_status: 'working' });
    expect(overviewGroups([b, a])[0]?.rows.map((r) => r.id)).toEqual(['b', 'a']);
  });

  test('T395: the same status, most recently changed first', () => {
    const a = row('a', { parent: 'root', agent_status: 'working' });
    const b = row('b', { parent: 'root', agent_status: 'working' });
    const older = { ...b, updated_at: '2026-09-26T10:00:00.000Z' };
    const newer = { ...a, updated_at: '2026-09-26T11:00:00.000Z' };
    expect(overviewGroups([older, newer])[0]?.rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  test("T395: a row's last change, else when it was made", () => {
    const id = ulid();
    expect(lastChange({ id, updated_at: '2026-09-26T11:00:00.000Z' })).toBe(
      '2026-09-26T11:00:00.000Z',
    );
    expect(lastChange({ id })).toBe(new Date(createdAt(id) ?? 0).toISOString());
    expect(lastChange({ id: 'not-a-ulid' })).toBeUndefined();
  });

  test('a count keeps only its status; empty groups are left out', () => {
    expect(overviewGroups(nodes, 'ready').map((g) => g.rows.map((r) => r.id))).toEqual([['ready']]);
    expect(overviewGroups(nodes, 'needs_you')[0]?.rows.map((r) => r.id)).toEqual(['needs']);
    expect(overviewGroups(nodes, 'closed').map((g) => [g.key, g.rows.map((r) => r.id)])).toEqual([
      ['finished', ['closed']],
    ]);
    expect(overviewGroups(nodes, 'idle')).toEqual([]);
    expect(overviewGroups([working])).toHaveLength(1);
    expect(overviewGroups([])).toEqual([]);
  });
});

describe('the project’s nodes', () => {
  const coord = row('coord', { parent: 'root', role: 'coordinating', title: 'Show sale prices' });
  const part = row('part', { parent: 'coord', title: 'api: add salePrice' });
  const deep = row('deep', { parent: 'part', title: 'a helper' });
  const other = row('other', { project: 'P-2', title: 'Blog' });
  const loose = row('loose', { parent: 'other' });
  const rows = [ROOT, coord, other, part, loose, deep];

  test('everything under the root, in reading order, the root left out', () => {
    expect(projectNodes(rows, 'root').map((r) => r.id)).toEqual(['coord', 'part', 'deep']);
    expect(projectNodes(rows, 'nothing')).toEqual([]);
  });

  test('a node’s path is its ancestors below the root, outermost first', () => {
    expect(pathUnder(coord, rows, 'root')).toEqual([]);
    expect(pathUnder(part, rows, 'root')).toEqual(['Show sale prices']);
    expect(pathUnder(deep, rows, 'root')).toEqual(['Show sale prices', 'api: add salePrice']);
  });

  test('a cycle in the parents stops', () => {
    const x = row('x', { parent: 'y' });
    const y = row('y', { parent: 'x' });
    expect(pathUnder(x, [x, y], 'root')).toEqual(['y']);
  });
});

describe('repos', () => {
  test('the project’s own list first, then any other repo a node is on', () => {
    const nodes = [row('a', { repo: 'web' }), row('b', { repo: 'infra' }), row('c')];
    expect(projectRepoNames(['api', 'web'], nodes)).toEqual(['api', 'web', 'infra']);
    expect(projectRepoNames(undefined, [])).toEqual([]);
  });

  test('open nodes on a repo leave out the done ones', () => {
    const nodes = [
      row('a', { repo: 'web', agent_status: 'working' }),
      row('b', { repo: 'web', human_status: 'landed' }),
      row('c', { repo: 'api' }),
    ];
    expect(openNodesOn(nodes, 'web')).toBe(1);
    expect(openNodesOn(nodes, 'infra')).toBe(0);
  });
});

describe('age', () => {
  test('a ULID id says when the node was made', () => {
    const at = Date.UTC(2026, 8, 26, 10, 4, 5, 123);
    expect(createdAt(ulid(at))).toBe(at);
    expect(createdAt('not-a-ulid')).toBeUndefined();
    expect(createdAt('root')).toBeUndefined();
  });
});

describe('recent events', () => {
  const nodes = new Set(['root', 'a', 'b']);
  let n = 0;
  function event(extra: Partial<RoutedEvent> = {}): RoutedEvent {
    n += 1;
    return {
      id: `E-${String(n).padStart(4, '0')}`,
      type: 'human_line',
      payload: { body: 'hi' },
      by: 'human',
      at: new Date(Date.UTC(2026, 8, 26, 10, n)).toISOString(),
      routing: [],
      ...extra,
    } as RoutedEvent;
  }

  test('about one of its nodes; about no node, when it names the project or tells one of them', () => {
    expect(isProjectEvent(event({ subject: 'a' }), 'P-1', nodes)).toBe(true);
    expect(isProjectEvent(event({ subject: 'root' }), 'P-1', nodes)).toBe(true);
    expect(isProjectEvent(event({ subject: 'z', project: 'P-1' }), 'P-1', nodes)).toBe(false);
    expect(isProjectEvent(event({ project: 'P-1' }), 'P-1', nodes)).toBe(true);
    expect(
      isProjectEvent(
        event({ routing: [{ node: 'b', because: 'same_repo' }] } as Partial<RoutedEvent>),
        'P-1',
        nodes,
      ),
    ).toBe(true);
    expect(isProjectEvent(event({ project: 'P-2' }), 'P-1', nodes)).toBe(false);
    expect(isProjectEvent(event(), 'P-1', nodes)).toBe(false);
  });

  test('merged in: the project’s only, each once, newest first, at most the limit', () => {
    const e1 = event({ subject: 'a' });
    const e2 = event({ subject: 'z' });
    const e3 = event({ subject: 'b' });
    const e4 = event({ subject: 'root' });
    const first = recentProjectEvents([], [e4, e3, e2, e1], 'P-1', nodes, 2);
    expect(first.map((e) => e.id)).toEqual([e4.id, e3.id]);
    // An older page adds nothing newer than what is shown.
    expect(recentProjectEvents(first, [e1], 'P-1', nodes, 2)).toBe(first);
    // A newer one goes on top; the oldest falls off.
    const e5 = event({ subject: 'a' });
    expect(recentProjectEvents(first, [e5, e4], 'P-1', nodes, 2).map((e) => e.id)).toEqual([
      e5.id,
      e4.id,
    ]);
    // Nothing new: the same array.
    expect(recentProjectEvents(first, [e4, e3, e2], 'P-1', nodes, 2)).toBe(first);
    expect(recentProjectEvents([], [], 'P-1', nodes)).toEqual([]);
  });
});
