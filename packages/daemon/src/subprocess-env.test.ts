import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DAEMON_CACHE_DIR, sandboxedSubprocessEnv } from './subprocess-env';

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
