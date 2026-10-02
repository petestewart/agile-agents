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
  'coordinator_note',
];
// D36 D10 (T351, narrowed by T453): an accepted item the conversation proposed wakes it.
const CONVERSATION: RoutedEventType[] = ['human_line', 'answer', 'knowledge_accepted'];

describe('wakesRole (P11 table)', () => {
  // T446, T456, T481, T484: a record (`autonomy_applied`, `agent_restarted`, `harness_updated`,
  // `model_escalated`) wakes nobody, a coordinator included. T504: nor a quiet one
  // (`thread_archived`, which rides the next digest).
  const record = (t: RoutedEventType) =>
    t === 'autonomy_applied' ||
    t === 'agent_restarted' ||
    t === 'harness_updated' ||
    t === 'model_escalated' ||
    t === 'thread_archived';
  const expected: Record<NodeRole, (t: RoutedEventType) => boolean> = {
    coordinating: (t) => !record(t),
    work: (t) => WORK.includes(t),
    conversation: (t) => CONVERSATION.includes(t),
    project: (t) => !record(t),
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
  test("T290: a parent's coordinator_note wakes an ended work node, never a stopped one", () => {
    expect(wakeVerdict(node(), 'work', [{ type: 'coordinator_note' }])).toBe('wake');
    const landed = node({ human: { status: 'landed' } } as Partial<Stream>);
    expect(wakeVerdict(landed, 'work', [{ type: 'coordinator_note' }])).toBe('stopped');
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
  test('a project root or coordinating node that never had an agent is not woken', () => {
    expect(wakeVerdict(node(), 'project', [{ type: 'human_line' }])).toBe('no_agent');
    expect(wakeVerdict(node({ sessions: [] }), 'coordinating', [{ type: 'overlap' }])).toBe(
      'no_agent',
    );
    expect(wakeVerdict(node(), 'coordinating', [{ type: 'overlap' }])).toBe('wake');
    const coordinated = node({ sessions: [{ role: 'coordinator' }] } as Partial<Stream>);
    expect(wakeVerdict(coordinated, 'coordinating', [{ type: 'child_status' }])).toBe('wake');
    // P20: a project root is woken once it has had a coordinator.
    expect(wakeVerdict(coordinated, 'project', [{ type: 'child_status' }])).toBe('wake');
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

describe('T453 (Q25): accepted knowledge wakes only the conversation it came from', () => {
  const CONVERSATION_ID = '01HZX8W9Q7M3N4P5R6S7T8V9W0';
  const accepted = (source?: string) => ({
    type: 'knowledge_accepted' as const,
    payload: { item: 'K-1', ...(source !== undefined ? { source } : {}) },
  });
  test('the conversation that proposed the item wakes; a stopped one does not', () => {
    const own = node({ id: CONVERSATION_ID } as Partial<Stream>);
    expect(wakeVerdict(own, 'conversation', [accepted(own.id)])).toBe('wake');
    const detached = node({ id: CONVERSATION_ID, agent: { status: 'idle' } } as Partial<Stream>);
    expect(wakeVerdict(detached, 'conversation', [accepted(detached.id)])).toBe('stopped');
  });
  test('another conversation in scope waits for its next turn', () => {
    expect(wakeVerdict(node(), 'conversation', [accepted('01ARZ3NDEKTSV4RRFFQ69G5FAV')])).toBe(
      'no_trigger',
    );
    // An item you wrote yourself came from no node: it wakes no conversation.
    expect(wakeVerdict(node(), 'conversation', [accepted()])).toBe('no_trigger');
    // Your line still wakes it, and the item goes with it.
    expect(
      wakeVerdict(node(), 'conversation', [accepted(), { type: 'human_line', payload: {} }]),
    ).toBe('wake');
  });
  test('coordinators still wake on any accepted item; a work node waits (P11)', () => {
    expect(
      wakeVerdict(
        node({ sessions: [{ role: 'coordinator' }] } as Partial<Stream>),
        'coordinating',
        [accepted()],
      ),
    ).toBe('wake');
    expect(wakeVerdict(node(), 'work', [accepted()])).toBe('no_trigger');
  });
});

describe('T454: an accepted item Jev judged relevant wakes another conversation', () => {
  const accepted = { id: 'E-1', type: 'knowledge_accepted' as const, payload: { item: 'K-1' } };
  const heard = (e: { id?: string }) => e.id === 'E-1';
  test('heard: the conversation wakes; unheard, it waits; stopped stays stopped', () => {
    expect(wakeVerdict(node(), 'conversation', [accepted], heard)).toBe('wake');
    expect(wakeVerdict(node(), 'conversation', [accepted], () => false)).toBe('no_trigger');
    const detached = node({ agent: { status: 'idle' } } as Partial<Stream>);
    expect(wakeVerdict(detached, 'conversation', [accepted], heard)).toBe('stopped');
  });
  test('a work node still waits (P11): Jev only speaks for conversations', () => {
    expect(wakeVerdict(node(), 'work', [accepted], heard)).toBe('no_trigger');
  });
});
