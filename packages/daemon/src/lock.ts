/**
 * PID/lock file: one long-lived `agiled` per state home (D9, §7.1), at
 * `<home>/agiled.pid`, so `agile daemon status|stop` can find it from
 * anywhere.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 only checks existence and permission.
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

/** Acquires the per-home lock: `LockError` if a live process holds it; a stale lock is reclaimed. */
export function acquireLock(lockPath: string): LockHandle {
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const holderPid = Number.parseInt(raw, 10);
    if (Number.isFinite(holderPid) && isProcessAlive(holderPid)) {
      throw new LockError(lockPath, holderPid);
    }
    // Stale: the holder is gone.
    unlinkSync(lockPath);
  }

  try {
    writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
  } catch (err) {
    // Lost a race reclaiming the same stale lock: report it like a live holder.
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
        // Only if still ours: don't clobber a lock another process now holds.
        const raw = readFileSync(lockPath, 'utf8').trim();
        if (raw === String(process.pid)) {
          unlinkSync(lockPath);
        }
      } catch {
        // Already gone.
      }
    },
  };
}
