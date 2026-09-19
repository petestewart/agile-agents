/**
 * PID/lock file — one long-lived `agiled` per **state home** (D9,
 * design/cockpit-design.md §7.1: "the tool is not a per-repo process").
 *
 * T112: the pidfile is `<home>/agiled.pid`. It used to sit at
 * `<repo>/.agile-daemon.lock`, back when a daemon belonged to a repo; one
 * daemon serving every registered repo means the mutual exclusion it
 * enforces is per-home, and `agile daemon status|stop` (which may run from
 * anywhere, including outside any repo) reads it from the home too.
 * Host/process-instance information, never committed or shared.
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
      `agiled is already running (pid ${holderPid}, lock at ${lockPath}). Stop that daemon first, or remove the lock file if it is stale.`,
    );
    this.name = 'LockError';
  }
}

/**
 * Acquires the per-home daemon lock. Throws `LockError` if a live process
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
