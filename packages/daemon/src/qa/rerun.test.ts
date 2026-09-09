import { describe, expect, test } from 'bun:test';
import type { TestRunOutput } from '../tools/test-run';
import type { RunTestRunFn } from './rerun';
import { runCriterionWithRerun } from './rerun';

function output(overrides: Partial<TestRunOutput> = {}): TestRunOutput {
  return {
    ok: true,
    failures: [],
    summary: 'tests passed',
    exit_code: 0,
    raw_output: 'test_run/x.log',
    total_failures: 0,
    ...overrides,
  };
}

function scriptedRunner(outputs: TestRunOutput[]): RunTestRunFn {
  const queue = [...outputs];
  return async () => {
    const next = queue.shift();
    if (!next) throw new Error('scriptedRunner: no more scripted outputs');
    return next;
  };
}

describe('runCriterionWithRerun', () => {
  test('skipped when no command was planned', async () => {
    const { result, flaky } = await runCriterionWithRerun({
      criterion: { index: 0, text: 'unreachable criterion' },
      command: undefined,
      worktree: '/tmp/x',
      repoRoot: '/tmp',
      runTestRun: scriptedRunner([]),
    });
    expect(result.status).toBe('skipped');
    expect(result.command).toBeUndefined();
    expect(flaky).toBeUndefined();
  });

  test('pass on the first try', async () => {
    const { result, flaky } = await runCriterionWithRerun({
      criterion: { index: 0, text: 'criterion A' },
      command: 'bun test a.test.ts',
      worktree: '/tmp/x',
      repoRoot: '/tmp',
      runTestRun: scriptedRunner([output({ ok: true })]),
    });
    expect(result.status).toBe('pass');
    expect(result.command).toBe('bun test a.test.ts');
    expect(flaky).toBeUndefined();
  });

  test('fail then fail again -> fail, no rerun-forgiveness', async () => {
    const { result, flaky } = await runCriterionWithRerun({
      criterion: { index: 0, text: 'criterion B' },
      command: 'bun test b.test.ts',
      worktree: '/tmp/x',
      repoRoot: '/tmp',
      runTestRun: scriptedRunner([
        output({ ok: false, summary: 'first fail' }),
        output({ ok: false, summary: 'second fail' }),
      ]),
    });
    expect(result.status).toBe('fail');
    expect(result.evidence).toContain('second fail');
    expect(flaky).toBeUndefined();
  });

  test('fail then pass on rerun -> flaky, with a FlakyFinding for the caller to file to the KB', async () => {
    const { result, flaky } = await runCriterionWithRerun({
      criterion: { index: 0, text: 'criterion C' },
      command: 'bun test c.test.ts',
      worktree: '/tmp/x',
      repoRoot: '/tmp',
      runTestRun: scriptedRunner([
        output({ ok: false, summary: 'flaked once' }),
        output({ ok: true, summary: 'passed on rerun' }),
      ]),
    });
    expect(result.status).toBe('flaky');
    expect(flaky).toBeDefined();
    expect(flaky?.command).toBe('bun test c.test.ts');
    expect(flaky?.first.summary).toBe('flaked once');
    expect(flaky?.second.summary).toBe('passed on rerun');
  });

  test('evidence stays within the 200-char cap', async () => {
    const { result } = await runCriterionWithRerun({
      criterion: { index: 0, text: 'x'.repeat(300) },
      command: 'bun test d.test.ts',
      worktree: '/tmp/x',
      repoRoot: '/tmp',
      runTestRun: scriptedRunner([
        output({ ok: false, summary: 'y'.repeat(300) }),
        output({ ok: false, summary: 'z'.repeat(300) }),
      ]),
    });
    expect(result.evidence.length).toBeLessThanOrEqual(200);
  });
});
