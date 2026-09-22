/**
 * T152: diff-level rules at landing (design/cockpit-design.md §8.2), over a
 * real state home, real `RulesService`/`GateService`/`StreamService` and
 * the `FakeClassifier` — §6.2's "the only classifier the suite ever uses".
 * No git here: the tier is handed a `DiffRuleContext` whose `diff()` is the
 * fixture, so the bands, the budget split and the fail policy are asserted
 * without a merge in the way. `service.test.ts` covers what a verdict does
 * to an actual land.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Rule, Stream } from '@agile-agents/shared';
import { ClassifierUnavailableError, FakeClassifier } from '../classifier';
import { GateService } from '../gates/service';
import { runInit } from '../init';
import { RulesService } from '../rules/service';
import { StateStore } from '../store';
import { StreamService } from '../streams/service';
import { ClassifierDiffRules, splitDiffByFile } from './diff-rules';
import type { DiffRuleContext } from './service';

let home: string;
let store: StateStore;
let streams: StreamService;
let rules: RulesService;
let gates: GateService;
let stream: Stream;

const ENV = { TYPESAFE_API_KEY: 'test-key' };

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'agile-diff-rules-'));
  const init = runInit(home);
  store = StateStore.open(init.stateRoot);
  streams = new StreamService(store);
  rules = new RulesService({ store, streams, statsFlushMs: 0 });
  gates = new GateService(store);
  await store.putRepos({ demo: { path: home, protected_branches: ['main'] } });
  stream = await streams.create('human', { title: 'CSV parser', goal: 'ship it', repo: 'demo' });
});

afterEach(async () => {
  await rules.flushStats();
  await store.flush();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

/** An accepted classifier rule at the given stage. */
async function acceptRule(
  text: string,
  over: { stage?: 'action' | 'diff' | 'both'; critical?: boolean } = {},
): Promise<Rule> {
  const proposed = await rules.create('human', {
    text,
    enforcement: 'classifier',
    stage: over.stage ?? 'diff',
    critical: over.critical ?? false,
    examples: [
      { action: 'a violating change', violates: true },
      { action: 'an innocent change', violates: false },
    ],
  });
  return rules.accept(proposed.id, 'pete');
}

const FILE_A = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-const a = 1;
+const a = 2;
`;
const FILE_B = `diff --git a/b.ts b/b.ts
--- a/b.ts
+++ b/b.ts
@@ -1 +1 @@
-const b = 1;
+const b = 2;
`;

function contextFor(diff: string): DiffRuleContext {
  return {
    stream,
    repoRoot: home,
    branch: 'T1-work',
    target: 'main',
    diff: () => diff,
  };
}

function tier(
  classifier: FakeClassifier,
  over: { stateMaxChars?: number; gates?: GateService | undefined } = {},
): ClassifierDiffRules {
  const gateService = over.gates === undefined ? gates : over.gates;
  return new ClassifierDiffRules({
    rules,
    classifier,
    config: {
      provider: 'jev',
      base_url: 'https://api.typesafe.ai',
      timeout_ms: 25_000,
      state_max_chars: over.stateMaxChars ?? 60_000,
      bands: { deny_at: 0.8, allow_below: 0.4, confidence_floor: 0.5 },
    },
    streams,
    policy: () => store.getPolicy(),
    repos: () => store.getRepos(),
    ...(gateService !== undefined ? { gates: gateService } : {}),
    env: ENV,
  });
}

function threadBodies(): string[] {
  return streams.readThread(stream.id, { limit: 500 }).entries.map((entry) => entry.body);
}

describe('ClassifierDiffRules (§8.2)', () => {
  test('a high-probability answer denies the land, naming the rule', async () => {
    const rule = await acceptRule('do not leave a TODO in shipped code');
    const classifier = new FakeClassifier([{ id: rule.id, probability: 0.95, confidence: 0.9 }]);

    const verdict = await tier(classifier).check(contextFor(FILE_A));

    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'allow') throw new Error('unreachable');
    expect(verdict.rule).toBe(rule.id);
    expect(verdict.reason).toContain('do not leave a TODO in shipped code');
    expect(rules.get(rule.id).stats).toMatchObject({ fired: 1, violated: 1, routed: 0 });
    // One call, N questions (§6.2), with the scrubbed diff as the state.
    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0]?.state).toContain('const a = 2;');
    expect(classifier.calls[0]?.questions).toHaveLength(1);
  });

  test('a low-probability answer allows the land', async () => {
    const rule = await acceptRule('do not broaden the public API');
    const classifier = new FakeClassifier([{ id: rule.id, probability: 0.05, confidence: 0.9 }]);

    expect(await tier(classifier).check(contextFor(FILE_A))).toEqual({ decision: 'allow' });
    expect(rules.get(rule.id).stats).toMatchObject({ fired: 1, violated: 0, routed: 0 });
  });

  test('a middle-band answer routes: a classifier_review gate, and landing waits', async () => {
    const rule = await acceptRule('do not add a dependency without asking');
    const classifier = new FakeClassifier([{ id: rule.id, probability: 0.6, confidence: 0.9 }]);
    const subject = tier(classifier);

    const verdict = await subject.check(contextFor(FILE_A));

    expect(verdict.decision).toBe('route');
    if (verdict.decision === 'allow') throw new Error('unreachable');
    const gate = verdict.gate;
    expect(gate?.gate).toBe('classifier_review');
    expect(gate?.stream).toBe(stream.id);
    expect(gate?.call?.tool).toBe('land');
    expect(rules.get(rule.id).stats).toMatchObject({ fired: 1, routed: 1 });

    // Pressing Land again while the card is open reuses it rather than
    // raising a second one (§3.3 "empty is the goal state").
    const again = await subject.check(contextFor(FILE_A));
    expect(again.decision).toBe('route');
    expect(gates.list().filter((g) => g.gate === 'classifier_review')).toHaveLength(1);
    expect(classifier.calls).toHaveLength(1);

    // Approving it lets the next land through, once.
    await gates.respond(gate?.id ?? '', 'approve', 'pete');
    expect(await subject.check(contextFor(FILE_A))).toEqual({ decision: 'allow' });
  });

  test('a routed gate answered "deny" keeps refusing that diff', async () => {
    const rule = await acceptRule('do not touch the migration files');
    const classifier = new FakeClassifier([{ id: rule.id, probability: 0.6, confidence: 0.9 }]);
    const subject = tier(classifier);
    const routed = await subject.check(contextFor(FILE_A));
    if (routed.decision === 'allow') throw new Error('unreachable');

    await gates.respond(routed.gate?.id ?? '', 'deny', 'pete', 'not this way');

    const verdict = await subject.check(contextFor(FILE_A));
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'allow') throw new Error('unreachable');
    expect(verdict.reason).toContain('not this way');
  });

  test('over the budget the diff is split per file and the MAX is taken', async () => {
    const rule = await acceptRule('one bad file makes the whole diff bad');
    const perFile = new FakeClassifier((state) => [
      { id: rule.id, probability: state.includes('b.ts') ? 0.95 : 0.01, confidence: 0.9 },
    ]);

    const verdict = await tier(perFile, { stateMaxChars: 200 }).check(contextFor(FILE_A + FILE_B));

    // Two calls, one per file, and the 0.95 from b.ts wins over a.ts's 0.01.
    expect(perFile.calls).toHaveLength(2);
    expect(perFile.calls[0]?.state).toContain('a.ts');
    expect(perFile.calls[0]?.state).not.toContain('b.ts');
    expect(perFile.calls[1]?.state).toContain('b.ts');
    expect(verdict.decision).toBe('deny');
    if (verdict.decision === 'allow') throw new Error('unreachable');
    expect(verdict.reason).toContain('0.95');
  });

  test('a diff inside the budget is one call, whole', async () => {
    const rule = await acceptRule('inside the budget');
    const classifier = new FakeClassifier([{ id: rule.id, probability: 0.1, confidence: 0.9 }]);

    await tier(classifier).check(contextFor(FILE_A + FILE_B));

    expect(classifier.calls).toHaveLength(1);
    expect(classifier.calls[0]?.state).toContain('a.ts');
    expect(classifier.calls[0]?.state).toContain('b.ts');
  });

  test('only accepted classifier rules staged diff/both are asked (§5.3, one scope filter)', async () => {
    const diffRule = await acceptRule('checked at the diff', { stage: 'diff' });
    const bothRule = await acceptRule('checked at both', { stage: 'both' });
    await acceptRule('checked per action', { stage: 'action' });
    const proposed = await rules.create('human', {
      text: 'not accepted yet',
      enforcement: 'classifier',
      stage: 'diff',
      examples: [
        { action: 'x', violates: true },
        { action: 'y', violates: false },
      ],
    });
    const classifier = new FakeClassifier((_state, questions) =>
      questions.map((q) => ({ id: q.id, probability: 0.1, confidence: 0.9 })),
    );

    await tier(classifier).check(contextFor(FILE_A));

    const asked = (classifier.calls[0]?.questions ?? []).map((q) => q.id).sort();
    expect(asked).toEqual([diffRule.id, bothRule.id].sort());
    expect(asked).not.toContain(proposed.id);
  });

  test('no diff rules in scope is no call at all', async () => {
    await acceptRule('per action only', { stage: 'action' });
    const classifier = new FakeClassifier([]);

    expect(await tier(classifier).check(contextFor(FILE_A))).toEqual({ decision: 'allow' });
    expect(classifier.calls).toHaveLength(0);
  });

  describe('§6.4 fail policy', () => {
    test('a critical rule denies when the classifier is unavailable', async () => {
      const critical = await acceptRule('never ship a secret', { critical: true });
      const classifier = new FakeClassifier([], {
        throws: new ClassifierUnavailableError('timeout', 'api.typesafe.ai timed out'),
      });

      const verdict = await tier(classifier).check(contextFor(FILE_A));

      expect(verdict.decision).toBe('deny');
      if (verdict.decision === 'allow') throw new Error('unreachable');
      expect(verdict.reason).toContain(critical.id);
      expect(rules.get(critical.id).stats).toMatchObject({ violated: 1 });
    });

    test('a non-critical rule proceeds with a hook_unchecked thread entry', async () => {
      const rule = await acceptRule('a nice-to-have');
      const classifier = new FakeClassifier([], {
        throws: new ClassifierUnavailableError('timeout', 'api.typesafe.ai timed out'),
      });

      expect(await tier(classifier).check(contextFor(FILE_A))).toEqual({ decision: 'allow' });
      expect(threadBodies().some((body) => body.startsWith('hook_unchecked:'))).toBe(true);
      expect(rules.get(rule.id).stats).toMatchObject({ fired: 1, violated: 0 });
    });

    test('the per-stream opt-out is the same policy, with no call made', async () => {
      await acceptRule('a nice-to-have');
      await streams.update('human', stream.id, { classifier: 'off' });
      stream = streams.get(stream.id);
      const classifier = new FakeClassifier([]);

      expect(await tier(classifier).check(contextFor(FILE_A))).toEqual({ decision: 'allow' });
      expect(classifier.calls).toHaveLength(0);
      expect(threadBodies().some((body) => body.startsWith('hook_unchecked:'))).toBe(true);
    });
  });
});

describe('splitDiffByFile', () => {
  test('one section per file, nothing dropped', () => {
    const parts = splitDiffByFile(FILE_A + FILE_B);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain('a/a.ts');
    expect(parts[1]).toContain('a/b.ts');
    expect(parts.join('\n')).toContain('+const b = 2;');
  });

  test('a fragment with no header is still one part', () => {
    expect(splitDiffByFile('@@ -1 +1 @@\n-x\n+y\n')).toHaveLength(1);
  });
});
