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
import { RulesService } from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: RulesService;
let inbox: InboxService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rule-inbox-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new RulesService({ store, streams });
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
    scope: { kind: 'stream', ref: child.id },
    provenance: { stream: child.id, by: 'agent' },
  });

  const items: InboxItem[] = inbox.list();
  expect(items.map((i) => i.kind)).toEqual(['rule_accept']);
  const item = items[0];
  expect(item?.id).toBe(rule.id);
  expect(item?.stream).toBe(child.id);
  expect(item?.stream_path).toEqual(['ledger-lite', 'parser']);
  expect(item?.ref).toBe(`rules/${rule.id}.yaml`);
  expect(item?.context).toBe(`stream:${child.id}: always run the integration suite before pushing`);
  expect(validateInboxItem(item).kind).toBe('rule_accept');
});

test('a global proposed rule with no stream is still an item', async () => {
  await rules.create('human', { text: 'prefer the repo scripts' });
  const [item] = inbox.list();
  expect(item?.kind).toBe('rule_accept');
  expect(item?.stream).toBeUndefined();
  expect(item?.stream_path).toEqual([]);
  expect(item?.context).toBe('global: prefer the repo scripts');
  expect(validateInboxItem(item).id).toMatch(/^R-/);
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
