import { describe, expect, test } from 'bun:test';
import {
  type NodeRole,
  ROUTED_EVENT_TYPES,
  type RoutedEventType,
  type Stream,
} from '@agile-agents/shared';
import { WakeBudget, stoppedByHuman, wakeVerdict, wakesRole } from './wake';

const WORK: RoutedEventType[] = [
  'human_line',
  'answer',
  'pr_review',
  'ci_failed',
  'ship_findings',
  'pr_behind',
  'sync_conflict',
  'contract_changed',
];
const CONVERSATION: RoutedEventType[] = ['human_line', 'answer'];

describe('wakesRole (P11 table)', () => {
  const expected: Record<NodeRole, (t: RoutedEventType) => boolean> = {
    coordinating: () => true,
    work: (t) => WORK.includes(t),
    conversation: (t) => CONVERSATION.includes(t),
    project: () => false,
  };
  for (const role of Object.keys(expected) as NodeRole[]) {
    for (const type of ROUTED_EVENT_TYPES) {
      const wakes = expected[role](type);
      test(`${role} × ${type} → ${wakes ? 'wake' : 'wait'}`, () => {
        expect(wakesRole(role, type)).toBe(wakes);
      });
    }
  }
});

function node(over: Partial<Stream> = {}): Stream {
  return {
    agent: { status: 'done' },
    human: { status: 'open' },
    sessions: [{ role: 'worker' }],
    ...over,
  } as unknown as Stream;
}

describe('wakeVerdict', () => {
  test('a finished work node wakes on ci_failed, waits on main_changed', () => {
    expect(wakeVerdict(node(), 'work', [{ type: 'ci_failed' }])).toBe('wake');
    expect(wakeVerdict(node(), 'work', [{ type: 'main_changed' }])).toBe('no_trigger');
    expect(wakeVerdict(node(), 'work', [{ type: 'main_changed' }, { type: 'answer' }])).toBe(
      'wake',
    );
  });
  test('stopped nodes are never woken', () => {
    for (const stopped of [
      node({ agent: { status: 'idle' } } as Partial<Stream>),
      node({ archived: true }),
      node({ human: { status: 'closed' } } as Partial<Stream>),
      node({ human: { status: 'landed' } } as Partial<Stream>),
    ]) {
      expect(stoppedByHuman(stopped)).toBe(true);
      expect(wakeVerdict(stopped, 'work', [{ type: 'human_line' }])).toBe('stopped');
    }
    expect(stoppedByHuman(node({ agent: { status: 'blocked' } } as Partial<Stream>))).toBe(false);
  });
  test('an idle the daemon set by stopping the worker (a reshape) is not a human stop', () => {
    const reshaped = node({
      agent: { status: 'idle' },
      sessions: [{ role: 'worker', status: 'stopped', ended_reason: 'stopped: reshape' }],
    } as Partial<Stream>);
    expect(stoppedByHuman(reshaped)).toBe(false);
    expect(wakeVerdict(reshaped, 'work', [{ type: 'human_line' }])).toBe('wake');
    // A detach records no ended_reason: still the human's stop.
    const detached = node({
      agent: { status: 'idle' },
      sessions: [{ role: 'worker', status: 'stopped' }],
    } as Partial<Stream>);
    expect(stoppedByHuman(detached)).toBe(true);
  });
  test('a project node, or a coordinating node that never had an agent, is not woken', () => {
    expect(wakeVerdict(node(), 'project', [{ type: 'human_line' }])).toBe('no_agent');
    expect(wakeVerdict(node({ sessions: [] }), 'coordinating', [{ type: 'overlap' }])).toBe(
      'no_agent',
    );
    expect(wakeVerdict(node(), 'coordinating', [{ type: 'overlap' }])).toBe('wake');
    const coordinated = node({ sessions: [{ role: 'coordinator' }] } as Partial<Stream>);
    expect(wakeVerdict(coordinated, 'coordinating', [{ type: 'child_status' }])).toBe('wake');
  });
});

describe('WakeBudget', () => {
  test('20 wakes per node per hour, then refused until the hour rolls', () => {
    let t = 0;
    const budget = new WakeBudget(() => t);
    for (let i = 0; i < 20; i++) {
      expect(budget.take('A', 20)).toBe(true);
      t += 1000;
    }
    expect(budget.take('A', 20)).toBe(false);
    expect(budget.take('B', 20)).toBe(true);
    t = 3_600_000;
    expect(budget.take('A', 20)).toBe(true);
    expect(budget.take('A', 20)).toBe(false);
  });
});
