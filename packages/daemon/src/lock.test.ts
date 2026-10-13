import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockError, acquireLock, lockHolder } from './lock';

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agile-lock-'));
  lockPath = join(dir, '.agile-daemon.lock');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('acquireLock', () => {
  test('writes the pid to the lock file', () => {
    const lock = acquireLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    expect(existsSync(lockPath)).toBe(true);
    lock.release();
  });

  test('a second acquire fails with a clear error naming the holder pid', () => {
    const first = acquireLock(lockPath);
    expect(() => acquireLock(lockPath)).toThrow(LockError);
    try {
      acquireLock(lockPath);
      throw new Error('expected acquireLock to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LockError);
      expect((err as LockError).message).toContain(String(process.pid));
      expect((err as LockError).message).toContain(lockPath);
    }
    first.release();
  });

  test('release removes the lock file', () => {
    const lock = acquireLock(lockPath);
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('release is idempotent', () => {
    const lock = acquireLock(lockPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  test('reclaims a stale lock left by a dead pid', async () => {
    // A pid that (almost certainly) does not exist: current pid space max
    // is well below this on every platform Bun runs on.
    const deadPid = 999_999_999;
    await Bun.write(lockPath, String(deadPid));
    const lock = acquireLock(lockPath);
    expect(lock.pid).toBe(process.pid);
    lock.release();
  });

  test('after release, a fresh acquire succeeds', () => {
    const first = acquireLock(lockPath);
    first.release();
    const second = acquireLock(lockPath);
    expect(second.pid).toBe(process.pid);
    second.release();
  });
});

describe('T533: a lock taken while starting', () => {
  test('holds the lock but names no started pid until published', () => {
    const lock = acquireLock(lockPath, { starting: true });
    expect(readFileSync(lockPath, 'utf8')).toBe(`starting ${process.pid}`);
    expect(lockHolder(lockPath)).toEqual({ pid: process.pid, started: false });
    // A second daemon is refused while the first is still starting.
    expect(() => acquireLock(lockPath)).toThrow(LockError);
    expect(() => acquireLock(lockPath, { starting: true })).toThrow(LockError);

    lock.publish();
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    expect(lockHolder(lockPath)).toEqual({ pid: process.pid, started: true });
    expect(() => acquireLock(lockPath)).toThrow(LockError);
    lock.publish(); // idempotent
    // The atomic write left no temp file next to the lock.
    expect(readdirSync(dir)).toEqual(['.agile-daemon.lock']);

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
    expect(lockHolder(lockPath)).toBeUndefined();
  });

  test('released before publishing, the file is gone', () => {
    const lock = acquireLock(lockPath, { starting: true });
    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test('a starting lock whose holder died is reclaimed', () => {
    writeFileSync(lockPath, 'starting 999999999');
    expect(lockHolder(lockPath)).toBeUndefined();
    const lock = acquireLock(lockPath, { starting: true });
    expect(lockHolder(lockPath)).toEqual({ pid: process.pid, started: false });
    lock.release();
  });

  test('publishing a lock that is no longer ours fails and leaves the other holder alone', () => {
    const lock = acquireLock(lockPath, { starting: true });
    // Removed by hand, and taken by another daemon (pid 1 is always alive).
    rmSync(lockPath);
    writeFileSync(lockPath, '1');
    expect(() => lock.publish()).toThrow(/lost its lock/);
    lock.release();
    expect(readFileSync(lockPath, 'utf8')).toBe('1');
  });
});
