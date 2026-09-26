/**
 * T140: a proposed rule is a `rule_accept` inbox item (cockpit design
 * §3.1). Kept in `rules/` rather than in `inbox/service.test.ts` so the
 * rule half of the inbox is tested beside the service that produces it.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type InboxItem, validateInboxItem } from '@agile-agents/shared';
import { GateService } from '../gates/service';
import { InboxService } from '../inbox/service';
import { runInit } from '../init';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { KnowledgeService } from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: KnowledgeService;
let inbox: InboxService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rule-inbox-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new KnowledgeService({ store, streams });
  inbox = new InboxService({
    streams,
    questions: new QuestionService(store, streams),
    gates: new GateService(store),
    rules,
  });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

test('a proposed rule on a stream carries the stream path, the scope and the rule file', async () => {
  const root = await streams.create('human', { title: 'ledger-lite', goal: 'import CSVs' });
  const child = await streams.create('human', {
    title: 'parser',
    goal: 'pick the dialect',
    parent: root.id,
  });
  const rule = await rules.create('agent', {
    text: 'always run the integration suite before pushing',
    name: 'integration-first',
    scope: { kind: 'subtree', node: child.id },
    source: { node: child.id, by: 'agent' },
  });

  const items: InboxItem[] = inbox.list();
  expect(items.map((i) => i.kind)).toEqual(['rule_accept']);
  const item = items[0];
  expect(item?.id).toBe(rule.id);
  expect(item?.stream).toBe(child.id);
  expect(item?.stream_path).toEqual(['ledger-lite', 'parser']);
  expect(item?.ref).toBe(`knowledge/${rule.id}.yaml`);
  expect(item?.context).toBe(
    `integration-first · subtree:${child.id}: always run the integration suite before pushing`,
  );
  expect(validateInboxItem(item).kind).toBe('rule_accept');
});

test('a global proposed rule with no stream is still an item', async () => {
  await rules.create('human', { text: 'prefer the repo scripts' });
  const [item] = inbox.list();
  expect(item?.kind).toBe('rule_accept');
  expect(item?.stream).toBeUndefined();
  expect(item?.stream_path).toEqual([]);
  expect(item?.context).toBe('global: prefer the repo scripts');
  expect(validateInboxItem(item).id).toMatch(/^K-/);
});

test('an accepted or retired rule leaves the inbox', async () => {
  const rule = await rules.create('human', { text: 'prefer the repo scripts' });
  expect(inbox.list()).toHaveLength(1);
  await rules.accept(rule.id, 'pete');
  expect(inbox.list()).toEqual([]);
  await rules.retire(rule.id, 'pete');
  expect(inbox.list()).toEqual([]);
});

test('an inbox with no rules service wired shows no rule items', async () => {
  await rules.create('human', { text: 'prefer the repo scripts' });
  const without = new InboxService({
    streams,
    questions: new QuestionService(store, streams),
    gates: new GateService(store),
  });
  expect(without.list()).toEqual([]);
});

test('T260: migrated seed proposals collapse into one card; agent proposals stay individual', async () => {
  const stream = await streams.create('human', { title: 'parser', goal: 'pick the dialect' });
  const a = await rules.create('human', {
    text: 'all shared schemas are strict',
    source: { by: 'migration' },
  });
  const b = await rules.create('human', {
    text: 'hooks enforce, prompts express intent',
    source: { by: 'migration' },
  });
  const lesson = await rules.create('agent', {
    text: 'run the repo scripts',
    scope: { kind: 'subtree', node: stream.id },
    source: { node: stream.id, by: 'agent' },
  });

  const items = inbox
    .list()
    .sort((x, y) => (x.kind === y.kind ? x.id.localeCompare(y.id) : x.kind < y.kind ? 1 : -1));
  expect(items.map((i) => [i.kind, i.id])).toEqual([
    ['rule_batch', 'migration'],
    ['rule_accept', lesson.id],
  ]);
  const batch = items[0];
  expect(batch?.context).toBe('2 proposed rules from migration');
  expect(batch?.rules).toEqual([a.id, b.id]);
  expect(batch?.stream).toBeUndefined();
  expect(validateInboxItem(batch).kind).toBe('rule_batch');

  // Deciding one shrinks the card; deciding the rest removes it.
  await rules.retire(a.id, 'human');
  expect(inbox.list().find((i) => i.id === 'migration')?.rules).toEqual([b.id]);
  await rules.retire(b.id, 'human');
  expect(inbox.list().map((i) => i.id)).toEqual([lesson.id]);
});

test('T163: an item schema keeps rule ids on rule_batch only', () => {
  const base = { stream_path: [], ts: new Date().toISOString(), context: 'x' };
  expect(() => validateInboxItem({ ...base, kind: 'rule_batch', id: 'seed:x' })).toThrow(
    /rule ids/,
  );
  expect(() =>
    validateInboxItem({ ...base, kind: 'rule_accept', id: 'K-1', rules: ['K-1'] }),
  ).toThrow();
});
