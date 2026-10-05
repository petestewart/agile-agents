/**
 * T504 (D65, design/chat-threads.md §6, §6a, §7): Move to thread / Move to
 * main are recorded and display only; Archive hides a thread, never re-sends
 * it to the agent and tells it once; Restore undoes it; Promote to tangent
 * seeds a tangent with the thread. The store checks each change.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RoutedEvent,
  type SessionRef,
  type Stream,
  type ThreadEntry,
  ulid,
} from '@agile-agents/shared';
import { RoutedEventService } from '../events/service';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ChatThreads, chatThreadsOf, linesForAgent } from './chat-threads';
import { QuestionService } from './service';
import { ChatThreadOps, CompactUnavailableError } from './thread-ops';
import type { ThreadActivity } from './threads';

const S = ulid();
const NODE = ulid();
const at = (minute: number, second = 0): string =>
  new Date(Date.UTC(2026, 9, 2, 10, minute, second)).toISOString();
const line = (ts: string, by: string, body: string, extra: Partial<ThreadEntry> = {}) =>
  ({ ts, by, kind: 'line', body, ...extra }) as ThreadEntry;
const op = (ts: string, o: NonNullable<ThreadEntry['op']>, body = 'recorded') =>
  ({ ts, by: 'human', kind: 'event', body, op: o }) as ThreadEntry;

const TURN = line(at(0), `agent:${S}`, 'Use banker’s rounding. Keep one sheet per account.');
const A = line(at(1), 'human', 'why banker’s?', {
  thread: at(1),
  anchor: { entry: at(0), start: 4, end: 21, quote: 'banker’s rounding' },
});
const node: Pick<Stream, 'id' | 'sessions'> = {
  id: NODE,
  sessions: [{ id: S, vendor: 'claude', model: 'm', role: 'worker', status: 'idle' } as SessionRef],
};
function delivered(ts: string, thread: string | undefined): ThreadActivity {
  const event: RoutedEvent = {
    id: `E-${ulid()}`,
    type: 'human_line',
    subject: NODE,
    payload: {
      body: 'x',
      ...(thread !== undefined ? { thread: { id: thread, on: at(0), of: 'agent' } } : {}),
    },
    ref: ts,
    by: 'human',
    at: ts,
    routing: [{ node: NODE, because: 'self' }],
  };
  return { event, status: 'delivered', delivered_at: ts, session: S, digest: `D-${ts}` };
}

describe('moves are display only (§6)', () => {
  const later = line(at(4), `agent:${S}`, 'by the way: the sheets are per account');
  const answer = line(at(2), `agent:${S}`, 'it avoids drift');
  /** The turn your reply woke ended here: what follows is the main flow's. */
  const done = line(at(2, 30), 'daemon', 'turn finished', { kind: 'event', ref: S });
  const activity = [delivered(at(1, 30), A.thread)];

  test('a main-flow line moved into a thread shows there, says so, and moves back', () => {
    const moved = chatThreadsOf({
      node,
      entries: [
        TURN,
        A,
        answer,
        done,
        later,
        op(at(5), { type: 'move', entry: later.ts, to: A.ts }),
      ],
      activity,
    });
    expect(moved.threads[0]?.entries).toEqual([at(1), at(2), at(4)]);
    expect(moved.moves).toEqual([{ entry: later.ts, from: 'main', to: A.ts, at: at(5) }]);
    // The stored line is untouched: still no `thread` of its own.
    expect(later.thread).toBeUndefined();

    const back = chatThreadsOf({
      node,
      entries: [
        TURN,
        A,
        answer,
        done,
        later,
        op(at(5), { type: 'move', entry: later.ts, to: A.ts }),
        op(at(6), { type: 'move', entry: later.ts, to: 'main' }),
      ],
      activity,
    });
    expect(back.threads[0]?.entries).toEqual([at(1), at(2)]);
    expect(back.moves).toEqual([]);
  });

  test('a line placed in a thread by cause moves to the main flow', () => {
    const out = chatThreadsOf({
      node,
      entries: [TURN, A, answer, op(at(5), { type: 'move', entry: answer.ts, to: 'main' })],
      activity,
    });
    expect(out.threads[0]?.entries).toEqual([at(1)]);
    expect(out.moves).toEqual([{ entry: answer.ts, from: A.ts, to: 'main', at: at(5) }]);
  });

  test('the records never reach the agent; a promotion does', () => {
    const move = op(at(5), { type: 'move', entry: later.ts, to: A.ts });
    const promote = op(at(6), { type: 'promote', thread: A.ts, node: ulid() });
    expect(linesForAgent([TURN, A, later, move, promote]).map((e) => e.ts)).toEqual([
      at(0),
      at(1),
      at(4),
      at(6),
    ]);
  });
});

describe('archived threads are never re-sent (§6a)', () => {
  test('its lines by field, by cause and moved in are left out; the turn it is on stays', () => {
    const answer = line(at(2), `agent:${S}`, 'it avoids drift');
    const later = line(at(4), `agent:${S}`, 'and the sheets');
    const main = line(at(7), 'human', 'carry on');
    const done = line(at(2, 30), 'daemon', 'turn finished', { kind: 'event', ref: S });
    const entries = [
      TURN,
      A,
      answer,
      done,
      later,
      op(at(5), { type: 'move', entry: later.ts, to: A.ts }),
      op(at(6), { type: 'archive', thread: A.ts }),
      main,
    ];
    const activity = [delivered(at(1, 30), A.thread)];
    expect(linesForAgent(entries, activity).map((e) => e.ts)).toEqual([at(0), at(2, 30), at(7)]);
    const t = chatThreadsOf({ node, entries, activity }).threads[0];
    expect(t?.archived).toEqual({ at: at(6) });
    // Restored: back in what the agent is handed.
    const restored = [...entries, op(at(8), { type: 'unarchive', thread: A.ts })];
    expect(linesForAgent(restored, activity).map((e) => e.ts)).toEqual([
      at(0),
      at(1),
      at(2),
      at(2, 30),
      at(4),
      at(7),
    ]);
    expect(chatThreadsOf({ node, entries: restored, activity }).threads[0]?.archived).toBe(
      undefined,
    );
  });
});

describe('thread changes over the store', () => {
  let home: string;
  let store: StateStore;
  let streams: StreamService;
  let questions: QuestionService;
  let events: RoutedEventService;
  let chat: ChatThreads;
  let ops: ChatThreadOps;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-threadops-'));
    const init = runInit(home);
    store = StateStore.open(init.stateRoot);
    events = new RoutedEventService(store);
    streams = new StreamService(store, {
      threadLines: (n, thread) => chat.linesOf(n, thread),
    });
    questions = new QuestionService(store, streams);
    chat = new ChatThreads({ streams, questions, events });
    ops = new ChatThreadOps({ streams, chatThreads: chat, events, questions });
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function threaded() {
    const n = await streams.create('human', { title: 'Ledger', goal: 'g' });
    const turn = await streams.appendThread(
      'agent',
      n.id,
      { kind: 'line', body: 'Use banker’s rounding.' },
      S,
    );
    const first = await streams.appendThread('human', n.id, {
      kind: 'line',
      body: 'why?',
      anchor: { entry: turn.ts, start: 4, end: 21, quote: 'banker’s rounding' },
    });
    return { n, turn, first };
  }

  test('a move is checked: a message, not a thread’s first reply, one level deep', async () => {
    const { n, turn, first } = await threaded();
    const aside = await streams.appendThread('human', n.id, { kind: 'line', body: 'aside' });
    await expect(ops.move(n.id, first.ts, 'main')).rejects.toThrow(/first reply/);
    await expect(ops.move(n.id, turn.ts, first.ts)).rejects.toThrow(/one level/);
    await expect(ops.move(n.id, at(0), first.ts)).rejects.toThrow(/no line/);
    const moved = await ops.move(n.id, aside.ts, first.ts);
    expect(moved).toMatchObject({ by: 'human', kind: 'event', op: { type: 'move' } });
    expect(chat.forNode(n.id).threads[0]?.entries).toEqual([first.ts, aside.ts]);
    // A line shown in a thread starts no thread of its own.
    await expect(
      streams.appendThread('human', n.id, { kind: 'line', body: 'x', anchor: { entry: aside.ts } }),
    ).rejects.toThrow(/one level/);
    // The stored line never changes.
    expect(store.readThread(n.id).find((e) => e.ts === aside.ts)?.thread).toBeUndefined();
    await ops.move(n.id, aside.ts, 'main');
    expect(chat.forNode(n.id).threads[0]?.entries).toEqual([first.ts]);
    // Only you change the threads.
    await expect(
      streams.appendThread(
        'agent',
        n.id,
        { kind: 'event', body: 'x', op: { type: 'move', entry: aside.ts, to: 'main' } },
        S,
      ),
    ).rejects.toThrow(/only you/);
  });

  test('archive: withdrawn question, dropped replies, told once (quietly); restore says so', async () => {
    const { n, first } = await threaded();
    const q = await questions.raise({
      stream: n.id,
      raised_by: S,
      session: S,
      text: 'half up?',
      thread: first.ts,
    });
    // Your reply still pending for the agent.
    await events.emit({
      type: 'human_line',
      subject: n.id,
      payload: { body: 'and?', thread: { id: first.ts, on: first.ts, of: 'agent' } },
      ref: first.ts,
      by: 'human',
      routing: [{ node: n.id, because: 'self' }],
    });
    const out = await ops.archive(n.id, first.ts);
    expect(out.withdrawn).toEqual([q.id]);
    expect(questions.get(q.id)).toMatchObject({ status: 'answered', resolved_as: 'withdrawn' });
    const pending = events.pendingFor(n.id).map((p) => p.event);
    expect(pending.map((e) => e.type)).toEqual(['thread_archived']);
    expect(pending[0]?.payload).toMatchObject({
      thread: first.ts,
      quote: 'banker’s rounding',
      of: 'agent',
      withdrawn: [q.id],
    });
    // A reply in it is refused; archiving it again too.
    await expect(
      streams.appendThread('human', n.id, { kind: 'line', body: 'x', thread: first.ts }),
    ).rejects.toThrow(/archived/);
    await expect(ops.archive(n.id, first.ts)).rejects.toThrow(/archived already/);
    expect(chat.forNode(n.id).threads[0]?.archived).toBeDefined();
    expect(chat.repliesFor(n.id, store.threadUpdatedAt(n.id))).toEqual([]);

    // Restored before the agent heard it: it hears nothing.
    await ops.restore(n.id, first.ts);
    expect(events.pendingFor(n.id)).toEqual([]);
    await expect(ops.restore(n.id, first.ts)).rejects.toThrow(/not archived/);

    // Archived again and the notice delivered: restoring tells it so.
    await ops.archive(n.id, first.ts);
    const notice = events.pendingFor(n.id)[0]?.event.id as string;
    await events.mark(n.id, [notice], 'delivered', { session: S, digest: 'D-1' });
    await ops.restore(n.id, first.ts);
    expect(events.pendingFor(n.id).map((p) => p.event.payload)).toEqual([
      expect.objectContaining({ thread: first.ts, restored: true }),
    ]);
  });

  test('compact now needs an agent whose vendor’s command takes instructions', async () => {
    const { n, first } = await threaded();
    await ops.archive(n.id, first.ts);
    await expect(ops.compact(n.id)).rejects.toBeInstanceOf(CompactUnavailableError);
    const withAgent = new ChatThreadOps({
      streams,
      chatThreads: chat,
      events,
      attach: {
        compactCommand: () => 'compact',
        restartFresh: async () => undefined,
        agentWorking: () => false,
      },
    });
    const { command, entry } = await withAgent.compact(n.id);
    expect(command).toBe(
      `/compact Leave out the archived threads (the operator closed them; don't carry them into the summary): the thread on "banker’s rounding".`,
    );
    expect(entry.op).toEqual({ type: 'compact', threads: [first.ts] });
    const sent = events.pendingFor(n.id).find((p) => p.event.type === 'human_line')?.event;
    expect(sent?.payload).toEqual({ body: command });
    // Never handed to the agent again in a brief.
    expect(linesForAgent(store.readThread(n.id)).some((e) => e.ts === entry.ts)).toBe(false);
  });

  test('promote: a tangent seeded with the passage and the lines; the thread links to it', async () => {
    const root = await streams.create('human', { title: 'Shop', goal: 'g' });
    const n = await streams.create('human', { title: 'Talk', goal: 'g', parent: root.id });
    const turn = await streams.appendThread(
      'agent',
      n.id,
      { kind: 'line', body: 'Use banker’s rounding.' },
      S,
    );
    const first = await streams.appendThread('human', n.id, {
      kind: 'line',
      body: 'why banker’s?',
      anchor: { entry: turn.ts, start: 4, end: 21, quote: 'banker’s rounding' },
    });
    await streams.appendThread(
      'agent',
      n.id,
      { kind: 'line', body: 'It avoids drift.', thread: first.ts },
      S,
    );
    await expect(
      streams.create('agent', { title: 'x', parent: n.id, seed_thread: first.ts }),
    ).rejects.toThrow(/only the operator/);
    await expect(
      streams.create('human', { title: 'x', parent: n.id, seed_thread: first.ts, seed_line: 0 }),
    ).rejects.toThrow(/not both/);
    const tangent = await streams.create('human', {
      title: 'Rounding',
      goal: 'Which rounding?',
      parent: n.id,
      seed_thread: first.ts,
    });
    const seed = store.readThread(tangent.id).map((e) => e.body);
    expect(seed[1]).toContain('> banker’s rounding');
    expect(
      seed.some((b) => b.includes('you wrote in the thread') && b.includes('> why banker’s?')),
    ).toBe(true);
    expect(
      seed.some((b) => b.includes('its agent wrote') && b.includes('> It avoids drift.')),
    ).toBe(true);
    expect(chat.forNode(n.id).threads[0]?.promoted).toMatchObject({ node: tangent.id });
    // The parent's agent is told (a promotion is not a display record).
    expect(linesForAgent(store.readThread(n.id)).some((e) => e.op?.type === 'promote')).toBe(true);
  });
});
