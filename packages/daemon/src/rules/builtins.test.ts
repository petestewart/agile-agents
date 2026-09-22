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

  const after = store.getRule(rule.id);
  expect(after.stats.fired).toBe(3);
  expect(after.stats.violated).toBe(1);
  expect(after.stats.routed).toBe(1);
  expect(after.stats.last_fired_at).toBeString();
  // Stats are not a decision: the human's fields are untouched.
  expect(after.status).toBe('accepted');
  expect(after.decided_by).toBe(BUILTIN_PROVENANCE);
});
