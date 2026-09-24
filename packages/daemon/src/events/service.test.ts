import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTED_EVENT_STRING_MAX, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { RoutedEventService } from './service';

let home: string;
let root: string;
let store: StateStore;
let events: RoutedEventService;
const a = ulid();
const b = ulid();

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-routed-'));
  root = runInit(home).stateRoot;
  store = StateStore.open(root);
  events = new RoutedEventService(store);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const line = (body = 'hi') => ({
  type: 'human_line' as const,
  subject: a,
  payload: { body },
  by: 'human' as const,
  routing: [
    { node: a, because: 'self' as const },
    { node: b, because: 'ancestor' as const },
  ],
});

/** A fresh daemon over the same home: nothing in memory survives. */
const restart = () => new RoutedEventService(StateStore.open(root));

describe('RoutedEventService (T240)', () => {
  test('emit, then a crash and restart: the deliveries are still pending', async () => {
    const e = await events.emit(line());
    expect(e.id).toMatch(/^E-/);
    const after = restart();
    expect(after.pendingFor(a).map((p) => p.event.id)).toEqual([e.id]);
    expect(after.pendingFor(b).map((p) => p.event.id)).toEqual([e.id]);
    expect(after.get(e.id)?.payload).toEqual({ body: 'hi' });
  });

  test('a crash between the log and the queue append is recovered as pending', async () => {
    const e = await events.emit(line());
    rmSync(join(root, 'events', 'queue', `${b}.jsonl`));
    const after = restart();
    expect(after.pendingFor(b)).toEqual([]);
    expect(await after.recover()).toBe(1);
    expect(after.pendingFor(b).map((p) => p.event.id)).toEqual([e.id]);
    expect(await after.recover()).toBe(0);
  });

  test('mark delivered moves only pending deliveries, per node', async () => {
    const e1 = await events.emit(line('one'));
    const e2 = await events.emit(line('two'));
    await events.mark(a, [e1.id], 'delivered', { session: 's1', digest: 'd1' });
    const after = restart();
    expect(after.pendingFor(a).map((p) => p.event.id)).toEqual([e2.id]);
    expect(after.pendingFor(b)).toHaveLength(2);
    await expect(after.mark(a, [e1.id], 'delivered')).rejects.toThrow(/not pending/);
    await expect(after.mark(a, [`E-${ulid()}`], 'expired')).rejects.toThrow(/absent/);
    const last = store.readDeliveries(a).at(-1);
    expect(last).toMatchObject({ status: 'delivered', session: 's1', digest: 'd1' });
    expect(last?.delivered_at).toBeDefined();
  });

  test('payloads over the cap are refused and nothing is written', async () => {
    await expect(events.emit(line('x'.repeat(ROUTED_EVENT_STRING_MAX + 1)))).rejects.toThrow();
    expect(existsSync(join(root, 'events', 'log.jsonl'))).toBe(false);
  });

  test('a corrupt line is refused with path and line', async () => {
    await events.emit(line());
    appendFileSync(join(root, 'events', 'queue', `${a}.jsonl`), '{"event":"bad"}\n');
    expect(() => restart().pendingFor(a)).toThrow(/corrupt delivery queue file .*\.jsonl:2:/);
    appendFileSync(join(root, 'events', 'log.jsonl'), 'not json\n');
    expect(() => restart().get('E-x')).toThrow(/corrupt routed event log file .*log\.jsonl:2:/);
  });

  test('the audit log is unchanged (P9)', async () => {
    const auditPath = join(root, 'log', 'events.jsonl');
    const before = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
    const e = await events.emit(line());
    await events.mark(a, [e.id], 'delivered');
    const after = existsSync(auditPath) ? readFileSync(auditPath, 'utf8') : '';
    expect(after).toBe(before);
  });
});
