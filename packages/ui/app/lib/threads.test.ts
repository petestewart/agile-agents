import { describe, expect, test } from 'bun:test';
import type { ChatThread } from '@agile-agents/shared';
import {
  anchorFor,
  anchorLabel,
  findPassage,
  moveTargets,
  movesByLine,
  openThreadsChip,
  placeChatThreads,
  quoteOf,
  threadReadKey,
  threadRepliesText,
  threadStateWords,
  threadUnread,
} from './threads';
import { parseSeen, unreadThreads } from './unread';

const NODE = '01ARZ3NDEKTSV4RRFFQ69GE001';

function thread(id: string, extra: Partial<ChatThread> = {}): ChatThread {
  return {
    id,
    stream: NODE,
    anchor: { entry: 't0' },
    state: 'open',
    replies: 1,
    entries: [id],
    last_at: id,
    ...extra,
  };
}

describe('placeChatThreads (T503, §6)', () => {
  const loaded = [
    { ts: 't0', kind: 'line' as const },
    { ts: 't1', kind: 'line' as const },
    { ts: 't2', kind: 'line' as const },
    { ts: 't3', kind: 'question' as const },
    { ts: 't4', kind: 'line' as const },
    { ts: 't5', kind: 'line' as const },
  ];

  test('marks sit under the turn in passage order; a thread’s lines leave the flow, its question stays', () => {
    const whole = thread('t1', { entries: ['t1', 't2', 't3'] });
    const late = thread('t4', { anchor: { entry: 't0', start: 30, end: 40, quote: 'later' } });
    const early = thread('t5', { anchor: { entry: 't0', start: 2, end: 9, quote: 'early' } });
    const placed = placeChatThreads([whole, late, early], [], loaded);
    expect(placed.marksOn.get('t0')?.map((t) => t.id)).toEqual(['t5', 't4', 't1']);
    expect([...placed.nested].sort()).toEqual(['t1', 't2', 't4', 't5']);
    // What needs you never hides in a folded thread (§6): the question stays, linked.
    expect(placed.alsoIn.get('t3')).toBe(whole);
  });

  test('a thread on a turn above the loaded lines keeps its lines in the flow', () => {
    const orphan = thread('t1', { anchor: { entry: 'older' }, entries: ['t1', 't2'] });
    const placed = placeChatThreads([orphan], [], loaded);
    expect(placed.nested.size).toBe(0);
    expect(placed.marksOn.get('t1')).toEqual([orphan]);
  });

  test('a batched turn’s first line links the threads it replies to', () => {
    const a = thread('t1');
    const b = thread('t2');
    const placed = placeChatThreads(
      [a, b],
      [{ entries: ['t4', 't5'], threads: ['t1', 't2'] }],
      loaded,
    );
    expect(placed.repliesTo.get('t4')).toEqual([a, b]);
    expect(placed.repliesTo.has('t5')).toBe(false);
  });
});

describe('a thread in words (T503)', () => {
  test('its passage, its state, its replies', () => {
    expect(anchorLabel({})).toBe('whole message');
    expect(anchorLabel({ quote: 'banker’s\nrounding' })).toBe('“banker’s rounding”');
    expect(anchorLabel({ quote: 'x'.repeat(60) }, 10)).toBe(`“${'x'.repeat(9)}…”`);
    expect(threadStateWords({ state: 'open' })).toBeUndefined();
    expect(threadStateWords({ state: 'waits_on_you' })).toEqual({
      text: 'waiting on you',
      tone: 'amber',
    });
    expect(threadStateWords({ state: 'waiting_on_agent', vendor: 'codex' })?.text).toBe(
      'waiting on Codex',
    );
    expect(threadStateWords({ state: 'resolved' })?.tone).toBe('green');
    expect([threadRepliesText(1), threadRepliesText(3)]).toEqual(['1 reply', '3 replies']);
  });
});

describe('unread (T503, §6)', () => {
  const by: Record<string, string> = { a: 'human', b: 'agent:x', c: 'agent:x', d: 'daemon' };
  const t = thread('a', { entries: ['a', 'b', 'c', 'd'], reply_at: 'd' });

  test('a thread’s unread: its lines not yours since your read mark', () => {
    expect(threadUnread(t, (ts) => by[ts], '0')).toBe(3);
    expect(threadUnread(t, (ts) => by[ts], 'b')).toBe(2);
    expect(threadUnread(t, (ts) => by[ts], 'd')).toBe(0);
    expect(threadUnread({ ...t, reply_at: undefined }, (ts) => by[ts], '0')).toBe(0);
  });

  test('the chip counts the threads not resolved and jumps to the first unread', () => {
    const resolved = thread('r', { state: 'resolved' });
    const waits = thread('w', { state: 'waits_on_you' });
    const fresh = thread('f');
    const chip = openThreadsChip([resolved, waits, fresh], (x) => (x === fresh ? 2 : 0));
    expect(chip).toMatchObject({ count: 2, unread: 1, target: fresh });
    expect(openThreadsChip([resolved, waits, fresh], () => 0).target).toBe(waits);
    expect(openThreadsChip([resolved], () => 0)).toEqual({
      count: 0,
      unread: 0,
      target: undefined,
    });
  });

  test('the rail row: threads with a reply after their read mark', () => {
    const seen = parseSeen(
      JSON.stringify({
        since: '2026-10-02T09:00:00.000Z',
        nodes: { [threadReadKey(NODE, 'x')]: '2026-10-02T10:10:00.000Z' },
      }),
      'now',
    );
    const row = {
      id: NODE,
      thread_replies: [
        { thread: 'x', at: '2026-10-02T10:05:00.000Z' },
        { thread: 'y', at: '2026-10-02T10:06:00.000Z' },
        { thread: 'z', at: '2026-10-02T08:00:00.000Z' },
      ],
    };
    expect(unreadThreads(row, seen)).toBe(1);
    expect(unreadThreads(row, seen, 'y')).toBe(0);
    expect(unreadThreads({ id: NODE }, seen)).toBe(0);
  });
});

describe('anchors (T503, §3a)', () => {
  const body = 'Use **banker’s rounding** for cents.\n\n- one sheet per account\n- totals';

  test('a selection reads in the source despite the Markdown, with its offsets', () => {
    const anchor = anchorFor({ ts: 't0', body }, 'banker’s rounding');
    expect(anchor).toEqual({ entry: 't0', start: 6, end: 23, quote: 'banker’s rounding' });
    expect(body.slice(anchor.start, anchor.end)).toBe('banker’s rounding');
    const across = anchorFor({ ts: 't0', body }, 'for cents.\none sheet');
    expect(body.slice(across.start, across.end)).toBe('for cents.\n\n- one sheet');
    expect(across.quote).toBe('for cents.\none sheet');
  });

  test('a selection the source doesn’t hold keeps its quote alone; none is the whole turn', () => {
    expect(anchorFor({ ts: 't0', body }, 'not there')).toEqual({ entry: 't0', quote: 'not there' });
    expect(anchorFor({ ts: 't0', body })).toEqual({ entry: 't0' });
    expect(anchorFor({ ts: 't0', body }, '  \n ')).toEqual({ entry: 't0' });
  });

  test('a long selection is cut at the quote limit', () => {
    const quote = quoteOf('x'.repeat(900));
    expect(quote).toHaveLength(800);
    expect(quote.endsWith('…')).toBe(true);
  });

  test('a passage is found again nearest its own place', () => {
    const text = 'cents here, and cents there';
    expect(findPassage(text, 'cents')).toEqual({ start: 0, end: 5 });
    expect(findPassage(text, 'cents', 20)).toEqual({ start: 16, end: 21 });
    expect(findPassage(text, 'pounds')).toBeUndefined();
    expect(findPassage(text, '')).toBeUndefined();
    expect(findPassage(text, 'and cents th…')).toEqual({ start: 12, end: 24 });
  });
});

describe('archived threads and moves (T504, §6, §6a)', () => {
  const loaded = [
    { ts: 't0', kind: 'line' as const },
    { ts: 't1', kind: 'line' as const },
    { ts: 't2', kind: 'line' as const },
    { ts: 't3', kind: 'line' as const },
  ];

  test('an archived thread leaves no mark; its lines fold away under its turn', () => {
    const open = thread('t1');
    const gone = thread('t2', { entries: ['t2', 't3'], archived: { at: 't9' } });
    const placed = placeChatThreads([open, gone], [], loaded);
    expect(placed.marksOn.get('t0')?.map((t) => t.id)).toEqual(['t1']);
    expect(placed.archivedOn.get('t0')?.map((t) => t.id)).toEqual(['t2']);
    expect([...placed.nested].sort()).toEqual(['t1', 't2', 't3']);
    // Out of "Open threads", nothing unread.
    expect(openThreadsChip([open, gone], () => 1)).toMatchObject({ count: 1, unread: 1 });
  });

  test('Move to thread offers the open threads on an earlier turn, one level only', () => {
    const a = thread('t1');
    const b = thread('t2', { archived: { at: 't9' } });
    const on3 = thread('t5', { anchor: { entry: 't3' } });
    expect(moveTargets([a, b], { ts: 't3', kind: 'line' }).map((t) => t.id)).toEqual(['t1']);
    // A line threads are on stays in the main flow; a thread's first reply stays in its thread.
    expect(moveTargets([a, on3], { ts: 't3', kind: 'line' })).toEqual([]);
    expect(moveTargets([a], { ts: 't4', kind: 'line', anchor: { entry: 't0' } })).toEqual([]);
    expect(moveTargets([a], { ts: 't4', kind: 'event' })).toEqual([]);
    // Already in it: nowhere new to go.
    expect(moveTargets([a], { ts: 't1', kind: 'line' })).toEqual([]);
    expect(movesByLine([{ entry: 't3', from: 'main', to: 't1', at: 't4' }]).get('t3')?.to).toBe(
      't1',
    );
  });
});
