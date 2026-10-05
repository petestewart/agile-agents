/**
 * T362: Settings' folder picker (`GET /api/fs/dirs`): the child folders of
 * one folder, each flagged when it is a git work tree's toplevel, so a repo
 * is added by browsing rather than by typing a path.
 *
 * One `readdir`, and one `stat` per symlink (to see whether it leads to a
 * folder); nothing recurses, so a symlink loop is one failed stat, skipped.
 * The git flag is an `existsSync` of `<dir>/.git` (a folder, or the file a
 * linked worktree or submodule has), done only for the entries returned.
 */

import { type Dirent, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** At most this many entries per listing; the rest are cut and `truncated` is set. */
export const DIR_LIST_MAX_ENTRIES = 500;

export interface DirEntry {
  name: string;
  path: string;
  /** A git work tree's toplevel (`.git` inside it). */
  git: boolean;
}

export interface DirListing {
  path: string;
  /** Absent at `/`. */
  parent?: string;
  home: string;
  /** The listed folder is itself a git toplevel. */
  is_git: boolean;
  entries: DirEntry[];
  truncated?: true;
}

/** A listing refused: 404 for a missing folder, 400 for anything else. */
export class DirListError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = 'DirListError';
  }
}

/** `~` and `~/…` are the home folder; anything else is returned unchanged. */
export function expandHome(input: string, home: string = homedir()): string {
  if (input === '~') return home;
  if (input.startsWith('~/')) return join(home, input.slice(2));
  return input;
}

/**
 * An absolute, normalised folder path from what the human typed: `~`
 * expanded, `..` resolved. A relative path has nothing to be relative to
 * in the daemon, so it is refused.
 */
export function resolveAbsolutePath(input: string, home: string = homedir()): string {
  if (input.includes('\0')) throw new DirListError('path must not contain a NUL byte', 400);
  const expanded = expandHome(input.trim(), home);
  if (!isAbsolute(expanded)) {
    throw new DirListError(`path must be absolute or start with ~/ (got ${input})`, 400);
  }
  return resolve(expanded);
}

export function isGitToplevel(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

function isFolder(dir: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(dir, entry.name)).isDirectory();
  } catch {
    return false; // dangling, a loop, or unreadable
  }
}

export interface ListDirsOptions {
  /** Show dot-folders (always shown when `prefix` starts with a dot). */
  hidden?: boolean;
  /** Only names starting with this, case-insensitively (the path field's autocomplete). */
  prefix?: string;
  home?: string;
  max?: number;
}

/** The child folders of `input` (default: home), sorted case-insensitively. */
export function listDirs(input: string | undefined, options: ListDirsOptions = {}): DirListing {
  const home = options.home ?? homedir();
  const path = input === undefined || input.trim() === '' ? home : resolveAbsolutePath(input, home);
  let children: Dirent[];
  try {
    children = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new DirListError(`no such folder: ${path}`, 404);
    if (code === 'ENOTDIR') throw new DirListError(`not a folder: ${path}`, 400);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new DirListError(`cannot read ${path}: permission denied`, 400);
    }
    throw new DirListError(`cannot read ${path}: ${code ?? 'unknown error'}`, 400);
  }
  const prefix = options.prefix?.toLowerCase() ?? '';
  const showHidden = options.hidden === true || prefix.startsWith('.');
  const names = children
    .filter(
      (c) => (showHidden || !c.name.startsWith('.')) && c.name.toLowerCase().startsWith(prefix),
    )
    .filter((c) => isFolder(path, c))
    .map((c) => c.name)
    .sort((a, b) => {
      const byFold = a.toLowerCase().localeCompare(b.toLowerCase());
      return byFold !== 0 ? byFold : a.localeCompare(b);
    });
  const max = options.max ?? DIR_LIST_MAX_ENTRIES;
  const parent = dirname(path);
  return {
    path,
    ...(parent !== path ? { parent } : {}),
    home,
    is_git: isGitToplevel(path),
    entries: names.slice(0, max).map((name) => {
      const full = join(path, name);
      return { name, path: full, git: isGitToplevel(full) };
    }),
    ...(names.length > max ? { truncated: true as const } : {}),
  };
}
