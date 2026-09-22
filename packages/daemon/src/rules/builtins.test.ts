/**
 * T143: §5.4's built-in pattern rules — created on first daemon start,
 * idempotent on every one after, and a retired built-in stays retired.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { BUILTIN_PROVENANCE, ensureBuiltinRules } from './builtins';
import { RulesService } from './service';

let home: string;
let store: StateStore;
let rules: RulesService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-builtins-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  rules = new RulesService({ store, streams: new StreamService(store) });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the three §5.4 built-ins are created as global pattern rules on first start', async () => {
  const created = await ensureBuiltinRules(store);
  expect(created.map((rule) => rule.pattern?.kind)).toEqual([
    'no_push_protected',
    'no_push',
    'path_deny',
  ]);
  for (const rule of created) {
    expect(rule.scope).toEqual({ kind: 'global' });
    expect(rule.enforcement).toBe('pattern');
    expect(rule.stage).toBe('action');
    expect(rule.provenance.by).toBe(BUILTIN_PROVENANCE);
    expect(rule.stats).toEqual({ fired: 0, violated: 0, routed: 0 });
  }

  const [protectedBranch, push, worktree] = created;
  // D8: on, and critical — the one act a human cannot cheaply undo.
  expect(protectedBranch?.status).toBe('accepted');
  expect(protectedBranch?.critical).toBe(true);
  // D7: agents may push by default, so the rule ships retired.
  expect(push?.status).toBe('retired');
  expect(worktree?.status).toBe('accepted');
  expect(worktree?.critical).toBe(true);
});

test('each built-in carries its §5.4 name, and a nameless one is backfilled (T145)', async () => {
  const created = await ensureBuiltinRules(store);
  expect(created.map((rule) => rule.name)).toEqual(['no_push_protected', 'no_push', 'path_deny']);

  // A built-in written before `name` existed: the next daemon start names
  // it in place rather than creating a second one or leaving `-` forever.
  const target = created[0];
  if (target === undefined) throw new Error('no built-in');
  const { name: _dropped, ...nameless } = target;
  await store.updateRule('daemon', target.id, () => nameless);
  expect(store.getRule(target.id).name).toBeUndefined();

  const again = await ensureBuiltinRules(store);
  expect(again.map((r) => r.id)).toEqual(created.map((r) => r.id));
  expect(store.getRule(target.id).name).toBe('no_push_protected');
  expect(store.listRules()).toHaveLength(3);
});

test('a second daemon start creates nothing (idempotent by kind + builtin provenance)', async () => {
  const first = await ensureBuiltinRules(store);
  const second = await ensureBuiltinRules(store);
  expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  expect(store.listRules()).toHaveLength(3);
});

test('a retired built-in stays retired across restarts, and an accepted one the human retired is never re-accepted', async () => {
  const [protectedBranch] = await ensureBuiltinRules(store);
  if (protectedBranch === undefined) throw new Error('no built-ins created');
  await rules.retire(protectedBranch.id, 'pete');

  await ensureBuiltinRules(store);

  expect(store.listRules()).toHaveLength(3);
  expect(store.getRule(protectedBranch.id).status).toBe('retired');
  // And so a retired rule is out of scope on the next tool call (§5.3).
  expect(rules.list({ status: 'accepted' }).map((r) => r.pattern?.kind)).toEqual(['path_deny']);
});

test('a human accepting the retired no_push rule is not undone by a restart', async () => {
  const created = await ensureBuiltinRules(store);
  const push = created.find((rule) => rule.pattern?.kind === 'no_push');
  if (push === undefined) throw new Error('no no_push rule');
  await rules.accept(push.id, 'pete');

  await ensureBuiltinRules(store);
  expect(store.getRule(push.id).status).toBe('accepted');
});

test('recordFired bumps fired, and violated/routed on top of it, as the daemon principal', async () => {
  const [rule] = await ensureBuiltinRules(store);
  if (rule === undefined) throw new Error('no built-ins created');

  await rules.recordFired(rule.id, 'fired');
  await rules.recordFired(rule.id, 'violated');
  await rules.recordFired(rule.id, 'routed');
  await rules.flushStats();

  const after = store.getRule(rule.id);
  expect(after.stats.fired).toBe(3);
  expect(after.stats.violated).toBe(1);
  expect(after.stats.routed).toBe(1);
  expect(after.stats.last_fired_at).toBeString();
  // Stats are not a decision: the human's fields are untouched.
  expect(after.status).toBe('accepted');
  expect(after.decided_by).toBe(BUILTIN_PROVENANCE);
});

// ------------------------------------------------------- coalesced stats

test('counters are coalesced: three fires are one write, and a read sees them before it lands', async () => {
  const [rule] = await ensureBuiltinRules(store);
  if (rule === undefined) throw new Error('no built-ins created');
  // No timer: this test owns the flush point (§5.7's counters are
  // telemetry, so "when" is a tunable, not a contract).
  const coalescing = new RulesService({
    store,
    streams: new StreamService(store),
    statsFlushMs: 0,
  });
  const eventsBefore = store.listEvents().filter((e) => e.kind === 'rule_put').length;

  await coalescing.recordFired(rule.id, 'fired');
  await coalescing.recordFired(rule.id, 'violated');
  await coalescing.recordFired(rule.id, 'fired');

  // Nothing on disk yet — that is the point.
  expect(store.getRule(rule.id).stats.fired).toBe(0);
  // But a read through the service is never stale (flush-on-read merges
  // whatever is still pending).
  expect(coalescing.get(rule.id).stats.fired).toBe(3);
  expect(coalescing.get(rule.id).stats.violated).toBe(1);
  expect(coalescing.list().find((r) => r.id === rule.id)?.stats.fired).toBe(3);

  await coalescing.flushStats();
  const after = store.getRule(rule.id);
  expect(after.stats.fired).toBe(3);
  expect(after.stats.violated).toBe(1);
  expect(after.stats.last_fired_at).toBeString();
  // One write for three fires, not three.
  const eventsAfter = store.listEvents().filter((e) => e.kind === 'rule_put').length;
  expect(eventsAfter - eventsBefore).toBe(1);

  // A flush with nothing pending writes nothing at all.
  await coalescing.flushStats();
  expect(store.listEvents().filter((e) => e.kind === 'rule_put').length).toBe(eventsAfter);
  coalescing.dispose();
});

test('a read flushes: the counters reach disk without anyone calling flushStats', async () => {
  const [rule] = await ensureBuiltinRules(store);
  if (rule === undefined) throw new Error('no built-ins created');
  const coalescing = new RulesService({
    store,
    streams: new StreamService(store),
    statsFlushMs: 0,
  });

  await coalescing.recordFired(rule.id, 'violated');
  coalescing.list();
  await waitFor(() => store.getRule(rule.id).stats.violated === 1);
  coalescing.dispose();
});

test('the timer flushes on its own, with no read and no shutdown', async () => {
  const [rule] = await ensureBuiltinRules(store);
  if (rule === undefined) throw new Error('no built-ins created');
  const ticking = new RulesService({
    store,
    streams: new StreamService(store),
    statsFlushMs: 10,
  });
  try {
    await ticking.recordFired(rule.id, 'fired');
    expect(store.getRule(rule.id).stats.fired).toBe(0);
    await waitFor(() => store.getRule(rule.id).stats.fired === 1);
  } finally {
    ticking.dispose();
  }
});

/** Polls until `predicate` holds, so a timer-driven write needs no fixed sleep. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for the stats flush');
}
