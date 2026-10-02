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
  // T490 (D57): the tier, not the model.
  tier: {
    choice: 'balanced',
    confidence: 0.82,
    probabilities: { balanced: 0.88, fast: 0.12, strongest: 0 },
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
  test('a confident tier decides, with its effort, and one call carries every question', async () => {
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
      why: 'balanced (Jev 0.82): well specified and covered by tests; short, low stakes',
      topic: 'none',
      confidence: 0.82,
      tier: 'balanced',
      tier_by: 'jev',
      in_tier: { by: 'only' },
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
      'tier',
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
      tier: { choice: 'fast', confidence: 0.3, probabilities: {} },
    };
    const { pick } = await service(fake(unsure)).pickForStart({ stream, fallback: FALLBACK });
    expect(pick).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      how: 'scores',
      tier: 'balanced',
      tier_by: 'scores',
    });
    expect(pick.why).toBe(
      'Jev wasn’t sure (0.30), so balanced by the scores: well specified and covered by tests; short, low stakes',
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
    expect(pick).toMatchObject({
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      how: 'rule',
      tier: 'balanced',
      tier_by: 'rule',
    });
    expect(pick.why).toBe('start cheap: balanced (no classifier key)');
    expect(pick.scores).toBeUndefined();
    expect(keyless.choiceCalls).toHaveLength(1);
    // … and no classifier at all read the same.
    expect((await service().pickForStart({ stream, fallback: FALLBACK })).pick.why).toBe(
      'start cheap: balanced (no classifier key)',
    );
  });

  test('a failed call (429, a bad reply, a timeout) falls back to the rule: "Jev didn’t answer"', async () => {
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS });
    const why = 'start cheap: balanced (Jev didn’t answer)';
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

  test('a tier the presets don’t have was never asked: that answer is “Jev didn’t answer”', async () => {
    // Haiku and Sonnet: fast and balanced are asked, strongest isn't.
    const stream = await nodeUnder({ mode: 'choose', presets: PRESETS.slice(0, 2) });
    const outside: Scripted = {
      ...CLEAR,
      tier: { choice: 'strongest', confidence: 0.9, probabilities: {} },
    };
    const jev = fake(outside);
    const { pick, chooser } = await service(jev).pickForStart({ stream, fallback: FALLBACK });
    const tierQ = jev.choiceCalls[0]?.questions.find((q) => q.id === 'tier');
    expect(Object.keys(tierQ?.options ?? {})).toEqual(['fast', 'balanced']);
    expect(chooser?.outcome).toMatchObject({ ok: false, reason: 'no_answer' });
    expect(pick).toMatchObject({ how: 'rule', model: 'claude-sonnet-5-5' });
    expect(pick.why).toBe('start cheap: balanced (Jev didn’t answer)');
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

  test('a rule naming reviewer governs a reviewer’s start only; T490: an unpinned reviewer is routed too', async () => {
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
    // T490: with no reviewer rule, a reviewer is routed like any start (Jev's tier) …
    const none = await nodeUnder({ mode: 'choose', presets: PRESETS });
    expect(await routing.pickForReviewer(none, FALLBACK)).toMatchObject({
      model: 'claude-sonnet-5-5',
      how: 'jev',
      tier: 'balanced',
    });
    // … and under Default it resolves as before.
    const plain = await nodeUnder({ mode: 'default', presets: [] });
    expect(await routing.pickForReviewer(plain, FALLBACK)).toBeUndefined();
  });

  test('the effort question: only when a preset vendor takes effort, up to the ceiling', async () => {
    const jev = fake(CLEAR);
    const capped = await nodeUnder({ mode: 'choose', presets: PRESETS, effort_ceiling: 'high' });
    await service(jev).pickForStart({ stream: capped, fallback: FALLBACK });
    const effortQ = jev.choiceCalls[0]?.questions.find((q) => q.id === 'effort');
    expect(Object.keys(effortQ?.options ?? {})).toEqual(['low', 'medium', 'high']);

    const noEffort = fake(CLEAR);
    const gemini = await nodeUnder({
      mode: 'choose',
      presets: [
        { vendor: 'gemini', model: 'gemini-3-pro' },
        { vendor: 'gemini', model: 'gemini-3-flash' },
      ],
    });
    const { pick } = await service(noEffort).pickForStart({ stream: gemini, fallback: FALLBACK });
    expect(noEffort.choiceCalls[0]?.questions.map((q) => q.id)).not.toContain('effort');
    // T490: two models of one tier (neither has a profile: balanced): no tier question.
    expect(noEffort.choiceCalls[0]?.questions.map((q) => q.id)).not.toContain('tier');
    expect(pick).toMatchObject({
      vendor: 'gemini',
      model: 'gemini-3-pro',
      how: 'scores',
      tier: 'balanced',
      tier_by: 'only',
    });
    expect(pick.why).toBe(
      'balanced, the only tier in the preset models: well specified and covered by tests; short, low stakes',
    );
  });

  test('the tier question carries the rule, the quality priority, the weights and the guidance', async () => {
    const jev = fake(CLEAR);
    const stream = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      quality: 80,
      weights: { stakes: 3, volume: 0 },
      guidance: 'Anything touching billing gets Opus.',
    });
    await service(jev).pickForStart({ stream, fallback: FALLBACK });
    const tier = jev.choiceCalls[0]?.questions.find((q) => q.id === 'tier');
    expect(tier?.instructions).toContain('Which tier of model should run this task?');
    expect(tier?.instructions).toContain('Use a balanced model when the task is well specified');
    expect(tier?.instructions).toContain('Quality priority: 80 of 100');
    expect(tier?.instructions).toContain(
      'clarity 1, verifiability 1, horizon 1, stakes 3, volume 0',
    );
    expect(tier?.instructions).toContain('Anything touching billing gets Opus.');
    expect(Object.keys(tier?.options ?? {})).toEqual(['fast', 'balanced', 'strongest']);
    expect(tier?.options.strongest).toBe(
      'Strongest: the most capable and costliest models, for ambiguous, high-stakes or long-horizon work. Here: Claude Opus 5.5 (cost 2).',
    );
  });

  test('Strongest first runs the strongest preset; Jev is not asked which tier', async () => {
    const jev = fake(CLEAR);
    const stream = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      escalation: 'strongest_first',
    });
    const { pick } = await service(jev).pickForStart({ stream, fallback: FALLBACK });
    expect(jev.choiceCalls[0]?.questions.map((q) => q.id)).not.toContain('tier');
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
      line: 'Model: Claude Sonnet 5.5 · medium — balanced (Jev 0.82): well specified and covered by tests; short, low stakes',
      confidence: 0.82,
      topic: 'none',
      tier: 'balanced',
      tier_by: 'jev',
      in_tier: { by: 'only' },
      vendor_order: 'no preference',
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
      'Model: Claude Sonnet 5.5 · medium — start cheap: balanced (no classifier key)',
    );
    await expect(Promise.resolve(rpc['policy.try']?.({ text: '' }))).rejects.toThrow();
  });
});

describe('T490: tier first (D57), the model by the vendor order (D59)', () => {
  /** Haiku, Sonnet, Opus from Claude; GPT-5.6 Sol and GPT-6 Astra from Codex (the live run's presets). */
  const MIXED = [
    ...PRESETS,
    { vendor: 'codex' as const, model: 'gpt-5.6-sol' },
    { vendor: 'codex' as const, model: 'gpt-6-astra' },
  ];
  const HIGH_EFFORT: Scripted = {
    ...CLEAR,
    effort: { choice: 'high', confidence: 0.4, probabilities: { high: 0.6 } },
  };

  function mixed(classifier?: FakeClassifier): ModelPolicyService {
    return new ModelPolicyService({
      store,
      streams,
      ...(classifier !== undefined ? { classifier } : {}),
      installed: (v) => v === 'claude' || v === 'codex',
    });
  }

  test('a confident tier runs the vendor order’s model in it, with Jev’s effort', async () => {
    const claudeFirst = await nodeUnder({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['claude', 'codex'],
    });
    const jev = fake(HIGH_EFFORT);
    const { pick } = await mixed(jev).pickForStart({ stream: claudeFirst, fallback: FALLBACK });
    // Only the tiers the presets have are asked, fast to strongest.
    const tierQ = jev.choiceCalls[0]?.questions.find((q) => q.id === 'tier');
    expect(Object.keys(tierQ?.options ?? {})).toEqual(['fast', 'balanced', 'strongest']);
    expect(tierQ?.options.balanced).toContain(
      'Here: Claude Sonnet 5.5 (cost 1), gpt-5.6-sol (cost 1).',
    );
    expect(pick).toMatchObject({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      // Jev's effort applies when its tier decided (as its model did, T483).
      effort: 'high',
      how: 'jev',
      tier: 'balanced',
      tier_by: 'jev',
      confidence: 0.82,
      in_tier: { by: 'vendor_order', words: 'Claude before Codex' },
    });
    expect(pick.why).toBe(
      'balanced (Jev 0.82): well specified and covered by tests; short, low stakes; Claude before Codex',
    );

    const codexFirst = await nodeUnder({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['codex', 'claude'],
    });
    const second = (
      await mixed(fake(CLEAR)).pickForStart({ stream: codexFirst, fallback: FALLBACK })
    ).pick;
    expect(second).toMatchObject({ vendor: 'codex', model: 'gpt-5.6-sol', how: 'jev' });
    expect(second.in_tier?.words).toBe('Codex before Claude');
  });

  test('no vendor order: the cheapest, then the order the presets are listed in', async () => {
    const node = await nodeUnder({ mode: 'choose', presets: MIXED });
    const { pick } = await mixed(fake(CLEAR)).pickForStart({ stream: node, fallback: FALLBACK });
    expect(pick).toMatchObject({ model: 'claude-sonnet-5-5', in_tier: { by: 'listed' } });
    expect(pick.why).toContain('no vendor preferred, so the one listed first');
    // A cheaper Codex model in the tier wins on cost when no vendor is preferred.
    await store.setModelProfiles(
      { 'codex/gpt-5.6-sol': { tier: 'balanced', cost: 0.8 } },
      {
        by: 'human',
      },
    );
    const cheaper = await nodeUnder({ mode: 'choose', presets: MIXED });
    const second = (await mixed(fake(CLEAR)).pickForStart({ stream: cheaper, fallback: FALLBACK }))
      .pick;
    expect(second).toMatchObject({
      model: 'gpt-5.6-sol',
      in_tier: { by: 'cost', words: 'the cheapest balanced preset model' },
    });
    // The vendor order comes before cost.
    const ordered = await nodeUnder({ mode: 'choose', presets: MIXED, vendor_order: ['claude'] });
    expect(
      (await mixed(fake(CLEAR)).pickForStart({ stream: ordered, fallback: FALLBACK })).pick.model,
    ).toBe('claude-sonnet-5-5');
  });

  test('below 0.5 the scores give the tier, and the vendor order the model', async () => {
    const node = await nodeUnder({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['codex', 'claude'],
    });
    const risky: Scripted = {
      ...CLEAR,
      stakes: scale(5),
      horizon: scale(4),
      tier: { choice: 'balanced', confidence: 0.42, probabilities: { balanced: 0.62 } },
    };
    const { pick } = await mixed(fake(risky)).pickForStart({ stream: node, fallback: FALLBACK });
    expect(pick).toMatchObject({
      vendor: 'codex',
      model: 'gpt-6-astra',
      effort: 'high',
      how: 'scores',
      tier: 'strongest',
      tier_by: 'scores',
      confidence: 0.42,
    });
    expect(pick.why).toStartWith('Jev wasn’t sure (0.42), so strongest by the scores:');
    expect(pick.why).toEndWith('; Codex before Claude');
  });

  test('no key: the rule as a tier (balanced), the model by the vendor order', async () => {
    const node = await nodeUnder({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['codex', 'claude'],
    });
    const { pick } = await mixed(fake(undefined)).pickForStart({
      stream: node,
      fallback: FALLBACK,
    });
    expect(pick).toMatchObject({
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      how: 'rule',
      tier: 'balanced',
      tier_by: 'rule',
    });
    expect(pick.why).toBe('start cheap: balanced (no classifier key); Codex before Claude');
    expect(pick.confidence).toBeUndefined();
  });

  test('a role’s own order: reviews prefer Codex, code prefers Claude', async () => {
    const node = await nodeUnder({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['claude', 'codex'],
      vendor_order_by_role: { reviewer: ['codex', 'claude'] },
    });
    const jev = fake(CLEAR);
    const routing = mixed(jev);
    expect((await routing.pickForStart({ stream: node, fallback: FALLBACK })).pick.model).toBe(
      'claude-sonnet-5-5',
    );
    const reviewer = await routing.pickForReviewer(node, FALLBACK);
    expect(reviewer).toMatchObject({
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      how: 'jev',
      in_tier: { words: 'Codex before Claude' },
    });
    // Jev read the task as a reviewer's.
    expect(jev.choiceCalls.at(-1)?.state).toContain('Role: a reviewer');
  });

  test('a pinned rule naming only a vendor: Jev’s tier inside that vendor; none there, no match', async () => {
    const node = await nodeUnder({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['claude', 'codex'],
      pinned_rules: [{ when: { role: 'reviewer' }, pick: { vendor: 'codex' } }],
    });
    const jev = fake(CLEAR);
    const reviewer = await mixed(jev).pickForReviewer(node, FALLBACK);
    expect(reviewer).toMatchObject({
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      how: 'pinned',
      tier: 'balanced',
      tier_by: 'jev',
    });
    expect(reviewer?.why).toBe(
      'pinned rule: reviewer → Codex; balanced (Jev 0.82): well specified and covered by tests; short, low stakes',
    );
    expect(jev.choiceCalls).toHaveLength(1);

    // Under Default the vendor-only rule still asks Jev for the tier.
    const plain = await nodeUnder({
      mode: 'default',
      presets: MIXED,
      pinned_rules: [{ when: { role: 'reviewer' }, pick: { vendor: 'codex', effort: 'low' } }],
    });
    const hard: Scripted = {
      ...CLEAR,
      tier: { choice: 'strongest', confidence: 0.9, probabilities: {} },
    };
    expect(await mixed(fake(hard)).pickForReviewer(plain, FALLBACK)).toMatchObject({
      model: 'gpt-6-astra',
      effort: 'low',
      how: 'pinned',
      tier: 'strongest',
    });

    // Codex has no preset: the rule doesn't apply, and the note says so.
    const claudeOnly = await nodeUnder({
      mode: 'choose',
      presets: PRESETS,
      pinned_rules: [{ when: { role: 'reviewer' }, pick: { vendor: 'codex' } }],
    });
    const skipped = await mixed(fake(CLEAR)).pickForReviewer(claudeOnly, FALLBACK);
    expect(skipped).toMatchObject({ vendor: 'claude', model: 'claude-sonnet-5-5', how: 'jev' });
    expect(skipped?.note).toBe(
      'The pinned rule for reviewer names Codex, which has no preset model here, so it didn’t apply.',
    );
  });

  test('Try it shows the tier, Jev’s confidence and why that model', async () => {
    await store.setHomeModelPolicy(
      { mode: 'choose', presets: MIXED, vendor_order: ['codex', 'claude'] },
      { by: 'human' },
    );
    const result = await mixed(fake(CLEAR)).tryTask({ text: 'Rename getUser to fetchUser' });
    expect(result).toMatchObject({
      tier: 'balanced',
      tier_by: 'jev',
      confidence: 0.82,
      in_tier: { by: 'vendor_order', words: 'Codex before Claude' },
      vendor_order: 'Codex, then Claude',
      pick: { vendor: 'codex', model: 'gpt-5.6-sol' },
    });
  });
});
