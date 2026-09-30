import { describe, expect, test } from 'bun:test';
import { HomeConfigSchema } from './home-config';
import { chooserQuestions, readChooserAnswers } from './model-chooser';
import {
  DEFAULT_MODEL_PROFILES,
  type ModelPolicy,
  ModelPolicyPartialSchema,
  ModelPolicyPatchSchema,
  ModelPolicySchema,
  ModelProfilesSchema,
  type PickModelInput,
  PinnedRuleSchema,
  applyModelPolicyPatch,
  builtinModelPolicy,
  chooserNeed,
  matchPinnedRule,
  modelForTier,
  modelWords,
  pickModel,
  policySourceWords,
  profileOf,
  resolveModelPolicy,
  routedPickLine,
  ruleFallbackPick,
  scoresRulePick,
  scoresTier,
  tiersPresent,
  vendorOrderFor,
  vendorOrderWords,
} from './model-policy';
import { ProjectSchema } from './project';
import { StreamHumanStateSchema, assertStreamWrite } from './stream';

const policy = (over: Partial<ModelPolicy> = {}): ModelPolicy => ({
  ...builtinModelPolicy(),
  ...over,
});

const fallback = { vendor: 'claude', model: 'claude-opus-5-5', effort: 'low' as const };

const input = (over: Partial<PickModelInput> = {}): PickModelInput => ({
  policy: policy(),
  fallback,
  installed: ['claude', 'codex', 'gemini'],
  ...over,
});

describe('model policy schemas (T482)', () => {
  test('a whole policy validates, and every schema is strict', () => {
    const whole = {
      mode: 'choose',
      quality: 70,
      presets: [{ vendor: 'claude', model: 'claude-sonnet-5-5' }],
      effort_ceiling: 'high',
      escalation: 'start_cheap',
      pinned_rules: [
        { when: { role: 'coordinator' }, pick: { vendor: 'claude', model: 'claude-opus-5-5' } },
      ],
      guidance: 'Anything touching billing gets Opus.',
      weights: { clarity: 2, verifiability: 1, horizon: 0, stakes: 3, volume: 1 },
      vendor_order: ['claude', 'codex'],
      vendor_order_by_role: { reviewer: ['codex', 'claude'] },
    };
    expect(ModelPolicySchema.safeParse(whole).success).toBe(true);
    expect(ModelPolicySchema.safeParse({ ...whole, extra: 1 }).success).toBe(false);
    expect(ModelPolicyPartialSchema.safeParse({ mode: 'inherit', extra: 1 }).success).toBe(false);
    expect(ModelPolicyPartialSchema.safeParse({}).success).toBe(true);
  });

  test('the limits: quality 0–100, weights 0–3, guidance ≤ 2000, a rule names something', () => {
    expect(ModelPolicyPartialSchema.safeParse({ quality: 101 }).success).toBe(false);
    expect(ModelPolicyPartialSchema.safeParse({ quality: 12.5 }).success).toBe(false);
    expect(ModelPolicyPartialSchema.safeParse({ weights: { stakes: 4 } }).success).toBe(false);
    expect(ModelPolicyPartialSchema.safeParse({ weights: { stakes: 3 } }).success).toBe(true);
    expect(ModelPolicyPartialSchema.safeParse({ guidance: 'x'.repeat(2001) }).success).toBe(false);
    expect(
      ModelPolicyPartialSchema.safeParse({ presets: [{ vendor: 'nope', model: 'x' }] }).success,
    ).toBe(false);
    expect(
      PinnedRuleSchema.safeParse({ when: {}, pick: { vendor: 'claude', model: 'opus' } }).success,
    ).toBe(false);
    expect(
      PinnedRuleSchema.safeParse({
        when: { topic: 'security' },
        pick: { vendor: 'claude', model: 'opus', effort: 'high' },
      }).success,
    ).toBe(true);
  });

  test('profiles: keyed vendor/model, a tier and a positive cost', () => {
    expect(
      ModelProfilesSchema.safeParse({ 'claude/claude-sonnet-5-5': { tier: 'balanced', cost: 1 } })
        .success,
    ).toBe(true);
    expect(ModelProfilesSchema.safeParse({ sonnet: { tier: 'balanced', cost: 1 } }).success).toBe(
      false,
    );
    expect(ModelProfilesSchema.safeParse({ 'acme/x': { tier: 'balanced', cost: 1 } }).success).toBe(
      false,
    );
    expect(
      ModelProfilesSchema.safeParse({ 'claude/x': { tier: 'balanced', cost: 0 } }).success,
    ).toBe(false);
  });

  test('the home, a project and a node carry it', () => {
    expect(HomeConfigSchema.safeParse({ model_policy: { mode: 'default' } }).success).toBe(true);
    expect(
      HomeConfigSchema.safeParse({
        model_profiles: { 'codex/gpt-5.5': { tier: 'fast', cost: 0.5 } },
      }).success,
    ).toBe(true);
    expect(
      ProjectSchema.safeParse({
        id: 'P-01J00000000000000000000000',
        name: 'shop',
        root: '01J00000000000000000000000',
        created_at: 'now',
        model_policy: {},
      }).success,
    ).toBe(true);
    expect(
      StreamHumanStateSchema.safeParse({
        status: 'open',
        model_policy: { mode: 'inherit' },
        choose_again: true,
      }).success,
    ).toBe(true);
  });

  test('a node’s policy is human-only: an agent, coordinator or Director write is refused', () => {
    const before = {
      id: '01J00000000000000000000000',
      title: 't',
      created_at: 'now',
      agent: { status: 'idle' as const, updated_at: 'now' },
      human: { status: 'open' as const },
      sessions: [],
    };
    const after = {
      ...before,
      human: { ...before.human, model_policy: { mode: 'choose' as const } },
    };
    for (const who of ['agent', 'coordinator', 'director'] as const) {
      expect(() => assertStreamWrite(who, before, after)).toThrow(/may not change human/);
    }
    expect(assertStreamWrite('human', before, after)).toBe(after);
    expect(assertStreamWrite('daemon', before, after)).toBe(after);
  });

  test('a patch sets, clears (null) and leaves alone', () => {
    const before = { mode: 'default' as const, quality: 20 };
    expect(applyModelPolicyPatch(before, { quality: null, escalation: 'strongest_first' })).toEqual(
      {
        mode: 'default',
        escalation: 'strongest_first',
      },
    );
    expect(ModelPolicyPatchSchema.safeParse({ nope: 1 }).success).toBe(false);
  });
});

describe('resolveModelPolicy (T482)', () => {
  test('nothing set: the built-in (D54), with the favourites as the presets', () => {
    const { policy: p, sources } = resolveModelPolicy({
      favourites: [{ vendor: 'claude', model: 'claude-sonnet-5-5' }, { vendor: 'gemini' }],
    });
    expect(p.mode).toBe('choose');
    expect(p.quality).toBe(50);
    expect(p.escalation).toBe('start_cheap');
    expect(p.pinned_rules).toEqual([]);
    expect(p.presets).toEqual([
      { vendor: 'claude', model: 'claude-sonnet-5-5' },
      { vendor: 'gemini', model: 'default' },
    ]);
    expect(p.weights).toEqual({ clarity: 1, verifiability: 1, horizon: 1, stakes: 1, volume: 1 });
    expect(sources.mode).toEqual({ from: 'built-in' });
  });

  test('field by field: node, then ancestors nearest first, then project, then home', () => {
    const { policy: p, sources } = resolveModelPolicy({
      node: { quality: 90 },
      ancestors: [
        { id: 'A1', title: 'Billing', policy: { mode: 'inherit' } },
        { id: 'A2', title: 'Root', policy: { mode: 'default', effort_ceiling: 'medium' } },
      ],
      project: {
        id: 'P-1',
        name: 'shop',
        policy: { effort_ceiling: 'high', escalation: 'strongest_first' },
      },
      home: {
        guidance: 'Prefer Codex for Rust.',
        escalation: 'start_cheap',
        weights: { stakes: 3 },
      },
    });
    expect(p.quality).toBe(90);
    expect(sources.quality).toEqual({ from: 'node' });
    expect(p.mode).toBe('inherit');
    expect(sources.mode).toEqual({ from: 'ancestor', id: 'A1', title: 'Billing' });
    // An ancestor wins over the project.
    expect(p.effort_ceiling).toBe('medium');
    expect(sources.effort_ceiling).toEqual({ from: 'ancestor', id: 'A2', title: 'Root' });
    expect(p.escalation).toBe('strongest_first');
    expect(sources.escalation).toEqual({ from: 'project', id: 'P-1', title: 'shop' });
    expect(p.guidance).toBe('Prefer Codex for Rust.');
    expect(sources.guidance).toEqual({ from: 'home' });
    expect(p.weights.stakes).toBe(3);
    expect(p.weights.clarity).toBe(1);
    expect(sources.presets).toEqual({ from: 'built-in' });
  });

  test('a stamped project (mode default) keeps Default over the home’s Choose', () => {
    const { policy: p, sources } = resolveModelPolicy({
      project: { policy: { mode: 'default' } },
      home: { mode: 'choose' },
    });
    expect(p.mode).toBe('default');
    expect(sources.mode.from).toBe('project');
  });

  test('source words', () => {
    expect(policySourceWords({ from: 'home' }, 'project')).toBe('from Home');
    expect(policySourceWords({ from: 'project' }, 'project')).toBe('set here');
    expect(policySourceWords({ from: 'ancestor', title: 'Billing' }, 'node')).toBe('from Billing');
    expect(policySourceWords({ from: 'built-in' }, 'home')).toBe('built in');
  });
});

describe('model profiles (T482)', () => {
  test('shipped defaults: Haiku fast 0.3, Sonnet balanced 1, Opus strongest 2', () => {
    expect(profileOf('claude', 'claude-haiku-4-5')).toEqual({
      tier: 'fast',
      cost: 0.3,
      known: true,
    });
    expect(profileOf('claude', 'claude-sonnet-5-5')).toEqual({
      tier: 'balanced',
      cost: 1,
      known: true,
    });
    expect(profileOf('claude', 'claude-opus-5-5').tier).toBe('strongest');
    expect(DEFAULT_MODEL_PROFILES['codex/gpt-6-astra']?.tier).toBe('strongest');
  });
  test('a vendor’s bracketed settings are ignored; an unknown model reads balanced, cost 1', () => {
    expect(profileOf('claude', 'opus[1m]').tier).toBe('strongest');
    expect(profileOf('cursor', 'grok-4.7')).toEqual({ tier: 'balanced', cost: 1, known: false });
  });
  test('model words', () => {
    expect(modelWords('claude', 'claude-sonnet-5-5')).toBe('Claude Sonnet 5.5');
    expect(modelWords('gemini', 'default')).toBe('Gemini default model');
    expect(modelWords('cursor', 'x', { cursor: [{ value: 'x', name: 'Grok Fast' }] })).toBe(
      'Grok Fast',
    );
  });
});

describe('pickModel (T482)', () => {
  const presets = [
    { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
    { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
    { vendor: 'claude' as const, model: 'claude-opus-5-5' },
  ];

  test('explicit inside the presets: no note', () => {
    const pick = pickModel(
      input({
        policy: policy({ presets }),
        explicit: { vendor: 'claude', model: 'claude-sonnet-5-5', effort: 'max' },
      }),
    );
    expect(pick).toEqual({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'max',
      how: 'explicit',
      why: 'your pick',
    });
  });

  test('explicit outside the presets runs as picked, never clamped, and says so (D53)', () => {
    const pick = pickModel(
      input({
        policy: policy({
          presets: [presets[0] as (typeof presets)[number]],
          effort_ceiling: 'low',
        }),
        explicit: { vendor: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        inProject: true,
      }),
    );
    expect(pick.how).toBe('explicit');
    expect(pick.model).toBe('claude-opus-5-5');
    expect(pick.effort).toBe('high');
    expect(pick.note).toBe(
      'Running Claude Opus 5.5, as you picked. Routed picks here use this project’s preset models.',
    );
    expect(pick.note).not.toMatch(/refus|not allowed|allowed/i);
  });

  test('the kept pick holds, unclamped (T464, D55)', () => {
    const pick = pickModel(
      input({
        policy: policy({ presets, effort_ceiling: 'low' }),
        kept: { vendor: 'codex', model: 'gpt-5.5', effort: 'high' },
      }),
    );
    expect(pick).toMatchObject({ vendor: 'codex', model: 'gpt-5.5', effort: 'high', how: 'kept' });
  });

  test('inherit copies the parent’s current pick', () => {
    const pick = pickModel(
      input({
        policy: policy({ mode: 'inherit', presets: [] }),
        parent: { vendor: 'codex', model: 'gpt-5.5', effort: 'medium', title: 'Billing' },
      }),
    );
    expect(pick).toMatchObject({ vendor: 'codex', model: 'gpt-5.5', how: 'inherit' });
    // T488: Codex takes effort, so its line names the level.
    expect(routedPickLine(pick)).toBe('Model: gpt-5.5 · medium — inherited from Billing');
  });

  test('inherit with no parent pick resolves as Default, and says why', () => {
    const pick = pickModel(input({ policy: policy({ mode: 'inherit', presets: [] }) }));
    expect(pick).toMatchObject({ ...fallback, how: 'default' });
    expect(pick.note).toMatch(/no model yet/);
  });

  test('default resolves as today', () => {
    const pick = pickModel(input({ policy: policy({ mode: 'default', presets: [] }) }));
    expect(pick).toMatchObject({ ...fallback, how: 'default', why: 'the Default setting' });
    expect(pick.note).toBeUndefined();
    expect(routedPickLine(pick)).toBe('Model: Claude Opus 5.5 · low — the Default setting');
  });

  test('choose, start cheap: a balanced preset at medium', () => {
    const pick = pickModel(input({ policy: policy({ mode: 'choose', presets }) }));
    expect(pick).toMatchObject({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      how: 'rule',
      tier: 'balanced',
      tier_by: 'rule',
    });
    expect(pick.why).toBe('start cheap: balanced (without Jev)');
  });

  test('choose, start cheap with no balanced preset: the cheapest of any tier', () => {
    const pick = pickModel(
      input({
        policy: policy({
          presets: [
            { vendor: 'claude', model: 'claude-opus-5-5' },
            { vendor: 'claude', model: 'claude-haiku-4-5' },
          ],
        }),
      }),
    );
    expect(pick.model).toBe('claude-haiku-4-5');
  });

  test('choose, strongest first: the highest tier, then the highest cost', () => {
    const pick = pickModel(
      input({
        policy: policy({ escalation: 'strongest_first', presets }),
        profiles: {
          ...DEFAULT_MODEL_PROFILES,
          'claude/claude-opus-5-5': { tier: 'strongest', cost: 3 },
        },
      }),
    );
    expect(pick).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', how: 'rule' });
  });

  test('choose with no presets: any installed model, today’s vendor first on a tie', () => {
    const pick = pickModel(
      input({ policy: policy({ presets: [] }), installed: ['claude', 'codex'] }),
    );
    expect(pick).toMatchObject({ vendor: 'claude', model: 'claude-sonnet-5-5', how: 'rule' });
  });

  test('the clamp: a Default pick outside the presets lands on the nearest preset, and says so', () => {
    const pick = pickModel(
      input({
        policy: policy({
          mode: 'default',
          presets: [
            { vendor: 'claude', model: 'claude-haiku-4-5' },
            { vendor: 'claude', model: 'claude-sonnet-5-5' },
          ],
        }),
      }),
    );
    // Opus (strongest) is nearest Sonnet (balanced), not Haiku (fast).
    expect(pick).toMatchObject({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      how: 'clamp',
      base: 'default',
    });
    expect(pick.note).toBe('Claude Opus 5.5 isn’t a preset model, so Claude Sonnet 5.5 instead.');
  });

  test('the clamp: effort over the ceiling comes down to it', () => {
    const pick = pickModel(
      input({
        policy: policy({ mode: 'inherit', presets: [], effort_ceiling: 'medium' }),
        parent: { vendor: 'claude', model: 'claude-opus-5-5', effort: 'max', title: 'Root' },
      }),
    );
    expect(pick).toMatchObject({ effort: 'medium', how: 'clamp', base: 'inherit' });
    expect(pick.note).toBe('Effort max is over the ceiling, so medium.');
    expect(routedPickLine(pick)).toBe(
      'Model: Claude Opus 5.5 · medium — inherited from Root, clamped. Effort max is over the ceiling, so medium.',
    );
  });

  test('a vendor without effort: the ceiling changes nothing it would say', () => {
    const pick = pickModel(
      input({
        policy: policy({ mode: 'inherit', presets: [], effort_ceiling: 'low' }),
        // T488: Cursor has no effort setting (Codex now does).
        parent: { vendor: 'cursor', model: 'gpt-5.5', effort: 'high', title: 'Root' },
        installed: ['claude', 'cursor'],
      }),
    );
    expect(pick.how).toBe('inherit');
    expect(pick.note).toBeUndefined();
    expect(pick.effort).toBe('low');
    expect(routedPickLine(pick)).toBe('Model: gpt-5.5 — inherited from Root');
  });

  test('a preset whose vendor isn’t installed is not a candidate', () => {
    const ruled = ruleFallbackPick(
      policy(),
      [{ vendor: 'claude', model: 'claude-sonnet-5-5' }],
      DEFAULT_MODEL_PROFILES,
    );
    expect(ruled?.model).toBe('claude-sonnet-5-5');
    const pick = pickModel(
      input({
        policy: policy({ presets: [{ vendor: 'gemini', model: 'default' }] }),
        installed: ['claude'],
      }),
    );
    expect(pick.vendor).toBe('claude');
    expect(pick.how).toBe('rule');
  });
});

describe('T490: tier first (D57) and the vendor order (D59)', () => {
  const MIXED = [
    { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
    { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
    { vendor: 'claude' as const, model: 'claude-opus-5-5' },
    { vendor: 'codex' as const, model: 'gpt-5.6-sol' },
    { vendor: 'codex' as const, model: 'gpt-6-astra' },
  ];
  const P = DEFAULT_MODEL_PROFILES;
  const CLEAR = { clarity: 5, verifiability: 5, horizon: 1, stakes: 1, volume: 1 };
  const reading = (tier: 'fast' | 'balanced' | 'strongest', confidence: number) => ({
    ok: true as const,
    reading: { scores: CLEAR, topic: 'none' as const, tier: { tier, confidence } },
  });

  test('the new fields are strict, validated and human-only on a node', () => {
    expect(ModelPolicyPartialSchema.safeParse({ vendor_order: ['claude', 'codex'] }).success).toBe(
      true,
    );
    expect(ModelPolicyPartialSchema.safeParse({ vendor_order: ['claude', 'claude'] }).success).toBe(
      false,
    );
    expect(ModelPolicyPartialSchema.safeParse({ vendor_order: ['openai'] }).success).toBe(false);
    expect(
      ModelPolicyPartialSchema.safeParse({ vendor_order_by_role: { reviewer: ['codex'] } }).success,
    ).toBe(true);
    expect(
      ModelPolicyPartialSchema.safeParse({ vendor_order_by_role: { tester: ['codex'] } }).success,
    ).toBe(false);
    expect(ModelPolicyPatchSchema.safeParse({ vendor_order: null }).success).toBe(true);
    expect(
      PinnedRuleSchema.safeParse({ when: { role: 'reviewer' }, pick: { vendor: 'codex' } }).success,
    ).toBe(true);
    const before = {
      id: '01J00000000000000000000000',
      title: 't',
      created_at: 'now',
      agent: { status: 'idle' as const, updated_at: 'now' },
      human: { status: 'open' as const },
      sessions: [],
    };
    const after = {
      ...before,
      human: {
        ...before.human,
        model_policy: {
          vendor_order: ['codex' as const],
          vendor_order_by_role: { reviewer: ['claude' as const] },
        },
      },
    };
    expect(StreamHumanStateSchema.safeParse(after.human).success).toBe(true);
    for (const who of ['agent', 'coordinator', 'director'] as const) {
      expect(() => assertStreamWrite(who, before, after)).toThrow(/may not change human/);
    }
    expect(assertStreamWrite('human', before, after)).toBe(after);
  });

  test('the fields resolve field by field; a role’s own order is over the global one', () => {
    const { policy: resolved, sources } = resolveModelPolicy({
      node: { vendor_order_by_role: { reviewer: ['codex'] } },
      project: { policy: { vendor_order: ['claude', 'codex'] } },
    });
    expect(resolved.vendor_order).toEqual(['claude', 'codex']);
    expect(sources.vendor_order.from).toBe('project');
    expect(sources.vendor_order_by_role.from).toBe('node');
    expect(vendorOrderFor(resolved, 'reviewer')).toEqual(['codex']);
    expect(vendorOrderFor(resolved, 'worker')).toEqual(['claude', 'codex']);
    expect(vendorOrderFor(builtinModelPolicy(), 'worker')).toEqual([]);
    expect(vendorOrderWords(['claude', 'codex'])).toBe('Claude, then Codex');
    expect(vendorOrderWords([])).toBe('no preference');
  });

  test('the tier question: only the tiers the candidates have; none when they have one', () => {
    const ids = (candidates: typeof MIXED) =>
      chooserQuestions({ policy: builtinModelPolicy(), candidates, profiles: P, need: 'full' });
    const all = ids(MIXED).find((q) => q.id === 'tier');
    expect(Object.keys(all?.options ?? {})).toEqual(['fast', 'balanced', 'strongest']);
    const two = ids(MIXED.filter((m) => m.model !== 'claude-haiku-4-5')).find(
      (q) => q.id === 'tier',
    );
    expect(Object.keys(two?.options ?? {})).toEqual(['balanced', 'strongest']);
    // Sonnet and Sol are both balanced: no tier question.
    const one = ids([MIXED[1], MIXED[3]] as typeof MIXED);
    expect(one.map((q) => q.id)).not.toContain('tier');
    expect(tiersPresent([MIXED[1], MIXED[3]] as typeof MIXED, P)).toEqual(['balanced']);
    // The tier answer reads as a tier with its confidence.
    const qs = ids(MIXED);
    const answers = qs.map((q) => ({
      id: q.id,
      choice:
        q.id === 'tier'
          ? 'strongest'
          : q.id === 'topic'
            ? 'none'
            : q.id === 'effort'
              ? 'high'
              : '3',
      confidence: 0.7,
      probabilities: {},
    }));
    expect(readChooserAnswers(qs, answers).tier).toEqual({ tier: 'strongest', confidence: 0.7 });
  });

  test('the model inside a tier: the vendor order, then cost, then the listed order', () => {
    expect(modelForTier('balanced', MIXED, P, { vendorOrder: ['claude', 'codex'] })).toEqual({
      preset: MIXED[1] as (typeof MIXED)[number],
      wanted: 'balanced',
      tier: 'balanced',
      by: 'vendor_order',
      words: 'Claude before Codex',
    });
    expect(modelForTier('strongest', MIXED, P, { vendorOrder: ['codex'] })?.preset).toEqual(
      MIXED[4],
    );
    // No order: the listed order when the costs tie …
    expect(modelForTier('balanced', MIXED, P)).toMatchObject({
      preset: MIXED[1],
      by: 'listed',
      words: 'no vendor preferred, so the one listed first',
    });
    // … the cheapest when they don't.
    const cheapSol = { ...P, 'codex/gpt-5.6-sol': { tier: 'balanced' as const, cost: 0.8 } };
    expect(modelForTier('balanced', MIXED, cheapSol)).toMatchObject({
      preset: MIXED[3],
      by: 'cost',
      words: 'the cheapest balanced preset model',
    });
    // The vendor order comes before cost; a vendor it doesn't name comes after those it does.
    expect(modelForTier('balanced', MIXED, cheapSol, { vendorOrder: ['claude'] })?.preset).toEqual(
      MIXED[1],
    );
    expect(modelForTier('fast', MIXED, P)).toMatchObject({ preset: MIXED[0], by: 'only' });
    expect(modelForTier('fast', MIXED, P)?.words).toBeUndefined();
  });

  test('a tier with no preset falls back to the nearest tier, and says so', () => {
    const noFast = MIXED.filter((m) => m.model !== 'claude-haiku-4-5');
    expect(modelForTier('fast', noFast, P, { vendorOrder: ['codex'] })).toMatchObject({
      wanted: 'fast',
      tier: 'balanced',
      preset: { model: 'gpt-5.6-sol' },
    });
    const pick = pickModel(
      input({
        policy: policy({ mode: 'choose', presets: noFast, vendor_order: ['codex', 'claude'] }),
        installed: ['claude', 'codex'],
        chooser: {
          ok: true,
          reading: { scores: { ...CLEAR, volume: 5 }, topic: 'none' },
        },
      }),
    );
    // The scores call for fast (high volume); there is none, so balanced, by the vendor order.
    expect(pick).toMatchObject({ model: 'gpt-5.6-sol', tier: 'fast', tier_by: 'scores' });
    expect(pick.why).toContain('no fast preset model, so balanced; Codex before Claude');
  });

  test('the tier: Jev’s from 0.5, else the scores’ rule; the model by the role’s order', () => {
    const base = policy({
      mode: 'choose',
      presets: MIXED,
      vendor_order: ['claude', 'codex'],
      vendor_order_by_role: { reviewer: ['codex', 'claude'] },
    });
    const sure = pickModel(
      input({ policy: base, installed: ['claude', 'codex'], chooser: reading('strongest', 0.5) }),
    );
    expect(sure).toMatchObject({ model: 'claude-opus-5-5', how: 'jev', tier: 'strongest' });
    expect(sure.why).toBe(
      'strongest (Jev 0.50): well specified and covered by tests; short, low stakes; Claude before Codex',
    );
    const unsure = pickModel(
      input({ policy: base, installed: ['claude', 'codex'], chooser: reading('strongest', 0.49) }),
    );
    expect(unsure).toMatchObject({ model: 'claude-sonnet-5-5', how: 'scores', tier: 'balanced' });
    expect(scoresTier(CLEAR, base)).toBe('balanced');
    expect(scoresRulePick(base, CLEAR, MIXED, P, ['codex'])).toMatchObject({
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      tier: 'balanced',
      effort: 'medium',
    });
    const reviewer = pickModel(
      input({
        policy: base,
        installed: ['claude', 'codex'],
        chooser: reading('balanced', 0.9),
        task: { role: 'reviewer' },
      }),
    );
    expect(reviewer).toMatchObject({ vendor: 'codex', model: 'gpt-5.6-sol' });
    // No key: the rule as a tier, then the order.
    const ruled = ruleFallbackPick(base, MIXED, P, ['codex']);
    expect(ruled).toMatchObject({ model: 'gpt-5.6-sol', tier: 'balanced', tier_by: 'rule' });
    // Strongest first: the highest tier, the vendor order, then the most capable.
    const strongest = ruleFallbackPick(policy({ escalation: 'strongest_first' }), MIXED, P, [
      'codex',
    ]);
    expect(strongest).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    expect(strongest?.why).toBe(
      'strongest first: the strongest preset model (without Jev); Codex before Claude',
    );
  });

  test('a pinned rule may name only a vendor: it matches only where that vendor has a preset', () => {
    const rule = { when: { role: 'reviewer' as const }, pick: { vendor: 'codex' as const } };
    expect(
      matchPinnedRule([rule], { role: 'reviewer' }, undefined, ['claude', 'codex'])?.index,
    ).toBe(0);
    expect(matchPinnedRule([rule], { role: 'reviewer' }, undefined, ['claude'])).toBeUndefined();
    // It needs Jev's tier, under any mode.
    const def = policy({ mode: 'default', pinned_rules: [rule] });
    expect(chooserNeed(def, { role: 'reviewer' }, ['codex'])).toBe('full');
    expect(chooserNeed(def, { role: 'reviewer' }, ['claude'])).toBe('none');
    const pick = pickModel(
      input({
        policy: policy({ mode: 'choose', presets: MIXED, pinned_rules: [rule] }),
        installed: ['claude', 'codex'],
        chooser: reading('strongest', 0.9),
        task: { role: 'reviewer' },
      }),
    );
    expect(pick).toMatchObject({
      vendor: 'codex',
      model: 'gpt-6-astra',
      how: 'pinned',
      tier: 'strongest',
      tier_by: 'jev',
    });
    expect(pick.why).toStartWith('pinned rule: reviewer → Codex; strongest (Jev 0.90)');
    const none = pickModel(
      input({
        policy: policy({ mode: 'choose', presets: MIXED.slice(0, 3), pinned_rules: [rule] }),
        installed: ['claude', 'codex'],
        chooser: reading('strongest', 0.9),
        task: { role: 'reviewer' },
      }),
    );
    expect(none).toMatchObject({ vendor: 'claude', model: 'claude-opus-5-5', how: 'jev' });
    expect(none.note).toBe(
      'The pinned rule for reviewer names Codex, which has no preset model here, so it didn’t apply.',
    );
    // A pinned model records its own tier, decided by the rule.
    const pinnedModel = pickModel(
      input({
        policy: policy({
          presets: MIXED,
          pinned_rules: [
            { when: { role: 'coordinator' }, pick: { vendor: 'claude', model: 'claude-opus-5-5' } },
          ],
        }),
        task: { role: 'coordinator' },
      }),
    );
    expect(pinnedModel).toMatchObject({ tier: 'strongest', tier_by: 'pinned' });
  });
});
