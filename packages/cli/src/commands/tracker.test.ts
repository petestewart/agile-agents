/**
 * `agile tracker` against an in-process daemon (T326, D31): the token comes
 * from the reader (stdin or a prompt), never argv, and is never printed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runTrackerClear, runTrackerSet, runTrackerStatus } from './tracker';

let daemon: TestDaemon;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-tracker-');
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

const TOKEN = 'jira-cli-token-T326-secret';

describe('agile tracker', () => {
  test('set reads the token from the reader, writes config.yaml, and prints only "set"', async () => {
    const asked: string[] = [];
    const { code, out } = await capture(() =>
      runTrackerSet(
        daemon.socketPath,
        parseArgs(['jira', '--base-url', 'https://shop.atlassian.net', '--email', 'p@example.com']),
        false,
        {
          readToken: async (system) => {
            asked.push(system);
            return `${TOKEN}\n`;
          },
        },
      ),
    );
    expect(code).toBe(0);
    expect(asked).toEqual(['jira']);
    expect(out).toContain('jira: token set');
    expect(out).toContain('https://shop.atlassian.net');
    expect(out).not.toContain(TOKEN);
    const config = readFileSync(join(daemon.stateRoot, 'config.yaml'), 'utf8');
    expect(config).toContain(TOKEN);

    const status = await capture(() => runTrackerStatus(daemon.socketPath, true));
    expect(JSON.parse(status.out)).toEqual({
      jira: { token_set: true, base_url: 'https://shop.atlassian.net', email: 'p@example.com' },
      linear: { token_set: false },
    });

    const cleared = await capture(() =>
      runTrackerClear(daemon.socketPath, parseArgs(['jira']), false),
    );
    expect(cleared.out).toContain('jira: token not set');
    expect(readFileSync(join(daemon.stateRoot, 'config.yaml'), 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(join(daemon.stateRoot, 'log', 'events.jsonl'), 'utf8')).not.toContain(
      TOKEN,
    );
  });

  test('a token as an argument is refused before anything is read or sent', async () => {
    let read = false;
    await expect(
      runTrackerSet(daemon.socketPath, parseArgs(['linear', TOKEN]), false, {
        readToken: async () => {
          read = true;
          return TOKEN;
        },
      }),
    ).rejects.toThrow('takes no token argument');
    expect(read).toBe(false);
  });

  test('an empty token or an unknown tracker writes nothing', async () => {
    await expect(
      runTrackerSet(daemon.socketPath, parseArgs(['linear']), false, {
        readToken: async () => '  ',
      }),
    ).rejects.toThrow('no linear token');
    await expect(
      runTrackerSet(daemon.socketPath, parseArgs(['github']), false, {
        readToken: async () => TOKEN,
      }),
    ).rejects.toThrow('jira or linear');
    const status = await capture(() => runTrackerStatus(daemon.socketPath, true));
    expect(JSON.parse(status.out).linear.token_set).toBe(false);
  });

  test('a jira token without a base URL is refused without echoing the token', async () => {
    const err = await runTrackerSet(daemon.socketPath, parseArgs(['jira']), false, {
      readToken: async () => TOKEN,
    }).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('base URL');
    expect((err as Error).message).not.toContain(TOKEN);
  });
});
