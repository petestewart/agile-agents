/**
 * Resolves the git dirs a linked worktree's `.git` gitfile points at:
 * `gitdir: <repo>/.git/worktrees/<name>` (this worktree's HEAD, index and
 * logs), whose `commondir` names the shared `.git` (normally `../..`).
 * `readFileSync` is injected so this tests without a real repo.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface GitPathsDeps {
  readFileSync: (path: string) => string;
}

export interface WorktreeGitPaths {
  /** `<repo>/.git/worktrees/<name>`: this worktree's HEAD/index/logs, written by every commit. */
  worktreeGitDir: string;
  /** `<repo>/.git`, shared: only objects/refs/logs need write; the rest stays read-only. */
  commonGitDir: string;
}

function defaultReadFileSync(path: string): string {
  return readFileSync(path, 'utf8');
}

const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/** `null` when `.git` isn't a linked-worktree gitfile (a real `.git` directory): nothing extra to grant. */
export function resolveWorktreeGitPaths(
  worktreePath: string,
  deps: GitPathsDeps = { readFileSync: defaultReadFileSync },
): WorktreeGitPaths | null {
  let gitFileContents: string;
  try {
    gitFileContents = deps.readFileSync(join(worktreePath, '.git'));
  } catch {
    return null;
  }

  const match = GITDIR_LINE.exec(gitFileContents);
  const rawGitDir = match?.[1];
  if (!rawGitDir) return null;
  const worktreeGitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(worktreePath, rawGitDir);

  let commonGitDir = worktreeGitDir;
  try {
    const commonDirRaw = deps.readFileSync(join(worktreeGitDir, 'commondir')).trim();
    commonGitDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(worktreeGitDir, commonDirRaw);
  } catch {
    // No `commondir`: treat its own dir as the common dir rather than guess.
  }

  return { worktreeGitDir, commonGitDir };
}
