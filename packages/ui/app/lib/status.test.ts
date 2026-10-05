import { describe, expect, test } from 'bun:test';
import {
  ago,
  isYourMove,
  nodeStatus,
  ownStatusKey,
  partsSummary,
  statusFromPart,
  statusKey,
  withParts,
} from './status';

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

describe('T437: your move, and a coordinator with its own branch', () => {
  test('a plan, gate or proposal of the node waiting on you reads Needs you', () => {
    expect(
      statusKey({
        agent_status: 'done',
        human_status: 'open',
        role: 'coordinating',
        pending_decision: true,
      }),
    ).toBe('needs_you');
    expect(
      statusKey({
        agent_status: 'idle',
        human_status: 'open',
        role: 'coordinating',
        never_started: true,
        pending_decision: true,
      }),
    ).toBe('needs_you');
  });

  test('a coordinating node that kept its own branch reads Ready to merge when done; one without, Done', () => {
    expect(
      statusKey({ agent_status: 'done', human_status: 'open', role: 'coordinating', repo: 'api' }),
    ).toBe('ready');
    expect(statusKey({ agent_status: 'done', human_status: 'open', role: 'coordinating' })).toBe(
      'done',
    );
  });
});

describe('T447 (audit r7 #2): a coordinating node rolls up its parts', () => {
  type Row = import('./feed-types').CockpitStreamRow;
  const row = (id: string, extra: Partial<Row> = {}): Row => ({
    id,
    title: id,
    role: 'work',
    agent_status: 'idle',
    human_status: 'open',
    ...extra,
  });
  const coord = (extra: Partial<Row> = {}) =>
    row('sale', { role: 'coordinating', parent: 'root', agent_status: 'done', ...extra });
  const rolled = (rows: Row[], id = 'sale') => withParts(rows).find((r) => r.id === id) as Row;

  test('Done only when every part is merged or closed', () => {
    const all = [
      coord(),
      row('api part', { parent: 'sale', human_status: 'landed' }),
      row('web part', { parent: 'sale', human_status: 'closed' }),
    ];
    const sale = rolled(all);
    expect(statusKey(sale)).toBe('done');
    expect(sale.parts).toEqual({ total: 2, merged: 1, closed: 1, open: 0 });
    expect(nodeStatus(sale).hint).toBe('Every part is merged or closed.');
    expect(partsSummary(sale.parts)).toBe('1 of 1 merged · 1 closed · every part finished');
  });

  test('otherwise its most urgent part: Needs you > Blocked > Ready to merge > Working > Not started', () => {
    const parts: Row[] = [
      row('a', { parent: 'sale', never_started: true }),
      row('b', { parent: 'sale', agent_status: 'working', live: true }),
      row('c', { parent: 'sale', agent_status: 'done' }),
      row('d', { parent: 'sale', agent_status: 'blocked' }),
      row('e', { parent: 'sale', agent_status: 'question' }),
    ];
    const expected = ['not_started', 'working', 'ready', 'blocked', 'needs_you'];
    for (let n = 1; n <= parts.length; n++) {
      expect(statusKey(rolled([coord(), ...parts.slice(0, n)]))).toBe(expected[n - 1] as never);
    }
    const sale = rolled([coord(), ...parts]);
    expect(statusFromPart(sale)).toBe(true);
    expect(nodeStatus(sale)).toMatchObject({ label: 'Needs you', hint: 'A part waits on you: e.' });
    expect(partsSummary(sale.parts)).toBe('0 of 5 merged · e needs you');
  });

  test('"2 of 4 merged · waiting for web part"', () => {
    const sale = rolled([
      coord(),
      row('api part', { parent: 'sale', human_status: 'landed' }),
      row('docs part', { parent: 'sale', human_status: 'landed' }),
      row('web part', { parent: 'sale', agent_status: 'working', live: true }),
      row('rss part', { parent: 'sale', never_started: true }),
    ]);
    expect(statusKey(sale)).toBe('working');
    expect(partsSummary(sale.parts)).toBe('2 of 4 merged · waiting for web part and 1 more');
  });

  test("its own question, block or work still counts; its own merge and close win; conversations aren't parts", () => {
    const working = [row('p', { parent: 'sale', never_started: true })];
    expect(statusKey(rolled([coord({ agent_status: 'question' }), ...working]))).toBe('needs_you');
    expect(statusKey(rolled([coord({ agent_status: 'working' }), ...working]))).toBe('working');
    expect(statusKey(rolled([coord({ human_status: 'closed' }), ...working]))).toBe('closed');
    const sale = rolled([coord(), row('q', { parent: 'sale', role: 'conversation' })]);
    expect(sale.parts).toBeUndefined();
    expect(statusKey(sale)).toBe('done');
    // Its own status for Delivery leaves the parts out.
    expect(ownStatusKey(rolled([coord(), ...working]))).toBe('done');
  });

  test('nested: a coordinating part reads as its own parts, and a project root as its top-level nodes', () => {
    const all = [
      row('root', { role: 'project', never_started: true }),
      coord(),
      row('sub', { parent: 'sale', role: 'coordinating', agent_status: 'done' }),
      row('leaf', { parent: 'sub', agent_status: 'done' }),
      row('talk', { parent: 'root', role: 'conversation', agent_status: 'done' }),
    ];
    const rows = withParts(all);
    const key = (id: string) => statusKey(rows.find((r) => r.id === id) as Row);
    expect(key('sub')).toBe('ready');
    expect(key('sale')).toBe('ready');
    expect(key('root')).toBe('ready');
    // It names the node to open, however deep: the leaf, not the coordinators above it.
    expect(rows.find((r) => r.id === 'root')?.parts?.lead).toEqual({
      id: 'leaf',
      title: 'leaf',
      key: 'ready',
    });
    // A row with nothing to roll up comes back as it was.
    expect(rows.find((r) => r.id === 'leaf')).toBe(all[3]);
  });
});
