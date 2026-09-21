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

async function capture(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return lines;
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
  /** T128: the in-flight streams sit between the daemon block and `needs you`. */
  test('lists the open streams between the daemon block and needs you', async () => {
    const root = await daemon.streamService.create('human', {
      title: 'Ship the cockpit',
      goal: 'do the thing',
    });
    const child = await daemon.streamService.create('human', {
      title: 'Design the tree',
      goal: 'a tree',
      parent: root.id,
    });
    const gone = await daemon.streamService.create('human', {
      title: 'Archive me',
      goal: 'gone',
    });
    await daemon.streamService.archive('human', gone.id);

    const lines = await capture(async () => printStatusHuman(await fetchStatus(daemon.socketPath)));
    const streamsAt = lines.findIndex((l) => l.startsWith('streams ('));
    const needsAt = lines.findIndex((l) => l.startsWith('needs you'));
    const stateAt = lines.findIndex((l) => l.startsWith('state'));
    expect(stateAt).toBeLessThan(streamsAt);
    expect(streamsAt).toBeLessThan(needsAt);
    expect(lines[streamsAt]).toBe('streams (2):');
    expect(lines[streamsAt + 1]).toContain('id');
    expect(lines[streamsAt + 1]).toContain('agent/human');
    expect(lines[streamsAt + 2]).toContain(root.id);
    expect(lines[streamsAt + 2]).toContain('idle/open');
    // The child is indented one level deeper than its parent.
    expect(lines[streamsAt + 3]).toContain(child.id);
    const indent = (l: string) => l.length - l.trimStart().length;
    expect(indent(lines[streamsAt + 3] ?? '')).toBeGreaterThan(indent(lines[streamsAt + 2] ?? ''));
    // Archived stays hidden.
    expect(lines.join('\n')).not.toContain(gone.id);
  });

  test('says so when no stream is open', async () => {
    const lines = await capture(async () => printStatusHuman(await fetchStatus(daemon.socketPath)));
    expect(lines.join('\n')).toContain('streams: (none open)');
  });

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
