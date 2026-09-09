/**
 * Resolves the shared git paths a ticket worktree's `.git` gitfile points
 * at (round 2 B4 — reviewer's own evidence: `.worktrees/T026.../.git` =
 * `gitdir: /home/user/agile-agents/.git/worktrees/T026-tier0-sandbox`).
 * `git worktree add` gives every linked worktree a `.git` *file* (not a
 * directory) containing `gitdir: <repo>/.git/worktrees/<name>`; that
 * per-worktree dir holds `HEAD`/`index`/`logs` for this worktree, and its
 * own `commondir` file names the real shared `.git` (objects/refs/config)
 * relative to itself — normally `../..`.
 *
 * Dependency-injected (`readFileSync`) so this is unit-testable without a
 * real git repo, matching the rest of this module's pure/injected style.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface GitPathsDeps {
  readFileSync: (path: string) => string;
}

export interface WorktreeGitPaths {
  /** `<repo>/.git/worktrees/<name>` — this worktree's own HEAD/index/logs. Write access here is what makes `git commit` (and the pre-commit hook) possible. */
  worktreeGitDir: string;
  /** `<repo>/.git` — shared across every worktree. Only `objects`/`refs` subpaths need write access; the rest (config, HEAD of the main checkout, hooks) stays read-only. */
  commonGitDir: string;
}

function defaultReadFileSync(path: string): string {
  return readFileSync(path, 'utf8');
}

const GITDIR_LINE = /^gitdir:\s*(.+?)\s*$/m;

/**
 * `null` when `worktreePath/.git` isn't a linked-worktree gitfile at all —
 * QA's fresh clone (§15 "env: clone") has a real `.git` *directory*
 * (`readFileSync` on a directory throws `EISDIR`), and a plain non-worktree
 * checkout would too. Callers treat `null` as "nothing extra to grant" —
 * exactly right for reviewer/QA, who must stay read-only there regardless.
 */
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
    // No `commondir` file — not a linked worktree after all (or an older
    // git); treat its own dir as the common dir rather than guessing.
  }

  return { worktreeGitDir, commonGitDir };
}
