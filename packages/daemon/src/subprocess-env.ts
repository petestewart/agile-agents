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

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** A `sandboxedSubprocessEnvOrTemp` call's env plus how to release whatever it had to create just for this one call — see its doc comment. */
export interface SandboxedSubprocessEnvOrTemp {
  env: Record<string, string>;
  /** Removes the call's own temp directory. A no-op when `repoRoot` was given: that cache directory belongs to the caller, not this one call (same lifetime as every other `sandboxedSubprocessEnv` caller's cache). */
  cleanup: () => void;
}

/**
 * `sandboxedSubprocessEnv`, for a caller with no real `repoRoot` in hand yet
 * — either because the call this env is *for* is itself how a repo root
 * gets discovered (`config.ts`'s bootstrap `git rev-parse
 * --show-toplevel`, `merge/precommit.ts`'s `git rev-parse
 * --git-common-dir`), or because the caller has no repo to root under at
 * all (`sandbox/backend.ts`'s bare, no-args `dockerProbeEnv`/`binaryOnPath`
 * calls).
 *
 * When `repoRoot` is given, this is exactly `sandboxedSubprocessEnv` with a
 * no-op `cleanup`. When omitted, it `mkdtempSync`s a fresh, uid/pid-unique
 * directory under the OS temp dir instead — review round 2 (T034, on
 * `sandbox/backend.ts`'s `dockerProbeEnv`, the first caller of this shape):
 * a *fixed* `os.tmpdir()/.agile-daemon-cache/<name>/` path is exactly as
 * unsafe as writing into the caller's own cwd, just world-shared instead —
 * any other process on the host can occupy it first (a regular file,
 * another uid's directory, a symlink). A fresh `mkdtempSync` per call has
 * nothing else on the host already occupying it, and `cleanup()` removes it
 * once the one-shot call is done with it.
 *
 * `sandbox/backend.ts`'s `dockerProbeEnv` is this function under a fixed
 * `'sandbox-detect'` name, kept as its own export (T026) for that module's
 * own call sites and tests; this generalizes the same shape for T037's
 * bootstrap-probe callers instead of a fourth near-copy.
 *
 * QA round 3 (T037 REJECT, blocker): `tempDirBase` — where the no-repo-root
 * `mkdtempSync` is rooted — defaults to `os.tmpdir()` but is dependency-
 * injectable, the same shape `detectBackend` already takes a `deps` object
 * for. This exists *only* so a test can isolate itself from the real,
 * shared OS temp directory by passing its own `mkdtempSync`'d directory —
 * QA found (with `strace`, reproduced 3/3 full-suite runs) that the
 * previous approach (a test-local `process.env.TMPDIR` mutation) is not
 * reliably honoured by `os.tmpdir()` under full-suite concurrency (many
 * test files running in one process), so `sandbox/backend.test.ts`'s "old
 * fixed path occupied" regression tests ended up squatting on the real
 * `/tmp/.agile-daemon-cache/sandbox-detect` themselves — exactly the
 * collision this module exists to prevent. Dependency injection has no
 * such race: no shared mutable process state is involved at all.
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
        // Best-effort — a leaked one-shot temp dir under the OS temp
        // directory is not a correctness bug.
      }
    },
  };
}
