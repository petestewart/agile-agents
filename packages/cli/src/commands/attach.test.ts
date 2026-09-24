/** `agile attach --force` (T176) against an in-process daemon and the fake agent. */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runAttach } from './attach';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-attach-');
});

afterEach(async () => {
  await daemon.cleanup();
});

describe('agile attach on a parent with open children', () => {
  test('refuses without --force, naming why; attaches with it', async () => {
    const parent = (await daemon.streamService.create('human', { title: 'p', goal: 'g' })).id;
    await daemon.streamService.create('human', { title: 'c', goal: 'g', parent });
    await expect(runAttach(daemon.socketPath, parseArgs([parent]), true)).rejects.toThrow(
      /a parent's branch is where its children land.*--force/,
    );
    const original = console.log;
    console.log = () => {};
    try {
      expect(await runAttach(daemon.socketPath, parseArgs([parent, '--force']), true)).toBe(0);
    } finally {
      console.log = original;
    }
    expect(daemon.streamService.get(parent).sessions[0]?.role).toBe('worker');
  });
});
