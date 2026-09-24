/**
 * T140: the `propose_rule` verb (cockpit design §4.1, §5.1, **D4**). An
 * agent proposes; the record lands with `status: 'proposed'`, provenance
 * pointing back at the stream and session, and a thread entry `ref`'d to
 * the rule's file. Nothing here can accept a rule — the store's principal
 * split is asserted in `store.test.ts` and `rules/service.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AgentId, type Stream, type ThreadEntry, ulid } from '@agile-agents/shared';
import { runInit } from '../init';
import { KnowledgeService } from '../knowledge/service';
import { QuestionService } from '../questions/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { UnknownSessionError, VerbService } from './verbs';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: KnowledgeService;
let verbs: VerbService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-verbs-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new KnowledgeService({ store, streams });
  verbs = new VerbService({
    store,
    streams,
    questions: new QuestionService(store, streams),
    rules,
  });
});

afterEach(() => {
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** A live session on a fresh stream, as `runner/session.ts` registers one. */
async function attach(repo?: string): Promise<{ session: string; stream: Stream }> {
  const stream = await streams.create('human', {
    title: 'CSV parser',
    goal: 'decide the dialect',
    ...(repo !== undefined ? { repo } : {}),
  });
  const session = ulid();
  await store.putAgent(session as AgentId, {
    vendor: 'claude',
    model: 'sonnet',
    stream: stream.id,
    last_seen: new Date().toISOString(),
    role: 'worker',
  });
  return { session, stream };
}

describe('propose_rule', () => {
  test('writes a proposed rule with provenance and a thread entry that points at it', async () => {
    const { session, stream } = await attach();
    const entry: ThreadEntry = await verbs.proposeRule({
      session,
      text: 'always run the integration suite before pushing',
    });

    const [rule] = rules.listProposed();
    expect(rule?.status).toBe('proposed');
    expect(rule?.text).toBe('always run the integration suite before pushing');
    expect(rule?.enforcement).toBe('tell');
    expect(rule?.source).toEqual({ by: 'agent', node: stream.id, session });
    expect(rule?.decided_at).toBeUndefined();
    expect(rule?.decided_by).toBeUndefined();
    expect(entry.kind).toBe('proposal');
    expect(entry.by).toBe(`agent:${session}`);
    expect(entry.ref).toBe(`knowledge/${rule?.id}.yaml`);
  });

  test('a repo-less stream’s proposal is scoped to that stream, never global', async () => {
    const { session, stream } = await attach();
    await verbs.proposeRule({ session, text: 'x' });
    expect(rules.listProposed()[0]?.scope).toEqual({ kind: 'subtree', node: stream.id });
  });

  test('a stream with a repo scopes the proposal to the repo (§5.1)', async () => {
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const { session } = await attach('alpha');
    await verbs.proposeRule({ session, text: 'x' });
    expect(rules.listProposed()[0]?.scope).toEqual({ kind: 'repo', repo: 'alpha' });
  });

  test('the scope grammar: global, the bare words, and explicit refs', async () => {
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const { session, stream } = await attach('alpha');
    await verbs.proposeRule({ session, text: 'a', scope: 'global' });
    await verbs.proposeRule({ session, text: 'b', scope: 'repo' });
    await verbs.proposeRule({ session, text: 'c', scope: 'stream' });
    await verbs.proposeRule({ session, text: 'd', scope: `stream:${stream.id}` });
    expect(rules.listProposed().map((r) => [r.text, r.scope])).toEqual([
      ['a', { kind: 'global' }],
      ['b', { kind: 'repo', repo: 'alpha' }],
      ['c', { kind: 'subtree', node: stream.id }],
      ['d', { kind: 'subtree', node: stream.id }],
    ]);
  });

  test('an unparseable scope is refused, and nothing is written', async () => {
    const { session } = await attach();
    await expect(verbs.proposeRule({ session, text: 'x', scope: 'everything' })).rejects.toThrow(
      /invalid knowledge scope/,
    );
    expect(rules.list()).toEqual([]);
  });

  test('a scope of "repo" on a repo-less stream is refused', async () => {
    const { session } = await attach();
    await expect(verbs.proposeRule({ session, text: 'x', scope: 'repo' })).rejects.toThrow(
      /needs a stream with a repo/,
    );
  });

  test('the old tiers map to enforcement: classifier is an action check with its examples', async () => {
    const { session } = await attach();
    await verbs.proposeRule({
      session,
      text: 'no new dependencies',
      enforcement: 'classifier',
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'bun test', violates: false },
      ],
    });
    const [rule] = rules.listProposed();
    expect(rule?.enforcement).toBe('action');
    expect(rule?.check).toEqual({
      by: 'classifier',
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'bun test', violates: false },
      ],
    });
  });

  test('a session that is no longer attached cannot propose anything', async () => {
    await expect(verbs.proposeRule({ session: ulid(), text: 'x' })).rejects.toThrow(
      UnknownSessionError,
    );
  });
});
