/**
 * T140: `RulesService` and `rulesInScope` against a real temp state home —
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
import { type Rule, type RuleInput, type Stream, ulid, validateRule } from '@agile-agents/shared';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import {
  RuleAlreadyDecidedError,
  RulesService,
  UnknownRuleScopeError,
  formatRuleScope,
  rulesInScope,
} from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: RulesService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rules-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new RulesService({ store, streams });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------------ rulesInScope

function fixture(text: string, over: Partial<RuleInput> = {}): Rule {
  return validateRule({
    id: `R-${ulid()}`,
    text,
    scope: { kind: 'global' },
    status: 'accepted',
    enforcement: 'guidance',
    critical: false,
    provenance: { by: 'human' },
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

describe('rulesInScope (§5.3)', () => {
  test('a stream with no repo sees global rules only', () => {
    const stream = fixtureStream();
    const all = [
      fixture('global one'),
      fixture('repo one', { scope: { kind: 'repo', ref: 'alpha' } }),
      fixture('stream one', { scope: { kind: 'stream', ref: ulid() } }),
    ];
    expect(rulesInScope(all, stream).map((r) => r.text)).toEqual(['global one']);
  });

  test('a repo-scoped rule matches only its own repo', () => {
    const all = [
      fixture('alpha rule', { scope: { kind: 'repo', ref: 'alpha' } }),
      fixture('beta rule', { scope: { kind: 'repo', ref: 'beta' } }),
    ];
    expect(rulesInScope(all, fixtureStream({ repo: 'alpha' })).map((r) => r.text)).toEqual([
      'alpha rule',
    ]);
    expect(rulesInScope(all, fixtureStream({ repo: 'beta' })).map((r) => r.text)).toEqual([
      'beta rule',
    ]);
    expect(rulesInScope(all, fixtureStream())).toEqual([]);
  });

  test('a stream-scoped rule matches the stream itself', () => {
    const stream = fixtureStream();
    const all = [
      fixture('mine', { scope: { kind: 'stream', ref: stream.id } }),
      fixture('theirs', { scope: { kind: 'stream', ref: ulid() } }),
    ];
    expect(rulesInScope(all, stream).map((r) => r.text)).toEqual(['mine']);
  });

  test('a nested stream inherits every ancestor’s stream-scoped rules', () => {
    const root = fixtureStream({ title: 'root' });
    const mid = fixtureStream({ title: 'mid', parent: root.id });
    const leaf = fixtureStream({ title: 'leaf', parent: mid.id });
    const all = [
      fixture('from root', { scope: { kind: 'stream', ref: root.id } }),
      fixture('from mid', { scope: { kind: 'stream', ref: mid.id } }),
      fixture('from leaf', { scope: { kind: 'stream', ref: leaf.id } }),
      fixture('from a cousin', { scope: { kind: 'stream', ref: ulid() } }),
    ];
    expect(rulesInScope(all, leaf, [root, mid]).map((r) => r.text)).toEqual([
      'from root',
      'from mid',
      'from leaf',
    ]);
    // The inheritance is one-way: the root does not see its child's rules.
    expect(rulesInScope(all, root).map((r) => r.text)).toEqual(['from root']);
  });

  test('proposed and retired rules are never in scope', () => {
    const stream = fixtureStream({ repo: 'alpha' });
    const all = [
      fixture('accepted', { status: 'accepted' }),
      fixture('proposed', { status: 'proposed' }),
      fixture('retired', { status: 'retired' }),
      fixture('proposed repo rule', {
        status: 'proposed',
        scope: { kind: 'repo', ref: 'alpha' },
      }),
    ];
    expect(rulesInScope(all, stream).map((r) => r.text)).toEqual(['accepted']);
  });

  test('formatRuleScope renders the three kinds', () => {
    expect(formatRuleScope({ kind: 'global' })).toBe('global');
    expect(formatRuleScope({ kind: 'repo', ref: 'alpha' })).toBe('repo:alpha');
    expect(formatRuleScope({ kind: 'stream', ref: 'S' })).toBe('stream:S');
  });
});

// ---------------------------------------------------------------- service

describe('create (a proposal, whoever calls it)', () => {
  test('mints the id, created_at, stats and status: proposed', async () => {
    const rule = await rules.create('human', { text: 'prefer the repo scripts' });
    expect(rule.id).toMatch(/^R-[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(rule.status).toBe('proposed');
    expect(rule.enforcement).toBe('guidance');
    expect(rule.scope).toEqual({ kind: 'global' });
    expect(rule.critical).toBe(false);
    expect(rule.stats).toEqual({ fired: 0, violated: 0, routed: 0 });
    expect(rule.provenance).toEqual({ by: 'human' });
    expect(store.getRule(rule.id).text).toBe('prefer the repo scripts');
  });

  test('an agent proposal records its session in provenance', async () => {
    const session = ulid();
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const rule = await rules.create('agent', {
      text: 'always run the integration suite',
      provenance: { by: `agent:${session}`, session, stream: stream.id },
    });
    expect(rule.status).toBe('proposed');
    expect(rule.provenance.by).toBe(`agent:${session}`);
  });

  test('a repo-scoped rule needs a registered repo', async () => {
    await expect(
      rules.create('human', { text: 'x', scope: { kind: 'repo', ref: 'ghost' } }),
    ).rejects.toThrow(UnknownRuleScopeError);
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const rule = await rules.create('human', {
      text: 'x',
      scope: { kind: 'repo', ref: 'alpha' },
    });
    expect(rule.scope).toEqual({ kind: 'repo', ref: 'alpha' });
  });

  test('a stream-scoped rule needs an existing stream', async () => {
    await expect(
      rules.create('human', { text: 'x', scope: { kind: 'stream', ref: ulid() } }),
    ).rejects.toThrow(/not a stream in this home/);
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const rule = await rules.create('human', {
      text: 'x',
      scope: { kind: 'stream', ref: stream.id },
    });
    expect(rule.scope.ref).toBe(stream.id);
  });

  test('a pattern rule without a pattern is refused', async () => {
    await expect(rules.create('human', { text: 'x', enforcement: 'pattern' })).rejects.toThrow(
      /must carry a pattern/,
    );
  });
});

describe('list / listProposed', () => {
  test('filters by status and by rendered scope', async () => {
    await store.addRepo('alpha', { path: join(home, 'alpha') });
    const global = await rules.create('human', { text: 'global rule' });
    const repo = await rules.create('human', {
      text: 'repo rule',
      scope: { kind: 'repo', ref: 'alpha' },
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
    expect(StateStore.open(home).listEvents().at(-1)?.kind).toBe('rule_decided');
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
    await expect(rules.accept(rule.id, 'pete')).rejects.toThrow(RuleAlreadyDecidedError);
  });

  test('a classifier rule cannot be accepted with fewer than two examples (§5.6)', async () => {
    const thin = await rules.create('human', {
      text: 'no new dependencies without asking',
      enforcement: 'classifier',
      examples: [{ action: 'bun add lodash', violates: true }],
    });
    await expect(rules.accept(thin.id, 'pete')).rejects.toThrow(/at least 2 examples/);
    await rules.update('human', thin.id, {
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'read a file', violates: false },
      ],
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
    expect(StateStore.open(home).listEvents().at(-1)?.kind).toBe('rule_put');
  });

  test('an agent may reword its own proposal but not decide it', async () => {
    const rule = await rules.create('agent', { text: 'original' });
    expect((await rules.update('agent', rule.id, { text: 'reworded' })).text).toBe('reworded');
    await expect(
      store.updateRule('agent', rule.id, (before) => ({ ...before, status: 'accepted' })),
    ).rejects.toThrow(/may not change status/);
  });

  test('a new scope is checked too', async () => {
    const rule = await rules.create('human', { text: 'x' });
    await expect(
      rules.update('human', rule.id, { scope: { kind: 'repo', ref: 'ghost' } }),
    ).rejects.toThrow(UnknownRuleScopeError);
  });
});

describe('inScope (the service over the home)', () => {
  test('resolves the stream’s ancestors and filters through rulesInScope', async () => {
    const root = await streams.create('human', { title: 'root', goal: 'g' });
    const leaf = await streams.create('human', { title: 'leaf', goal: 'g', parent: root.id });

    const global = await rules.create('human', { text: 'global rule' });
    const fromRoot = await rules.create('human', {
      text: 'root rule',
      scope: { kind: 'stream', ref: root.id },
    });
    const proposedGlobal = await rules.create('human', { text: 'not yet accepted' });
    const other = await streams.create('human', { title: 'other', goal: 'g' });
    const fromOther = await rules.create('human', {
      text: 'other rule',
      scope: { kind: 'stream', ref: other.id },
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
