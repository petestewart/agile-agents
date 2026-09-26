import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROUTED_EVENT_STRING_MAX, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { RoutedEventService, UnknownEventError } from './service';

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

describe('activity (T245)', () => {
  test("a node's activity: newest first, with its reason and the session that carried it", async () => {
    const first = await events.emit(line('one'));
    const second = await events.emit(line('two'));
    await events.mark(b, [first.id], 'delivered', { session: 'S-1' });
    await events.mark(b, [second.id], 'delivered', { digest: 'D-1' });
    const rows = restart().activityFor(b);
    expect(rows.map((r) => r.event.id)).toEqual([second.id, first.id]);
    expect(rows[0]).toMatchObject({ because: 'ancestor', status: 'delivered', digest: 'D-1' });
    expect(rows[1]).toMatchObject({ status: 'delivered', session: 'S-1' });
    expect(events.activityFor(a).map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  test('forRepo lists only the events on that repo', async () => {
    await events.emit(line());
    const moved = await events.emit({
      type: 'main_changed',
      repo: 'api',
      payload: { repo: 'api', sha: 'b2', outcome: 'synced' },
      by: 'daemon',
      routing: [{ node: a, because: 'same_repo' }],
    });
    expect(events.forRepo('api').map((e) => e.id)).toEqual([moved.id]);
  });
});

describe('the log a page at a time (T383)', () => {
  const onRepo = (repo: string, body: string) => ({
    ...line(body),
    repo,
  });

  test('pages newest first with a cursor, across the end of the log', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) ids.push((await events.emit(line(`n${i}`))).id);
    const newest = [...ids].reverse();
    const first = events.page({ limit: 3 });
    expect(first.events.map((e) => e.id)).toEqual(newest.slice(0, 3));
    expect(first).toMatchObject({ more: true, total: 7 });
    const second = events.page({ limit: 3, before: first.events.at(-1)?.id });
    expect(second.events.map((e) => e.id)).toEqual(newest.slice(3, 6));
    expect(second.more).toBe(true);
    // The last page holds what is left and says the log ends there.
    const last = events.page({ limit: 3, before: second.events.at(-1)?.id });
    expect(last.events.map((e) => e.id)).toEqual(newest.slice(6));
    expect(last).toMatchObject({ more: false, total: 7 });
    // Before the oldest event there is nothing.
    expect(events.page({ before: ids[0] })).toEqual({ events: [], more: false, total: 7 });
    // A page exactly as long as what is left has no more.
    expect(events.page({ limit: 1, before: ids[1] })).toMatchObject({ more: false });
    expect(events.page({ limit: 7 }).more).toBe(false);
  });

  test('the default page is the newest 200, and an empty log is one empty page', async () => {
    expect(events.page()).toEqual({ events: [], more: false, total: 0 });
    for (let i = 0; i < 201; i++) await events.emit(line(`n${i}`));
    const page = restart().page();
    expect(page.events).toHaveLength(200);
    expect(page.events[0]?.payload).toEqual({ body: 'n200' });
    expect(page).toMatchObject({ more: true, total: 201 });
  });

  test("repo keeps that repo's events; the cursor pages through them", async () => {
    const api1 = await events.emit(onRepo('api', 'a1'));
    await events.emit(onRepo('web', 'w1'));
    const api2 = await events.emit(onRepo('api', 'a2'));
    await events.emit(line('no repo'));
    const api3 = await events.emit(onRepo('api', 'a3'));
    const first = events.page({ repo: 'api', limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual([api3.id, api2.id]);
    expect(first).toMatchObject({ more: true, total: 3 });
    const rest = events.page({ repo: 'api', limit: 2, before: api2.id });
    expect(rest.events.map((e) => e.id)).toEqual([api1.id]);
    expect(rest.more).toBe(false);
    expect(events.page({ repo: 'nope' })).toEqual({ events: [], more: false, total: 0 });
  });

  test('an unknown cursor is refused by name', async () => {
    await events.emit(line());
    expect(() => events.page({ before: 'E-nope' })).toThrow(UnknownEventError);
    expect(() => events.page({ before: 'E-nope' })).toThrow(/no event E-nope in the log/);
  });

  test('an event emitted after a page was read tops the next one, once', async () => {
    const old = await events.emit(line('old'));
    // A fresh service whose first read of the log comes after the append.
    const fresh = restart();
    const next = await fresh.emit(line('new'));
    expect(fresh.page().events.map((e) => e.id)).toEqual([next.id, old.id]);
    expect(fresh.get(next.id)?.payload).toEqual({ body: 'new' });
    const late = new RoutedEventService(StateStore.open(root));
    const third = await late.emit(line('third'));
    expect(late.page().events.map((e) => e.id)).toEqual([third.id, next.id, old.id]);
    expect(late.recent().map((e) => e.id)).toEqual([third.id, next.id, old.id]);
  });
});
