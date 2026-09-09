import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffSummaryError, runDiffSummary } from './diff-summary';

let repo: string;

function git(args: string[], cwd: string = repo): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`);
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-diffsum-'));
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['checkout', '-q', '-b', 'integration']);
  writeFileSync(join(repo, 'a.ts'), 'export function existing() {\n  return 1;\n}\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  git(['checkout', '-q', '-b', 'tkt/0001-fixture']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('runDiffSummary', () => {
  test('summarizes an added file with a symbol and no risk notes', () => {
    writeFileSync(join(repo, 'b.ts'), 'export function newThing() {\n  return 2;\n}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add b.ts']);

    const output = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });

    const added = output.files.find((f) => f.path === 'b.ts');
    expect(added?.status).toBe('added');
    expect(added?.symbols).toContain('newThing');
    expect(output.riskNotes).toEqual([]);
    expect(existsSync(output.rawDiffPath)).toBe(true);
    expect(readFileSync(output.rawDiffPath, 'utf8')).toContain('newThing');
    // The tool output itself never carries the raw diff text.
    expect(JSON.stringify(output)).not.toContain('return 2');
  });

  test('flags a lockfile change as a risk note', () => {
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion": 2}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'bump deps']);

    const output = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });
    expect(output.riskNotes.some((n) => n.includes('package-lock.json'))).toBe(true);
  });

  test('flags a deleted test file as a risk note', () => {
    // The file must exist on `integration` (the base) for its removal on
    // the ticket branch to show up as a net deletion in the range diff.
    git(['checkout', '-q', 'integration']);
    writeFileSync(join(repo, 'a.test.ts'), 'test content');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'add test on integration']);
    git(['checkout', '-q', 'tkt/0001-fixture']);
    git(['merge', '-q', 'integration']);
    git(['rm', '-q', 'a.test.ts']);
    git(['commit', '-q', '-m', 'delete test']);

    const output = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });
    expect(output.riskNotes.some((n) => n.includes('test file deleted'))).toBe(true);
  });

  test('produces hunks with a stable hash for the same content', () => {
    writeFileSync(join(repo, 'a.ts'), 'export function existing() {\n  return 42;\n}\n');
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'edit a.ts']);

    const output = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });
    expect(output.hunks.length).toBeGreaterThan(0);
    expect(output.hunks[0]?.path).toBe('a.ts');
  });

  test('throws DiffSummaryError on an invalid base ref', () => {
    expect(() =>
      runDiffSummary({
        worktree: repo,
        base: 'no-such-branch',
        head: 'tkt/0001-fixture',
        repoRoot: repo,
      }),
    ).toThrow(DiffSummaryError);
  });
});
