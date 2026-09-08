import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PACKAGE_NAME, runCliInit } from './index';

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
    const message = runCliInit(repo);
    expect(message).toContain('bootstrapped');
    expect(existsSync(join(repo, '.agile'))).toBe(true);
  });

  test('a second call reports already-initialised instead of throwing', () => {
    runCliInit(repo);
    const message = runCliInit(repo);
    expect(message).toContain('already initialised');
  });
});
