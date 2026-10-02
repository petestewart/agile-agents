/**
 * T503 (design/chat-threads.md §3a, §4, §6): a chat thread is derived by
 * field and by cause; a batched turn stays in the main flow with links; its
 * state comes from its lines and their deliveries. Over the store, a
 * thread's anchor and replies are checked and the rail row's replies kept.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Question,
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
import { ChatThreads, chatThreadsOf } from './chat-threads';
import { QuestionService } from './service';
import type { ThreadActivity } from './threads';

const S = ulid();
const NODE = ulid();
const at = (minute: number, second = 0): string =>
  new Date(Date.UTC(2026, 9, 2, 10, minute, second)).toISOString();

const line = (ts: string, by: string, body: string, extra: Partial<ThreadEntry> = {}) =>
  ({ ts, by, kind: 'line', body, ...extra }) as ThreadEntry;

/** The agent's message of 10:00 the threads are on. */
const TURN = line(at(0), `agent:${S}`, 'Use banker’s rounding. Keep one sheet per account.');
/** A thread on a passage of it (10:01), and one on the whole turn (10:03). */
const A = line(at(1), 'human', 'why banker’s?', {
  thread: at(1),
  anchor: { entry: at(0), start: 4, end: 21, quote: 'banker’s rounding' },
});
const B = line(at(3), 'human', 'and the sheets?', { thread: at(3), anchor: { entry: at(0) } });

function humanLine(id: string, ts: string, thread?: string): RoutedEvent {
  return {
    id,
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
}

function delivered(event: RoutedEvent, digest: string, deliveredAt: string): ThreadActivity {
  return { event, status: 'delivered', delivered_at: deliveredAt, session: S, digest };
}

const node = (status: SessionRef['status']): Pick<Stream, 'id' | 'sessions'> => ({
  id: NODE,
  sessions: [{ id: S, vendor: 'codex', model: 'gpt', role: 'worker', status }],
});

const finished = (ts: string) =>
  line(ts, 'daemon', 'turn finished', { kind: 'event', ref: S }) as ThreadEntry;

describe('chatThreadsOf: placement by cause (§4.1)', () => {
  test('the turn your reply woke posts in its thread; the main flow keeps the rest', () => {
    const answer = line(at(2), `agent:${S}`, 'it avoids drift');
    const after = line(at(5), `agent:${S}`, 'next step done');
    const { threads, batches } = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, answer, finished(at(2, 30)), after],
      activity: [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))],
    });
    expect(batches).toEqual([]);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: at(1),
      stream: NODE,
      anchor: A.anchor,
      entries: [at(1), at(2)],
      replies: 2,
      last_at: at(2),
      reply_at: at(2),
      state: 'open',
      vendor: 'codex',
    });
  });

  test('a question asked in that turn is in the thread too, and waits on you there', () => {
    const Q = `Q-${ulid()}`;
    const asked = line(at(2), `agent:${S}`, 'half up or half even?', {
      kind: 'question',
      ref: `questions/${Q}.yaml`,
    });
    const [t] = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, asked],
      activity: [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))],
      questions: [{ id: Q, stream: NODE, status: 'open' } as unknown as Question],
    }).threads;
    expect(t?.entries).toEqual([at(1), at(2)]);
    expect(t?.questions).toEqual([Q]);
    expect(t?.state).toBe('waits_on_you');
    // Answered, and you haven't written since: resolved. Replying again reopens it.
    const answered = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, asked],
      activity: [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))],
      questions: [{ id: Q, stream: NODE, status: 'answered' } as unknown as Question],
    }).threads[0];
    expect(answered?.state).toBe('resolved');
    const again = line(at(4), 'human', 'one more thing', { thread: at(1) });
    const reopened = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, asked, again],
      activity: [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))],
      questions: [{ id: Q, stream: NODE, status: 'answered' } as unknown as Question],
    }).threads[0];
    expect(reopened?.state).toBe('waiting_on_agent');
  });

  test('a batched turn (two threads, or main and a thread) stays in the main flow with links', () => {
    const both = line(at(4), `agent:${S}`, 'both answered');
    const twoThreads = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, B, both],
      activity: [
        delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(3, 30)),
        delivered(humanLine('E-2', B.ts, B.thread), 'D-1', at(3, 30)),
      ],
    });
    expect(twoThreads.batches).toEqual([{ entries: [at(4)], threads: [at(1), at(3)] }]);
    expect(twoThreads.threads.map((t) => t.entries)).toEqual([[at(1)], [at(3)]]);

    const main = line(at(2), 'human', 'also: carry on');
    const mixed = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, main, both],
      activity: [
        delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(3, 30)),
        delivered(humanLine('E-3', main.ts), 'D-1', at(3, 30)),
      ],
    });
    expect(mixed.batches).toEqual([{ entries: [at(4)], threads: [at(1)] }]);
    expect(mixed.threads[0]?.entries).toEqual([at(1)]);
  });

  test('in a batch the agent places a line itself with `thread` (§4.2); a plain line’s turn is no thread’s', () => {
    const placed = line(at(4), `agent:${S}`, 'about the sheets', { thread: at(3) });
    const rest = line(at(5), `agent:${S}`, 'and rounding: drift');
    const out = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, B, placed, rest],
      activity: [
        delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(3, 30)),
        delivered(humanLine('E-2', B.ts, B.thread), 'D-1', at(3, 30)),
      ],
    });
    expect(out.threads.find((t) => t.id === at(3))?.entries).toEqual([at(3), at(4)]);
    expect(out.batches).toEqual([{ entries: [at(5)], threads: [at(1), at(3)] }]);

    const plain = line(at(7), 'human', 'carry on');
    const reply = line(at(8), `agent:${S}`, 'ok');
    const none = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, plain, reply],
      activity: [delivered(humanLine('E-4', plain.ts), 'D-2', at(7, 30))],
    });
    expect(none.batches).toEqual([]);
    expect(none.threads[0]?.entries).toEqual([at(1)]);
  });
});

describe('chatThreadsOf: replies (T513, §6)', () => {
  test('what the agent said on the way to its answer is no reply: your line and its answer are 2', () => {
    // The operator's reply, then one turn: a line on the way ("Let me look"), then the answer.
    const onTheWay = line(at(2), `agent:${S}`, 'Let me look at the ledger first.');
    const answer = line(at(2, 20), `agent:${S}`, 'It avoids drift when you sum many rows.');
    const { threads } = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, onTheWay, answer, finished(at(2, 30))],
      activity: [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))],
    });
    expect(threads[0]?.entries).toEqual([A.ts, onTheWay.ts, answer.ts]);
    expect(threads[0]?.replies).toBe(2);
    expect(threads[0]?.reply_at).toBe(answer.ts);
  });

  test('each turn’s answer counts; a question asked on the way is never folded', () => {
    const asked = line(at(2), `agent:${S}`, 'Half up or half even?', {
      kind: 'question',
      ref: 'questions/Q-1.yaml',
    });
    const first = line(at(2, 10), `agent:${S}`, 'Waiting on your pick.');
    const again = line(at(4), 'human', 'half even', { thread: A.ts });
    const second = line(at(4, 20), `agent:${S}`, 'Done: half even.');
    const { threads } = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, asked, first, finished(at(2, 30)), again, second, finished(at(4, 30))],
      activity: [
        delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30)),
        delivered(humanLine('E-2', again.ts, A.thread), 'D-2', at(4, 10)),
      ],
    });
    // A, the question, its answer line, your second line, its answer: 5 replies, nothing folded.
    expect(threads[0]?.entries).toEqual([A.ts, asked.ts, first.ts, again.ts, second.ts]);
    expect(threads[0]?.replies).toBe(5);
  });

  test('two turns with no line of yours between them: each turn’s last message counts', () => {
    const one = line(at(2), `agent:${S}`, 'first turn, on the way');
    const oneEnd = line(at(2, 10), `agent:${S}`, 'first turn’s answer');
    const two = line(at(3), `agent:${S}`, 'second turn’s answer', { thread: A.ts });
    const { threads } = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, one, oneEnd, finished(at(2, 30)), two],
      activity: [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))],
    });
    expect(threads[0]?.entries).toEqual([A.ts, one.ts, oneEnd.ts, two.ts]);
    expect(threads[0]?.replies).toBe(3);
  });
});

describe('chatThreadsOf: state (§6)', () => {
  test('your reply waits on the agent until the turn it started ends', () => {
    const pending: ThreadActivity = { event: humanLine('E-1', A.ts, A.thread), status: 'pending' };
    const queued = chatThreadsOf({
      node: node('running'),
      entries: [TURN, A],
      activity: [pending],
    });
    expect(queued.threads[0]?.state).toBe('waiting_on_agent');
    expect(queued.threads[0]?.reply_at).toBeUndefined();

    const taken = [delivered(humanLine('E-1', A.ts, A.thread), 'D-1', at(1, 30))];
    const working = chatThreadsOf({ node: node('running'), entries: [TURN, A], activity: taken });
    expect(working.threads[0]?.state).toBe('waiting_on_agent');
    // The turn ended without a word in the thread: open, nothing pending.
    const ended = chatThreadsOf({
      node: node('idle'),
      entries: [TURN, A, finished(at(2))],
      activity: taken,
    });
    expect(ended.threads[0]?.state).toBe('open');
  });

  test('no thread started: nothing derived, whatever the lines say', () => {
    expect(chatThreadsOf({ node: node('idle'), entries: [TURN], activity: [] }).threads).toEqual(
      [],
    );
  });
});

describe('ChatThreads over the store', () => {
  let home: string;
  let store: StateStore;
  let streams: StreamService;
  let questions: QuestionService;
  let events: RoutedEventService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-chatthreads-'));
    const init = runInit(home);
    store = StateStore.open(init.stateRoot);
    streams = new StreamService(store);
    questions = new QuestionService(store, streams);
    events = new RoutedEventService(store);
  });

  afterEach(() => {
    store.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('a thread starts on a line of the node, one level deep, its passage inside the line', async () => {
    const node = await streams.create('human', { title: 'Ledger', goal: 'g' });
    const turn = await streams.appendThread('human', node.id, { kind: 'line', body: 'two things' });
    await expect(
      streams.appendThread('human', node.id, {
        kind: 'line',
        body: 'x',
        anchor: { entry: '2020-01-01T00:00:00.000Z' },
      }),
    ).rejects.toThrow(/no line/);
    await expect(
      streams.appendThread('human', node.id, {
        kind: 'line',
        body: 'x',
        anchor: { entry: turn.ts, start: 0, end: 11, quote: 'two things!' },
      }),
    ).rejects.toThrow(/past the line/);
    const first = await streams.appendThread('human', node.id, {
      kind: 'line',
      body: 'which two?',
      anchor: { entry: turn.ts, start: 0, end: 3, quote: 'two' },
    });
    expect(first.thread).toBe(first.ts);
    // A reply to a reply goes in the same thread, never a thread of its own.
    await expect(
      streams.appendThread('human', node.id, {
        kind: 'line',
        body: 'x',
        anchor: { entry: first.ts },
      }),
    ).rejects.toThrow(/one level/);
    const reply = await streams.appendThread('human', node.id, {
      kind: 'line',
      body: 'and?',
      thread: first.ts,
    });
    expect(reply.thread).toBe(first.ts);
    await expect(
      streams.appendThread('human', node.id, {
        kind: 'line',
        body: 'x',
        thread: '2020-01-01T00:00:00.000Z',
      }),
    ).rejects.toThrow(/no thread/);
    // A question's thread names a question asked on this node.
    const other = await streams.create('human', { title: 'Other', goal: 'g' });
    const q = await questions.raise({ stream: other.id, raised_by: S, session: S, text: 'q?' });
    await expect(
      streams.appendThread('human', node.id, {
        kind: 'line',
        body: 'x',
        thread: `questions/${q.id}`,
      }),
    ).rejects.toThrow(/another node/);
    expect(
      (
        await streams.appendThread('human', other.id, {
          kind: 'line',
          body: 'x',
          thread: `questions/${q.id}`,
        })
      ).thread,
    ).toBe(`questions/${q.id}`);

    const chat = new ChatThreads({ streams, questions, events });
    const { threads } = chat.forNode(node.id);
    expect(threads.map((t) => [t.id, t.replies, t.state])).toEqual([
      [first.ts, 2, 'waiting_on_agent'],
    ]);
    // The rail row: only where a thread started; replies are lines not yours.
    expect(store.hasChatThreads(node.id)).toBe(true);
    expect(store.hasChatThreads(other.id)).toBe(false);
    expect(chat.repliesFor(node.id, store.threadUpdatedAt(node.id))).toEqual([]);
    const said = await streams.appendThread(
      'agent',
      node.id,
      { kind: 'line', body: 'these two', thread: first.ts },
      S,
    );
    expect(chat.repliesFor(node.id, store.threadUpdatedAt(node.id))).toEqual([
      { thread: first.ts, at: said.ts },
    ]);
  });
});
