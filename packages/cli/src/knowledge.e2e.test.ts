/**
 * T140/T260 acceptance, end to end: `agile knowledge …` and its `agile
 * rules …` alias against a real in-process daemon over a real unix socket
 * on a temp `AGILE_HOME`. No vendor, no network.
 *
 * The principal split (**D4**) is the point of the accept path: the CLI is
 * the human's edge, so `rules accept` works here — and nothing on this
 * surface can write a rule as an agent.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProjectService } from '@agile-agents/daemon';
import {
  type InboxItem,
  type KnowledgeItem as Rule,
  examplesOf,
  patternOf,
} from '@agile-agents/shared';
import { callRpc } from './client';
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

describe('agile knowledge: the Phase 10 walkthrough syntax (T267)', () => {
  test('add --name --kind --scope repo:<name> --text --enforcement ship --example … --json, then accept', async () => {
    await daemon.store.addRepo('ledger-lite', { path: daemon.repo });
    const added = await cli([
      'knowledge',
      'add',
      '--name',
      'tests-with-changes',
      '--kind',
      'standard',
      '--scope',
      'repo:ledger-lite',
      '--text',
      'Every change to a file under src/ comes with a test that exercises it',
      '--enforcement',
      'ship',
      '--example',
      'diff changes src/ledger.ts and adds no test::true',
      '--example',
      'diff changes src/ledger.ts and test/ledger.test.ts::false',
      '--json',
    ]);
    expect(added.code).toBe(0);
    const item = JSON.parse(added.out) as Rule;
    expect(item.id).toMatch(/^K-/);
    expect(item).toMatchObject({
      name: 'tests-with-changes',
      kind: 'standard',
      scope: { kind: 'repo', repo: 'ledger-lite' },
      enforcement: 'ship',
      status: 'proposed',
      check: {
        by: 'classifier',
        examples: [
          { action: 'diff changes src/ledger.ts and adds no test', violates: true },
          { action: 'diff changes src/ledger.ts and test/ledger.test.ts', violates: false },
        ],
      },
    });
    const accepted = await cli(['knowledge', 'accept', item.id]);
    expect(accepted.code).toBe(0);
    expect(daemon.rulesService.get(item.id).status).toBe('accepted');
    const listed = await cli(['knowledge', 'list']);
    expect(listed.out).toContain('tests-with-changes');
    expect(listed.out).toContain('ship:classifier');
  });

  test('a project-scoped tell decision needs no examples', async () => {
    const project = await new ProjectService(daemon.store, daemon.streamService).create({
      name: 'Shop',
    });
    const added = await cli([
      'knowledge',
      'add',
      '--name',
      'totals-in-cents',
      '--kind',
      'decision',
      '--scope',
      `project:${project.id}`,
      '--text',
      'Totals are printed in integer cents',
      '--enforcement',
      'tell',
      '--json',
    ]);
    expect(added.code).toBe(0);
    const item = JSON.parse(added.out) as Rule;
    expect(item.check).toBeUndefined();
    expect((await cli(['knowledge', 'accept', item.id])).code).toBe(0);
  });
});

describe('agile rules (the alias) against a daemon on a temp AGILE_HOME', () => {
  test('add/list/show/accept/retire round-trips and writes the home file', async () => {
    const rule = await add('prefer the repo scripts over a second toolchain');
    expect(rule.status).toBe('proposed');
    expect(existsSync(join(daemon.home, 'knowledge', `${rule.id}.yaml`))).toBe(true);

    const listed = await cli(['rules', 'list']);
    const lines = listed.out.split('\n');
    expect(lines[0]?.trimEnd().split(/\s{2,}/)).toEqual([
      'id',
      'name',
      'kind',
      'status',
      'enforcement',
      'scope',
      'text',
    ]);
    expect(lines[1]).toContain(rule.id);
    expect(lines[1]).toContain('proposed');
    expect(lines[1]).toContain('global');

    const shown = await cli(['rules', 'show', rule.id]);
    expect(shown.out).toContain('prefer the repo scripts over a second toolchain');
    expect(shown.out).toContain('enforcement  tell');
    // An item added without --name prints `-`.
    expect(shown.out).toContain('name         -');

    const accepted = await cli(['rules', 'accept', rule.id, '--by', 'pete']);
    expect(accepted.code).toBe(0);
    expect(accepted.out).toContain('is accepted');
    expect(daemon.rulesService.get(rule.id).decided_by).toBe('pete');

    const retired = await cli(['rules', 'retire', rule.id]);
    expect(retired.out).toContain('is retired');
    // Retiring is a status change; nothing is deleted (§5.7).
    expect(existsSync(join(daemon.home, 'knowledge', `${rule.id}.yaml`))).toBe(true);
  });

  test('--status and --scope filter the list', async () => {
    const stream = daemon.streamService;
    const s = await stream.create('human', { title: 'parser', goal: 'pick a dialect' });
    const global = await add('a global rule');
    const scoped = await add('a stream rule', ['--scope', `stream:${s.id}`]);
    await cli(['rules', 'accept', global.id]);

    const proposed = await cli(['rules', 'list', '--status', 'proposed', '--json']);
    expect((JSON.parse(proposed.out) as { items: Rule[] }).items.map((r) => r.id)).toEqual([
      scoped.id,
    ]);
    const byScope = await cli(['rules', 'list', '--scope', `stream:${s.id}`, '--json']);
    expect((JSON.parse(byScope.out) as { items: Rule[] }).items.map((r) => r.id)).toEqual([
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
    expect(examplesOf(thin)).toEqual([{ action: 'bun add lodash', violates: true }]);

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
  /** T155: §3.1's edit-then-accept without a raw RPC. */
  describe('agile rules edit', () => {
    test('edits text, question, enforcement, stage and examples, then accepts', async () => {
      const rule = await add('do not add deps');
      const result = await cli([
        'rules',
        'edit',
        rule.id,
        '--text',
        'do not add a dependency without asking',
        '--question',
        'Does this action add a dependency?',
        '--enforcement',
        'classifier',
        '--stage',
        'both',
        '--example',
        'bun add lodash::true',
        '--example',
        'edit src/index.ts::false',
      ]);
      expect(result.code).toBe(0);
      expect(result.out).toContain(`${rule.id} updated`);

      const edited = daemon.rulesService.get(rule.id);
      expect(edited).toMatchObject({
        text: 'do not add a dependency without asking',
        check: { by: 'classifier', question: 'Does this action add a dependency?' },
        // The old `--stage both` maps to action (P6 splits only on migration).
        enforcement: 'action',
        status: 'proposed',
      });
      expect(examplesOf(edited)).toEqual([
        { action: 'bun add lodash', violates: true },
        { action: 'edit src/index.ts', violates: false },
      ]);
      expect((await cli(['rules', 'accept', rule.id])).code).toBe(0);
      expect(daemon.rulesService.get(rule.id).status).toBe('accepted');
    });

    test('--json prints the edited rule', async () => {
      const rule = await add('first wording');
      const result = await cli(['rules', 'edit', rule.id, '--text', 'second wording', '--json']);
      expect(result.code).toBe(0);
      expect((JSON.parse(result.out) as Rule).text).toBe('second wording');
    });

    test('an edit with nothing to change is refused', async () => {
      const rule = await add('unchanged');
      expect((await cli(['rules', 'edit', rule.id])).code).not.toBe(0);
    });
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

    test('agreement exits 0 and prints the raw probability and band per example (no confidence, D14)', async () => {
      await acceptedClassifierRule();
      daemon.classifier.setScript((state, questions) =>
        questions.map((q) => ({
          id: q.id,
          probability: state.startsWith('bun add') ? 0.95 : 0.05,
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
        'band',
        'verdict',
      ]);
      expect(result.out).toContain('bun add lodash');
      expect(result.out).toContain('0.950');
      expect(result.out).toContain('agree');
      expect(result.out).toContain('2 examples · 2 agree');
      expect(result.out).toContain('agreement 100.0%');
      expect(result.out).toContain('bands: deny >= 0.8 · allow < 0.4');
      expect(result.out).not.toContain('confidence');
    });

    test('a disagreement is listed with its numbers and exits non-zero', async () => {
      await acceptedClassifierRule();
      // A confident allow on the example that is supposed to violate.
      daemon.classifier.setScript((_state, questions) =>
        questions.map((q) => ({ id: q.id, probability: 0.12 })),
      );
      const result = await cli(['rules', 'test']);
      expect(result.code).toBe(1);
      expect(result.out).toContain('DISAGREE');
      expect(result.out).toContain('0.120');
      expect(result.out).toContain('1 agree · 1 disagree');
      expect(result.out).toContain('agreement 50.0%');
    });

    test('--json carries the same verdicts, and the exit code with them', async () => {
      const rule = await acceptedClassifierRule();
      daemon.classifier.setScript((_state, questions) =>
        questions.map((q) => ({ id: q.id, probability: 0.6 })),
      );
      const result = await cli(['rules', 'test', rule.id, '--json']);
      // The middle band routes, which is not the verdict either example claims.
      expect(result.code).toBe(1);
      const report = JSON.parse(result.out) as {
        rules: Array<{
          id: string;
          question: string;
          examples: Array<{
            band: string;
            agree: boolean;
            probability: number;
          }>;
        }>;
        disagreed: number;
      };
      expect(report.rules.map((r) => r.id)).toEqual([rule.id]);
      expect(report.rules[0]?.question).toBe(
        'Does this action violate: do not add a dependency without asking?',
      );
      expect(report.rules[0]?.examples.map((e) => [e.band, e.agree, e.probability])).toEqual([
        ['route', false, 0.6],
        ['route', false, 0.6],
      ]);
      expect(report.disagreed).toBe(2);
    });

    test('no accepted classifier rules is an empty report, exit 0', async () => {
      const result = await cli(['rules', 'test']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('no accepted classifier checks');
    });

    test('a run slower than the default 5 s RPC deadline still finishes (T155)', async () => {
      await acceptedClassifierRule();
      await add('do not log secrets', [
        '--enforcement',
        'classifier',
        '--example',
        'console.log(apiKey)::true',
        '--example',
        'console.log(count)::false',
      ]).then((rule) => cli(['rules', 'accept', rule.id]));
      // Four calls at 1.5 s each: 6 s in total, past the old 5 s deadline.
      daemon.classifier.setScript(
        (state, questions) =>
          questions.map((q) => ({
            id: q.id,
            probability: state.startsWith('bun add') || state.includes('apiKey') ? 0.95 : 0.05,
          })),
        { delayMs: 1_500 },
      );
      const result = await cli(['rules', 'test']);
      expect(result.code).toBe(0);
      expect(result.out).toContain('4 examples · 4 agree');
    }, 20_000);

    test('every eval call leaves a classifier_call event (T155, §6.2)', async () => {
      const rule = await acceptedClassifierRule();
      daemon.classifier.setScript((state, questions) =>
        questions.map((q) => ({
          id: q.id,
          probability: state.startsWith('bun add') ? 0.95 : 0.05,
        })),
      );
      await cli(['rules', 'test']);
      const calls = daemon.store.listEvents().filter((e) => e.kind === 'classifier_call');
      expect(calls).toHaveLength(2);
      expect(calls.map((e) => e.data.source)).toEqual(['eval', 'eval']);
      expect(calls.map((e) => e.data.rule)).toEqual([rule.id, rule.id]);
      expect(calls.map((e) => e.data.outcome)).toEqual(['deny', 'allow']);
      for (const e of calls) expect(typeof e.data.latency_ms).toBe('number');
    });

    test('a failed eval call is still an event, with its error', async () => {
      await acceptedClassifierRule();
      // Unscripted: the fake answers nothing for the rule.
      daemon.classifier.setScript([]);
      await cli(['rules', 'test']);
      const calls = daemon.store.listEvents().filter((e) => e.kind === 'classifier_call');
      expect(calls).toHaveLength(2);
      expect(calls[0]?.data.error).toContain('no answer');
      expect(calls[0]?.data.outcome).toBeUndefined();
    });

    test('an eval is not a firing: stats stay at zero (§5.7)', async () => {
      const rule = await acceptedClassifierRule();
      daemon.classifier.setScript((_state, questions) =>
        questions.map((q) => ({ id: q.id, probability: 0.95 })),
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

  test('T167: a command_deny rule added and accepted from the CLI denies `rm -rf dist`, naming the rule', async () => {
    const rule = await add('never delete build output wholesale', [
      '--enforcement',
      'pattern',
      '--pattern',
      'command_deny',
      '--pattern-arg',
      'rm -rf',
      '--pattern-arg',
      'git reset --hard',
    ]);
    expect(patternOf(rule)).toEqual({
      kind: 'command_deny',
      args: { patterns: ['rm -rf', 'git reset --hard'] },
    });
    const shown = await cli(['rules', 'show', rule.id]);
    expect(shown.out).toContain('check        pattern command_deny: "rm -rf", "git reset --hard"');
    expect((await cli(['rules', 'accept', rule.id])).code).toBe(0);

    const stream = await daemon.streamService.create('human', { title: 'x', goal: 'y' });
    await daemon.store.putAgent('worker-t167', {
      vendor: 'claude',
      model: 'claude-sonnet-4-5',
      stream: stream.id,
      pid: 4242,
      role: 'worker',
      worktree: daemon.repo,
      last_seen: new Date().toISOString(),
    });
    const payload = (command: string) => ({
      cwd: daemon.repo,
      session_id: 'worker-t167',
      agile_agent: 'worker-t167',
      tool_name: 'Bash',
      tool_input: { command },
    });
    type HookOut = {
      hookSpecificOutput: { permissionDecision: string; permissionDecisionReason?: string };
    };
    const denied = await callRpc<HookOut>(
      daemon.socketPath,
      'hook.pre_tool_use',
      payload('rm -rf dist'),
    );
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain(rule.id);
    const allowed = await callRpc<HookOut>(
      daemon.socketPath,
      'hook.pre_tool_use',
      payload('ls dist'),
    );
    expect(allowed.hookSpecificOutput.permissionDecision).toBe('allow');
  });

  test('T167: --enforcement pattern without --pattern is refused; bad pattern args are refused', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(String(msg));
    try {
      expect(
        await runCli(['rules', 'add', '--text', 'x', '--enforcement', 'pattern'], daemon.repo),
      ).toBe(1);
      expect(errors.join('\n')).toContain('a pattern rule needs a pattern');
      expect(
        await runCli(
          ['rules', 'add', '--text', 'x', '--pattern', 'no_push', '--pattern-arg', 'a'],
          daemon.repo,
        ),
      ).toBe(1);
      expect(errors.join('\n')).toContain('takes no arguments');
      expect(await runCli(['rules', 'add', '--text', 'x', '--pattern', 'nope'], daemon.repo)).toBe(
        1,
      );
      expect(errors.join('\n')).toContain('invalid pattern kind');
    } finally {
      console.error = original;
    }
    // The store refuses a pattern on a ship item, for a caller that skips the CLI.
    const refused = await callRpc(daemon.socketPath, 'knowledge.create', {
      text: 'x',
      enforcement: 'ship',
      check: { by: 'pattern', pattern: { kind: 'no_push', args: {} } },
    }).then(
      () => 'created',
      (err: unknown) => String(err instanceof Error ? err.message : err),
    );
    expect(refused).toContain('a pattern check is an action check only');
  });

  test('T167: rules edit sets a pattern', async () => {
    const rule = await add('no secrets dir');
    const edited = await cli([
      'rules',
      'edit',
      rule.id,
      '--enforcement',
      'pattern',
      '--pattern',
      'path_deny',
      '--pattern-arg',
      'secrets/**',
      '--json',
    ]);
    expect(edited.code).toBe(0);
    expect(patternOf(JSON.parse(edited.out) as Rule)).toEqual({
      kind: 'path_deny',
      args: { globs: ['secrets/**'] },
    });
  });
});
