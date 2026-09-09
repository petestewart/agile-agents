import { describe, expect, test } from 'bun:test';
import type { ToolDefinition } from '@agile-agents/shared';
import { FakeRunner, ToolRunnerTimeoutError, withRunnerTimeout } from './runner';
import type { ToolRunInput } from './types';

function makeInput(overrides: Partial<ToolRunInput> = {}): ToolRunInput {
  const tool: ToolDefinition = {
    name: 'read_summary',
    kind: 'reader',
    trigger: { hook: 'pre-tool-use', match: 'true' },
    action: 'redirect',
    runner: { tier: 'trivial', max_output_tokens: 400 },
    input: {},
    output: {},
    ledger_kind: 'reader',
    promote_to_kb: 'never',
  };
  return {
    tool,
    prompt: 'summarize',
    input: { path: 'a.ts' },
    cwd: '/tmp',
    maxOutputTokens: 400,
    ...overrides,
  };
}

describe('withRunnerTimeout', () => {
  test('resolves normally when the work finishes first', async () => {
    const result = await withRunnerTimeout(async () => 'done', 1000);
    expect(result).toBe('done');
  });

  test('rejects with ToolRunnerTimeoutError when the deadline fires first', async () => {
    await expect(withRunnerTimeout(() => new Promise<never>(() => {}), 20)).rejects.toThrow(
      ToolRunnerTimeoutError,
    );
  });
});

describe('FakeRunner (QA round 1: every ToolRunner owns its own deadline + cleanup)', () => {
  test('a call that finishes in time never triggers cleanup extra times, and returns the reply', async () => {
    let cleanupCalls = 0;
    const runner = new FakeRunner(
      () => ({ text: 'ok', model: 'fake', inTokens: 1, outTokens: 1 }),
      () => {
        cleanupCalls++;
      },
    );
    const result = await runner.run(makeInput({ timeoutMs: 1000 }));
    expect(result.text).toBe('ok');
    expect(cleanupCalls).toBe(1);
  });

  test('a call that hangs past timeoutMs rejects with ToolRunnerTimeoutError and still runs cleanup', async () => {
    let cleanupCalls = 0;
    const runner = new FakeRunner(
      () => new Promise(() => {}), // never resolves — simulates a stuck vendor session
      () => {
        cleanupCalls++;
      },
    );

    await expect(runner.run(makeInput({ timeoutMs: 20 }))).rejects.toThrow(ToolRunnerTimeoutError);
    expect(cleanupCalls).toBe(1);
    expect(runner.cleanupCalls).toBe(1);
  });

  test('defaults to DEFAULT_RUNNER_TIMEOUT_MS when the caller gives no timeoutMs', async () => {
    const runner = new FakeRunner(() => ({ text: 'ok', model: 'fake', inTokens: 0, outTokens: 0 }));
    const result = await runner.run(makeInput());
    expect(result.text).toBe('ok');
  });
});
