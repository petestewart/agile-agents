/**
 * PID/lock file — one `agiled` per repo (design/agile-agents-design.md §15
 * "Git model and teams": "One daemon per repo (it locks the state worktree
 * at start)").
 *
 * Location decision: the lock file lives at `<repo>/.agile-daemon.lock`,
 * *outside* `.agile/` (the state worktree, tracked on the orphan
 * `agile-state` branch). A lock file is host/process-instance information,
 * not repo state — it must never be committed, diffed, or shared between
 * clones, so it does not belong on a branch at all. Keeping it at the repo
 * root (sibling to `.agile/`, `.git/`) also means it exists before `.agile/`
 * does (a daemon can hold the lock while `agile init` runs) and survives
 * `.agile/` being an entirely separate worktree checkout. It is added to the
 * repo's `.gitignore` by `agile init` (see init.ts).
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0: no-op, just checks existence/permission.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false; // no such process
    if (code === 'EPERM') return true; // exists, owned by someone else
    return false;
  }
}

export class LockError extends Error {
  constructor(
    public readonly lockPath: string,
    public readonly holderPid: number,
  ) {
    super(
      `agiled is already running for this repo (pid ${holderPid}, lock at ${lockPath}). Stop that daemon first, or remove the lock file if it is stale.`,
    );
    this.name = 'LockError';
  }
}

/**
 * Acquires the per-repo daemon lock. Throws `LockError` if a live process
 * already holds it; silently reclaims a stale lock (holder no longer alive).
 */
export function acquireLock(lockPath: string): LockHandle {
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const holderPid = Number.parseInt(raw, 10);
    if (Number.isFinite(holderPid) && isProcessAlive(holderPid)) {
      throw new LockError(lockPath, holderPid);
    }
    // Stale lock: previous holder is gone. Reclaim it.
    unlinkSync(lockPath);
  }

  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    // Lost a race with another process reclaiming the same stale lock —
    // report it the same way a live holder would be reported, not a raw
    // filesystem error.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const holderPid = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
      throw new LockError(lockPath, holderPid);
    }
    throw err;
  }

  let released = false;
  return {
    path: lockPath,
    pid: process.pid,
    release() {
      if (released) return;
      released = true;
      try {
        // Only remove it if it's still ours — don't clobber a lock another
        // process legitimately holds after this one already released.
        const raw = readFileSync(lockPath, 'utf8').trim();
        if (raw === String(process.pid)) {
          unlinkSync(lockPath);
        }
      } catch {
        // Already gone — fine.
      }
    },
  };
}
