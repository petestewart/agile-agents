import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LockError, acquireLock } from './lock';

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
