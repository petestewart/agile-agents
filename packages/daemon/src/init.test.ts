import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validatePolicy, validateVendorsConfig } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';
import { AlreadyInitialisedError, STATE_BRANCH, runInit } from './init';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-init-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
  writeFileSync(join(repo, 'README.md'), '# fixture repo\n');
  Bun.spawnSync(['git', 'add', '-A'], { cwd: repo });
  Bun.spawnSync(['git', 'commit', '-q', '-m', 'initial commit'], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe' });
  return new TextDecoder().decode(result.stdout).trim();
}

describe('runInit', () => {
  test('creates the agile-state orphan branch checked out as a worktree at .agile/', () => {
    const result = runInit(repo);
    expect(result.branch).toBe(STATE_BRANCH);
    expect(result.stateRoot).toBe(join(repo, '.agile'));

    const branches = git(['branch', '--list', STATE_BRANCH], repo);
    expect(branches).toContain(STATE_BRANCH);

    // Orphan: no parent commit.
    const parents = git(['log', '--format=%P', '-1', STATE_BRANCH], repo);
    expect(parents).toBe('');

    // It's a worktree of its own, distinct from the main checkout's HEAD.
    const worktrees = git(['worktree', 'list', '--porcelain'], repo);
    expect(worktrees).toContain(join(repo, '.agile'));

    const branchInWorktree = git(['branch', '--show-current'], join(repo, '.agile'));
    expect(branchInWorktree).toBe(STATE_BRANCH);
  });

  test('produces the §4 layout: dirs, empty indexes, policy.yaml, vendors.yaml', () => {
    runInit(repo);
    const stateRoot = join(repo, '.agile');

    for (const relative of [
      'oracle/product.md',
      'oracle/index.yaml',
      'oracle/changelog.md',
      'oracle/decisions',
      'oracle/specs',
      'knowledge/facts',
      'knowledge/index.yaml',
      'tickets',
      'board/status',
      'board/halts',
      'sprints',
      'policy.yaml',
      'vendors.yaml',
      'tools',
      'rules',
      'ledger',
      'log/events.jsonl',
      'bus/inbox',
      'bus/threads',
      'bus/agents',
    ]) {
      expect(existsSync(join(stateRoot, relative))).toBe(true);
    }

    const oracleIndex = parseYaml(readFileSync(join(stateRoot, 'oracle/index.yaml'), 'utf8'));
    expect(oracleIndex).toEqual({});
    const knowledgeIndex = parseYaml(readFileSync(join(stateRoot, 'knowledge/index.yaml'), 'utf8'));
    expect(knowledgeIndex).toEqual({});
  });

  test('policy.yaml and vendors.yaml validate against the shared schemas', () => {
    runInit(repo);
    const stateRoot = join(repo, '.agile');

    const policy = parseYaml(readFileSync(join(stateRoot, 'policy.yaml'), 'utf8'));
    expect(() => validatePolicy(policy)).not.toThrow();

    const vendors = parseYaml(readFileSync(join(stateRoot, 'vendors.yaml'), 'utf8'));
    expect(() => validateVendorsConfig(vendors)).not.toThrow();
  });

  test('adds .agile/, .worktrees/, and the daemon lock/socket files to .gitignore, idempotently', () => {
    runInit(repo);
    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    const lineCount = (needle: string) => gitignore.split('\n').filter((l) => l === needle).length;
    for (const needle of ['.agile/', '.worktrees/', '.agile-daemon.lock', '.agile-daemon.sock']) {
      expect(gitignore).toContain(needle);
      expect(lineCount(needle)).toBe(1);
    }
  });

  test('respects .gitignore lines that already exist', () => {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n.worktrees/\n');
    runInit(repo);
    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect((gitignore.match(/\.worktrees\//g) ?? []).length).toBe(1);
    expect(gitignore).toContain('.agile/');
  });

  test('a second init refuses cleanly', () => {
    runInit(repo);
    expect(() => runInit(repo)).toThrow(AlreadyInitialisedError);
  });

  test('refuses cleanly when only the branch exists (no .agile/ dir)', () => {
    runInit(repo);
    // Simulate a half-torn-down state: remove the worktree dir but leave the branch.
    Bun.spawnSync(['git', 'worktree', 'remove', '--force', '.agile'], { cwd: repo });
    expect(() => runInit(repo)).toThrow(AlreadyInitialisedError);
  });

  test('throws a clear error when repoRoot is not a git repository', () => {
    const notGit = mkdtempSync(join(tmpdir(), 'agile-init-notgit-'));
    try {
      expect(() => runInit(notGit)).toThrow(/not a git repository/);
    } finally {
      rmSync(notGit, { recursive: true, force: true });
    }
  });
});
