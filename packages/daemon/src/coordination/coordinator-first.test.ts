/**
 * T338 (§9): a part's question about a shared thing goes to its coordinator
 * first (a `child_question` event, not the operator's inbox); the
 * coordinator answers it or passes it up; approving the plan supersedes the
 * questions it answers and posts each part its share.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type Stream, ulid } from '@agile-agents/shared';
import { VerbService } from '../attach/verbs';
import { makeEmitter } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { GateService } from '../gates';
import { InboxService } from '../inbox';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ContractService } from './contracts';
import { PlanService } from './plans';

let home: string;
let store: StateStore;
let streams: StreamService;
let events: RoutedEventService;
let contracts: ContractService;
let plans: PlanService;
let questions: QuestionService;
let inbox: InboxService;
let verbs: VerbService;
const delivered: string[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-coordfirst-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  events = new RoutedEventService(store);
  const emit = makeEmitter(events, streams);
  contracts = new ContractService({ store, streams, emit });
  questions = new QuestionService(store, streams, {
    deliver: async (_s, q) => {
      delivered.push(q.answer ?? '');
    },
  });
  plans = new PlanService({ store, streams, contracts, emit, questions });
  inbox = new InboxService({ streams, questions, gates: new GateService(store) } as never);
  verbs = new VerbService({ store, streams, questions, plans, contracts, emitRouted: emit });
  delivered.length = 0;
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

async function session(stream: Stream, role: 'worker' | 'coordinator', live = true) {
  const id = ulid();
  await store.putAgent(id as AgentId, {
    vendor: 'fake',
    model: 'fake',
    stream: stream.id,
    last_seen: new Date().toISOString(),
    role,
  });
  await store.updateStream('daemon', stream.id, (before) => ({
    ...before,
    sessions: [{ id, vendor: 'fake', model: 'fake', role, status: live ? 'running' : 'stopped' }],
  }));
  return id;
}

async function shop(coordinatorLive = true) {
  const node = await streams.create('human', { title: 'Sale prices', goal: 'g' });
  const api = await streams.create('human', { title: 'api part', goal: 'g', parent: node.id });
  const web = await streams.create('human', { title: 'web part', goal: 'g', parent: node.id });
  await plans.write(node.id, [
    { child: api.id, owns: ['prices.ts'] },
    { child: web.id, owns: ['shop.html'] },
  ]);
  return {
    node,
    api,
    web,
    coordinator: await session(node, 'coordinator', coordinatorLive),
    apiAgent: await session(api, 'worker'),
  };
}

const inboxIds = () => inbox.list().map((i) => i.id);

describe('coordinator first (T338)', () => {
  test('a shared-thing question goes to the coordinator, not the inbox; answer_child answers it', async () => {
    const s = await shop();
    const { id } = await verbs.ask({
      session: s.apiAgent,
      text: 'Should web part format shop.html prices?',
    });
    expect(questions.get(id as never).coordinator).toBe(s.node.id);
    expect(inboxIds()).not.toContain(id);
    const routed = events.activityFor(s.node.id).map((a) => a.event);
    expect(routed.some((e) => e.type === 'child_question' && e.payload.question === id)).toBe(true);

    await verbs.answerChild({ session: s.coordinator, question: id, answer: 'yes, web formats' });
    expect(questions.get(id as never).status).toBe('answered');
    expect(delivered).toEqual(['yes, web formats']);
    const last = streams.readThread(s.api.id).entries.at(-1);
    expect(last?.by).toBe('daemon');
    expect(last?.body).toBe('Your coordinator answers: yes, web formats');
  });

  test('answer_child without an answer passes it to the operator', async () => {
    const s = await shop();
    const { id } = await verbs.ask({ session: s.apiAgent, text: 'who owns the contract?' });
    expect(inboxIds()).not.toContain(id);
    await verbs.answerChild({ session: s.coordinator, question: id });
    expect(inboxIds()).toContain(id);
  });

  test('a question about the part alone, or with no live coordinator, goes straight to the inbox', async () => {
    const s = await shop();
    const own = await verbs.ask({ session: s.apiAgent, text: 'Which rounding mode do you want?' });
    expect(questions.get(own.id as never).coordinator).toBeUndefined();
    expect(inboxIds()).toContain(own.id);

    // A coordinator that stops: the held question surfaces rather than being stranded.
    const held = await verbs.ask({
      session: s.apiAgent,
      text: 'Does the plan give me web part files?',
    });
    expect(inboxIds()).not.toContain(held.id);
    await store.updateStream('daemon', s.node.id, (b) => ({
      ...b,
      sessions: b.sessions.map((x) => ({ ...x, status: 'stopped' as const })),
    }));
    expect(inboxIds()).toContain(held.id);
  });

  test('only the coordinator it was sent to can answer', async () => {
    const s = await shop();
    const own = await verbs.ask({ session: s.apiAgent, text: 'Which rounding mode do you want?' });
    await expect(
      verbs.answerChild({ session: s.coordinator, question: own.id, answer: 'x' }),
    ).rejects.toThrow('was not sent to you');
  });

  test('a question passed up to the operator stays open in the inbox when the plan is approved', async () => {
    const s = await shop();
    const { id } = await verbs.ask({ session: s.apiAgent, text: 'who owns the contract?' });
    await verbs.answerChild({ session: s.coordinator, question: id });
    await plans.approve(s.node.id, 'human');
    expect(questions.get(id as never).status).toBe('open');
    expect(inboxIds()).toContain(id);
  });

  test('approving the plan supersedes the parts’ held questions and posts each part its share', async () => {
    const s = await shop();
    const held = await verbs.ask({
      session: s.apiAgent,
      text: 'Do I own prices.ts under the plan?',
    });
    const own = await verbs.ask({ session: s.apiAgent, text: 'Which rounding mode do you want?' });
    await plans.approve(s.node.id, 'human');
    const q = questions.get(held.id as never);
    expect(q.status).toBe('answered');
    expect(q.resolved_as).toBe('superseded');
    // Not auto-answered for you: the question that went to the operator stays open.
    expect(questions.get(own.id as never).status).toBe('open');
    const thread = streams.readThread(s.api.id).entries.map((e) => e.body);
    expect(thread).toContain('plan v1 approved: you own prices.ts');
    expect(streams.readThread(s.web.id).entries.map((e) => e.body)).toContain(
      'plan v1 approved: you own shop.html',
    );
  });
});
