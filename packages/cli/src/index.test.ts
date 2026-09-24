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
    const result = runCliInit();
    expect(result.message).toContain(home);
    expect(result.alreadyInitialised).toBe(false);
    expect(existsSync(join(home, 'repos.yaml'))).toBe(true);
    expect(existsSync(join(repo, '.agile'))).toBe(false);
  });

  test('a second call is an idempotent no-op', () => {
    runCliInit();
    const result = runCliInit();
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
