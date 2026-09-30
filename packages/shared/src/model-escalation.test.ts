import { describe, expect, test } from 'bun:test';
import { InboxItemSchema } from './inbox';
import {
  EscalationStateSchema,
  type LadderRung,
  QUIET_TURNS_MAX,
  escalationLadder,
  nextRung,
  steppedUpLine,
  stuckLine,
} from './model-escalation';
import {
  DEFAULT_MODEL_PROFILES,
  ModelPickRecordSchema,
  PICK_HOWS,
  builtinModelPolicy,
} from './model-policy';
import { RECORD_ONLY_EVENT_TYPES, ROUTED_EVENT_PAYLOADS } from './routed-event';
import { type Stream, StreamSchema, assertStreamWrite } from './stream';
import { AGENT_VERBS, EscalateInputSchema, validateVerbInput } from './verbs';

const CLAUDE = [
  { vendor: 'claude' as const, model: 'claude-opus-5-5' },
  { vendor: 'claude' as const, model: 'claude-haiku-4-5' },
  { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
];

const policy = (over: Partial<ReturnType<typeof builtinModelPolicy>> = {}) => ({
  ...builtinModelPolicy(),
  ...over,
});

const key = (r: LadderRung) => `${r.vendor}/${r.model}${r.effort ? `·${r.effort}` : ''}`;

describe('the ladder (T484, design/model-routing.md §6)', () => {
  test('presets by tier then cost, each model’s efforts from low up to the ceiling', () => {
    const ladder = escalationLadder(policy({ presets: CLAUDE, effort_ceiling: 'high' }), {
      installed: ['claude'],
    });
    expect(ladder.map(key)).toEqual([
      'claude/claude-haiku-4-5·low',
      'claude/claude-haiku-4-5·medium',
      'claude/claude-haiku-4-5·high',
      'claude/claude-sonnet-5-5·low',
      'claude/claude-sonnet-5-5·medium',
      'claude/claude-sonnet-5-5·high',
      'claude/claude-opus-5-5·low',
      'claude/claude-opus-5-5·medium',
      'claude/claude-opus-5-5·high',
    ]);
  });

  test('within a tier the cheaper model is lower; a tie keeps the listed order', () => {
    const profiles = {
      ...DEFAULT_MODEL_PROFILES,
      'codex/gpt-5.6-sol': { tier: 'balanced' as const, cost: 1.5 },
    };
    const ladder = escalationLadder(
      policy({
        presets: [
          { vendor: 'codex', model: 'gpt-5.6-sol' },
          { vendor: 'claude', model: 'claude-sonnet-4-6' },
          { vendor: 'claude', model: 'claude-sonnet-5-5' },
        ],
        effort_ceiling: 'low',
      }),
      { installed: ['claude', 'codex'], profiles },
    );
    expect(ladder.map(key)).toEqual([
      'claude/claude-sonnet-4-6·low',
      'claude/claude-sonnet-5-5·low',
      'codex/gpt-5.6-sol·low',
    ]);
  });

  test('a vendor that takes no effort is one rung; a preset whose vendor isn’t installed is left out', () => {
    const ladder = escalationLadder(
      policy({
        presets: [
          { vendor: 'gemini', model: 'gemini-3-pro' },
          { vendor: 'claude', model: 'claude-haiku-4-5' },
          { vendor: 'cursor', model: 'composer-2' },
        ],
        effort_ceiling: 'medium',
      }),
      { installed: ['claude', 'gemini'] },
    );
    // Gemini's model has no profile: balanced, cost 1 (above Haiku, a fast model).
    expect(ladder.map(key)).toEqual([
      'claude/claude-haiku-4-5·low',
      'claude/claude-haiku-4-5·medium',
      'gemini/gemini-3-pro',
    ]);
  });

  test('empty presets: any installed model, by tier and cost', () => {
    const ladder = escalationLadder(policy({ presets: [], effort_ceiling: 'low' }), {
      installed: ['claude'],
      models: {
        claude: [
          { value: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
          { value: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
          { value: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
        ],
      },
    });
    expect(ladder.map(key)).toEqual([
      'claude/claude-haiku-4-5·low',
      'claude/claude-sonnet-5-5·low',
      'claude/claude-opus-5-5·low',
    ]);
  });

  test('the same preset listed twice is one model on the ladder', () => {
    const ladder = escalationLadder(
      policy({ presets: [...CLAUDE, CLAUDE[0] as (typeof CLAUDE)[number]], effort_ceiling: 'low' }),
      { installed: ['claude'] },
    );
    expect(ladder).toHaveLength(3);
  });
});

describe('one step up (T484)', () => {
  const ladder = escalationLadder(policy({ presets: CLAUDE, effort_ceiling: 'high' }), {
    installed: ['claude'],
  });

  test('the next effort on the same model first', () => {
    expect(
      nextRung(ladder, { vendor: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }),
    ).toEqual({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
  });

  test('then the next model, at the effort it ran on (never lower)', () => {
    expect(
      nextRung(ladder, { vendor: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }),
    ).toEqual({
      vendor: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
    });
  });

  test('the top of the ladder has no step', () => {
    expect(
      nextRung(ladder, { vendor: 'claude', model: 'claude-opus-5-5', effort: 'high' }),
    ).toBeUndefined();
  });

  test('an effort over the ceiling (an explicit pick) moves to the next model, capped', () => {
    expect(
      nextRung(ladder, { vendor: 'claude', model: 'claude-haiku-4-5', effort: 'max' }),
    ).toEqual({
      vendor: 'claude',
      model: 'claude-sonnet-5-5',
      effort: 'high',
    });
  });

  test('a model outside the presets steps to the first preset ranked above it', () => {
    // Sonnet 4.6 (balanced, cost 1) isn't a preset: Opus 5.5 is the first above it.
    expect(
      nextRung(ladder, { vendor: 'claude', model: 'claude-sonnet-4-6', effort: 'medium' }),
    ).toEqual({
      vendor: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
    // Above every preset: the top.
    const low = escalationLadder(
      policy({ presets: [{ vendor: 'claude', model: 'claude-haiku-4-5' }], effort_ceiling: 'low' }),
      { installed: ['claude'] },
    );
    expect(
      nextRung(low, { vendor: 'claude', model: 'claude-opus-4-8', effort: 'low' }),
    ).toBeUndefined();
  });

  test('to and from a vendor with no effort', () => {
    const mixed = escalationLadder(
      policy({
        presets: [
          { vendor: 'claude', model: 'claude-haiku-4-5' },
          { vendor: 'gemini', model: 'gemini-3-pro' },
          { vendor: 'claude', model: 'claude-opus-5-5' },
        ],
        effort_ceiling: 'max',
      }),
      { installed: ['claude', 'gemini'] },
    );
    // Haiku at max, the top of its efforts: the next model takes no effort.
    expect(nextRung(mixed, { vendor: 'claude', model: 'claude-haiku-4-5', effort: 'max' })).toEqual(
      {
        vendor: 'gemini',
        model: 'gemini-3-pro',
      },
    );
    // From a vendor with none: the next model at medium.
    expect(nextRung(mixed, { vendor: 'gemini', model: 'gemini-3-pro' })).toEqual({
      vendor: 'claude',
      model: 'claude-opus-5-5',
      effort: 'medium',
    });
  });

  test('an empty ladder (nothing installed) has no step', () => {
    expect(
      nextRung([], { vendor: 'claude', model: 'claude-haiku-4-5', effort: 'low' }),
    ).toBeUndefined();
  });
});

describe('escalation records, words and the verb (T484)', () => {
  const now = new Date().toISOString();
  const base: Stream = StreamSchema.parse({
    id: '01J0000000000000000000000A',
    title: 'Parser',
    created_at: now,
    agent: { status: 'working', updated_at: now },
    human: { status: 'open' },
    sessions: [],
  });

  test('the record is strict and daemon-only: agent, coordinator, Director and human writes are refused', () => {
    const escalation = {
      pending: { trigger: 'asked', reason: 'the tests still fail', by: 'agent', at: now },
    };
    expect(EscalationStateSchema.parse(escalation)).toEqual(escalation as never);
    expect(EscalationStateSchema.safeParse({ ...escalation, model: 'x' }).success).toBe(false);
    expect(
      EscalationStateSchema.safeParse({
        pending: { ...escalation.pending, model: 'claude-opus-5-5' },
      }).success,
    ).toBe(false);
    const after = StreamSchema.parse({ ...base, escalation });
    for (const principal of ['agent', 'coordinator', 'director', 'human'] as const) {
      expect(() => assertStreamWrite(principal, base, after)).toThrow(/only the daemon/);
    }
    expect(assertStreamWrite('daemon', base, after).escalation?.pending?.by).toBe('agent');
  });

  test('`escalate` takes only why: it can never carry a model', () => {
    expect(AGENT_VERBS).toContain('escalate');
    const session = '01J0000000000000000000000B';
    expect(validateVerbInput('escalate', { session, why: 'tests still fail' }).why).toBe(
      'tests still fail',
    );
    for (const extra of [{ model: 'claude-opus-5-5' }, { vendor: 'claude' }, { effort: 'max' }]) {
      expect(EscalateInputSchema.safeParse({ session, why: 'x', ...extra }).success).toBe(false);
      expect(() => validateVerbInput('escalate', { session, why: 'x', ...extra })).toThrow();
    }
    expect(EscalateInputSchema.safeParse({ session, why: '' }).success).toBe(false);
  });

  test('a pick records how = escalation; the event is record-only; the inbox has model_stuck', () => {
    expect(PICK_HOWS).toContain('escalation');
    expect(
      ModelPickRecordSchema.safeParse({
        vendor: 'claude',
        model: 'claude-opus-5-5',
        effort: 'high',
        how: 'escalation',
        why: 'stepped up: the agent asked',
        at: now,
      }).success,
    ).toBe(true);
    expect(RECORD_ONLY_EVENT_TYPES.has('model_escalated')).toBe(true);
    expect(
      ROUTED_EVENT_PAYLOADS.model_escalated
        .strict()
        .safeParse({ step: 'up', trigger: 'asked', from: 'a', to: 'b', reason: 'c' }).success,
    ).toBe(true);
    expect(
      InboxItemSchema.safeParse({
        kind: 'model_stuck',
        id: base.id,
        stream: base.id,
        stream_path: ['Parser'],
        ts: now,
        context: stuckLine('Parser', 'the merge was refused twice'),
      }).success,
    ).toBe(true);
  });

  test('the words name models, never ids', () => {
    expect(
      steppedUpLine(
        { vendor: 'claude', model: 'claude-opus-5-5', effort: 'high' },
        { vendor: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
        'the tests failed twice',
      ),
    ).toBe(
      'Stepped up to Claude Opus 5.5 · high: the tests failed twice on Claude Sonnet 5.5 · high',
    );
    expect(stuckLine('Parser', 'the agent asked: stuck')).toBe(
      'Parser is stuck on the strongest preset model: the agent asked: stuck',
    );
    expect(QUIET_TURNS_MAX).toBe(3);
  });
});
