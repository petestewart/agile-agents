import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DirListError, listDirs, resolveAbsolutePath } from './browse-dirs';

let scratch: string;
let home: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'agile-browse-dirs-'));
  home = join(scratch, 'home');
  mkdirSync(home);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function refusal(fn: () => unknown): DirListError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DirListError) return err;
    throw err;
  }
  throw new Error('expected a DirListError');
}

describe('listDirs (T362)', () => {
  test('only folders, sorted case-insensitively, dot-folders hidden, git toplevels flagged', () => {
    for (const d of ['beta', 'Alpha', 'gamma', '.config', 'repo/.git', 'worktree']) {
      mkdirSync(join(home, d), { recursive: true });
    }
    writeFileSync(join(home, 'worktree', '.git'), 'gitdir: /elsewhere\n'); // a linked worktree
    writeFileSync(join(home, 'notes.txt'), 'x');
    const listing = listDirs(undefined, { home });
    expect(listing.path).toBe(home);
    expect(listing.home).toBe(home);
    expect(listing.parent).toBe(scratch);
    expect(listing.is_git).toBe(false);
    expect(listing.truncated).toBeUndefined();
    expect(listing.entries).toEqual([
      { name: 'Alpha', path: join(home, 'Alpha'), git: false },
      { name: 'beta', path: join(home, 'beta'), git: false },
      { name: 'gamma', path: join(home, 'gamma'), git: false },
      { name: 'repo', path: join(home, 'repo'), git: true },
      { name: 'worktree', path: join(home, 'worktree'), git: true },
    ]);
    expect(listDirs(home, { home, hidden: true }).entries.map((e) => e.name)).toEqual([
      '.config',
      'Alpha',
      'beta',
      'gamma',
      'repo',
      'worktree',
    ]);
    expect(listDirs(join(home, 'repo'), { home }).is_git).toBe(true);
  });

  test('a symlink to a folder is listed; a dangling one and a loop are skipped, not followed', () => {
    mkdirSync(join(scratch, 'target'));
    symlinkSync(join(scratch, 'target'), join(home, 'linked'));
    symlinkSync(join(scratch, 'missing'), join(home, 'dangling'));
    symlinkSync(join(home, 'loop-b'), join(home, 'loop-a'));
    symlinkSync(join(home, 'loop-a'), join(home, 'loop-b'));
    symlinkSync(home, join(home, 'self')); // a cycle through the listed folder itself
    expect(listDirs(home, { home }).entries.map((e) => e.name)).toEqual(['linked', 'self']);
    expect(listDirs(join(home, 'self', 'self'), { home }).entries.map((e) => e.name)).toEqual([
      'linked',
      'self',
    ]);
  });

  test('`~` paths, `..` normalised, the root has no parent', () => {
    mkdirSync(join(home, 'Projects', 'shop'), { recursive: true });
    expect(listDirs('~', { home }).path).toBe(home);
    expect(listDirs('~/Projects', { home }).entries.map((e) => e.name)).toEqual(['shop']);
    expect(listDirs(`${home}/Projects/shop/..`, { home }).path).toBe(join(home, 'Projects'));
    const root = listDirs('/', { home });
    expect(root.path).toBe('/');
    expect(root.parent).toBeUndefined();
  });

  test('prefix filters case-insensitively, and a dot prefix finds dot-folders', () => {
    for (const d of ['Projects', 'proto', 'music', '.profile.d']) mkdirSync(join(home, d));
    expect(listDirs(home, { home, prefix: 'PRO' }).entries.map((e) => e.name)).toEqual([
      'Projects',
      'proto',
    ]);
    expect(listDirs(home, { home, prefix: '.pro' }).entries.map((e) => e.name)).toEqual([
      '.profile.d',
    ]);
  });

  test('capped, with truncated set', () => {
    for (let i = 0; i < 7; i++) mkdirSync(join(home, `d${i}`));
    const listing = listDirs(home, { home, max: 5 });
    expect(listing.entries.map((e) => e.name)).toEqual(['d0', 'd1', 'd2', 'd3', 'd4']);
    expect(listing.truncated).toBe(true);
  });

  test('refusals: missing is 404; a file, a relative path or a NUL byte is 400', () => {
    writeFileSync(join(home, 'file.txt'), 'x');
    expect(refusal(() => listDirs(join(home, 'nope'), { home })).status).toBe(404);
    const file = refusal(() => listDirs(join(home, 'file.txt'), { home }));
    expect(file.status).toBe(400);
    expect(file.message).toBe(`not a folder: ${join(home, 'file.txt')}`);
    expect(refusal(() => listDirs('Projects', { home })).message).toContain('must be absolute');
    expect(refusal(() => resolveAbsolutePath('/tmp/a\0b', home)).status).toBe(400);
  });
});
