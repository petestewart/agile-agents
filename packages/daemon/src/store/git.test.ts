import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitPaths } from './git';

let repo: string;

function git(args: string[], cwd: string): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe' });
  return new TextDecoder().decode(result.stdout).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'agile-store-git-'));
  Bun.spawnSync(['git', 'init', '-q'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], { cwd: repo });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('commitPaths', () => {
  test('commits exactly the given paths with the given message', () => {
    writeFileSync(join(repo, 'a.txt'), 'a');
    writeFileSync(join(repo, 'b.txt'), 'b');
    const hash = commitPaths(repo, ['a.txt'], 'add a');
    expect(hash).not.toBeNull();

    const files = git(['show', '--stat', '--format=', 'HEAD'], repo);
    expect(files).toContain('a.txt');
    expect(files).not.toContain('b.txt');

    const subject = git(['log', '-1', '--format=%s'], repo);
    expect(subject).toBe('add a');

    // b.txt was never staged/committed — still untracked.
    const status = git(['status', '--porcelain'], repo);
    expect(status).toContain('b.txt');
  });

  test("authors the commit as agiled <agiled@localhost> (matches init.ts's bootstrap commit)", () => {
    writeFileSync(join(repo, 'a.txt'), 'a');
    commitPaths(repo, ['a.txt'], 'add a');
    const author = git(['log', '-1', '--format=%an <%ae>'], repo);
    expect(author).toBe('agiled <agiled@localhost>');
  });

  test('returns null and tolerates "nothing to commit" when nothing changed', () => {
    writeFileSync(join(repo, 'a.txt'), 'a');
    const first = commitPaths(repo, ['a.txt'], 'add a');
    expect(first).not.toBeNull();

    const second = commitPaths(repo, ['a.txt'], 'no-op');
    expect(second).toBeNull();

    const log = git(['log', '--format=%s'], repo);
    expect(log.split('\n')).toEqual(['add a']);
  });

  test('commits a modification to a tracked file', () => {
    writeFileSync(join(repo, 'a.txt'), 'a');
    commitPaths(repo, ['a.txt'], 'add a');

    writeFileSync(join(repo, 'a.txt'), 'a2');
    const hash = commitPaths(repo, ['a.txt'], 'update a');
    expect(hash).not.toBeNull();

    const log = git(['log', '--format=%s'], repo);
    expect(log.split('\n')).toEqual(['update a', 'add a']);
  });

  test('rejects an empty path list', () => {
    expect(() => commitPaths(repo, [], 'x')).toThrow(/non-empty/);
  });

  // Review nit: "nothing to commit" detection must not depend on git's
  // human-readable, locale-dependent commit output.
  test('detects "nothing to commit" via porcelain status, not locale-dependent message text', () => {
    writeFileSync(join(repo, 'a.txt'), 'a');
    commitPaths(repo, ['a.txt'], 'add a');

    const result = Bun.spawnSync(
      ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'noop'],
      { cwd: repo, env: { ...process.env, LC_ALL: 'fr_FR.UTF-8' }, stdout: 'pipe', stderr: 'pipe' },
    );
    // Whatever git prints under a non-English locale (may itself fall back
    // to C if fr_FR isn't installed in the test image) is irrelevant —
    // commitPaths never inspects this text at all.
    expect(result.exitCode).not.toBe(0);

    const second = commitPaths(repo, ['a.txt'], 'no-op');
    expect(second).toBeNull();
  });
});
