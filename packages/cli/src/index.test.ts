import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_NAME, runCli, runCliInit } from './index';

test('PACKAGE_NAME identifies the package', () => {
  expect(PACKAGE_NAME).toBe('@agile-agents/cli');
});

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-cli-init-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('runCliInit', () => {
  test('bootstraps .agile/ in the given repo', () => {
    const result = runCliInit(repo);
    expect(result.message).toContain('bootstrapped');
    expect(result.alreadyInitialised).toBe(false);
    expect(existsSync(join(repo, '.agile'))).toBe(true);
  });

  test('a second call reports already-initialised instead of throwing', () => {
    runCliInit(repo);
    const result = runCliInit(repo);
    expect(result.message).toContain('already initialised');
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

  test('re-init on an already-initialised repo exits non-zero', async () => {
    process.chdir(repo);
    try {
      expect(await runCli(['init'])).toBe(0);
      expect(await runCli(['init'])).not.toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
