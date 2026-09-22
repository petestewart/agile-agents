/**
 * T140 acceptance, end to end: `agile rules add|list|show|accept|retire|
 * seed` against a real in-process daemon over a real unix socket on a temp
 * `AGILE_HOME`. No vendor, no network.
 *
 * The principal split (**D4**) is the point of the accept path: the CLI is
 * the human's edge, so `rules accept` works here — and nothing on this
 * surface can write a rule as an agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InboxItem, Rule } from '@agile-agents/shared';
import { runCli } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

let daemon: TestDaemon;

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(String(msg));
  try {
    const code = await runCli(argv, daemon.repo);
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

async function add(text: string, extra: string[] = []): Promise<Rule> {
  const result = await cli(['rules', 'add', '--text', text, ...extra, '--json']);
  expect(result.code).toBe(0);
  return JSON.parse(result.out) as Rule;
}

beforeEach(async () => {
  daemon = await startTestDaemon('agile-rules-e2e-');
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('agile rules against a daemon on a temp AGILE_HOME', () => {
  test('add/list/show/accept/retire round-trips and writes the home file', async () => {
    const rule = await add('prefer the repo scripts over a second toolchain');
    expect(rule.status).toBe('proposed');
    expect(existsSync(join(daemon.home, 'rules', `${rule.id}.yaml`))).toBe(true);

    const listed = await cli(['rules', 'list']);
    const lines = listed.out.split('\n');
    expect(lines[0]?.trimEnd().split(/\s{2,}/)).toEqual([
      'id',
      'name',
      'status',
      'tier',
      'scope',
      'text',
    ]);
    expect(lines[1]).toContain(rule.id);
    expect(lines[1]).toContain('proposed');
    expect(lines[1]).toContain('global');

    const shown = await cli(['rules', 'show', rule.id]);
    expect(shown.out).toContain('prefer the repo scripts over a second toolchain');
    expect(shown.out).toContain('enforcement  guidance');
    // T145: only a built-in has a name; a rule a human wrote prints `-`.
    expect(shown.out).toContain('name         -');

    const accepted = await cli(['rules', 'accept', rule.id, '--by', 'pete']);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('is accepted');
    expect(daemon.rulesService.get(rule.id).decided_by).toBe('pete');

    const retired = await cli(['rules', 'retire', rule.id]);
    expect(retired.out).toContain('is retired');
    // Retiring is a status change; nothing is deleted (§5.7).
    expect(existsSync(join(daemon.home, 'rules', `${rule.id}.yaml`))).toBe(true);
  });

  test('--status and --scope filter the list', async () => {
    const stream = daemon.streamService;
    const s = await stream.create('human', { title: 'parser', goal: 'pick a dialect' });
    const global = await add('a global rule');
    const scoped = await add('a stream rule', ['--scope', `stream:${s.id}`]);
    await cli(['rules', 'accept', global.id]);

    const proposed = await cli(['rules', 'list', '--status', 'proposed', '--json']);
    expect((JSON.parse(proposed.out) as { rules: Rule[] }).rules.map((r) => r.id)).toEqual([
      scoped.id,
    ]);
    const byScope = await cli(['rules', 'list', '--scope', `stream:${s.id}`, '--json']);
    expect((JSON.parse(byScope.out) as { rules: Rule[] }).rules.map((r) => r.id)).toEqual([
      scoped.id,
    ]);
  });

  test('a classifier rule needs two examples before it can be accepted (§5.6)', async () => {
    const thin = await add('do not add a dependency without asking', [
      '--enforcement',
      'classifier',
      '--critical',
      '--example',
      'bun add lodash::true',
    ]);
    expect(thin.critical).toBe(true);
    expect(thin.examples).toEqual([{ action: 'bun add lodash', violates: true }]);

    const errors: string[] = [];
    const originalError = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(await runCli(['rules', 'accept', thin.id], daemon.repo)).toBe(1);
    } finally {
      console.error = originalError;
    }
    expect(errors.join('\n')).toContain('at least 2 examples');
    expect(daemon.rulesService.get(thin.id).status).toBe('proposed');
  });

  test('a proposed rule is a rule_accept inbox item, and accepting clears it', async () => {
    const rule = await add('a global rule');
    const inbox = await cli(['inbox', '--json']);
    const items = (JSON.parse(inbox.out) as { items: InboxItem[] }).items;
    expect(items.map((i) => [i.kind, i.id])).toEqual([['rule_accept', rule.id]]);
    await cli(['rules', 'accept', rule.id]);
    expect(
      (JSON.parse((await cli(['inbox', '--json'])).out) as { items: InboxItem[] }).items,
    ).toEqual([]);
  });

  test('seed imports a PLAN-v1 §9 decision log once, and is idempotent', async () => {
    const plan = join(daemon.repo, 'PLAN-v1.md');
    writeFileSync(
      plan,
      [
        '## 9. Discovered Issues Log',
        '',
        '- 2026-09-08 — T002 FAIL. Decision: all shared schemas are `.strict()` so the store rejects unknown keys.',
        '- 2026-09-09 — T005 merged. Decisions (manager, yolo): (1) every store mutation emits exactly one events.jsonl line; (2) hooks enforce and prompts express intent.',
        '',
      ].join('\n'),
    );

    const first = await cli(['rules', 'seed', '--from', plan, '--json']);
    expect(first.code).toBe(0);
    const firstResult = JSON.parse(first.out) as { created: string[]; skipped: number };
    expect(firstResult.created).toHaveLength(3);
    expect(firstResult.skipped).toBe(0);

    const seeded = daemon.rulesService.list();
    expect(seeded).toHaveLength(3);
    for (const rule of seeded) {
      expect(rule.status).toBe('proposed');
      expect(rule.enforcement).toBe('guidance');
      expect(rule.scope).toEqual({ kind: 'global' });
      expect(rule.provenance).toEqual({ by: 'seed:PLAN-v1' });
    }

    const second = await cli(['rules', 'seed', '--from', plan, '--json']);
    const secondResult = JSON.parse(second.out) as { created: string[]; skipped: number };
    expect(secondResult.created).toEqual([]);
    expect(secondResult.skipped).toBe(3);
    expect(daemon.rulesService.list()).toHaveLength(3);
  });

  test('an accepted rule in scope reaches a session brief; a proposed one does not', async () => {
    const stream = await daemon.streamService.create('human', {
      title: 'parser',
      goal: 'pick a dialect',
    });
    const accepted = await add('always run the integration suite');
    await cli(['rules', 'accept', accepted.id]);
    await add('not yet accepted');

    expect(daemon.rulesService.inScope(stream.id).map((r) => r.text)).toEqual([
      'always run the integration suite',
    ]);
  });
  /**
   * T153 (§5.6): "examples as evals". The same path the live check runs,
   * proven offline through `FakeClassifier` — the CLI never reaches the
   * network and there is no key in this suite.
   */
  describe('agile rules test', () => {
    async function acceptedClassifierRule(): Promise<Rule> {
      const rule = await add('do not add a dependency without asking', [
        '--enforcement',
        'classifier',
        '--example',
        'bun add lodash::true',
        '--example',
        'edit src/index.ts::false',
      ]);
      await cli(['rules', 'accept', rule.id]);
      return rule;
    }

    test('agreement exits 0 and prints probability, confidence and band per example', async () => {
      await acceptedClassifierRule();
      daemon.classifier.setScript((state, questions) =>
        questions.map((q) => ({
          id: q.id,
          probability: state.startsWith('bun add') ? 0.95 : 0.05,
          confidence: 0.91,
        })),
      );
      const result = await cli(['rules', 'test']);
      expect(result.code).toBe(0);
      const lines = result.out.split('\n');
      expect(lines[0]?.trimEnd().split(/\s{2,}/)).toEqual([
        'rule',
        'example',
        'expected',
        'probability',
        'confidence',
        'band',
        'verdict',
      ]);
      expect(result.out).toContain('bun add lodash');
      expect(result.out).toContain('0.950');
      // The confidence is printed on every row, agreement or not: it is the
      // evidence the confidence-floor question needs from the live run.
      expect(result.out).toContain('0.910');
      expect(result.out).toContain('agree');
      expect(result.out).toContain('2 examples · 2 agree');
      expect(result.out).toContain('agreement 100.0%');
      expect(result.out).toContain('confidence floor 0.5');
    });

    test('a disagreement is listed with its numbers and exits non-zero', async () => {
      await acceptedClassifierRule();
      // A confident allow on the example that is supposed to violate.
      daemon.classifier.setScript((_state, questions) =>
        questions.map((q) => ({ id: q.id, probability: 0.12, confidence: 0.88 })),
      );
      const result = await cli(['rules', 'test']);
      expect(result.code).toBe(1);
      expect(result.out).toContain('DISAGREE');
      expect(result.out).toContain('0.120');
      expect(result.out).toContain('0.880');
      expect(result.out).toContain('1 agree · 1 disagree');
      expect(result.out).toContain('agreement 50.0%');
    });

    test('--json carries the same verdicts, and the exit code with them', async () => {
      const rule = await acceptedClassifierRule();
      daemon.classifier.setScript((_state, questions) =>
        questions.map((q) => ({ id: q.id, probability: 0.95, confidence: 0.2 })),
      );
      const result = await cli(['rules', 'test', rule.id, '--json']);
      // Below the confidence floor: §6.3 routes it, which is not the
      // verdict either example claims.
      expect(result.code).toBe(1);
      const report = JSON.parse(result.out) as {
        rules: Array<{
          id: string;
          question: string;
          examples: Array<{
            band: string;
            agree: boolean;
            probability: number;
            confidence: number;
          }>;
        }>;
        disagreed: number;
      };
      expect(report.rules.map((r) => r.id)).toEqual([rule.id]);
      expect(report.rules[0]?.question).toBe(
        'Does this action violate: do not add a dependency without asking?',
      );
      expect(report.rules[0]?.examples.map((e) => [e.band, e.agree, e.confidence])).toEqual([
        ['route', false, 0.2],
        ['route', false, 0.2],
      ]);
      expect(report.disagreed).toBe(2);
    });

    test('no accepted classifier rules is an empty report, exit 0', async () => {
      const result = await cli(['rules', 'test']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('no accepted classifier rules');
    });

    test('an eval is not a firing: stats stay at zero (§5.7)', async () => {
      const rule = await acceptedClassifierRule();
      daemon.classifier.setScript((_state, questions) =>
        questions.map((q) => ({ id: q.id, probability: 0.95, confidence: 0.9 })),
      );
      await cli(['rules', 'test']);
      await daemon.rulesService.flushStats();
      expect(daemon.rulesService.get(rule.id).stats).toMatchObject({
        fired: 0,
        violated: 0,
        routed: 0,
      });
    });
  });
});
