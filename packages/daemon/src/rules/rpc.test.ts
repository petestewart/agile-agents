/**
 * T140: the `rule.*` RPC edge. The two things only this layer can get
 * wrong are param validation and the principal stamp (design §2.2) — a
 * caller must not be able to name its own principal, create an already
 * accepted rule, or decide one through an update.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Rule } from '@agile-agents/shared';
import {
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
  DEFAULT_CLASSIFIER_DENY_AT,
  ulid,
} from '@agile-agents/shared';
import { FakeClassifier } from '../classifier';
import { runInit } from '../init';
import type { RpcMethodHandler } from '../rpc';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { buildRuleRpcMethods } from './rpc';
import { RulesService } from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let methods: Record<string, RpcMethodHandler>;

const call = async <T>(method: string, params?: unknown): Promise<T> => {
  const handler = methods[method];
  if (!handler) throw new Error(`no such method: ${method}`);
  return (await handler(params)) as T;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rule-rpc-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  methods = buildRuleRpcMethods(new RulesService({ store, streams }));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function create(text = 'prefer the repo scripts'): Promise<Rule> {
  return call<Rule>('rule.create', { text });
}

test('the method table is exactly the nine rule verbs', () => {
  expect(Object.keys(methods).sort()).toEqual([
    'rule.accept',
    'rule.create',
    'rule.get',
    'rule.in_scope',
    'rule.list',
    'rule.report',
    'rule.retire',
    'rule.test',
    'rule.update',
  ]);
});

/**
 * T153 (§5.6): `rule.test` is the one verb that needs a classifier. Built
 * without one — a home with `classifier: off`, or no key — it says so as
 * bad params rather than pretending every rule agreed.
 */
test('rule.test without a classifier is a param error, not a silent pass', async () => {
  await expect(call('rule.test', {})).rejects.toThrow(/needs a classifier/);
});

test('rule.test evaluates the accepted classifier rules through the fake', async () => {
  const methodsWithClassifier = buildRuleRpcMethods(new RulesService({ store, streams }), {
    classifier: new FakeClassifier((state, questions) =>
      questions.map((q) => ({
        id: q.id,
        probability: state.startsWith('bun add') ? 0.95 : 0.05,
        confidence: 0.9,
      })),
    ),
    bands: {
      deny_at: DEFAULT_CLASSIFIER_DENY_AT,
      allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
      confidence_floor: DEFAULT_CLASSIFIER_CONFIDENCE_FLOOR,
    },
  });
  const proposed = (await methodsWithClassifier['rule.create']?.({
    text: 'do not add a dependency without asking',
    enforcement: 'classifier',
    examples: [
      { action: 'bun add lodash', violates: true },
      { action: 'edit src/index.ts', violates: false },
    ],
  })) as Rule;
  await methodsWithClassifier['rule.accept']?.({ id: proposed.id });
  const report = (await methodsWithClassifier['rule.test']?.({})) as {
    agreed: number;
    disagreed: number;
    agreement_rate: number;
  };
  expect(report.agreed).toBe(2);
  expect(report.disagreed).toBe(0);
  expect(report.agreement_rate).toBe(1);

  // Naming a rule that has no examples to evaluate is bad params (-32602).
  const guidance = (await methodsWithClassifier['rule.create']?.({
    text: 'a guidance rule',
  })) as Rule;
  await expect(methodsWithClassifier['rule.test']?.({ id: guidance.id })).rejects.toThrow(
    /only classifier rules/,
  );
});

describe('params validation (-32602, never a TypeError)', () => {
  test.each([
    ['rule.create', undefined],
    ['rule.get', undefined],
    ['rule.in_scope', {}],
    ['rule.accept', {}],
    ['rule.update', {}],
  ])('%s rejects bad params', async (method, params) => {
    await expect(call(method, params)).rejects.toMatchObject({ code: -32602 });
  });

  test('rule.list takes no params at all', async () => {
    expect(await call<{ rules: Rule[] }>('rule.list')).toEqual({ rules: [] });
  });

  test('an unknown status filter is refused', async () => {
    await expect(call('rule.list', { status: 'maybe' })).rejects.toMatchObject({ code: -32602 });
  });

  test('an unknown scope ref is the caller’s fault, not an internal error', async () => {
    await expect(
      call('rule.create', { text: 'x', scope: { kind: 'repo', ref: 'ghost' } }),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

describe('the principal stamp (§2.2)', () => {
  test('a create is always a proposal, and cannot arrive accepted', async () => {
    expect((await create()).status).toBe('proposed');
    await expect(call('rule.create', { text: 'x', status: 'accepted' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  test('a create cannot name its own principal', async () => {
    await expect(call('rule.create', { text: 'x', principal: 'daemon' })).rejects.toMatchObject({
      code: -32602,
    });
  });

  test('an update may not carry a decision or rewrite provenance', async () => {
    const rule = await create();
    for (const patch of [
      { status: 'accepted' },
      { decided_by: 'someone' },
      { decided_at: '2026-09-22T00:00:00.000Z' },
      { provenance: { by: 'someone else' } },
    ]) {
      await expect(call('rule.update', { id: rule.id, ...patch })).rejects.toMatchObject({
        code: -32602,
      });
    }
    expect(store.getRule(rule.id).status).toBe('proposed');
  });
});

describe('the verbs', () => {
  test('accept/retire stamp decided_by, defaulting to human', async () => {
    const rule = await create();
    const accepted = await call<Rule>('rule.accept', { id: rule.id });
    expect(accepted.status).toBe('accepted');
    expect(accepted.decided_by).toBe('human');
    const retired = await call<Rule>('rule.retire', { id: rule.id, by: 'pete' });
    expect(retired.status).toBe('retired');
    expect(retired.decided_by).toBe('pete');
  });

  test('a second identical decision is the caller’s fault', async () => {
    const rule = await create();
    await call('rule.accept', { id: rule.id });
    await expect(call('rule.accept', { id: rule.id })).rejects.toMatchObject({ code: -32602 });
  });

  test('get / list / update round-trip', async () => {
    const rule = await create();
    expect((await call<Rule>('rule.get', { id: rule.id })).id).toBe(rule.id);
    expect((await call<{ rules: Rule[] }>('rule.list', { status: 'proposed' })).rules).toHaveLength(
      1,
    );
    const edited = await call<Rule>('rule.update', { id: rule.id, text: 'reworded' });
    expect(edited.text).toBe('reworded');
  });

  test('rule.in_scope is §5.3 over one stream', async () => {
    const stream = await streams.create('human', { title: 's', goal: 'g' });
    const rule = await create('global rule');
    await call('rule.accept', { id: rule.id });
    await create('still proposed');
    const result = await call<{ rules: Rule[] }>('rule.in_scope', { stream: stream.id });
    expect(result.rules.map((r) => r.text)).toEqual(['global rule']);
    await expect(call('rule.in_scope', { stream: ulid() })).rejects.toThrow(/not found/);
  });
});
