/**
 * `agile review <stream>` against an in-process daemon (T131), same shape
 * as the other command tests: a real socket, the fake-agent transport, no
 * vendor and no login.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runReview } from './review';

let daemon: TestDaemon;
let stream: string;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-review-');
  stream = (await daemon.streamService.create('human', { title: 's', goal: 'g' })).id;
});

afterEach(async () => {
  await daemon.cleanup();
});

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (msg: string) => lines.push(msg);
  try {
    const code = await run();
    return { code, out: lines.join('\n') };
  } finally {
    console.log = original;
  }
}

describe('agile review', () => {
  test('starts a reviewer session on the stream and prints it like attach', async () => {
    const { code, out } = await capture(() =>
      runReview(daemon.socketPath, parseArgs([stream]), false),
    );
    expect(code).toBe(0);
    expect(out).toContain('agile review:');
    expect(out).toContain(stream);

    const recorded = daemon.streamService.get(stream).sessions;
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.role).toBe('reviewer');
    // A review is not work: the worker's status field is untouched.
    expect(daemon.streamService.get(stream).agent.status).toBe('idle');
  });

  test('--json prints the session record', async () => {
    const { out } = await capture(() => runReview(daemon.socketPath, parseArgs([stream]), true));
    expect(JSON.parse(out).role).toBe('reviewer');
  });

  test('rejects an effort level the schema does not have', async () => {
    await expect(
      runReview(daemon.socketPath, parseArgs([stream, '--effort', 'turbo']), false),
    ).rejects.toThrow(/--effort must be one of/);
  });

  test('refuses a second live reviewer on the same stream', async () => {
    await capture(() => runReview(daemon.socketPath, parseArgs([stream]), false));
    await expect(runReview(daemon.socketPath, parseArgs([stream]), false)).rejects.toThrow(
      /already has a live reviewer/,
    );
  });
});
