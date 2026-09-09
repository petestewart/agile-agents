import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DAEMON_CACHE_DIR,
  sandboxedSubprocessEnv,
  sandboxedSubprocessEnvOrTemp,
} from './subprocess-env';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'agile-subprocess-env-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('sandboxedSubprocessEnv', () => {
  test('points HOME/npm_config_cache/XDG_* under <repoRoot>/.agile-daemon-cache/<name>/, never the real $HOME', () => {
    const env = sandboxedSubprocessEnv(repoRoot, 'test-run');
    const cacheRoot = join(repoRoot, DAEMON_CACHE_DIR, 'test-run');

    expect(env.HOME).toBe(join(cacheRoot, 'home'));
    expect(env.npm_config_cache).toBe(join(cacheRoot, 'npm-cache'));
    expect(env.XDG_CACHE_HOME).toBe(join(cacheRoot, 'xdg-cache'));
    expect(env.XDG_CONFIG_HOME).toBe(join(cacheRoot, 'xdg-config'));
    expect(env.XDG_DATA_HOME).toBe(join(cacheRoot, 'xdg-data'));
    expect(env.XDG_STATE_HOME).toBe(join(cacheRoot, 'xdg-state'));

    expect(env.HOME).not.toBe(process.env.HOME);
  });

  test('creates every cache directory eagerly', () => {
    const env = sandboxedSubprocessEnv(repoRoot, 'docker-probe');
    expect(existsSync(env.HOME as string)).toBe(true);
    expect(existsSync(env.npm_config_cache as string)).toBe(true);
    expect(existsSync(env.XDG_CACHE_HOME as string)).toBe(true);
    expect(existsSync(env.XDG_CONFIG_HOME as string)).toBe(true);
    expect(existsSync(env.XDG_DATA_HOME as string)).toBe(true);
    expect(existsSync(env.XDG_STATE_HOME as string)).toBe(true);
  });

  test('namespaces different callers under different <name> subdirectories', () => {
    const a = sandboxedSubprocessEnv(repoRoot, 'test-run');
    const b = sandboxedSubprocessEnv(repoRoot, 'git');
    expect(a.HOME).not.toBe(b.HOME);
  });

  test('preserves PATH and the rest of process.env', () => {
    const env = sandboxedSubprocessEnv(repoRoot, 'test-run');
    expect(env.PATH).toBe(process.env.PATH);
  });

  test('never overrides GIT_CONFIG_GLOBAL — whatever the caller already has (set or unset) passes through unchanged', () => {
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = undefined;
    try {
      const env = sandboxedSubprocessEnv(repoRoot, 'git');
      expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    } finally {
      if (original !== undefined) process.env.GIT_CONFIG_GLOBAL = original;
    }
  });

  test('passes an already-set GIT_CONFIG_GLOBAL through untouched', () => {
    const original = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = '/dev/null';
    try {
      const env = sandboxedSubprocessEnv(repoRoot, 'git');
      expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    } finally {
      if (original === undefined) {
        process.env.GIT_CONFIG_GLOBAL = undefined;
      } else {
        process.env.GIT_CONFIG_GLOBAL = original;
      }
    }
  });
});

describe('sandboxedSubprocessEnvOrTemp (review round 1 B2 fix)', () => {
  test('with a repoRoot, behaves exactly like sandboxedSubprocessEnv and cleanup() is a no-op', () => {
    const { env, cleanup } = sandboxedSubprocessEnvOrTemp(repoRoot, 'git');
    const cacheRoot = join(repoRoot, DAEMON_CACHE_DIR, 'git');
    expect(env.HOME).toBe(join(cacheRoot, 'home'));
    cleanup();
    // The repoRoot form has nothing of its own to clean up — the cache dir
    // belongs to the caller, same lifetime as every other
    // `sandboxedSubprocessEnv` caller's cache.
    expect(existsSync(env.HOME as string)).toBe(true);
  });

  test('without a repoRoot, falls back to a fresh mkdtemp under the OS temp dir and never touches process.cwd()', () => {
    const cwdMarker = process.cwd();
    const { env, cleanup } = sandboxedSubprocessEnvOrTemp(undefined, 'git');
    try {
      expect(env.HOME?.startsWith(cwdMarker)).toBe(false);
      expect(env.HOME?.startsWith(tmpdir())).toBe(true);
      expect(existsSync(env.HOME as string)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('cleanup() removes the no-repoRoot temp directory entirely', () => {
    const { env, cleanup } = sandboxedSubprocessEnvOrTemp(undefined, 'git');
    const tempBase = join(env.HOME as string, '..', '..', '..');
    expect(existsSync(tempBase)).toBe(true);
    cleanup();
    expect(existsSync(tempBase)).toBe(false);
  });

  test('two concurrent no-repoRoot calls never collide on the same directory', () => {
    const a = sandboxedSubprocessEnvOrTemp(undefined, 'git');
    const b = sandboxedSubprocessEnvOrTemp(undefined, 'git');
    try {
      expect(a.env.HOME).not.toBe(b.env.HOME);
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test('QA round 3 (T037 REJECT, blocker): an injected tempDirBase is used instead of the real OS temp dir, and cleanup only removes the injected dir', () => {
    const injectedBase = mkdtempSync(join(tmpdir(), 'agile-subprocess-env-injected-'));
    try {
      const { env, cleanup } = sandboxedSubprocessEnvOrTemp(undefined, 'git', injectedBase);
      try {
        expect(env.HOME?.startsWith(injectedBase)).toBe(true);
        expect(env.HOME?.startsWith(tmpdir())).toBe(injectedBase.startsWith(tmpdir()));
      } finally {
        cleanup();
      }
      // The injected base directory itself is the caller's own — only the
      // mkdtemp'd subdirectory this call created inside it is removed.
      expect(existsSync(injectedBase)).toBe(true);
    } finally {
      rmSync(injectedBase, { recursive: true, force: true });
    }
  });
});
