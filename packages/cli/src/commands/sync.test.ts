import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../args';
import { type TestDaemon, startTestDaemon } from '../test-support';
import { runSync, syncUsage } from './sync';

let daemon: TestDaemon;
let configPath: string;

beforeEach(async () => {
  daemon = await startTestDaemon('agile-cli-sync-');
  configPath = join(daemon.repo, 'agile.config.yaml');
});

afterEach(async () => {
  await daemon.cleanup();
});

/** Captures `console.log` for one call, the same way `gate.test.ts` does. */
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

async function captureErr(run: () => Promise<number>): Promise<{ code: number; err: string }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: string) => lines.push(msg);
  try {
    const code = await run();
    return { code, err: lines.join('\n') };
  } finally {
    console.error = original;
  }
}

describe('agile sync jira status', () => {
  test('reports an unlinked repo', async () => {
    const { code, out } = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'status']), false),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/linked\s+false/);
    expect(out).toMatch(/mapped tickets\s+0/);
  });

  test('defaults to status when no action is given', async () => {
    const { code, out } = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira']), true),
    );
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ linked: false, mapped: 0 });
  });
});

describe('agile sync jira link', () => {
  test('links a project over a real RPC round-trip and writes agile.config.yaml', async () => {
    const { code, out } = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'link', 'LED']), false),
    );
    expect(code).toBe(0);
    expect(out).toMatch(/linked\s+LED/);
    // The daemon-side write really happened, in the host-local config file.
    expect(daemon.jiraSync.linkedProject()).toBe('LED');
    expect(readFileSync(configPath, 'utf8')).toContain('project: LED');

    const status = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'status']), true),
    );
    expect(JSON.parse(status.out)).toMatchObject({
      linked: true,
      project: 'LED',
      source: 'config',
    });
  });

  test('accepts the project as a --project option instead of a positional', async () => {
    const { code } = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'link', '--project', 'OPS']), true),
    );
    expect(code).toBe(0);
    expect(daemon.jiraSync.linkedProject()).toBe('OPS');
  });

  test('link with no project at all is a usage error and links nothing', async () => {
    const { code, err } = await captureErr(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'link']), false),
    );
    expect(code).toBe(1);
    expect(err).toMatch(/usage: agile sync jira link <PROJECT>/);
    expect(daemon.jiraSync.linkedProject()).toBeUndefined();
  });

  test('a malformed project key is rejected by the daemon, not written', async () => {
    await expect(
      runSync(daemon.socketPath, parseArgs(['jira', 'link', 'not a key']), true),
    ).rejects.toThrow(/invalid "project"/);
    expect(daemon.jiraSync.linkedProject()).toBeUndefined();
  });

  test('link preserves other keys already in agile.config.yaml', async () => {
    writeFileSync(configPath, 'port: 4700\n');
    await capture(() => runSync(daemon.socketPath, parseArgs(['jira', 'link', 'LED']), true));
    const text = readFileSync(configPath, 'utf8');
    expect(text).toContain('port: 4700');
    expect(text).toContain('project: LED');
  });
});

describe('agile sync jira unlink', () => {
  test('unlinks a linked project', async () => {
    await capture(() => runSync(daemon.socketPath, parseArgs(['jira', 'link', 'LED']), true));
    const { code, out } = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'unlink']), false),
    );
    expect(code).toBe(0);
    expect(out).toContain('unlinked: LED');
    expect(daemon.jiraSync.linkedProject()).toBeUndefined();
  });

  test('unlinking an unlinked repo says so and is not an error', async () => {
    const { code, out } = await capture(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'unlink']), false),
    );
    expect(code).toBe(0);
    expect(out).toContain('no jira project was linked');
  });
});

describe('usage errors', () => {
  test('an unknown sync target prints usage and exits 1', async () => {
    const { code, err } = await captureErr(() =>
      runSync(daemon.socketPath, parseArgs(['linear', 'link', 'ENG']), false),
    );
    expect(code).toBe(1);
    expect(err).toBe(syncUsage());
  });

  test('an unknown jira action prints usage and exits 1', async () => {
    const { code, err } = await captureErr(() =>
      runSync(daemon.socketPath, parseArgs(['jira', 'frobnicate']), false),
    );
    expect(code).toBe(1);
    expect(err).toBe(syncUsage());
  });

  test('the usage text names the env vars and never suggests storing a credential', () => {
    expect(syncUsage()).toContain('JIRA_API_TOKEN');
    expect(syncUsage()).toContain('agile.config.yaml (jira.project)');
  });
});
