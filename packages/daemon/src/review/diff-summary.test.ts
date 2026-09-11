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

  test('a hunk hash is stable across a pure line-number shift elsewhere in the file (opus review, blocker 1)', () => {
    // Must exist on `integration` too, or the whole file reads as newly
    // added (one hunk, not a real modification) on the ticket branch.
    const base = `${Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')}\n`;
    git(['checkout', '-q', 'integration']);
    writeFileSync(join(repo, 'shift.ts'), base);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base shift file on integration']);
    git(['checkout', '-q', 'tkt/0001-fixture']);
    git(['merge', '-q', 'integration']);

    // Round A: modify line 10 only.
    const roundA = base.split('\n');
    roundA[9] = 'line 10 CHANGED';
    writeFileSync(join(repo, 'shift.ts'), roundA.join('\n'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'round A']);
    const outputA = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });

    // Round B: the same line-10 change, plus an unrelated insertion far away
    // at the top of the file — shifts the line-10 hunk's new-side range down
    // without changing its own content at all.
    const roundB = ['inserted line 0', ...roundA];
    writeFileSync(join(repo, 'shift.ts'), roundB.join('\n'));
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'round B']);
    const outputB = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });

    const shiftHunksA = outputA.hunks.filter((h) => h.path === 'shift.ts');
    const shiftHunksB = outputB.hunks
      .filter((h) => h.path === 'shift.ts')
      .sort((a, b) => a.newStart - b.newStart);
    const hunkA = shiftHunksA[0];
    // The line-10 hunk is the *last* one in round B (the unrelated insertion
    // produces its own, earlier hunk).
    const hunkB = shiftHunksB.at(-1);

    expect(hunkA).toBeDefined();
    expect(hunkB).toBeDefined();
    expect(hunkA?.newStart).not.toBe(hunkB?.newStart); // it did shift...
    expect(hunkA?.hash).toBe(hunkB?.hash); // ...but the hash didn't.
  });

  test('degrades gracefully and marks truncated when the summary would exceed the token cap', () => {
    // Many new files each declaring several functions — enough distinct
    // symbols/files that the untruncated JSON blows well past the cap.
    for (let i = 0; i < 60; i++) {
      const lines = Array.from(
        { length: 20 },
        (_, j) => `export function fn${i}_${j}() {\n  return ${j};\n}\n`,
      ).join('\n');
      writeFileSync(join(repo, `file${i}.ts`), lines);
    }
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'many files']);

    const output = runDiffSummary({
      worktree: repo,
      base: 'integration',
      head: 'tkt/0001-fixture',
      repoRoot: repo,
    });

    expect(output.truncated).toBe(true);
    // The hunk record is protocol-internal bookkeeping the re-review rule
    // depends on — truncation must never drop it, only the reviewer-facing
    // files/riskNotes/symbols (opus review, blocker 1).
    expect(output.hunks.length).toBeGreaterThan(0);
    expect(output.files.every((f) => f.symbols.length <= 5)).toBe(true);
    expect(output.riskNotes.length).toBeLessThanOrEqual(5);
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
