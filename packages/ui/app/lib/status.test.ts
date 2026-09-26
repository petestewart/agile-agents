import { describe, expect, test } from 'bun:test';
import { ago, isYourMove, nodeStatus, statusKey } from './status';

const base = { agent_status: 'idle', human_status: 'open' } as const;

describe('statusKey (T360, design/cockpit-ui.md §6)', () => {
  test('the human half wins: merged and closed', () => {
    expect(statusKey({ ...base, human_status: 'landed', agent_status: 'working' })).toBe('merged');
    expect(statusKey({ ...base, human_status: 'closed' })).toBe('closed');
  });

  test('a question or a waiting-on-you node needs you', () => {
    expect(statusKey({ ...base, agent_status: 'question' })).toBe('needs_you');
    expect(statusKey({ ...base, human_status: 'waiting_on_you' })).toBe('needs_you');
  });

  test('done: ready to merge on a work node, done where nothing merges, PR open on a PR', () => {
    expect(statusKey({ ...base, agent_status: 'done', role: 'work' })).toBe('ready');
    expect(
      statusKey({ ...base, agent_status: 'done', role: 'work', human_status: 'waiting_on_you' }),
    ).toBe('ready');
    expect(statusKey({ ...base, agent_status: 'done', role: 'coordinating' })).toBe('done');
    expect(statusKey({ ...base, agent_status: 'done', role: 'conversation', project: 'P-1' })).toBe(
      'done',
    );
    expect(statusKey({ ...base, agent_status: 'done', role: 'work', pr_open: true })).toBe(
      'pr_open',
    );
  });

  test('T380: a finished work node with nothing to merge reads "No changes", still your move', () => {
    const empty = { ...base, agent_status: 'done', role: 'work', nothing_to_merge: true } as const;
    expect(statusKey(empty)).toBe('no_changes');
    expect(statusKey({ ...empty, human_status: 'waiting_on_you' })).toBe('no_changes');
    expect(nodeStatus(empty).label).toBe('No changes');
    expect(nodeStatus(empty).tone).toBe('amber');
    expect(isYourMove('no_changes')).toBe(true);
    // Where nothing merges anyway, the flag changes nothing.
    expect(statusKey({ ...empty, role: 'coordinating' })).toBe('done');
    expect(statusKey({ ...empty, pr_open: true })).toBe('pr_open');
  });

  test('blocked, waiting for the plan, working', () => {
    expect(statusKey({ ...base, agent_status: 'blocked' })).toBe('blocked');
    expect(statusKey({ ...base, waiting_for_plan: true, agent_status: 'working' })).toBe('waiting');
    expect(statusKey({ ...base, agent_status: 'working' })).toBe('working');
  });

  test('no agent: not started, stopped, waits on, idle', () => {
    expect(statusKey({ ...base, never_started: true })).toBe('not_started');
    expect(statusKey({ ...base, stopped: true })).toBe('stopped');
    expect(statusKey({ ...base, waits_on: ['S-1'] })).toBe('waiting');
    expect(statusKey(base)).toBe('idle');
    // A live idle session is idle whatever the flags say.
    expect(statusKey({ ...base, live: true, never_started: true })).toBe('idle');
  });

  test('labels and whose move', () => {
    expect(nodeStatus({ ...base, agent_status: 'done', role: 'work' }).label).toBe(
      'Ready to merge',
    );
    expect(
      nodeStatus({ ...base, agent_status: 'done', role: 'conversation', project: 'P-1' }).label,
    ).toBe('Replied');
    expect(nodeStatus({ ...base, agent_status: 'done', role: 'coordinating' }).label).toBe('Done');
    expect(isYourMove('ready')).toBe(true);
    expect(isYourMove('working')).toBe(false);
  });
});

describe('ago', () => {
  const now = Date.parse('2026-09-26T12:00:00Z');
  test('compact ages', () => {
    expect(ago('2026-09-26T11:59:50Z', now)).toBe('now');
    expect(ago('2026-09-26T11:55:00Z', now)).toBe('5m');
    expect(ago('2026-09-26T09:00:00Z', now)).toBe('3h');
    expect(ago('2026-09-23T12:00:00Z', now)).toBe('3d');
    expect(ago('not a date', now)).toBe('');
  });
});

describe('T412: one verdict on a finished branch', () => {
  const finished = { agent_status: 'done', human_status: 'waiting_on_you', role: 'work' } as const;

  test('already in its target: your move, "Already merged"', () => {
    const status = nodeStatus({ ...finished, merged_outside: true });
    expect([status.key, status.label, status.tone]).toEqual([
      'merged_outside',
      'Already merged',
      'amber',
    ]);
    expect(isYourMove(status.key)).toBe(true);
    // Before the waits: a merged branch has nothing left to wait for.
    expect(statusKey({ ...finished, merged_outside: true, waits_on: ['x'] })).toBe(
      'merged_outside',
    );
  });

  test('waits on another node: Waiting, not Ready to merge', () => {
    expect(statusKey({ ...finished, waits_on: ['x'] })).toBe('waiting');
    expect(
      statusKey({ ...finished, agent_status: 'done', human_status: 'open', waits_on: ['x'] }),
    ).toBe('waiting');
    expect(isYourMove('waiting')).toBe(false);
    expect(statusKey(finished)).toBe('ready');
  });
});
