/**
 * `agile status` after T122: the daemon block, the open gates and the open
 * questions. The sprint strip, ticket table, halt list and spend table went
 * with the subsystems behind them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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

  /**
   * T126 (QA rough edge 3): a dead daemon used to surface as the raw
   * `could not reach daemon at ...: connect ENOENT`. It now says what
   * `agile daemon status` says, and exits 1.
   */
  test('says agiled is not running and exits 1 when the socket is dead', async () => {
    const errors: string[] = [];
    const logs: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (msg: string) => errors.push(String(msg));
    console.log = (msg: string) => logs.push(String(msg));
    try {
      const dead = join(daemon.home, 'no-such-daemon.sock');
      expect(await runStatus(dead, false)).toBe(1);
      expect(errors.join('\n')).toMatch(/^agiled is not running \(home=/);
      expect(errors.join('\n')).not.toContain('ENOENT');
      expect(await runStatus(dead, true)).toBe(1);
      expect(JSON.parse(logs.join('\n')) as { running: boolean }).toMatchObject({
        running: false,
      });
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
  });
});
