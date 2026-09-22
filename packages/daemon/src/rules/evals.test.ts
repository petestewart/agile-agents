/**
 * T153 (§5.6): a rule's examples are its evals. Everything here runs
 * through `FakeClassifier` — the suite never reaches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  type ClassifierBands,
  DEFAULT_CLASSIFIER_ALLOW_BELOW,
  DEFAULT_CLASSIFIER_DENY_AT,
  type Rule,
} from '@agile-agents/shared';
import { ClassifierUnavailableError, FakeClassifier } from '../classifier';
import { runInit } from '../init';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { RuleNotEvaluableError, runRuleEvals } from './evals';
import { parsePlanV1Decisions, seedClassifierWording, seedProposal } from './seed-plan-v1';
import { RulesService } from './service';

const BANDS: ClassifierBands = {
  deny_at: DEFAULT_CLASSIFIER_DENY_AT,
  allow_below: DEFAULT_CLASSIFIER_ALLOW_BELOW,
};

let home: string;
let rules: RulesService;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agile-rule-evals-'));
  const init = runInit(home);
  const store = StateStore.open(init.stateRoot);
  rules = new RulesService({ store, streams: new StreamService(store) });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** An accepted classifier rule with one violating and one clean example. */
async function acceptedClassifierRule(
  text = 'do not add a dependency without asking',
): Promise<Rule> {
  const rule = await rules.create('human', {
    text,
    enforcement: 'classifier',
    examples: [
      { action: 'bun add lodash', violates: true },
      { action: 'edit src/index.ts', violates: false },
    ],
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
      enforcement: 'classifier',
      examples: [
        { action: 'a', violates: true },
        { action: 'b', violates: false },
      ],
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
      enforcement: 'classifier',
      examples: [
        { action: 'a', violates: true },
        { action: 'b', violates: false },
      ],
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
      enforcement: 'classifier',
      examples: [{ action: 'edit db/migrations/001.sql', violates: true }],
    });
    await expect(rules.accept(thin.id, 'pete')).rejects.toThrow(/at least 2 examples/);
    expect(rules.get(thin.id).status).toBe('proposed');
  });

  test('…and one with two examples can, so the eval always has material', async () => {
    const rule = await acceptedClassifierRule();
    expect(rule.status).toBe('accepted');
    expect(rule.examples).toHaveLength(2);
  });
});

describe('criteria reach the classifier (T156, D14)', () => {
  test("a rule's criteria ride on the Noul the FakeClassifier is asked", async () => {
    const criteria = { true: 'a new package is added', false: 'no package is added' };
    const created = await rules.create('human', {
      text: 'do not add a dependency without asking',
      question: 'Does this action add a dependency?',
      criteria,
      enforcement: 'classifier',
      examples: [
        { action: 'bun add lodash', violates: true },
        { action: 'edit src/index.ts', violates: false },
      ],
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

  test('rule.update can set criteria, and a half pair is refused (.strict())', async () => {
    const rule = await acceptedClassifierRule();
    const updated = await rules.update('human', rule.id, {
      criteria: { true: 'broken', false: 'holds' },
    });
    expect(updated.criteria).toEqual({ true: 'broken', false: 'holds' });
    await expect(
      rules.create('human', { text: 'x'.repeat(30), criteria: { true: 'only one' } }),
    ).rejects.toThrow();
  });
});

/**
 * T156 (3): the two seeded rules the Phase 5 agreement check found too thin
 * (…GR77MM, …8CMD5B), rewritten as one yes/no question each (yes = broken)
 * with criteria, and evaluated over the examples recorded in that run
 * (PLAN T154 note). The classifier is the FakeClassifier: this proves the
 * rewritten wording is what gets asked and that the examples band per their
 * labels on a clear answer; the real agreement is a live check.
 */
describe('the rewritten seeded rules (T156)', () => {
  const planV1 = readFileSync(resolve(import.meta.dir, '../../../../PLAN-v1.md'), 'utf8');
  const seeded = parsePlanV1Decisions(planV1);

  const RECORDED: Record<string, Array<{ action: string; violates: boolean }>> = {
    browser: [
      {
        action: "diff --git a/packages/daemon/src/http.ts\n+  const actor = body.actor ?? 'human';",
        violates: true,
      },
      {
        action: "diff --git a/packages/daemon/src/http.ts\n+  const actor = 'human';",
        violates: false,
      },
    ],
    strict: [
      {
        action:
          'diff --git a/packages/shared/src/thing.ts\n+export const ThingSchema = z.object({ id: z.string() });',
        violates: true,
      },
      {
        action:
          'diff --git a/packages/shared/src/thing.ts\n+export const ThingSchema = z.object({ id: z.string() }).strict();',
        violates: false,
      },
      {
        action:
          'diff --git a/packages/shared/src/thing.ts\n+  // free-form by design\n+  data: z.record(z.string(), z.unknown()),',
        violates: false,
      },
    ],
  };

  test('both seeded sentences exist in PLAN-v1 and seed with their rewritten wording', () => {
    const browser = seeded.find((t) => t.startsWith('browser writes are always actor'));
    const strict = seeded.find((t) => t.startsWith('all shared schemas are `.strict()`'));
    expect(browser).toBeDefined();
    expect(strict).toBeDefined();
    for (const text of [browser as string, strict as string]) {
      const proposal = seedProposal(text);
      expect(proposal.question).toMatch(/^Does this change /);
      expect(proposal.criteria?.true.length).toBeGreaterThan(0);
      expect(proposal.criteria?.false.length).toBeGreaterThan(0);
    }
    // Every other seeded sentence keeps §5.1's default question.
    expect(seeded.filter((t) => seedClassifierWording(t) !== undefined)).toHaveLength(2);
  });

  test('evaluated over the recorded examples, the rewritten question and criteria are asked', async () => {
    const ids: Record<string, string> = {};
    for (const [key, prefix] of [
      ['browser', 'browser writes are always actor'],
      ['strict', 'all shared schemas are `.strict()`'],
    ] as const) {
      const text = seeded.find((t) => t.startsWith(prefix)) as string;
      const proposal = seedProposal(text);
      const rule = await rules.create('human', {
        ...proposal,
        enforcement: 'classifier',
        stage: 'diff',
        examples: RECORDED[key],
      });
      ids[key] = rule.id;
      await rules.accept(rule.id, 'pete');
    }
    const byAction = new Map(
      Object.values(RECORDED)
        .flat()
        .map((e) => [e.action, e.violates ? 0.9 : 0.1]),
    );
    const classifier = new FakeClassifier((state, questions) =>
      questions.map((q) => ({ id: q.id, probability: byAction.get(state) ?? 0.5 })),
    );
    const report = await runRuleEvals({ rules, classifier, bands: BANDS });
    expect(report.total).toBe(5);
    expect(report.agreed).toBe(5);
    for (const call of classifier.calls) {
      const noul = call.questions[0];
      const wording = seedClassifierWording(rules.get(noul?.id as string).text);
      expect(noul?.question).toBe(wording?.question as string);
      expect(noul?.criteria).toEqual(wording?.criteria);
    }
    expect(new Set(classifier.calls.map((c) => c.questions[0]?.id))).toEqual(
      new Set([ids.browser, ids.strict]),
    );
  });
});
