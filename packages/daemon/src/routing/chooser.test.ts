/**
 * T483 (design/model-routing.md §5, D52): the chooser through the policy
 * service, with `FakeClassifier` (no network). Each test sets a project's
 * policy, makes a node in it and asks for its routed pick.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChoiceAnswer, ModelPolicyPartial, Stream } from '@agile-agents/shared';
import { ClassifierUnavailableError, FakeClassifier } from '../classifier';
import type { FakeClassifierOptions } from '../classifier/fake';
import { runInit } from '../init';
import { ProjectService } from '../projects/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ModelPolicyService } from './policy';
import { buildModelPolicyRpcMethods } from './rpc';

let home: string;
let store: StateStore;
let streams: StreamService;
let projectCount = 0;

const PRESETS = [
  { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
  { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
  { vendor: 'claude' as const, model: 'claude-opus-5-5' },
];
const FALLBACK = { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' as const };

type Scripted = Record<string, Omit<ChoiceAnswer, 'id'>>;

/** One scale answer: `n`, all the probability on it. */
function scale(n: number, confidence = 0.9): Omit<ChoiceAnswer, 'id'> {
  return { choice: String(n), confidence, probabilities: { [String(n)]: 1 } };
}

/** A well-specified, checkable, short, low-stakes one-off, as the live rename came back. */
const CLEAR: Scripted = {
  clarity: { choice: '5', confidence: 0.85, probabilities: { '1': 0, '3': 0.1, '5': 0.9 } },
  verifiability: scale(5),
  horizon: scale(1),
  stakes: scale(1),
  volume: scale(1),
  topic: { choice: 'none', confidence: 0.9, probabilities: { none: 0.9, security: 0.1 } },
  model: {
    choice: 'claude/claude-sonnet-5-5',
    confidence: 0.82,
    probabilities: {
      'claude/claude-sonnet-5-5': 0.88,
      'claude/claude-haiku-4-5': 0.12,
      'claude/claude-opus-5-5': 0,
    },
  },
  effort: { choice: 'medium', confidence: 0.7, probabilities: { medium: 0.7, low: 0.3 } },
};

function fake(choice: Scripted | undefined, extra: FakeClassifierOptions = {}): FakeClassifier {
  return new FakeClassifier([], { ...(choice !== undefined ? { choice } : {}), ...extra });
}

async function nodeUnder(
  policy: ModelPolicyPartial,
  node: Partial<Pick<Stream, 'labels'>> & { title?: string; goal?: string } = {},
): Promise<Stream> {
  projectCount += 1;
  const project = await new ProjectService(store, streams).create({ name: `Shop ${projectCount}` });
  await store.updateProject(project.id, (p) => ({ ...p, model_policy: policy }));
  const created = await streams.create('human', {
    title: node.title ?? 'Rename getUser to fetchUser',
    goal: node.goal ?? 'Rename the function and its call sites; the tests must pass.',
    project: project.id,
    ...(node.labels !== undefined ? { labels: node.labels } : {}),
  });
  return streams.get(created.id);
}

function service(classifier?: FakeClassifier, timeoutMs?: number): ModelPolicyService {
  return new ModelPolicyService({
    store,
    streams,
    ...(classifier !== undefined ? { classifier } : {}),
    ...(timeoutMs !== undefined ? { chooserTimeoutMs: timeoutMs } : {}),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-chooser-'));
  store = StateStore.open(runInit(home).stateRoot);
  streams = new StreamService(store);
});

afterEach(async () => {
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe('T483: the chooser (D52)', () => {
  test('a confident model choice decides, with its effort, and one call carries every question', async () => {
    const jev = fake(CLEAR);
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const { pick, chooser } = await service(jev).pickForStart({
      stream,
      fallback: FALLBACK,
      role: 'worker',
    });
    expect(pick).toMatchObject({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      how: 'jev',
      why: 'well specified and covered by tests; short, low stakes',
      topic: 'none',
      confidence: 0.82,
    });
    expect(pick.scores).toEqual({
      clarity: 4.8,
      verifiability: 5,
      horizon: 1,
      stakes: 1,
      volume: 1,
    });
    expect(jev.choiceCalls).toHaveLength(1);
    expect(jev.choiceCalls[0]?.questions.map((q) => q.id)).toEqual([
      'clarity',
      'verifiability',
      'horizon',
      'stakes',
      'volume',
      'topic',
      'model',
      'effort',
    ]);
    // The task is the state; never the thread.
    expect(jev.choiceCalls[0]?.state).toContain('Task: Rename getUser to fetchUser');
    expect(jev.choiceCalls[0]?.state).toContain('Goal: Rename the function');
    expect(chooser?.outcome.ok).toBe(true);
  });

  test('below 0.5 confidence the rule decides from the scores, and says so', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const unsure: Scripted = {
      ...CLEAR,
      model: { choice: 'claude/claude-haiku-4-5', confidence: 0.3, probabilities: {} },
    };
    const { pick } = await service(fake(unsure)).pickForStart({ stream, fallback: FALLBACK });
    expect(pick).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', how: 'scores' });
    expect(pick.why).toBe(
      'Jev wasn’t sure; chose by the scores: well specified and covered by tests; short, low stakes',
    );
    expect(pick.confidence).toBe(0.3);

    // High stakes and long: the strongest preset, one effort level up.
    const risky: Scripted = { ...unsure, stakes: scale(5), horizon: scale(4) };
    const second = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const hard = (await service(fake(risky)).pickForStart({ stream: second, fallback: FALLBACK }))
      .pick;
    expect(hard).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', how: 'scores' });
    expect(hard.why).toContain('long, high stakes');
  });

  test('with no key the no-score rule decides and the line names why', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    // A tier with no key (the fake with no choice script throws not_configured) …
    const keyless = fake(undefined);
    const { pick } = await service(keyless).pickForStart({ stream, fallback: FALLBACK });
    expect(pick).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', how: 'rule' });
    expect(pick.why).toBe('start cheap: the cheapest balanced preset model (no classifier key)');
    expect(pick.scores).toBeUndefined();
    expect(keyless.choiceCalls).toHaveLength(1);
    // … and no classifier at all read the same.
    expect((await service().pickForStart({ stream, fallback: FALLBACK })).pick.why).toBe(
      'start cheap: the cheapest balanced preset model (no classifier key)',
    );
  });

  test('a failed call (429, a bad reply, a timeout) falls back to the rule: "Jev didn’t answer"', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const why = 'start cheap: the cheapest balanced preset model (Jev didn’t answer)';
    const refused = fake(CLEAR, {
      throws: new ClassifierUnavailableError('http_error', 'classifier call returned HTTP 429'),
    });
    expect((await service(refused).pickForStart({ stream, fallback: FALLBACK })).pick.why).toBe(
      why,
    );
    const { effort: _missing, ...noEffort } = CLEAR;
    const bad = await service(fake(noEffort)).pickForStart({ stream, fallback: FALLBACK });
    expect(bad.pick.why).toBe(why);
    expect(bad.chooser?.outcome).toMatchObject({ ok: false, reason: 'no_answer' });
    const notATopic = await service(
      fake({ ...CLEAR, topic: { choice: 'billing', confidence: 1, probabilities: {} } }),
    ).pickForStart({ stream, fallback: FALLBACK });
    expect(notATopic.pick.why).toBe(why);
    const slow = await service(fake(CLEAR, { delayMs: 300 }), 20).pickForStart({
      stream,
      fallback: FALLBACK,
    });
    expect(slow.pick.why).toBe(why);
    expect(slow.chooser?.outcome).toMatchObject({
      reason: 'no_answer',
      detail: 'timed out after 20ms',
    });
  });

  test('a Jev pick outside the presets is clamped to the nearest preset, with a note', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS.slice(0, 2) });
    const outside: Scripted = {
      ...CLEAR,
      model: { choice: 'claude/claude-opus-5-5', confidence: 0.9, probabilities: {} },
    };
    const { pick } = await service(fake(outside)).pickForStart({ stream, fallback: FALLBACK });
    expect(pick).toMatchObject({ how: 'clamp', base: 'jev', model: 'claude-sonnet-5-5' });
    expect(pick.note).toBe('Claude Opus 5.5 isn’t a preset model, so Claude Sonnet 5.5 instead.');
    expect(pick.scores).toBeDefined();
  });

  test('pinned rules first: by role, by label (no call), by topic (Jev’s reading)', async () => {
    const opus = { vendor: 'claude' as const, model: 'claude-opus-5-5', effort: 'high' as const };
    const haiku = { vendor: 'claude' as const, model: 'claude-haiku-4-5' };
    const rules = [
      { when: { role: 'coordinator' as const }, pick: opus },
      { when: { label: 'Docs' }, pick: haiku },
      { when: { topic: 'security' as const }, pick: opus },
    ];
    const policy = { mode: 'choose' as const, presets: PRESETS, pinned_rules: rules };

    const jev = fake(CLEAR);
    const coord = await nodeUnder(policy);
    const byRole = await service(jev).pickForStart({
      stream: coord,
      fallback: FALLBACK,
      role: 'coordinator',
    });
    expect(byRole.pick).toMatchObject({
      model: 'claude-opus-5-5',
      effort: 'high',
      how: 'pinned',
      why: 'pinned rule: coordinator',
    });
    expect(jev.choiceCalls).toHaveLength(0);

    const docs = await nodeUnder(policy, { labels: ['docs'] });
    const byLabel = await service(jev).pickForStart({ stream: docs, fallback: FALLBACK });
    expect(byLabel.pick).toMatchObject({
      model: 'claude-haiku-4-5',
      effort: 'medium',
      how: 'pinned',
      why: 'pinned rule: label Docs',
    });
    expect(jev.choiceCalls).toHaveLength(0);

    const secure = fake({
      ...CLEAR,
      topic: { choice: 'security', confidence: 0.8, probabilities: { security: 0.8 } },
    });
    const auth = await nodeUnder(policy, { title: 'Rotate the session tokens' });
    const byTopic = await service(secure).pickForStart({ stream: auth, fallback: FALLBACK });
    expect(byTopic.pick).toMatchObject({
      model: 'claude-opus-5-5',
      how: 'pinned',
      why: 'pinned rule: security work',
      topic: 'security',
    });
    expect(secure.choiceCalls).toHaveLength(1);

    // Under Default, a topic rule asks Jev the topic alone.
    const topicOnly = fake({ topic: CLEAR.topic as Omit<ChoiceAnswer, 'id'> });
    const plain = await nodeUnder({
      mode: 'default',
      presets: [],
      pinned_rules: [rules[2] as never],
    });
    const read = await service(topicOnly).pickForStart({ stream: plain, fallback: FALLBACK });
    expect(topicOnly.choiceCalls[0]?.questions.map((q) => q.id)).toEqual(['topic']);
    expect(read.pick).toMatchObject({ how: 'default', model: 'claude-opus-5-5', topic: 'none' });
  });

  test('a rule naming reviewer governs a reviewer’s start only', async () => {
    const sonnet = {
      vendor: 'claude' as const,
      model: 'claude-sonnet-5-5',
      effort: 'medium' as const,
    };
    const stream = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      pinned_rules: [{ when: { role: 'reviewer' }, pick: sonnet }],
    });
    const routing = service(fake(CLEAR));
    expect(await routing.pickForReviewer(stream, FALLBACK)).toMatchObject({
      model: 'claude-sonnet-5-5',
      how: 'pinned',
      why: 'pinned rule: reviewer',
    });
    // The node's own agent isn't a reviewer: the chooser decides.
    expect((await routing.pickForStart({ stream, fallback: FALLBACK })).pick.how).toBe('jev');
    const none = await nodeUnder({ mode: 'choose', presets: PRESETS });
    expect(await routing.pickForReviewer(none, FALLBACK)).toBeUndefined();
  });

  test('the effort question: only when a preset vendor takes effort, up to the ceiling', async () => {
    const jev = fake(CLEAR);
    const capped = await nodeUnder({ mode: 'choose', presets: PRESETS, effort_ceiling: 'high' });
    await service(jev).pickForStart({ stream: capped, fallback: FALLBACK });
    const effortQ = jev.choiceCalls[0]?.questions.find((q) => q.id === 'effort');
    expect(Object.keys(effortQ?.options ?? {})).toEqual(['low', 'medium', 'high']);

    const noEffort = fake({
      ...CLEAR,
      model: { ...CLEAR.model, choice: 'gemini/gemini-3-pro' } as never,
    });
    const gemini = await nodeUnder({
      mode: 'choose',
      presets: [
        { vendor: 'gemini', model: 'gemini-3-pro' },
        { vendor: 'gemini', model: 'gemini-3-flash' },
      ],
    });
    const { pick } = await service(noEffort).pickForStart({ stream: gemini, fallback: FALLBACK });
    expect(noEffort.choiceCalls[0]?.questions.map((q) => q.id)).not.toContain('effort');
    expect(pick).toMatchObject({ vendor: 'gemini', model: 'gemini-3-pro', how: 'jev' });
  });

  test('the model question carries the rule, the quality priority, the weights and the guidance', async () => {
    const jev = fake(CLEAR);
    const stream = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      quality: 80,
      weights: { stakes: 3, volume: 0 },
      guidance: 'Anything touching billing gets Opus.',
    });
    await service(jev).pickForStart({ stream, fallback: FALLBACK });
    const model = jev.choiceCalls[0]?.questions.find((q) => q.id === 'model');
    expect(model?.instructions).toContain('Use a balanced model when the task is well specified');
    expect(model?.instructions).toContain('Quality priority: 80 of 100');
    expect(model?.instructions).toContain(
      'clarity 1, verifiability 1, horizon 1, stakes 3, volume 0',
    );
    expect(model?.instructions).toContain('Anything touching billing gets Opus.');
    expect(model?.options['claude/claude-opus-5-5']).toBe(
      'Claude Opus 5.5: strongest tier, relative cost 2.',
    );
  });

  test('Strongest first runs the strongest preset; Jev is not asked which model', async () => {
    const jev = fake(CLEAR);
    const stream = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      escalation: 'strongest_first',
    });
    const { pick } = await service(jev).pickForStart({ stream, fallback: FALLBACK });
    expect(jev.choiceCalls[0]?.questions.map((q) => q.id)).not.toContain('model');
    expect(pick).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', how: 'rule' });
    expect(pick.why).toBe(
      'strongest first: the strongest preset model; well specified and covered by tests; short, low stakes',
    );
  });

  test('the task names the parent, its plan entry and the siblings starting now', async () => {
    const jev = fake(CLEAR);
    const project = await new ProjectService(store, streams).create({ name: 'Shop' });
    const parent = await streams.create('human', {
      title: 'API cleanup',
      goal: 'Consistent verbs across the API',
      project: project.id,
    });
    const parts = [];
    for (const title of ['Rename getUser', 'Rename getOrder', 'Rename getCart']) {
      parts.push(
        await streams.create('human', { title, goal: 'g', project: project.id, parent: parent.id }),
      );
    }
    const routing = new ModelPolicyService({
      store,
      streams,
      classifier: jev,
      plans: {
        childView: () => ({ version: 1, owns: ['src/user.ts'], siblings: [], contracts: [] }),
      },
    });
    await routing.pickForStart({ stream: streams.get(parts[0]?.id as string), fallback: FALLBACK });
    const state = jev.choiceCalls[0]?.state ?? '';
    expect(state).toContain('Part of: API cleanup');
    expect(state).toContain("The parent's goal: Consistent verbs across the API");
    expect(state).toContain("The parent's plan gives this part: src/user.ts");
    expect(state).toContain('Siblings starting now: 2 (Rename getOrder; Rename getCart)');
  });

  test('a preview never calls Jev; with a key it says Jev picks, and names the fallback', async () => {
    const jev = fake(CLEAR);
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    expect(service(jev).nextPick(stream)).toMatchObject({
      model: 'claude-sonnet-5-5',
      chooses: true,
    });
    expect(jev.choiceCalls).toHaveLength(0);
    expect(service().nextPick(stream)?.chooses).toBeUndefined();
    const plain = await nodeUnder({ mode: 'default', presets: [] });
    expect(service(jev).nextPick(plain)?.chooses).toBeUndefined();
  });

  test('Try it reads a pasted task as Choose would, nothing started; policy.try over RPC', async () => {
    await store.setHomeModelPolicy({ mode: 'default', presets: PRESETS }, { by: 'human' });
    const routing = service(fake(CLEAR));
    const result = await routing.tryTask({ text: 'Rename getUser to fetchUser\nTests must pass.' });
    expect(result).toMatchObject({
      mode: 'default',
      line: 'Model: Claude Sonnet 5.5 · medium — well specified and covered by tests; short, low stakes',
      confidence: 0.82,
      topic: 'none',
      pick: { how: 'jev', model: 'claude-sonnet-5-5' },
    });
    expect(result.scores?.clarity).toBe(4.8);
    expect(streams.list()).toHaveLength(0);

    const keyless = service(fake(undefined));
    const rpc = buildModelPolicyRpcMethods(keyless);
    const viaRpc = (await rpc['policy.try']?.({ text: 'Rename a thing' })) as Awaited<
      ReturnType<ModelPolicyService['tryTask']>
    >;
    expect(viaRpc.failed).toEqual({ reason: 'no_key', words: 'no classifier key' });
    expect(viaRpc.line).toBe(
      'Model: Claude Sonnet 5.5 · medium — start cheap: the cheapest balanced preset model (no classifier key)',
    );
    await expect(Promise.resolve(rpc['policy.try']?.({ text: '' }))).rejects.toThrow();
  });
});
