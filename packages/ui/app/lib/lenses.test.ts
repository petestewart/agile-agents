/**
 * T368: the lenses' and the event log's words and ordering. Plain `bun test`, no DOM.
 */

import { describe, expect, test } from 'bun:test';
import type { RoutedEvent } from '@agile-agents/shared';
import type { CockpitStreamRow } from './feed-types';
import {
  EVENT_FAMILY,
  ROUTE_REASON,
  clip,
  deliveryHint,
  deliveryWords,
  dependencyGroups,
  eventDetail,
  eventFamily,
  eventTitle,
  filterEvents,
  groupByDay,
  isSatisfied,
  runningAgent,
  runningSummary,
  sortNewestFirst,
  sortRunning,
} from './lenses';
import { eventLabel } from './streams';

function row(id: string, extra: Partial<CockpitStreamRow> = {}): CockpitStreamRow {
  return { id, title: id, role: 'work', agent_status: 'idle', human_status: 'open', ...extra };
}

function event(
  id: string,
  type: RoutedEvent['type'],
  payload: Record<string, unknown>,
  extra: Partial<RoutedEvent> = {},
): RoutedEvent {
  return {
    id,
    type,
    payload,
    by: 'daemon',
    at: '2026-09-26T10:00:00.000Z',
    routing: [],
    ...extra,
  };
}

const titles: Record<string, string> = { N1: 'Add CSV import', N2: 'Fix rounding' };
const titleOf = (id: string): string => titles[id] ?? id;

describe('delivery in words', () => {
  test('direct merges, pr opens pull requests', () => {
    expect(deliveryWords('direct')).toBe('Merges directly');
    expect(deliveryWords('pr')).toBe('Opens pull requests');
  });

  test('the hint names the target branch and auto-merge', () => {
    expect(deliveryHint('direct', { main: 'trunk' })).toContain('into trunk');
    expect(deliveryHint('pr', { autoMerge: true })).toContain('Auto-merge is on');
    expect(deliveryHint('pr')).not.toContain('Auto-merge');
  });
});

describe('Running', () => {
  const rows = [
    row('idle-b', { title: 'b idle', live: true }),
    row('work', { title: 'working', agent_status: 'working', live: true }),
    row('ask', { title: 'asks', agent_status: 'question', live: true }),
    row('idle-a', { title: 'a idle', live: true }),
  ];

  test('your move first, then working, then idle, alphabetical within', () => {
    expect(sortRunning(rows).map((r) => r.id)).toEqual(['ask', 'work', 'idle-a', 'idle-b']);
  });

  test('the summary counts each kind in words', () => {
    expect(runningSummary(rows)).toBe('1 needs you · 1 working · 2 idle');
    expect(runningSummary([rows[1] as CockpitStreamRow])).toBe('1 working');
    expect(runningSummary([])).toBe('');
  });

  test("T382: each row names its agent, model and effort; a reviewer says it's one", () => {
    const agent = (live_agent: CockpitStreamRow['live_agent']) =>
      runningAgent(row('n', { live: true, live_agent }));
    expect(
      agent({ role: 'worker', vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' }),
    ).toEqual({
      text: 'Claude Opus 5.5 · low',
      title: 'Worker: claude/claude-opus-5-5 · low effort',
    });
    expect(
      agent({ role: 'coordinator', vendor: 'gemini', model: 'default', effort: 'high' }),
    ).toEqual({
      text: 'Gemini default model · high',
      title: 'Coordinator: gemini/default · high effort',
    });
    expect(agent({ role: 'reviewer', vendor: 'codex', model: 'gpt-9' })).toEqual({
      text: 'Reviewer · Codex · gpt-9',
      title: 'Reviewer: codex/gpt-9',
    });
    expect(agent({ role: 'lessons', vendor: 'claude', model: 'claude-haiku-4-5' })?.text).toBe(
      'Lessons pass · Claude Haiku 4.5',
    );
    // An older daemon's row says nothing about its session.
    expect(runningAgent(row('old', { live: true }))).toBeUndefined();
  });
});

describe('dependencyGroups', () => {
  test('one group per waiting node, in order, with every node it waits on', () => {
    const rows = [row('a', { waits_on: ['b', 'c'] }), row('b'), row('c', { waits_on: ['gone'] })];
    const groups = dependencyGroups(rows);
    expect(groups.map((g) => g.from.id)).toEqual(['a', 'c']);
    expect(groups[0]?.on.map((o) => (typeof o === 'string' ? o : o.id))).toEqual(['b', 'c']);
    expect(groups[1]?.on).toEqual(['gone']);
  });

  test('a merged or closed node is satisfied; an unknown one is not', () => {
    expect(isSatisfied(row('x', { human_status: 'landed' }))).toBe(true);
    expect(isSatisfied(row('x', { human_status: 'closed' }))).toBe(true);
    expect(isSatisfied(row('x'))).toBe(false);
    expect(isSatisfied('gone')).toBe(false);
  });
});

describe('event families and reasons', () => {
  test('every family is one of four; an unknown type is coordination', () => {
    expect(new Set(Object.values(EVENT_FAMILY))).toEqual(
      new Set(['messages', 'delivery', 'coordination', 'knowledge']),
    );
    expect(eventFamily('human_line')).toBe('messages');
    expect(eventFamily('pr_merged')).toBe('delivery');
    expect(eventFamily('overlap')).toBe('coordination');
    expect(eventFamily('knowledge_accepted')).toBe('knowledge');
    expect(eventFamily('nope')).toBe('coordination');
  });

  test('every routing reason has words and a sentence', () => {
    for (const reason of Object.values(ROUTE_REASON)) {
      expect(reason.label).not.toMatch(/_/);
      expect(reason.hint).toMatch(/\.$/);
    }
    expect(ROUTE_REASON.same_repo.label).toBe('same repo');
  });
});

describe('eventTitle', () => {
  test('eventLabel capitalised, PR and CI in capitals', () => {
    expect(eventTitle(event('E1', 'human_line', { body: 'x' }))).toBe('Human line');
    expect(eventTitle(event('E1', 'pr_merged', { pr: 3, repo: 'a', sha: 'b' }))).toBe('PR merged');
    expect(eventTitle(event('E1', 'pr_merged', { repo: 'a', sha: 'b' }))).toBe('Merged');
    expect(eventTitle(event('E1', 'ci_failed', { pr: 3, check: 'lint' }))).toBe('CI failed');
    expect(eventTitle(event('E1', 'main_changed', {}))).toBe('Main changed');
    expect(eventTitle(event('E1', 'child_delivered', {}))).toBe('Child delivered');
  });
});

describe('eventDetail', () => {
  test('a message reads as its first line', () => {
    expect(eventDetail(event('E1', 'human_line', { body: 'Round half to even.\nThanks' }))).toBe(
      'Round half to even.',
    );
  });

  test('a PR review names the reviewer, the verdict and the first comment', () => {
    expect(
      eventDetail(
        event('E1', 'pr_review', {
          pr: 42,
          login: 'maria',
          state: 'changes_requested',
          comments: ['Use the token.'],
        }),
      ),
    ).toBe('maria asked for changes on PR #42: Use the token.');
  });

  test('a merge without a PR reads as a merge, with a short sha', () => {
    expect(eventDetail(event('E1', 'pr_merged', { repo: 'api', sha: 'abcdef1234567' }))).toBe(
      'Merged into api at abcdef1',
    );
    expect(eventDetail(event('E1', 'pr_merged', { pr: 4, repo: 'api', sha: 'abc' }))).toBe(
      'PR #4 merged into api at abc',
    );
  });

  test('ids read as titles', () => {
    expect(
      eventDetail(
        event('E1', 'overlap', { other: 'N2', files: ['a.ts', 'b.ts', 'c.ts'] }),
        titleOf,
      ),
    ).toBe('Changes the same files as Fix rounding: a.ts, b.ts and 1 more');
    expect(
      eventDetail(event('E1', 'dependency_satisfied', { node: 'N1', outcome: 'merged' }), titleOf),
    ).toBe('Add CSV import merged; nothing waits on it now');
  });

  test('main moved, with what happened to the nodes on it', () => {
    expect(
      eventDetail(
        event('E1', 'main_changed', { repo: 'api', sha: '1234567890', outcome: 'synced' }),
      ),
    ).toBe('api main moved to 1234567 · nodes on it synced');
  });

  test('ship findings show the first and count the rest', () => {
    expect(
      eventDetail(
        event('E1', 'ship_findings', {
          source: 'classifier',
          findings: ['a', 'b'],
          more_findings: 3,
        }),
      ),
    ).toBe('a (+4 more)');
  });

  test('a long detail is clipped; nothing to say is undefined', () => {
    const long = 'x'.repeat(300);
    expect(eventDetail(event('E1', 'human_line', { body: long }))?.length).toBe(140);
    expect(eventDetail(event('E1', 'plan_changed', {}))).toBeUndefined();
  });

  test('clip keeps the first non-empty line', () => {
    expect(clip('\n\n  hello   world \nnext')).toBe('hello world');
    expect(clip('abcdef', 4)).toBe('abc…');
  });
});

describe('the event log', () => {
  const events = [
    event('E1', 'human_line', { body: 'hi there' }, { subject: 'N1', at: '2026-09-26T09:00:00Z' }),
    event(
      'E2',
      'pr_merged',
      { repo: 'api', sha: 'abc' },
      { subject: 'N2', repo: 'api', at: '2026-09-26T11:00:00Z' },
    ),
    event(
      'E3',
      'knowledge_accepted',
      { item: 'K', kind: 'standard', text: 'cents', enforcement: 'tell' },
      { at: '2026-09-25T11:00:00Z', routing: [{ node: 'N1', because: 'party' }] },
    ),
  ];

  test('newest first by time; ties keep the log order', () => {
    expect(sortNewestFirst(events).map((e) => e.id)).toEqual(['E2', 'E1', 'E3']);
    const same = [event('A', 'human_line', { body: 'a' }), event('B', 'human_line', { body: 'b' })];
    expect(sortNewestFirst(same).map((e) => e.id)).toEqual(['A', 'B']);
  });

  test('filters by family, repo and words over what the row says', () => {
    const run = (filter: Parameters<typeof filterEvents>[1]) =>
      filterEvents(events, filter, titleOf, eventLabel).map((e) => e.id);
    expect(run({ family: 'all', query: '' })).toEqual(['E1', 'E2', 'E3']);
    expect(run({ family: 'delivery', query: '' })).toEqual(['E2']);
    expect(run({ family: 'all', query: '', repo: 'api' })).toEqual(['E2']);
    expect(run({ family: 'all', query: 'csv' })).toEqual(['E1', 'E3']);
    expect(run({ family: 'all', query: 'merged rounding' })).toEqual(['E2']);
    expect(run({ family: 'all', query: 'cents' })).toEqual(['E3']);
  });

  test('groupByDay keeps consecutive events of a day together', () => {
    const now = new Date(2026, 8, 26, 15, 0).getTime();
    const at = (d: number, h: number) => ({ at: new Date(2026, 8, d, h).toISOString() });
    const days = groupByDay([at(26, 14), at(26, 9), at(25, 20), at(24, 8), at(24, 7)], now);
    expect(days.map((d) => d.events.length)).toEqual([2, 1, 2]);
    expect(days.slice(0, 2).map((d) => d.day)).toEqual(['Today', 'Yesterday']);
    expect(days[2]?.day).not.toBe('Yesterday');
  });
});
