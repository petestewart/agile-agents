/**
 * T502 (design/chat-threads.md §4.1, §5): a question's thread is derived by
 * ref and by cause, and its state from its lines and their deliveries.
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
import { QuestionService } from './service';
import { QuestionThreads, type ThreadActivity, linesByCause, questionThreadsOf } from './threads';

const S = ulid();
const NODE = ulid();
const at = (minute: number, second = 0): string =>
  new Date(Date.UTC(2026, 9, 1, 10, minute, second)).toISOString();

function question(id: string, extra: Partial<Question> = {}): Question {
  return {
    id,
    stream: NODE,
    raised_by: S,
    session: S,
    text: 'Store amounts how?',
    options: ['Integer cents', 'Floats'],
    status: 'open',
    raised_at: at(0),
    ...extra,
  } as Question;
}

const Q1 = `Q-${ulid()}`;
const Q2 = `Q-${ulid()}`;
const ref = (id: string) => `questions/${id}.yaml`;
const line = (ts: string, by: string, body: string, extra: Partial<ThreadEntry> = {}) =>
  ({ ts, by, kind: 'line', body, ...extra }) as ThreadEntry;

function humanLine(id: string, ts: string, body: string, question?: string): RoutedEvent {
  return {
    id,
    type: 'human_line',
    subject: NODE,
    payload: { body, ...(question ? { question: { id: question, text: 'q' } } : {}) },
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

describe('questionThreadsOf', () => {
  const asked = { ts: at(0), by: `agent:${S}`, kind: 'question', body: 'q', ref: ref(Q1) };
  const reply = line(at(1), 'human', 'What does Stripe use?', { ref: ref(Q1) });

  test('an open question with no reply waits on you', () => {
    const [t] = questionThreadsOf({
      node: node('idle'),
      entries: [asked as ThreadEntry],
      questions: [question(Q1)],
      activity: [],
    });
    expect(t).toMatchObject({
      question: Q1,
      state: 'waits_on_you',
      vendor: 'codex',
      replies: 0,
      entries: [at(0)],
    });
  });

  test('your reply, not yet read, waits on the agent; its turn’s lines join the thread by cause', () => {
    const pending: ThreadActivity = { event: humanLine('E-1', reply.ts, reply.body, Q1), status: 'pending' };
    const waiting = questionThreadsOf({
      node: node('idle'),
      entries: [asked as ThreadEntry, reply],
      questions: [question(Q1)],
      activity: [pending],
    });
    expect(waiting[0]).toMatchObject({ state: 'waiting_on_agent', replies: 1 });

    // Read, and the agent is working on it: still waiting; what it says is in the thread.
    const clarify = line(at(2), `agent:${S}`, 'Stripe uses integer cents');
    const later = line(at(5), 'human', 'unrelated message');
    const working = questionThreadsOf({
      node: node('running'),
      entries: [asked as ThreadEntry, reply, clarify, later],
      questions: [question(Q1)],
      activity: [delivered(humanLine('E-1', reply.ts, reply.body, Q1), 'D-1', at(1, 30))],
    });
    expect(working[0]?.state).toBe('waiting_on_agent');
    expect(working[0]?.entries).toEqual([at(0), at(1), at(2)]);
  });

  test('the turn on your reply finished without a settle: unsettled', () => {
    const clarify = line(at(2), `agent:${S}`, 'Stripe uses integer cents');
    const activity = [delivered(humanLine('E-1', reply.ts, reply.body, Q1), 'D-1', at(1, 30))];
    // The session went idle waiting on the question (no line is written for that).
    const idle = questionThreadsOf({
      node: node('idle'),
      entries: [asked as ThreadEntry, reply, clarify],
      questions: [question(Q1)],
      activity,
    });
    expect(idle[0]?.state).toBe('unsettled');
    // Or the turn finished and the session rests.
    const finished = line(at(3), 'daemon', 'turn finished', { kind: 'event', ref: S });
    const rested = questionThreadsOf({
      node: node('running'),
      entries: [asked as ThreadEntry, reply, clarify, finished],
      questions: [question(Q1)],
      activity,
    });
    expect(rested[0]?.state).toBe('unsettled');
  });

  test('settled, it is resolved, the agent’s answer in the thread', () => {
    const settle = {
      ts: at(3),
      by: `agent:${S}`,
      kind: 'answer',
      body: 'Integer cents',
      ref: ref(Q1),
    } as ThreadEntry;
    const [t] = questionThreadsOf({
      node: node('running'),
      entries: [asked as ThreadEntry, reply, settle],
      questions: [
        question(Q1, {
          status: 'answered',
          answer: 'Integer cents',
          resolved_as: 'settled',
          answered_by: `agent:${S}`,
          answered_at: at(3),
        }),
      ],
      activity: [],
    });
    expect(t).toMatchObject({ state: 'resolved', resolved_as: 'settled', answer: 'Integer cents' });
    expect(t?.entries).toEqual([at(0), at(1), at(3)]);
  });

  test('a question answered at once is no thread; a re-asked one is one thread under the newer', () => {
    const answered = question(Q1, {
      status: 'answered',
      answer: 'cents',
      resolved_as: 'reply',
      answered_by: 'human',
      answered_at: at(1),
    });
    expect(
      questionThreadsOf({ node: node('idle'), entries: [], questions: [answered], activity: [] }),
    ).toEqual([]);

    const earlier = question(Q1, {
      status: 'answered',
      answer: 'asked again',
      resolved_as: 'superseded',
      answered_by: 'daemon',
      answered_at: at(3),
      superseded_by: Q2,
    });
    const newer = question(Q2, { text: 'Cents, or decimal strings?', raised_at: at(3) });
    const asked2 = { ts: at(3), by: `agent:${S}`, kind: 'question', body: 'q2', ref: ref(Q2) };
    const threads = questionThreadsOf({
      node: node('idle'),
      entries: [asked as ThreadEntry, reply, asked2 as ThreadEntry],
      questions: [earlier, newer],
      activity: [],
    });
    expect(threads).toHaveLength(1);
    // The new question waits on you again; the thread keeps the earlier one and your reply.
    expect(threads[0]).toMatchObject({
      question: Q2,
      earlier: [Q1],
      state: 'waits_on_you',
      replies: 1,
      raised_at: at(0),
    });
    expect(threads[0]?.entries).toEqual([at(0), at(1), at(3)]);
  });

  test('with its coordinator first, it says so', () => {
    const [t] = questionThreadsOf({
      node: node('idle'),
      entries: [],
      questions: [question(Q1)],
      activity: [],
      withCoordinator: () => true,
    });
    expect(t?.state).toBe('with_coordinator');
  });
});

describe('linesByCause (§4.1)', () => {
  test('a digest of one key’s events owns its turn’s lines; a batched one owns none', () => {
    const entries = [
      line(at(1), `agent:${S}`, 'one'),
      line(at(2), 'daemon', 'turn finished', { kind: 'event', ref: S }),
      line(at(4), `agent:${S}`, 'batched'),
      line(at(6), `agent:${S}`, 'proposal', { kind: 'proposal' }),
    ];
    const a = humanLine('E-1', at(0), 'a');
    const b = humanLine('E-2', at(3), 'b');
    const c = humanLine('E-3', at(3), 'c');
    const activity = [
      delivered(a, 'D-1', at(0, 30)),
      delivered(b, 'D-2', at(3, 30)),
      delivered(c, 'D-2', at(3, 30)),
    ];
    const keys: Record<string, string> = { 'E-1': 'x', 'E-2': 'x', 'E-3': 'y' };
    const out = linesByCause(entries, activity, (e) => keys[e.id]);
    expect(out.get('x')).toEqual([at(1)]);
    expect(out.get('y')).toBeUndefined();
  });

  test('a turn ends at the next digest its session takes', () => {
    const entries = [line(at(1), `agent:${S}`, 'one'), line(at(3), `agent:${S}`, 'two')];
    const activity = [
      delivered(humanLine('E-1', at(0), 'a'), 'D-1', at(0, 30)),
      delivered(humanLine('E-2', at(2), 'b'), 'D-2', at(2, 30)),
    ];
    const out = linesByCause(entries, activity, (e) => (e.id === 'E-1' ? 'x' : 'z'));
    expect(out.get('x')).toEqual([at(1)]);
    expect(out.get('z')).toEqual([at(3)]);
  });
});

describe('QuestionThreads over the store', () => {
  let home: string;
  let store: StateStore;
  let streams: StreamService;
  let questions: QuestionService;
  let events: RoutedEventService;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'agile-qthreads-'));
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

  test('a coordinator’s chat lists its children’s questions, with their states', async () => {
    const root = await streams.create('human', { title: 'Shop', goal: 'g' });
    const web = await streams.create('human', { title: 'Web', goal: 'g', parent: root.id });
    const api = await streams.create('human', { title: 'API', goal: 'g', parent: root.id });
    const a = await questions.raise({
      stream: web.id,
      raised_by: S,
      session: S,
      text: 'Which font?',
      options: ['Inter', 'System'],
    });
    const b = await questions.raise({
      stream: api.id,
      raised_by: S,
      session: S,
      text: 'REST or RPC?',
    });
    await questions.answer(b.id, { answer: 'REST', by: 'human' });
    const threads = new QuestionThreads({ streams, questions, events });
    const rows = threads.forCoordinator(root.id, []);
    expect(rows.map((r) => [r.node_title, r.question, r.state])).toEqual([
      ['Web', a.id, 'waits_on_you'],
      ['API', b.id, 'resolved'],
    ]);
    // An open choice question's state for the inbox; your reply, never read, waits on the agent.
    expect(threads.stateOf(questions.get(a.id)).state).toBe('waits_on_you');
    await questions.reply(a.id, { text: 'what do we use elsewhere?', by: 'human' });
    expect(threads.stateOf(questions.get(a.id)).state).toBe('waiting_on_agent');
    expect(threads.forNode(web.id)[0]).toMatchObject({ question: a.id, replies: 1 });
  });
});
