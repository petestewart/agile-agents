/**
 * `sandboxedSubprocessEnv` — the env every daemon-spawned *non-vendor*
 * subprocess (test runners, `docker info`/`sandbox-exec` probes, the
 * `git` plumbing under `merge/` and `runner/worktrees.ts`) runs with, so
 * the daemon never writes into the real operator's `$HOME` (T021 round 5,
 * QA round 4 finding 6: `npm test`'s own debug logger writes to
 * `$HOME/.npm/_logs` unconditionally, regardless of `cwd` — a demo/offline
 * run was writing into the actual `/root/.npm/_logs` on every ticket
 * merge; T034 found the same shape of leak in `test_run` and the tier-0
 * `docker info` backend probe, both of which ran with the real, inherited
 * `process.env` before this module existed).
 *
 * `HOME` and everything a package manager's own config/cache resolution
 * keys off (`npm_config_cache`, the `XDG_*` base-directory vars a growing
 * set of CLIs read even outside a strict XDG-following OS) point under
 * `<repoRoot>/.agile-daemon-cache/<name>/` instead — `name` namespaces one
 * caller's cache from another's (`test-run`, `git`, `sandbox-detect`, ...)
 * so two different subprocess kinds never share one `$HOME` and can't
 * stomp each other's config/cache files. Every directory is created
 * eagerly so a tool that assumes its config dir already exists (rather
 * than creating it on first write) doesn't fail outright. `PATH` and the
 * rest of `process.env` are preserved unchanged — including
 * `GIT_CONFIG_GLOBAL` when a caller (or the test preload) has already set
 * it; this module never touches that var itself, so production never
 * relies on it being set while a test environment that does set it keeps
 * working exactly as before.
 *
 * Sibling precedent: `store/git.ts` is this same shape of small, focused
 * daemon module living beside the domain it serves rather than folded into
 * one particular caller — this one started life inline in
 * `merge/owner.ts` (T021) and is promoted here so `tools/test-run.ts`,
 * `sandbox/backend.ts`, `merge/git.ts` and `runner/worktrees.ts` share one
 * implementation instead of five near-identical copies (T034).
 *
 * Vendor ACP session spawns (`runner/session.ts` / `acp-client`) never use
 * this — they keep the operator's real `HOME` because the vendor CLI needs
 * its own login/credential store there; see `runner/session.test.ts`'s
 * "vendor session env keeps the real HOME" test.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** `.agile-daemon-cache/` under `repoRoot` — the daemon's own host-local scratch space, gitignored, never the operator's real `$HOME`. */
export const DAEMON_CACHE_DIR = '.agile-daemon-cache';

/**
 * Builds the sandboxed env for a subprocess of kind `name`, creating its
 * cache directories under `<repoRoot>/.agile-daemon-cache/<name>/` if they
 * don't already exist.
 */
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
  };
}
