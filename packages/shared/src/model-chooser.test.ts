/**
 * T483 (design/model-routing.md §5): the chooser's pure half: the task as
 * Jev reads it, the reading of its answers into scores, the rule over the
 * scores, and the scores in words.
 */

import { describe, expect, test } from 'bun:test';
import {
  ChooserReadError,
  buildChooserState,
  chooserQuestions,
  readChooserAnswers,
  scoreOf,
  taskFromText,
} from './model-chooser';
import {
  type ChooserScores,
  type ModelPolicy,
  builtinModelPolicy,
  chooserNeed,
  readScores,
  scoresWords,
  weightedScore,
} from './model-policy';

const POLICY: ModelPolicy = builtinModelPolicy();
const CLEAR: ChooserScores = { clarity: 5, verifiability: 5, horizon: 1, stakes: 1, volume: 1 };

describe('scores (T483)', () => {
  test('a score is the probability-weighted mean; odd sums are renormalised', () => {
    const opts = ['1', '2', '3', '4', '5'];
    const a = (probabilities: Record<string, number>, choice = '3') => ({
      id: 'x',
      choice,
      confidence: 0.5,
      probabilities,
    });
    // The live clarity answer: 3 at 0.1, 5 at 0.9.
    expect(scoreOf(a({ '1': 0, '3': 0.1, '5': 0.9 }), opts)).toBe(4.8);
    // Summing to 0.4, or to 2: the same mean.
    expect(scoreOf(a({ '3': 0.2, '5': 0.2 }), opts)).toBe(4);
    expect(scoreOf(a({ '3': 1, '5': 1 }), opts)).toBe(4);
    // An option that wasn't asked is dropped.
    expect(scoreOf(a({ '5': 0.5, '9': 0.5 }), opts)).toBe(5);
    // Nothing usable: the chosen option itself; an unknown one is a bad answer.
    expect(scoreOf(a({}, '2'), opts)).toBe(2);
    expect(() => scoreOf(a({}, '7'), opts)).toThrow(ChooserReadError);
  });

  test('weights scale the distance from the middle; 0 leaves a criterion out', () => {
    expect(weightedScore(4, 1)).toBe(4);
    expect(weightedScore(4, 2)).toBe(5);
    expect(weightedScore(2, 3)).toBe(1);
    expect(weightedScore(5, 0)).toBeUndefined();
  });

  test('the rule: balanced when clear and checkable, strongest when not, fastest for many alike', () => {
    expect(readScores(CLEAR, POLICY)).toEqual({ tier: 'balanced', stepUp: false });
    expect(readScores({ ...CLEAR, volume: 5 }, POLICY).tier).toBe('fast');
    expect(readScores({ ...CLEAR, stakes: 4.5 }, POLICY)).toEqual({
      tier: 'strongest',
      stepUp: true,
    });
    expect(readScores({ ...CLEAR, clarity: 2 }, POLICY).tier).toBe('strongest');
    // The quality priority moves the bar: 3.5 passes toward speed, not toward quality.
    const middling = { ...CLEAR, clarity: 3.5, verifiability: 3.5 };
    expect(readScores(middling, { ...POLICY, quality: 0 }).tier).toBe('balanced');
    expect(readScores(middling, { ...POLICY, quality: 100 }).tier).toBe('strongest');
    // A weight of 0 ignores stakes altogether.
    const weights = { ...POLICY.weights, stakes: 0 };
    expect(readScores({ ...CLEAR, stakes: 5 }, { ...POLICY, weights }).tier).toBe('balanced');
  });

  test('the scores in words, never numbers', () => {
    expect(scoresWords(CLEAR)).toBe('well specified and covered by tests; short, low stakes');
    expect(
      scoresWords(
        { clarity: 1.5, verifiability: 3, horizon: 4.6, stakes: 5, volume: 4 },
        'migration',
      ),
    ).toBe(
      'open-ended and partly checkable; long, high stakes; one of many similar parts; touches migration',
    );
  });
});

describe('what Jev is asked (T483)', () => {
  test('the state is the task: title, goal, role, parent, plan entry, siblings', () => {
    const state = buildChooserState({
      title: 'Rename getUser',
      goal: 'Rename it and its call sites',
      role: 'worker',
      repo: 'api',
      labels: ['refactor'],
      parent: { title: 'API cleanup', goal: 'Consistent verbs' },
      plan: ['src/user.ts'],
      siblings: { count: 6, titles: ['Rename getOrder'] },
    });
    expect(state.split('\n')).toEqual([
      'Task: Rename getUser',
      'Goal: Rename it and its call sites',
      'Role: a worker: it writes the code on its own branch',
      'Repository: api',
      'Labels: refactor',
      'Part of: API cleanup',
      "The parent's goal: Consistent verbs",
      "The parent's plan gives this part: src/user.ts",
      'Siblings starting now: 6 (Rename getOrder)',
    ]);
    expect(taskFromText('Fix the login bug\nIt 500s on empty passwords.')).toEqual({
      title: 'Fix the login bug',
      goal: 'It 500s on empty passwords.',
      role: 'worker',
    });
  });

  test('the questions: five scales, the topic, the model (start cheap), the effort', () => {
    const candidates = [
      { vendor: 'claude' as const, model: 'claude-sonnet-5-5' },
      { vendor: 'claude' as const, model: 'claude-opus-5-5' },
    ];
    const full = chooserQuestions({ policy: POLICY, candidates, profiles: {}, need: 'full' });
    expect(full.map((q) => q.id)).toEqual([
      'clarity',
      'verifiability',
      'horizon',
      'stakes',
      'volume',
      'topic',
      'model',
      'effort',
    ]);
    expect(Object.keys(full[0]?.options ?? {})).toEqual(['1', '2', '3', '4', '5']);
    expect(Object.keys(full[5]?.options ?? {})).toEqual([
      'architecture',
      'migration',
      'security',
      'none',
    ]);
    expect(
      chooserQuestions({ policy: POLICY, candidates, profiles: {}, need: 'topic' }).map(
        (q) => q.id,
      ),
    ).toEqual(['topic']);
  });

  test('a reading needs every answer; the effort must be one it was asked', () => {
    const questions = chooserQuestions({
      policy: { ...POLICY, effort_ceiling: 'medium' },
      candidates: [
        { vendor: 'claude', model: 'claude-sonnet-5-5' },
        { vendor: 'claude', model: 'claude-opus-5-5' },
      ],
      profiles: {},
      need: 'full',
    });
    const answer = (id: string, choice: string) => ({
      id,
      choice,
      confidence: 0.9,
      probabilities: { [choice]: 1 },
    });
    const answers = [
      ...['clarity', 'verifiability', 'horizon', 'stakes', 'volume'].map((c) => answer(c, '4')),
      answer('topic', 'none'),
      answer('model', 'claude/claude-sonnet-5-5'),
      answer('effort', 'medium'),
    ];
    expect(readChooserAnswers(questions, answers)).toEqual({
      scores: { clarity: 4, verifiability: 4, horizon: 4, stakes: 4, volume: 4 },
      topic: 'none',
      model: { key: 'claude/claude-sonnet-5-5', confidence: 0.9 },
      effort: { level: 'medium', confidence: 0.9 },
    });
    expect(() => readChooserAnswers(questions, answers.slice(1))).toThrow(
      /no answer for "clarity"/,
    );
    expect(() =>
      readChooserAnswers(questions, [...answers.slice(0, -1), answer('effort', 'high')]),
    ).toThrow(/not an effort level/);
    expect(() =>
      readChooserAnswers(questions, [
        ...answers.slice(0, 6),
        answer('model', 'sonnet'),
        answers[7] as never,
      ]),
    ).toThrow(/vendor\/model/);
  });

  test('what a routed start needs from Jev', () => {
    const coordRule = {
      when: { role: 'coordinator' as const },
      pick: { vendor: 'claude' as const, model: 'x' },
    };
    const topicRule = {
      when: { topic: 'security' as const },
      pick: { vendor: 'claude' as const, model: 'x' },
    };
    expect(chooserNeed(POLICY, { role: 'worker' })).toBe('full');
    expect(chooserNeed({ ...POLICY, pinned_rules: [coordRule] }, { role: 'coordinator' })).toBe(
      'none',
    );
    expect(
      chooserNeed({ ...POLICY, mode: 'default', pinned_rules: [topicRule] }, { role: 'worker' }),
    ).toBe('topic');
    expect(chooserNeed({ ...POLICY, mode: 'inherit' }, { role: 'worker' })).toBe('none');
    // A topic rule before a role rule: the topic has to be read first.
    expect(
      chooserNeed({ ...POLICY, pinned_rules: [topicRule, coordRule] }, { role: 'coordinator' }),
    ).toBe('full');
  });
});
