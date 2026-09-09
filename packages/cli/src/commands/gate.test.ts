import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Policy } from '@agile-agents/shared';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runApprove, runBreakerClear, runDelegate, runGateList, runResolve } from './gate';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon();
});

afterEach(async () => {
  await daemon.cleanup();
});

function ctx(gates: Policy['gates']) {
  return { policy: { gates, breaker_signals: [] }, hilKind: 'unblock' as const };
}

describe('runApprove', () => {
  test('approves a pending HIL request', async () => {
    const req = await daemon.gateService.request('demo', ctx({ demo: 'human' }));

    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runApprove(daemon.socketPath, parseArgs([req.id, '--by', 'pete']), false);
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    expect(lines.join('\n')).toMatch(/resolved/);
  });

  test('json mode returns the resolved request', async () => {
    const req = await daemon.gateService.request('demo', ctx({ demo: 'human' }));
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runApprove(daemon.socketPath, parseArgs([req.id]), true);
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.id).toBe(req.id);
    expect(parsed.decision).toBe('approve');
  });
});

describe('runDelegate', () => {
  test('fails closed when no delegate is configured (T018 decision: never auto-approve)', async () => {
    const req = await daemon.gateService.request('unblock', ctx({ unblock: 'human' }));
    await expect(
      runDelegate(daemon.socketPath, parseArgs([req.id, '--to', 'architect']), true),
    ).rejects.toThrow(/no delegate function is configured/);
  });
});

describe('runResolve', () => {
  test('resolves with an explicit deny decision', async () => {
    const req = await daemon.gateService.request('demo', ctx({ demo: 'human' }));
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runResolve(
        daemon.socketPath,
        parseArgs([req.id, '--decision', 'deny', '--by', 'pete']),
        true,
      );
    } finally {
      console.log = original;
    }
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.decision).toBe('deny');
  });
});

describe('runGateList', () => {
  test('lists open requests, empty message when none', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await runGateList(daemon.socketPath, false);
    } finally {
      console.log = original;
    }
    expect(lines.join('\n')).toMatch(/none open/);
  });
});

describe('runBreakerClear', () => {
  test('clears a known breaker signal', async () => {
    const code = await runBreakerClear(daemon.socketPath, parseArgs(['deadlock']), false);
    expect(code).toBe(0);
  });

  test('an unknown signal is a non-zero exit via the thrown RpcCallError', async () => {
    await expect(
      runBreakerClear(daemon.socketPath, parseArgs(['not-a-signal']), false),
    ).rejects.toThrow();
  });
});
