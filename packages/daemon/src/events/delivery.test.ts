import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { type DeliveryTarget, SessionDelivery, digestPrompt } from './delivery';
import { RoutedEventService } from './service';

let home: string;
let root: string;
let store: StateStore;
let events: RoutedEventService;
const node = ulid();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-delivery-'));
  root = runInit(home).stateRoot;
  store = StateStore.open(root);
  events = new RoutedEventService(store);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const line = (body: string, coalesce_key?: string) => ({
  type: 'human_line' as const,
  subject: node,
  payload: { body },
  by: 'human' as const,
  routing: [{ node, because: 'self' as const }],
  ...(coalesce_key !== undefined ? { coalesce_key } : {}),
});

/** A fake session: records prompts; `accept` controls whether the turn starts. */
function fakeTarget(opts: { busy?: () => boolean; accept?: boolean } = {}) {
  const prompts: string[] = [];
  const target: DeliveryTarget = {
    sessionId: 'S1',
    busy: opts.busy ?? (() => false),
    prompt: async (text, { onDelivered }) => {
      prompts.push(text);
      if (opts.accept !== false) onDelivered();
    },
  };
  return { prompts, target };
}

async function until(pred: () => boolean): Promise<void> {
  const end = Date.now() + 5000;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await Bun.sleep(5);
  }
}

describe('SessionDelivery (T242, P10)', () => {
  test('three events during a turn produce one digest after it', async () => {
    let busy = true;
    const { prompts, target } = fakeTarget({ busy: () => busy });
    const delivery = new SessionDelivery({ events, target: () => target, delayMs: 5 });
    for (const body of ['one', 'two', 'three']) await events.emit(line(body));
    await Bun.sleep(30);
    expect(prompts).toEqual([]);
    expect(delivery.waiting(node)).toBe(true);
    busy = false;
    expect(await delivery.flushWhenReady(node)).toBe(true);
    await until(() => events.pendingFor(node).length === 0);
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('3 things arrived for you:');
    expect(prompts[0]?.indexOf('one')).toBeLessThan(prompts[0]?.indexOf('three') ?? 0);
    // One write: every line of the digest carries the same digest id and session.
    const delivered = store.readDeliveries(node).filter((d) => d.status === 'delivered');
    expect(delivered.length).toBe(3);
    expect(new Set(delivered.map((d) => d.digest)).size).toBe(1);
    expect(delivered.every((d) => d.session === 'S1')).toBe(true);
    delivery.stop();
  });

  test('an idle session gets the digest within the delay', async () => {
    const { prompts, target } = fakeTarget();
    const delivery = new SessionDelivery({ events, target: () => target, delayMs: 20 });
    await events.emit(line('hello'));
    await events.emit(line('again'));
    await until(() => prompts.length === 1);
    await until(() => events.pendingFor(node).length === 0);
    await Bun.sleep(40);
    expect(prompts.length).toBe(1);
    delivery.stop();
  });

  test('no live session: the events stay pending for the next one', async () => {
    const live: { target?: DeliveryTarget } = {};
    const delivery = new SessionDelivery({ events, target: () => live.target, delayMs: 5 });
    await events.emit(line('while away'));
    await Bun.sleep(30);
    expect(events.pendingFor(node).length).toBe(1);
    const fake = fakeTarget();
    live.target = fake.target;
    expect(await delivery.flushWhenReady(node)).toBe(true);
    expect(fake.prompts[0]).toContain('while away');
    delivery.stop();
  });

  test('a restart between send and mark repeats the prompt, never an event within it', async () => {
    const first = fakeTarget({ accept: false });
    const before = new SessionDelivery({ events, target: () => first.target, delayMs: 60_000 });
    for (const body of ['a', 'b']) await events.emit(line(body));
    expect(await before.flush(node)).toBe(true);
    before.stop();
    // The daemon dies here: nothing was marked. A fresh one over the same home.
    const events2 = new RoutedEventService(StateStore.open(root));
    await events2.recover();
    const second = fakeTarget();
    const after = new SessionDelivery({ events: events2, target: () => second.target });
    expect(await after.flush(node)).toBe(true);
    await until(() => events2.pendingFor(node).length === 0);
    const text = second.prompts[0] ?? '';
    expect(text.match(/: a$/gm)?.length).toBe(1);
    expect(text.match(/: b$/gm)?.length).toBe(1);
    // A second flush has nothing to send.
    expect(await after.flush(node)).toBe(false);
    after.stop();
  });

  test('several pending events on one coalesce key fold to the newest', async () => {
    const { prompts, target } = fakeTarget();
    const delivery = new SessionDelivery({ events, target: () => target, delayMs: 60_000 });
    await events.emit(line('old', 'k'));
    await events.emit(line('new', 'k'));
    await delivery.flush(node);
    await until(() => events.pendingFor(node).length === 0);
    expect(prompts[0]).toContain('new');
    expect(prompts[0]).not.toContain('old');
    const last = new Map(store.readDeliveries(node).map((d) => [d.event, d.status]));
    expect([...last.values()].sort()).toEqual(['delivered', 'superseded']);
    delivery.stop();
  });

  test('a hold keeps the turn-end flush waiting until the producer has emitted', async () => {
    const { prompts, target } = fakeTarget();
    const delivery = new SessionDelivery({ events, target: () => target, delayMs: 60_000 });
    const release = delivery.hold(node);
    expect(delivery.waiting(node)).toBe(true);
    const flushing = delivery.flushWhenReady(node);
    await events.emit(line('late'));
    release();
    expect(await flushing).toBe(true);
    expect(prompts[0]).toContain('late');
    delivery.stop();
  });

  test('more than ten events: the newest ten, plus "N earlier"', async () => {
    const list = [];
    for (let i = 0; i < 12; i++) list.push(await events.emit(line(`line ${i}`)));
    const text = digestPrompt(list);
    expect(text).toContain('12 things arrived');
    expect(text).toContain('2 earlier');
    expect(text).not.toContain('line 1\n');
    expect(text).toContain('line 11');
  });
});

describe('T336: a woken session gets its events in the brief', () => {
  test('claimed events are not digested; `delivered` marks them for the session', async () => {
    const { prompts, target } = fakeTarget();
    const delivery = new SessionDelivery({ events, target: () => target, delayMs: 5 });
    const note = await events.emit(line('use CSV'));
    const wake = delivery.inBrief(node, [note]);
    expect(wake.text).toContain(
      `${note.id} (human_line): The operator wrote on the stream: use CSV`,
    );
    delivery.notify(node);
    await Bun.sleep(30);
    expect(prompts).toEqual([]);
    wake.delivered('S2');
    await until(() => events.pendingFor(node).length === 0);
    const [record] = store.readDeliveries(node).filter((d) => d.status === 'delivered');
    expect(record?.session).toBe('S2');
    wake.release();
    await Bun.sleep(30);
    expect(prompts).toEqual([]);
    delivery.stop();
  });

  test('released unaccepted, the events go with the next digest', async () => {
    const { prompts, target } = fakeTarget();
    const delivery = new SessionDelivery({ events, target: () => target, delayMs: 5 });
    const note = await events.emit(line('use CSV'));
    const wake = delivery.inBrief(node, [note]);
    wake.release();
    await until(() => prompts.length === 1);
    expect(prompts[0]).toContain('use CSV');
    delivery.stop();
  });
});
