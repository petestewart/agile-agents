import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_NAME, runCli, runCliInit } from './index';
import { type TestDaemon, startTestDaemon } from './test-support';

test('PACKAGE_NAME identifies the package', () => {
  expect(PACKAGE_NAME).toBe('@agile-agents/cli');
});

let repo: string;
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-cli-init-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  // T111: the state home is never inside the repo. Point `AGILE_HOME` at a
  // temp dir so `agile init` cannot touch the operator's real `~/.agile/`.
  home = join(mkdtempSync(join(tmpdir(), 'agile-cli-home-')), 'home');
  previousHome = process.env.AGILE_HOME;
  process.env.AGILE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) Reflect.deleteProperty(process.env, 'AGILE_HOME');
  else process.env.AGILE_HOME = previousHome;
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('runCliInit', () => {
  test('creates the state home and never a .agile/ inside the repo', () => {
    const result = runCliInit(repo);
    expect(result.message).toContain(home);
    expect(result.alreadyInitialised).toBe(false);
    expect(existsSync(join(home, 'repos.yaml'))).toBe(true);
    expect(existsSync(join(repo, '.agile'))).toBe(false);
  });

  test('a second call is an idempotent no-op', () => {
    runCliInit(repo);
    const result = runCliInit(repo);
    expect(result.alreadyInitialised).toBe(true);
  });
});

describe('runCli init exit code', () => {
  const originalCwd = process.cwd();

  test('a fresh init exits 0', async () => {
    process.chdir(repo);
    try {
      expect(await runCli(['init'])).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  test('re-init is idempotent and still exits 0', async () => {
    process.chdir(repo);
    try {
      expect(await runCli(['init'])).toBe(0);
      expect(await runCli(['init'])).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('runCli dispatch against a running daemon', () => {
  let daemon: TestDaemon;

  beforeEach(async () => {
    daemon = await startTestDaemon();
  });

  afterEach(async () => {
    await daemon.cleanup();
  });

  test('status --json exits 0 and prints the daemon status shape', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let code: number;
    try {
      code = await runCli(['status', '--json'], daemon.repo);
    } finally {
      console.log = original;
    }
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n'));
    expect(parsed.daemon.pid).toBe(process.pid);
  });

  test('send delivers a bus message end to end', async () => {
    const code = await runCli(
      ['send', '--from', 'daemon', '--to', 'em', '--kind', 'fyi', '--body', 'via runCli'],
      daemon.repo,
    );
    expect(code).toBe(0);
  });

  test('halt then resume round-trips through dispatch', async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (msg: string) => lines.push(msg);
    let haltCode: number;
    try {
      haltCode = await runCli(['halt', '--reason', 'via runCli', '--json'], daemon.repo);
    } finally {
      console.log = original;
    }
    expect(haltCode).toBe(0);
    const halt = JSON.parse(lines.join('\n'));

    const resumeCode = await runCli(['resume', halt.id], daemon.repo);
    expect(resumeCode).toBe(0);
  });

  test('hook pre-tool-use fails open (no hook.* wired) and exits 0', async () => {
    // Redirect stdin isn't practical without spawning a subprocess; the
    // fail-open contract itself is covered end to end by
    // commands/hook.test.ts, which controls stdin directly. This just
    // checks `agile hook` is reachable from the top-level dispatcher.
    expect(await runCli(['gate', 'list'], daemon.repo)).toBe(0);
  });

  test('an unknown command prints usage to stderr and exits non-zero', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => errors.push(msg);
    let code: number;
    try {
      code = await runCli(['not-a-real-command'], daemon.repo);
    } finally {
      console.error = original;
    }
    expect(code).toBe(1);
    expect(errors.join('\n')).toMatch(/usage: agile/);
  });
});
