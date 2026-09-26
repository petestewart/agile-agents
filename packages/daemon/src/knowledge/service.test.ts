/**
 * T140/T260: `KnowledgeService` and `knowledgeInScope` against a real temp state home —
 * no git, no vendor, no network (cockpit design §5).
 *
 * The scope filter gets its own block: §5.3 is the one place scope is
 * decided, and the brief and the hook both rely on it, so global / repo /
 * stream / nested-stream are asserted here rather than in either caller.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type KnowledgeItem,
  type KnowledgeItemInput,
  type RoutedEvent,
  type Stream,
  ulid,
  validateKnowledgeItem,
} from '@agile-agents/shared';
import { makeEmitter, summarize } from '../events/producers';
import { RoutedEventService } from '../events/service';
import { runInit } from '../init';
import { ProjectService } from '../projects';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  KnowledgeAlreadyDecidedError,
  KnowledgeService,
  UnknownKnowledgeScopeError,
  knowledgeInScope,
} from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: KnowledgeService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rules-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new KnowledgeService({ store, streams });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------ rulesInScope

function fixture(text: string, over: Partial<KnowledgeItemInput> = {}): KnowledgeItem {
  return validateKnowledgeItem({
    id: `K-${ulid()}`,
    kind: 'standard',
    text,
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'tell',
    critical: false,
    source: { by: 'human' },
    stats: {},
    created_at: '2026-09-22T00:00:00.000Z',
    ...over,
  });
}

function fixtureStream(over: Partial<Stream> = {}): Stream {
  return {
    id: ulid(),
    title: 'a stream',
    goal: 'a goal',
    created_at: '2026-09-22T00:00:00.000Z',
    agent: { status: 'idle', updated_at: '2026-09-22T00:00:00.000Z' },
    human: { status: 'open' },
    sessions: [],
    ...over,
  };
}

describe('knowledgeInScope', () => {
  test('a stream with no repo sees global rules only', () => {
    const stream = fixtureStream();
    const all = [
      fixture('global one'),
      fixture('repo one', { scope: { kind: 'repo', repo: 'alpha' } }),
      fixture('stream one', { scope: { kind: 'subtree', node: ulid() } }),
    ];
    expect(knowledgeInScope(all, stream).map((r) => r.text)).toEqual(['global one']);
  });

  test('a repo-scoped rule matches only its own repo', () => {
    const all = [
      fixture('alpha rule', { scope: { kind: 'repo', repo: 'alpha' } }),
      fixture('beta rule', { scope: { kind: 'repo', repo: 'beta' } }),
    ];
    expect(knowledgeInScope(all, fixtureStream({ repo: 'alpha' })).map((r) => r.text)).toEqual([
      'alpha rule',
    ]);
    expect(knowledgeInScope(all, fixtureStream({ repo: 'beta' })).map((r) => r.text)).toEqual([
      'beta rule',
    ]);
    expect(knowledgeInScope(all, fixtureStream())).toEqual([]);
  });

  test('a stream-scoped rule matches the stream itself', () => {
    const stream = fixtureStream();
    const all = [
      fixture('mine', { scope: { kind: 'subtree', node: stream.id } }),
      fixture('theirs', { scope: { kind: 'subtree', node: ulid() } }),
    ];
    expect(knowledgeInScope(all, stream).map((r) => r.text)).toEqual(['mine']);
  });

  test('a nested stream inherits every ancestor’s stream-scoped rules', () => {
    const root = fixtureStream({ title: 'root' });
    const mid = fixtureStream({ title: 'mid', parent: root.id });
    const leaf = fixtureStream({ title: 'leaf', parent: mid.id });
    const all = [
      fixture('from root', { scope: { kind: 'subtree', node: root.id } }),
      fixture('from mid', { scope: { kind: 'subtree', node: mid.id } }),
      fixture('from leaf', { scope: { kind: 'subtree', node: leaf.id } }),
      fixture('from a cousin', { scope: { kind: 'subtree', node: ulid() } }),
    ];
    expect(knowledgeInScope(all, leaf, [root, mid]).map((r) => r.text)).toEqual([
      'from root',
      'from mid',
      'from leaf',
    ]);
    // The inheritance is one-way: the root does not see its child's rules.
    expect(knowledgeInScope(all, root).map((r) => r.text)).toEqual(['from root']);
  });

  test('proposed and retired rules are never in scope', () => {
    const stream = fixtureStream({ repo: 'alpha' });
    const all = [
      fixture('accepted', { status: 'accepted' }),
      fixture('proposed', { status: 'proposed' }),
      fixture('retired', { status: 'retired' }),
      fixture('proposed repo rule', {
        status: 'proposed',
        scope: { kind: 'repo', repo: 'alpha' },
      }),
    ];
    expect(knowledgeInScope(all, stream).map((r) => r.text)).toEqual(['accepted']);
  });

  test('T260: a project-scoped item matches the streams of that project only', () => {
    const shop = `P-${ulid()}`;
    const all = [fixture('shop decision', { scope: { kind: 'project', project: shop } })];
    expect(knowledgeInScope(all, fixtureStream({ project: shop })).map((r) => r.text)).toEqual([
      'shop decision',
    ]);
    expect(knowledgeInScope(all, fixtureStream({ project: `P-${ulid()}` }))).toEqual([]);
    expect(knowledgeInScope(all, fixtureStream())).toEqual([]);
  });

  test('the enforcement filter selects one checkpoint', () => {
    const stream = fixtureStream();
    const check = { by: 'classifier' as const, examples: [] };
    const all = [
      fixture('told'),
      fixture('at the action', { enforcement: 'action', check }),
      fixture('at ship', { enforcement: 'ship', check }),
      fixture('at review', { enforcement: 'review' }),
    ];
    expect(knowledgeInScope(all, stream).map((r) => r.text)).toEqual([
      'told',
      'at the action',
      'at ship',
      'at review',
    ]);
    expect(knowledgeInScope(all, stream, [], 'action').map((r) => r.text)).toEqual([
      'at the action',
    ]);
    expect(knowledgeInScope(all, stream, [], 'ship').map((r) => r.text)).toEqual(['at ship']);
  });
});

// ---------------------------------------------------------------- service

describe('create (a proposal, whoever calls it)', () => {
  test('mints the id, created_at, stats and status: proposed', async () => {
    const rule = await rules.create('human', { text: 'prefer the repo scripts' });
    expect(rule.id).toMatch(/^K-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(rule.status).toBe('proposed');
    expect(rule.kind).toBe('standard');
    expect(rule.enforcement).toBe('tell');
    expect(rule.check).toBeUndefined();
    expect(rule.scope).toEqual({ kind: 'global' });
    expect(rule.critical).toBe(false);
    expect(rule.stats).toEqual({ fired: 0, violated: 0, routed: 0 });
    expect(rule.source).toEqual({ by: 'human' });
    expect(store.getKnowledge(rule.id).text).toBe('prefer the repo scripts');
  });

  test('an agent proposal records its session in source', async () => {
    const session = ulid();
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const rule = await rules.create('agent', {
      text: 'always run the integration suite',
      source: { by: 'agent', session, node: stream.id },
    });
    expect(rule.status).toBe('proposed');
    expect(rule.source).toEqual({ by: 'agent', session, node: stream.id });
  });

  test('name, kind and paths ride along; an unchecked ship item gets an empty classifier check', async () => {
    const rule = await rules.create('human', {
      name: 'tests-with-changes',
      kind: 'decision',
      text: 'every change under src/ has a test',
      paths: ['src/**'],
      enforcement: 'ship',
    });
    expect(rule.name).toBe('tests-with-changes');
    expect(rule.kind).toBe('decision');
    expect(rule.paths).toEqual(['src/**']);
    expect(rule.check).toEqual({ by: 'classifier', examples: [] });
  });

  test('a project scope needs an existing project', async () => {
    await expect(
      rules.create('human', { text: 'x', scope: { kind: 'project', project: `P-${ulid()}` } }),
    ).rejects.toThrow(/not a project in this home/);
  });

  test('a repo-scoped rule needs a registered repo', async () => {
    await expect(
      rules.create('human', { text: 'x', scope: { kind: 'repo', repo: 'ghost' } }),
    ).rejects.toThrow(UnknownKnowledgeScopeError);
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const rule = await rules.create('human', {
      text: 'x',
      scope: { kind: 'repo', repo: 'alpha' },
    });
    expect(rule.scope).toEqual({ kind: 'repo', repo: 'alpha' });
  });

  test('a stream-scoped rule needs an existing stream', async () => {
    await expect(
      rules.create('human', { text: 'x', scope: { kind: 'subtree', node: ulid() } }),
    ).rejects.toThrow(/not a stream in this home/);
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const rule = await rules.create('human', {
      text: 'x',
      scope: { kind: 'subtree', node: stream.id },
    });
    expect(rule.scope).toEqual({ kind: 'subtree', node: stream.id });
  });

  test('a check on a tell item, or a pattern on a ship item, is refused', async () => {
    await expect(
      rules.create('human', { text: 'x', check: { by: 'classifier', examples: [] } }),
    ).rejects.toThrow(/carries no check/);
    await expect(
      rules.create('human', {
        text: 'x',
        enforcement: 'ship',
        check: { by: 'pattern', pattern: { kind: 'no_push' } },
      }),
    ).rejects.toThrow(/action check only/);
  });
});

describe('list / listProposed', () => {
  test('filters by status and by rendered scope', async () => {
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const global = await rules.create('human', { text: 'global rule' });
    const repo = await rules.create('human', {
      text: 'repo rule',
      scope: { kind: 'repo', repo: 'alpha' },
    });
    await rules.accept(global.id, 'pete');

    expect(
      rules
        .list()
        .map((r) => r.id)
        .sort(),
    ).toEqual([global.id, repo.id].sort());
    expect(rules.list({ status: 'proposed' }).map((r) => r.id)).toEqual([repo.id]);
    expect(rules.listProposed().map((r) => r.id)).toEqual([repo.id]);
    expect(rules.list({ scope: 'repo:alpha' }).map((r) => r.id)).toEqual([repo.id]);
    expect(rules.list({ scope: 'global' }).map((r) => r.id)).toEqual([global.id]);
  });
});

describe('accept / retire (the human’s decision, D4)', () => {
  test('accept stamps status, decided_at and decided_by', async () => {
    const rule = await rules.create('human', { text: 'x' });
    const accepted = await rules.accept(rule.id, 'pete');
    expect(accepted.status).toBe('accepted');
    expect(accepted.decided_by).toBe('pete');
    expect(accepted.decided_at).toBeDefined();
    expect(StateStore.open(home).listEvents().at(-1)?.kind).toBe('knowledge_decided');
  });

  test('retire is a status change; nothing is deleted (§5.7)', async () => {
    const rule = await rules.create('human', { text: 'x' });
    await rules.accept(rule.id, 'pete');
    const retired = await rules.retire(rule.id, 'pete');
    expect(retired.status).toBe('retired');
    expect(rules.get(rule.id).text).toBe('x');
  });

  test('deciding the same way twice is refused', async () => {
    const rule = await rules.create('human', { text: 'x' });
    await rules.accept(rule.id, 'pete');
    await expect(rules.accept(rule.id, 'pete')).rejects.toThrow(KnowledgeAlreadyDecidedError);
  });

  test('a classifier rule cannot be accepted with fewer than two examples (§5.6)', async () => {
    const thin = await rules.create('human', {
      text: 'no new dependencies without asking',
      enforcement: 'action',
      check: { by: 'classifier', examples: [{ action: 'bun add lodash', violates: true }] },
    });
    await expect(rules.accept(thin.id, 'pete')).rejects.toThrow(/at least 2 examples/);
    await rules.update('human', thin.id, {
      check: {
        by: 'classifier',
        examples: [
          { action: 'bun add lodash', violates: true },
          { action: 'read a file', violates: false },
        ],
      },
    });
    expect((await rules.accept(thin.id, 'pete')).status).toBe('accepted');
  });
});

describe('update (edit-then-accept, §3.1)', () => {
  test('edits the text and keeps the decision fields alone', async () => {
    const rule = await rules.create('human', { text: 'original' });
    const edited = await rules.update('human', rule.id, { text: 'reworded', critical: true });
    expect(edited.text).toBe('reworded');
    expect(edited.critical).toBe(true);
    expect(edited.status).toBe('proposed');
    expect(StateStore.open(home).listEvents().at(-1)?.kind).toBe('knowledge_put');
  });

  test('an agent may reword its own proposal but not decide it', async () => {
    const rule = await rules.create('agent', { text: 'original' });
    expect((await rules.update('agent', rule.id, { text: 'reworded' })).text).toBe('reworded');
    await expect(
      store.updateKnowledge('agent', rule.id, (before) => ({ ...before, status: 'accepted' })),
    ).rejects.toThrow(/may not change status/);
  });

  test('a new scope is checked too', async () => {
    const rule = await rules.create('human', { text: 'x' });
    await expect(
      rules.update('human', rule.id, { scope: { kind: 'repo', repo: 'ghost' } }),
    ).rejects.toThrow(UnknownKnowledgeScopeError);
  });
});

describe('inScope (the service over the home)', () => {
  test('resolves the stream’s ancestors and filters through knowledgeInScope', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const leaf = await streams.create('human', { title: 'leaf', goal: 'g', parent: root.id });

    const global = await rules.create('human', { text: 'global rule' });
    const fromRoot = await rules.create('human', {
      text: 'root rule',
      scope: { kind: 'subtree', node: root.id },
    });
    const proposedGlobal = await rules.create('human', { text: 'not yet accepted' });
    const other = await streams.create('human', { title: 'other', goal: 'g' });
    const fromOther = await rules.create('human', {
      text: 'other rule',
      scope: { kind: 'subtree', node: other.id },
    });
    for (const id of [global.id, fromRoot.id, fromOther.id]) await rules.accept(id, 'pete');

    const texts = rules.inScope(leaf.id).map((r) => r.text);
    expect(texts).toEqual(['global rule', 'root rule']);
    expect(texts).not.toContain('not yet accepted');
    expect(rules.get(proposedGlobal.id).status).toBe('proposed');
  });

  test('ancestorsOf returns the chain root→leaf', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const mid = await streams.create('human', { title: 'mid', goal: 'g', parent: root.id });
    const leaf = await streams.create('human', { title: 'leaf', goal: 'g', parent: mid.id });
    expect(rules.ancestorsOf(streams.get(leaf.id)).map((s) => s.title)).toEqual(['root', 'mid']);
  });
});

// ------------------------------------------------------ knowledge_accepted

describe('accept emits knowledge_accepted (T264)', () => {
  test('accepting a Shop decision reaches Shop’s live nodes and not Blog’s', async () => {
    const events = new RoutedEventService(store);
    const emitted: RoutedEvent[] = [];
    events.onEmitted((e) => emitted.push(e));
    const emitting = new KnowledgeService({
      store,
      streams,
      emitRouted: makeEmitter(events, streams),
    });
    const projects = new ProjectService(store, streams);
    const shop = await projects.create({ name: 'Shop' });
    const blog = await projects.create({ name: 'Blog' });
    const child = await streams.create('human', { title: 'api', goal: 'g', parent: shop.root });
    const done = await streams.create('human', { title: 'old', goal: 'g', parent: shop.root });
    await streams.close('human', done.id);
    const blogChild = await streams.create('human', { title: 'b', goal: 'g', parent: blog.root });

    const item = await emitting.create('human', {
      kind: 'decision',
      text: 'sale prices show in red',
      scope: { kind: 'project', project: shop.id },
    });
    await emitting.accept(item.id, 'pete');

    const [event] = emitted.filter((e) => e.type === 'knowledge_accepted');
    expect(event?.payload).toMatchObject({ item: item.id, kind: 'decision', enforcement: 'tell' });
    const routed = event?.routing.map((r) => r.node).sort();
    expect(routed).toEqual([shop.root, child.id].sort());
    expect(routed).not.toContain(blogChild.id);
    expect(routed).not.toContain(blog.root);
    expect(routed).not.toContain(done.id);
    // §15's line (T351): the recipient is told the item itself, not only its id.
    expect(summarize(event as RoutedEvent, child.id)).toBe(
      'New decision in scope: sale prices show in red (tell).',
    );
  });
});
