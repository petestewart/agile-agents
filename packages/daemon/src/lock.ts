/**
 * PID/lock file: one long-lived `agiled` per state home (D9, §7.1), at
 * `<home>/agiled.pid`, so `agile daemon status|stop` can find it from
 * anywhere.
 *
 * T533: the daemon takes the lock before anything reads or writes the home,
 * but a daemon that is starting is not a started one: `agile daemon start`
 * reports a daemon up when the file names a live pid, so that must wait until
 * the port is bound (T127). A lock taken `starting` reads `starting <pid>`:
 * already the lock (a second daemon is refused), not yet the pidfile.
 * `publish()` makes it the bare pid.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { atomicWriteFile } from './store/fs';

export interface LockHandle {
  readonly path: string;
  readonly pid: number;
  /** T533: a lock taken `starting` becomes the pidfile (the bare pid). Idempotent. */
  publish(): void;
  release(): void;
}

/** What a lock file says while its holder is still starting (T533). */
const STARTING_PREFIX = 'starting ';

/** Who a lock file names: a pid, and whether it is up (the bare pid) or still starting. */
export interface LockHolder {
  pid: number;
  started: boolean;
}

function parseLock(raw: string): LockHolder | undefined {
  const match = /^(starting )?(\d+)$/.exec(raw.trim());
  if (match === null) return undefined;
  return { pid: Number(match[2]), started: match[1] === undefined };
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

/**
 * The live process holding the lock at `lockPath`, started or still starting;
 * `undefined` when there is none (no file, an unreadable one, or a dead holder).
 */
export function lockHolder(lockPath: string): LockHolder | undefined {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return undefined;
  }
  const holder = parseLock(raw);
  return holder !== undefined && isProcessAlive(holder.pid) ? holder : undefined;
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

export interface AcquireLockOptions {
  /** T533: take the lock without publishing the pid; `publish()` does that later. */
  starting?: boolean;
}

/** Acquires the per-home lock: `LockError` if a live process holds it; a stale lock is reclaimed. */
export function acquireLock(lockPath: string, options: AcquireLockOptions = {}): LockHandle {
  if (existsSync(lockPath)) {
    const holder = parseLock(readFileSync(lockPath, 'utf8'));
    if (holder !== undefined && isProcessAlive(holder.pid)) {
      throw new LockError(lockPath, holder.pid);
    }
    // Stale: the holder is gone (it may have died starting).
    unlinkSync(lockPath);
  }

  const pid = String(process.pid);
  try {
    writeFileSync(lockPath, options.starting === true ? `${STARTING_PREFIX}${pid}` : pid, {
      flag: 'wx',
    });
  } catch (err) {
    // Lost a race reclaiming the same stale lock: report it like a live holder.
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const holderPid = parseLock(readFileSync(lockPath, 'utf8'))?.pid ?? Number.NaN;
      throw new LockError(lockPath, holderPid);
    }
    throw err;
  }

  let published = options.starting !== true;
  let released = false;
  /** The file still names this process (started or starting). */
  const ours = (): boolean => {
    try {
      return parseLock(readFileSync(lockPath, 'utf8'))?.pid === process.pid;
    } catch {
      return false; // Already gone.
    }
  };
  return {
    path: lockPath,
    pid: process.pid,
    publish() {
      if (published) return;
      if (released || !ours()) {
        throw new Error(`agiled lost its lock at ${lockPath} while starting`);
      }
      // Atomic (temp file + rename): a second daemon reading it mid-write would
      // otherwise see an empty file and reclaim it as stale.
      atomicWriteFile(lockPath, pid);
      published = true;
    },
    release() {
      if (released) return;
      released = true;
      // Only if still ours: don't clobber a lock another process now holds.
      if (ours()) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone.
        }
      }
    },
  };
}
