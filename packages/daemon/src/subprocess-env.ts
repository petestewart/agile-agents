/**
 * `sandboxedSubprocessEnv`: the env for every daemon-spawned non-vendor
 * subprocess (test runners, sandbox probes, git plumbing), so the daemon
 * never writes into the operator's real `$HOME` (`npm test`'s debug logger
 * once wrote `$HOME/.npm/_logs` on every run).
 *
 * `HOME`, `npm_config_cache` and the `XDG_*` dirs point under
 * `<repoRoot>/.agile-daemon-cache/<name>/`, one namespace per kind of
 * caller, all created eagerly. `PATH` and the rest of `process.env`
 * (including a preset `GIT_CONFIG_GLOBAL`) pass through unchanged.
 *
 * `GIT_TERMINAL_PROMPT=0`: the daemon has no terminal, so a git that
 * wants a credential fails at once rather than hanging (T231).
 *
 * Vendor sessions never use this: their CLI needs the real `HOME` for its
 * login.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The daemon's host-local scratch space under `repoRoot` (gitignored). */
export const DAEMON_CACHE_DIR = '.agile-daemon-cache';

/** The sandboxed env for a subprocess of kind `name`, creating its dirs. */
export function sandboxedSubprocessEnv(repoRoot: string, name: string): Record<string, string> {
  const cacheRoot = join(repoRoot, DAEMON_CACHE_DIR, name);
  const home = join(cacheRoot, 'home');
  const npmCache = join(cacheRoot, 'npm-cache');
  const xdgCache = join(cacheRoot, 'xdg-cache');
  const xdgConfig = join(cacheRoot, 'xdg-config');
  const xdgData = join(cacheRoot, 'xdg-data');
  const xdgState = join(cacheRoot, 'xdg-state');
  for (const dir of [home, npmCache, xdgCache, xdgConfig, xdgData, xdgState]) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    ...process.env,
    HOME: home,
    npm_config_cache: npmCache,
    XDG_CACHE_HOME: xdgCache,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_DATA_HOME: xdgData,
    XDG_STATE_HOME: xdgState,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** The env plus how to release anything created for this one call. */
export interface SandboxedSubprocessEnvOrTemp {
  env: Record<string, string>;
  /** Removes the call's own temp dir; a no-op when `repoRoot` was given (that cache is the caller's). */
  cleanup: () => void;
}

/**
 * `sandboxedSubprocessEnv` for a caller with no repo root (a bootstrap
 * `git rev-parse`, a sandbox probe). Without one it `mkdtempSync`s a fresh
 * dir per call: a fixed shared temp path could be pre-occupied by another
 * process. `tempDirBase` is injectable so tests stay out of the real
 * `/tmp` (a `TMPDIR` mutation isn't reliably honoured under full-suite
 * concurrency).
 */
export function sandboxedSubprocessEnvOrTemp(
  repoRoot: string | undefined,
  name: string,
  tempDirBase: string = tmpdir(),
): SandboxedSubprocessEnvOrTemp {
  if (repoRoot !== undefined) {
    return { env: sandboxedSubprocessEnv(repoRoot, name), cleanup: () => {} };
  }
  const tempBase = mkdtempSync(join(tempDirBase, `agile-daemon-${name}-`));
  return {
    env: sandboxedSubprocessEnv(tempBase, name),
    cleanup: () => {
      try {
        rmSync(tempBase, { recursive: true, force: true });
      } catch {
        // Best effort: a leaked one-shot temp dir is not a correctness bug.
      }
    },
  };
}
