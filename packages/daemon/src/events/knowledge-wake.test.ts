/**
 * T454: `KnowledgeWakeJudge` against a real temp state home, with
 * `FakeClassifier` (no network): the switch, the two questions and their
 * bands, the fail policy, once per (event, node), the per-item cap, and
 * the state Jev reads.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClassifierConfig,
  type RoutedEvent,
  type Stream,
  ulid,
  validateClassifierConfig,
} from '@agile-agents/shared';
import { ClassifierUnavailableError, FakeClassifier } from '../classifier';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge/service';
import { ProjectService } from '../projects';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  JEV_WAKES_PER_ITEM,
  KnowledgeWakeJudge,
  LAST_REPLY_MAX_CHARS,
  RELEVANT_NOUL,
  STALE_NOUL,
  ageInWords,
} from './knowledge-wake';

let home: string;
let store: StateStore;
let streams: StreamService;
let config: ClassifierConfig;
let logs: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-knowledge-wake-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
  config = validateClassifierConfig({ api_key: 'fake-t454-key' });
  logs = [];
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** Jev's two values: "is the decision relevant?" and "is the conversation stale?". */
const jevSays = (relevant: number, stale: number) =>
  new FakeClassifier((_state, qs) =>
    qs.map((q) => ({ id: q.id, probability: q.id === 'relevant' ? relevant : stale })),
  );

function judgeWith(classifier: FakeClassifier): KnowledgeWakeJudge {
  return new KnowledgeWakeJudge({
    store,
    streams: () => streams.list(),
    home,
    classifier,
    config,
    env: {},
    log: (line) => logs.push(line),
  });
}

async function project() {
  return new ProjectService(store, streams).create({ name: 'Shop' });
}

async function conversation(projectId: string, title: string): Promise<Stream> {
  await Bun.sleep(3); // distinct created_at, so "newer" is well defined
  return streams.create('human', { title, goal: `${title}?`, project: projectId });
}

/** An accepted item and its `knowledge_accepted` event, routed to nobody (the judge reads only the event). */
async function accepted(projectId: string, source?: string): Promise<RoutedEvent> {
  const knowledge = new KnowledgeService({ store, streams });
  const item = await knowledge.create(source !== undefined ? 'agent' : 'human', {
    text: 'Amounts in exported JSON are integer cents, never floats',
    kind: 'decision',
    enforcement: 'tell',
    scope: { kind: 'project', project: projectId },
    ...(source !== undefined ? { source: { by: 'agent', node: source } } : {}),
  });
  await knowledge.accept(item.id, 'human');
  return {
    id: `E-${ulid()}`,
    type: 'knowledge_accepted',
    payload: {
      item: item.id,
      kind: 'decision',
      text: item.text,
      enforcement: 'tell',
      ...(source !== undefined ? { source } : {}),
    },
  } as unknown as RoutedEvent;
}

/** `consider`, then the judgment settles; resolves to how many rechecks ran. */
async function consider(
  judge: KnowledgeWakeJudge,
  node: Stream,
  events: RoutedEvent[],
): Promise<number> {
  let rechecks = 0;
  const logged = logs.length;
  judge.consider(node, events, () => {
    rechecks += 1;
  });
  // Every judgment logs once when it settles.
  for (let i = 0; i < 200 && logs.length - logged < events.length; i++) await Bun.sleep(5);
  return rechecks;
}

describe('T454: Jev decides whether accepted knowledge wakes a conversation', () => {
  test('off (the default): nothing is asked', async () => {
    const p = await project();
    const node = await conversation(p.id, 'Cents check');
    const jev = jevSays(0.99, 0.01);
    const judge = judgeWith(jev);
    judge.consider(node, [await accepted(p.id)], () => {
      throw new Error('no recheck when off');
    });
    await Bun.sleep(30);
    expect(jev.calls).toHaveLength(0);
    expect(judge.on()).toBe(false);
  });

  test('relevant and current: approved and rechecked, asked once per (event, node)', async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    const node = await conversation(p.id, 'Cents check');
    const event = await accepted(p.id);
    const jev = jevSays(0.95, 0.1);
    const judge = judgeWith(jev);
    expect(await consider(judge, node, [event])).toBe(1);
    expect(judge.approvedFor(node.id, event)).toBe(true);
    expect(jev.calls).toHaveLength(1);
    expect(jev.calls[0]?.questions).toEqual([RELEVANT_NOUL, STALE_NOUL]);
    // Re-evaluated (another notify): not asked again.
    judge.consider(node, [event], () => undefined);
    await Bun.sleep(30);
    expect(jev.calls).toHaveLength(1);
    // Another conversation is its own pair.
    const other = await conversation(p.id, 'Refunds');
    expect(await consider(judge, other, [event])).toBe(1);
    expect(jev.calls).toHaveLength(2);
    expect(judge.approvedFor(other.id, event)).toBe(true);
    // Switched off before the wake: back to `source`.
    await store.setKnowledgeWake('source');
    expect(judge.approvedFor(other.id, event)).toBe(false);
  });

  test('a no, an unsure answer or a stale conversation: not approved', async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    for (const [relevant, stale] of [
      [0.95, 0.9], // relevant, but stale
      [0.1, 0.05], // current, but beside the point
      [0.6, 0.05], // unsure it is relevant: the route band is no yes
      [0.95, 0.6], // unsure it is current
    ] as const) {
      const node = await conversation(p.id, `Case ${relevant}/${stale}`);
      const event = await accepted(p.id);
      const jev = jevSays(relevant, stale);
      const judge = judgeWith(jev);
      expect(await consider(judge, node, [event])).toBe(0);
      expect(judge.approvedFor(node.id, event)).toBe(false);
      expect(jev.calls).toHaveLength(1);
    }
    expect(logs.filter((l) => l.includes('not woken'))).toHaveLength(4);
  });

  test('the classifier unavailable, or a missing answer: not approved', async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    const node = await conversation(p.id, 'Cents check');
    const event = await accepted(p.id);
    const down = new FakeClassifier([], {
      throws: new ClassifierUnavailableError('http_error', 'classifier call returned HTTP 503'),
    });
    const judge = judgeWith(down);
    expect(await consider(judge, node, [event])).toBe(0);
    expect(judge.approvedFor(node.id, event)).toBe(false);
    expect(logs.at(-1)).toContain('classifier unavailable (http_error)');
    // One answer of two is no yes.
    const half = new FakeClassifier([{ id: 'relevant', probability: 0.99 }]);
    const again = judgeWith(half);
    expect(await consider(again, node, [event])).toBe(0);
  });

  test('no key, or the conversation opted out of the classifier: not asked', async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    const node = await conversation(p.id, 'Cents check');
    const event = await accepted(p.id);
    const jev = jevSays(0.99, 0.01);
    config = validateClassifierConfig({});
    expect(await consider(judgeWith(jev), node, [event])).toBe(0);
    config = validateClassifierConfig({ api_key: 'fake-t454-key' });
    const off = await streams.update('human', node.id, { classifier: 'off' });
    expect(await consider(judgeWith(jev), off, [event])).toBe(0);
    expect(jev.calls).toHaveLength(0);
    expect(logs.every((l) => l.includes('the classifier is off or has no key'))).toBe(true);
  });

  test('the item it proposed itself and other event types are not asked about', async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    const node = await conversation(p.id, 'Cents check');
    const own = await accepted(p.id, node.id);
    const jev = jevSays(0.99, 0.01);
    const judge = judgeWith(jev);
    const line = { id: `E-${ulid()}`, type: 'human_line', payload: {} } as unknown as RoutedEvent;
    judge.consider(node, [own, line], () => undefined);
    await Bun.sleep(30);
    expect(jev.calls).toHaveLength(0);
  });

  test(`at most ${JEV_WAKES_PER_ITEM} conversations woken per item`, async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    const event = await accepted(p.id);
    const jev = jevSays(0.99, 0.01);
    const judge = judgeWith(jev);
    const nodes: Stream[] = [];
    for (let i = 0; i < JEV_WAKES_PER_ITEM + 2; i++) {
      nodes.push(await conversation(p.id, `Conversation ${i}`));
    }
    let rechecks = 0;
    for (const node of nodes) rechecks += await consider(judge, node, [event]);
    expect(rechecks).toBe(JEV_WAKES_PER_ITEM);
    expect(nodes.filter((n) => judge.approvedFor(n.id, event))).toHaveLength(JEV_WAKES_PER_ITEM);
    // Past the cap, no call is made at all.
    expect(jev.calls).toHaveLength(JEV_WAKES_PER_ITEM);
  });

  test('the state: the item, the question, the last reply capped, and newer conversations', async () => {
    await store.setKnowledgeWake('jev');
    const p = await project();
    const node = await conversation(p.id, 'Cents check');
    const session = ulid();
    await streams.appendThread('human', node.id, { kind: 'line', body: 'Floats or cents?' });
    await streams.appendThread('agent', node.id, { kind: 'line', body: 'An older reply' }, session);
    await streams.appendThread(
      'agent',
      node.id,
      { kind: 'line', body: `Floats for now. ${'x'.repeat(2000)}` },
      session,
    );
    expect(streams.readThread(node.id).entries.at(-1)?.by).toBe(`agent:${session}`);
    const newer = await conversation(p.id, 'Export format v2');
    const event = await accepted(p.id);
    const state = judgeWith(jevSays(0, 0)).stateFor(node, event);
    expect(state).toContain('kind: decision; enforcement: tell; applies to the project Shop');
    expect(state).toContain('text: Amounts in exported JSON are integer cents, never floats');
    expect(state).toContain('question: Cents check?');
    expect(state).toContain('last reply: Floats for now.');
    expect(state).not.toContain('An older reply');
    const reply = state.split('\n').find((l) => l.startsWith('- last reply: ')) ?? '';
    expect(reply.length).toBeLessThanOrEqual('- last reply: '.length + LAST_REPLY_MAX_CHARS);
    expect(state).toMatch(/last changed: \S+ \(just now\)/);
    expect(state).toContain('status: open');
    expect(state).toContain(`- ${newer.title} (started just now)`);
    // A conversation lists only the ones started after it.
    expect(judgeWith(jevSays(0, 0)).stateFor(newer, event)).toContain(
      'Newer conversations in the same project:\n- (none)',
    );
  });

  test('ages read in words', () => {
    expect(ageInWords(10_000)).toBe('just now');
    expect(ageInWords(60_000)).toBe('1 minute ago');
    expect(ageInWords(3 * 3_600_000)).toBe('3 hours ago');
    expect(ageInWords(5 * 86_400_000)).toBe('5 days ago');
  });
});
