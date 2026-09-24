/**
 * T143: §5.4's built-in pattern rules — created on first daemon start,
 * idempotent on every one after, and a retired built-in stays retired.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type KnowledgeId, type Policy, patternOf } from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { wireClassifierRouteStats } from '../hook/route-band';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { BUILTIN_PROVENANCE, ensureBuiltinKnowledge } from './builtins';
import { KnowledgeService } from './service';

let home: string;
let store: StateStore;
let rules: KnowledgeService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-builtins-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  rules = new KnowledgeService({ store, streams: new StreamService(store) });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test('the three §5.4 built-ins are created as global standard action items with a pattern check', async () => {
  const created = await ensureBuiltinKnowledge(store);
  expect(created.map((rule) => patternOf(rule)?.kind)).toEqual([
    'no_push_protected',
    'no_push',
    'path_deny',
  ]);
  for (const rule of created) {
    expect(rule.scope).toEqual({ kind: 'global' });
    expect(rule.kind).toBe('standard');
    expect(rule.enforcement).toBe('action');
    expect(rule.check?.by).toBe('pattern');
    expect(rule.source.by).toBe(BUILTIN_PROVENANCE);
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
  const created = await ensureBuiltinKnowledge(store);
  expect(created.map((rule) => rule.name)).toEqual(['no_push_protected', 'no_push', 'path_deny']);

  // A built-in written before `name` existed: the next daemon start names
  // it in place rather than creating a second one or leaving `-` forever.
  const target = created[0];
  if (target === undefined) throw new Error('no built-in');
  const { name: _dropped, ...nameless } = target;
  await store.updateKnowledge('daemon', target.id, () => nameless);
  expect(store.getKnowledge(target.id).name).toBeUndefined();

  const again = await ensureBuiltinKnowledge(store);
  expect(again.map((r) => r.id)).toEqual(created.map((r) => r.id));
  expect(store.getKnowledge(target.id).name).toBe('no_push_protected');
  expect(store.listKnowledge()).toHaveLength(3);
});

test('a second daemon start creates nothing (idempotent by kind + builtin provenance)', async () => {
  const first = await ensureBuiltinKnowledge(store);
  const second = await ensureBuiltinKnowledge(store);
  expect(second.map((r) => r.id)).toEqual(first.map((r) => r.id));
  expect(store.listKnowledge()).toHaveLength(3);
});

test('a retired built-in stays retired across restarts, and an accepted one the human retired is never re-accepted', async () => {
  const [protectedBranch] = await ensureBuiltinKnowledge(store);
  if (protectedBranch === undefined) throw new Error('no built-ins created');
  await rules.retire(protectedBranch.id, 'pete');

  await ensureBuiltinKnowledge(store);

  expect(store.listKnowledge()).toHaveLength(3);
  expect(store.getKnowledge(protectedBranch.id).status).toBe('retired');
  // And so a retired rule is out of scope on the next tool call (§5.3).
  expect(rules.list({ status: 'accepted' }).map((r) => patternOf(r)?.kind)).toEqual(['path_deny']);
});

test('a human accepting the retired no_push rule is not undone by a restart', async () => {
  const created = await ensureBuiltinKnowledge(store);
  const push = created.find((rule) => patternOf(rule)?.kind === 'no_push');
  if (push === undefined) throw new Error('no no_push rule');
  await rules.accept(push.id, 'pete');

  await ensureBuiltinKnowledge(store);
  expect(store.getKnowledge(push.id).status).toBe('accepted');
});

test('recordFired bumps fired, and violated/routed on top of it, as the daemon principal', async () => {
  const [rule] = await ensureBuiltinKnowledge(store);
  if (rule === undefined) throw new Error('no built-ins created');

  await rules.recordFired(rule.id, 'fired');
  await rules.recordFired(rule.id, 'violated');
  await rules.recordFired(rule.id, 'routed');
  await rules.flushStats();

  const after = store.getKnowledge(rule.id);
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
  const [rule] = await ensureBuiltinKnowledge(store);
  if (rule === undefined) throw new Error('no built-ins created');
  // No timer: this test owns the flush point (§5.7's counters are
  // telemetry, so "when" is a tunable, not a contract).
  const coalescing = new KnowledgeService({
    store,
    streams: new StreamService(store),
    statsFlushMs: 0,
  });
  const eventsBefore = store.listEvents().filter((e) => e.kind === 'knowledge_put').length;

  await coalescing.recordFired(rule.id, 'fired');
  await coalescing.recordFired(rule.id, 'violated');
  await coalescing.recordFired(rule.id, 'fired');

  // Nothing on disk yet — that is the point.
  expect(store.getKnowledge(rule.id).stats.fired).toBe(0);
  // But a read through the service is never stale (flush-on-read merges
  // whatever is still pending).
  expect(coalescing.get(rule.id).stats.fired).toBe(3);
  expect(coalescing.get(rule.id).stats.violated).toBe(1);
  expect(coalescing.list().find((r) => r.id === rule.id)?.stats.fired).toBe(3);

  await coalescing.flushStats();
  const after = store.getKnowledge(rule.id);
  expect(after.stats.fired).toBe(3);
  expect(after.stats.violated).toBe(1);
  expect(after.stats.last_fired_at).toBeString();
  // One write for three fires, not three.
  const eventsAfter = store.listEvents().filter((e) => e.kind === 'knowledge_put').length;
  expect(eventsAfter - eventsBefore).toBe(1);

  // A flush with nothing pending writes nothing at all.
  await coalescing.flushStats();
  expect(store.listEvents().filter((e) => e.kind === 'knowledge_put').length).toBe(eventsAfter);
  coalescing.dispose();
});

test('a read flushes: the counters reach disk without anyone calling flushStats', async () => {
  const [rule] = await ensureBuiltinKnowledge(store);
  if (rule === undefined) throw new Error('no built-ins created');
  const coalescing = new KnowledgeService({
    store,
    streams: new StreamService(store),
    statsFlushMs: 0,
  });

  await coalescing.recordFired(rule.id, 'violated');
  coalescing.list();
  await waitFor(() => store.getKnowledge(rule.id).stats.violated === 1);
  coalescing.dispose();
});

test('the timer flushes on its own, with no read and no shutdown', async () => {
  const [rule] = await ensureBuiltinKnowledge(store);
  if (rule === undefined) throw new Error('no built-ins created');
  const ticking = new KnowledgeService({
    store,
    streams: new StreamService(store),
    statsFlushMs: 10,
  });
  try {
    await ticking.recordFired(rule.id, 'fired');
    expect(store.getKnowledge(rule.id).stats.fired).toBe(0);
    await waitFor(() => store.getKnowledge(rule.id).stats.fired === 1);
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

// ------------------------------------------- T153: the routed-then-denied fix

/** A `classifier_review` gate the human owns — §6.3's route band. */
const ROUTE_POLICY: Policy = { gates: { classifier_review: 'human' }, breaker_signals: [] };

test('a routed call the human later denies is one firing, not two (T153)', async () => {
  const [rule] = await ensureBuiltinKnowledge(store);
  if (rule === undefined) throw new Error('no built-ins created');
  const streams = new StreamService(store);
  const stream = await streams.create('human', { title: 'parser', goal: 'pick a dialect' });
  const gates = new GateService(store);
  wireClassifierRouteStats(gates, rules);

  // The hook's side: the classifier's band routed this call to the human,
  // which is one evaluation of the rule.
  await rules.recordFired(rule.id, 'routed');
  const gate = await gates.request('classifier_review', {
    policy: ROUTE_POLICY,
    stream: stream.id,
    rule: rule.id as KnowledgeId,
    summary: 'the classifier routed this call',
  });
  // The human's side: their deny turns that routed call into a violation.
  await gates.respond(gate.id, 'deny', 'pete', 'no');
  await rules.flushStats();

  const after = store.getKnowledge(rule.id);
  expect(after.stats).toMatchObject({ fired: 1, routed: 1, violated: 1 });
  // The deny is not a firing, so it does not move the firing clock either.
  expect(after.stats.last_fired_at).toBeString();
});

test('an approved route stays a route: nothing is added to violated', async () => {
  const [rule] = await ensureBuiltinKnowledge(store);
  if (rule === undefined) throw new Error('no built-ins created');
  const streams = new StreamService(store);
  const stream = await streams.create('human', { title: 'parser', goal: 'pick a dialect' });
  const gates = new GateService(store);
  wireClassifierRouteStats(gates, rules);

  await rules.recordFired(rule.id, 'routed');
  const gate = await gates.request('classifier_review', {
    policy: ROUTE_POLICY,
    stream: stream.id,
    rule: rule.id as KnowledgeId,
  });
  await gates.respond(gate.id, 'approve', 'pete');
  await rules.flushStats();

  expect(store.getKnowledge(rule.id).stats).toMatchObject({ fired: 1, routed: 1, violated: 0 });
});
