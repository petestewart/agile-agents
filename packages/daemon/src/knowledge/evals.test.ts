/**
 * T153 (§5.6): a rule's examples are its evals. Everything here runs
 * through `FakeClassifier` — the suite never reaches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ClassifierBands,
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_DENY_AT,
  type KnowledgeItem,
  examplesOf,
} from '@agile-agents/shared';
import { ClassifierUnavailableError, FakeClassifier } from '../classifier';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { RuleNotEvaluableError, runRuleEvals } from './evals';
import { KnowledgeService } from './service';

const BANDS: ClassifierBands = {
  deny_at: DEFAULT_CLASSIFIER_DENY_AT,
  allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
};

let home: string;
let rules: KnowledgeService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rule-evals-'));
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  rules = new KnowledgeService({ store, streams: new StreamService(store) });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** An accepted classifier rule with one violating and one clean example. */
async function acceptedClassifierRule(
  text = 'do not add a dependency without asking',
): Promise<KnowledgeItem> {
  const rule = await rules.create('human', {
    text,
    enforcement: 'action',
    check: {
      by: 'classifier',
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'edit src/index.ts', violates: false },
      ],
    },
  });
  return rules.accept(rule.id, 'pete');
}

describe('runRuleEvals (§5.6)', () => {
  test('one call per example, carrying that example as the state', async () => {
    const rule = await acceptedClassifierRule();
    const classifier = new FakeClassifier((_state, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.9 })),
    );
    await runRuleEvals({ rules, classifier, bands: BANDS });
    // Two examples are two *states*, and §6.2's batching is questions over
    // one state — so there is nothing to batch here.
    expect(classifier.calls.map((c) => c.state)).toEqual(['bun add lodash', 'edit src/index.ts']);
    expect(classifier.calls.map((c) => c.questions.length)).toEqual([1, 1]);
    expect(classifier.calls[0]?.questions[0]).toEqual({
      id: rule.id,
      question: `Does this action violate: ${rule.text}?`,
    });
  });

  test('agreement: deny on the violating example, allow on the clean one', async () => {
    await acceptedClassifierRule();
    const classifier = new FakeClassifier((state, questions) =>
      questions.map((q) => ({
        id: q.id,
        probability: state.startsWith('bun add') ? 0.95 : 0.05,
      })),
    );
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(report.total).toBe(2);
    expect(report.agreed).toBe(2);
    expect(report.disagreed).toBe(0);
    expect(report.errors).toBe(0);
    expect(report.agreement_rate).toBe(1);
    expect(report.rules[0]?.examples.map((e) => [e.band, e.agree])).toEqual([
      ['deny', true],
      ['allow', true],
    ]);
    expect(report.rules[0]?.examples[0]?.probability).toBe(0.95);
    // The report says what 0.8 meant when it ran.
    expect(report.bands).toEqual(BANDS);
  });

  test('a disagreement carries the raw probability that caused it', async () => {
    await acceptedClassifierRule();
    // A confident allow on the example that is *supposed* to violate.
    const classifier = new FakeClassifier((_state, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.1 })),
    );
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect([report.agreed, report.disagreed]).toEqual([1, 1]);
    expect(report.agreement_rate).toBe(0.5);
    const bad = report.rules[0]?.examples[0];
    expect(bad?.expected_band).toBe('deny');
    expect(bad?.band).toBe('allow');
    expect(bad?.agree).toBe(false);
    expect(bad?.probability).toBe(0.1);
    expect(bad).not.toHaveProperty('confidence');
  });

  test('a route is a disagreement — an example has a verdict, not a shrug', async () => {
    await acceptedClassifierRule();
    // The middle band: between allow_below and deny_at routes (D14).
    const classifier = new FakeClassifier((_state, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.6 })),
    );
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(report.rules[0]?.examples.map((e) => e.band)).toEqual(['route', 'route']);
    expect(report.disagreed).toBe(2);
    expect(report.agreed).toBe(0);
  });

  test('an unavailable classifier is an error per example, never a silent agreement', async () => {
    await acceptedClassifierRule();
    const classifier = new FakeClassifier([], {
      throws: new ClassifierUnavailableError('timeout', 'the classifier timed out'),
    });
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(report.errors).toBe(2);
    expect(report.agreed).toBe(0);
    expect(report.agreement_rate).toBeUndefined();
    expect(report.rules[0]?.examples[0]?.error).toContain('timeout');
    expect(report.rules[0]?.examples[0]?.agree).toBe(false);
  });

  test('an answer for a different rule id is no answer for this one', async () => {
    await acceptedClassifierRule();
    const classifier = new FakeClassifier([{ id: 'R-somebody-else', probability: 0.9 }]);
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(report.errors).toBe(2);
    expect(report.rules[0]?.examples[0]?.error).toContain('no answer');
  });

  test('only accepted classifier rules are evaluated', async () => {
    await acceptedClassifierRule('do not add a dependency without asking');
    // A proposed classifier rule, a retired one and a guidance rule.
    await rules.create('human', {
      text: 'a proposed classifier rule',
      enforcement: 'action',
      check: {
        by: 'classifier',
        examples: [
          { action: 'a', violates: true },
          { action: 'b', violates: false },
        ],
      },
    });
    const guidance = await rules.create('human', { text: 'prefer the repo scripts' });
    await rules.accept(guidance.id, 'pete');
    const classifier = new FakeClassifier((_s, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.9 })),
    );
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(report.rules).toHaveLength(1);
    expect(report.rules[0]?.question).toContain('do not add a dependency');
  });

  test('a named rule that is not an accepted classifier rule is refused', async () => {
    const guidance = await rules.create('human', { text: 'prefer the repo scripts' });
    await rules.accept(guidance.id, 'pete');
    const classifier = new FakeClassifier();
    await expect(
      runRuleEvals({ rules, classifier, bands: BANDS, ruleId: guidance.id }),
    ).rejects.toBeInstanceOf(RuleNotEvaluableError);

    const proposed = await rules.create('human', {
      text: 'a proposed classifier rule',
      enforcement: 'action',
      check: {
        by: 'classifier',
        examples: [
          { action: 'a', violates: true },
          { action: 'b', violates: false },
        ],
      },
    });
    await expect(
      runRuleEvals({ rules, classifier, bands: BANDS, ruleId: proposed.id }),
    ).rejects.toThrow(/proposed/);
  });

  test('an eval is not a firing — nothing it does touches stats (§5.7)', async () => {
    const rule = await acceptedClassifierRule();
    const classifier = new FakeClassifier((_s, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.95 })),
    );
    await runRuleEvals({ rules, classifier, bands: BANDS });
    await rules.flushStats();
    expect(rules.get(rule.id).stats).toMatchObject({ fired: 0, violated: 0, routed: 0 });
  });

  test('no accepted classifier rules is an empty report, not an error', async () => {
    const report = await runRuleEvals({
      rules,
      classifier: new FakeClassifier(),
      bands: BANDS,
    });
    expect(report.rules).toEqual([]);
    expect(report.total).toBe(0);
    expect(report.agreement_rate).toBeUndefined();
  });
});

describe('the store refusal this ticket depends on (§5.6)', () => {
  test('a classifier rule with one example cannot be accepted', async () => {
    const thin = await rules.create('human', {
      text: 'do not touch the migration files',
      enforcement: 'action',
      check: {
        by: 'classifier',
        examples: [{ action: 'edit db/migrations/001.sql', violates: true }],
      },
    });
    await expect(rules.accept(thin.id, 'pete')).rejects.toThrow(/at least 2 examples/);
    expect(rules.get(thin.id).status).toBe('proposed');
  });

  test('…and one with two examples can, so the eval always has material', async () => {
    const rule = await acceptedClassifierRule();
    expect(rule.status).toBe('accepted');
    expect(examplesOf(rule)).toHaveLength(2);
  });
});

describe('criteria reach the classifier (T156, D14)', () => {
  test("a rule's criteria ride on the Noul the FakeClassifier is asked", async () => {
    const criteria = { true: 'a new package is added', false: 'no package is added' };
    const created = await rules.create('human', {
      text: 'do not add a dependency without asking',
      enforcement: 'action',
      check: {
        by: 'classifier',
        question: 'Does this action add a dependency?',
        criteria,
        examples: [
          { action: 'bun add lodash', violates: true },
          { action: 'edit src/index.ts', violates: false },
        ],
      },
    });
    await rules.accept(created.id, 'pete');
    const classifier = new FakeClassifier((_s, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.1 })),
    );
    await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(classifier.calls[0]?.questions[0]).toEqual({
      id: created.id,
      question: 'Does this action add a dependency?',
      criteria,
    });
  });

  test('knowledge.update can set criteria, and a half pair is refused (.strict())', async () => {
    const rule = await acceptedClassifierRule();
    const updated = await rules.update('human', rule.id, {
      check: {
        by: 'classifier',
        examples: examplesOf(rule),
        criteria: { true: 'broken', false: 'holds' },
      },
    });
    expect(updated.check).toMatchObject({ criteria: { true: 'broken', false: 'holds' } });
    await expect(
      rules.create('human', {
        text: 'x'.repeat(30),
        enforcement: 'action',
        check: { by: 'classifier', examples: [], criteria: { true: 'only one' } as never },
      }),
    ).rejects.toThrow();
  });
});
