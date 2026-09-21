/**
 * `agile status` after T122: the daemon block, the open gates and the open
 * questions. The sprint strip, ticket table, halt list and spend table went
 * with the subsystems behind them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { fetchStatus, printStatusHuman, runStatus } from './status';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon();
});

afterEach(async () => {
  await daemon.cleanup();
});

async function seedQuestion(): Promise<void> {
  const stream = await daemon.streamService.create('human', {
    title: 'A stream',
    goal: 'do the thing',
  });
  await daemon.questionService.raise({
    stream: stream.id,
    raised_by: 'human',
    text: 'which branch?',
  });
}

describe('fetchStatus', () => {
  test('reports the running daemon and empty queues on a fresh home', async () => {
    const status = await fetchStatus(daemon.socketPath);
    expect(status.daemon.version).toBe('test');
    expect(status.questions).toEqual([]);
    expect(status.gates).toEqual([]);
  });

  test('an open question shows up', async () => {
    await seedQuestion();
    const status = await fetchStatus(daemon.socketPath);
    expect(status.questions).toHaveLength(1);
    expect(status.questions[0]?.text).toBe('which branch?');
  });
});

describe('printStatusHuman', () => {
  test('names the empty queues rather than printing nothing', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(args.join(' '));
    try {
      printStatusHuman(await fetchStatus(daemon.socketPath));
    } finally {
      console.log = original;
    }
    const text = lines.join('\n');
    expect(text).toContain('gates: (none open)');
    expect(text).toContain('open questions: (none)');
    expect(text).toContain('needs you');
  });
});

describe('runStatus', () => {
  test('exits 0 against a live daemon, in both output modes', async () => {
    const original = console.log;
    console.log = () => {};
    try {
      expect(await runStatus(daemon.socketPath, false)).toBe(0);
      expect(await runStatus(daemon.socketPath, true)).toBe(0);
    } finally {
      console.log = original;
    }
  });
});
