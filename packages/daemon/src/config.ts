/**
 * Config discovery (design/agile-agents-design.md §18 "Technical shape").
 *
 * Walks up from cwd to the git toplevel, then reads an optional
 * `agile.config.yaml` at the repo root plus env overrides. Kept minimal:
 * the only settings v0 needs are the daemon's HTTP port and unix socket
 * path, and the state root itself.
 *
 * DESIGN-GAP: the design does not specify a config file name or shape;
 * `agile.config.yaml` with `{ port?, socketPath? }` is the smallest thing
 * that satisfies "config discovery" in the T004 scope line.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { sandboxedSubprocessEnvOrTemp } from './subprocess-env';

/**
 * Host-local Jira link settings (T045, §17 v2 "Jira is two-way sync"). Only
 * the *non-secret* half lives in `agile.config.yaml`: the credentials
 * (`JIRA_EMAIL`, `JIRA_API_TOKEN`) are read from the operator's environment
 * and never written anywhere under `.agile/`, per the ticket scope.
 */
export interface JiraConfig {
  /** e.g. `https://acme.atlassian.net` (env: `JIRA_BASE_URL`). */
  baseUrl?: string;
  /**
   * The linked Jira project key, e.g. `LED` (env: `JIRA_PROJECT_KEY`).
   * Written by `agile sync jira link|unlink` — this file, not anything under
   * `.agile/`, is where "which project is this repo linked to" lives. A
   * project key is not a secret; the credentials never come from here.
   */
  project?: string;
  /** Poll cadence for the pull direction (env: `JIRA_POLL_INTERVAL_MS`). */
  pollIntervalMs?: number;
}

export interface AgileConfig {
  /** Repo toplevel (git rev-parse --show-toplevel), i.e. where `.agile/` lives. */
  repoRoot: string;
  /** `<repoRoot>/.agile` — the state worktree root. */
  stateRoot: string;
  /** HTTP port for the localhost UI/CLI API. 0 lets the OS pick an ephemeral port. */
  port: number;
  /** Unix socket path for the JSON-RPC bus/state/hook/gate API. */
  socketPath: string;
  /** PID/lock file path — see lock.ts for why it lives outside `.agile/`. */
  lockPath: string;
  /** T045: `jira:` block from `agile.config.yaml`, overlaid with env. Absent when nothing is configured. */
  jira?: JiraConfig;
}

const DEFAULT_PORT = 4600;
export const CONFIG_FILE_NAME = 'agile.config.yaml';

interface RawConfigFile {
  port?: number;
  socketPath?: string;
  jira?: JiraConfig;
}

function findRepoRoot(startDir: string, tempDirBase?: string): string {
  // Review round 1 blocker B2: this call is what *discovers* the repo
  // root, so there's no `repoRoot` in hand yet to sandbox under — an
  // earlier version used `startDir` itself, which materializes
  // `<startDir>/.agile-daemon-cache/` even when `startDir` isn't inside any
  // repo at all (e.g. `agile status` run from the operator's own `$HOME`),
  // and leaves it behind even though this call then throws. Fixed with
  // `sandboxedSubprocessEnvOrTemp`'s no-repo-root fallback (the same
  // `mkdtempSync` + `cleanup()` shape `sandbox/backend.ts`'s
  // `dockerProbeEnv` already uses for its own "no repo root in hand"
  // case): a fresh, uid/pid-unique temp directory instead of the caller's
  // own cwd, removed again once this one bootstrap call is done with it.
  //
  // Review round 3 blocker B3: `tempDirBase` (defaults to `os.tmpdir()` via
  // `sandboxedSubprocessEnvOrTemp` itself, same DI seam T037 round 4 built
  // for `sandbox/backend.ts`) exists purely so a test can point this at its
  // own `mkdtempSync`'d directory instead of the real, shared OS temp dir —
  // round 3's own non-repo-leak regression test used to snapshot
  // `readdirSync(tmpdir())` before/after and assert no *other* entry
  // appeared, which is racy against every other process (and every other
  // test file in the same `bun test` run) also using the real temp dir.
  const probe = sandboxedSubprocessEnvOrTemp(undefined, 'git', tempDirBase);
  try {
    const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
      cwd: startDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: probe.env,
    });
    if (result.exitCode !== 0) {
      const stderr = new TextDecoder().decode(result.stderr).trim();
      throw new Error(`not a git repository (looked from ${startDir}): ${stderr}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
  } finally {
    probe.cleanup();
  }
}

function readConfigFile(repoRoot: string): RawConfigFile {
  const configPath = join(repoRoot, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return {};
  }
  const raw = readFileSync(configPath, 'utf8');
  const parsed = parseYaml(raw);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE_NAME} must be a mapping, got ${typeof parsed}`);
  }
  return parsed as RawConfigFile;
}

export interface DiscoverConfigOptions {
  cwd?: string;
  /** Overrides applied after file + env — used by tests and CLI flags. */
  port?: number;
  socketPath?: string;
  /**
   * Test-only seam (review round 3 B3): overrides where `findRepoRoot`'s
   * no-repo-root sandbox fallback `mkdtempSync`s its temp directory —
   * defaults to `os.tmpdir()`. Production never sets this; a test points it
   * at its own `mkdtempSync`'d directory so it can assert *that* directory
   * (never the real, shared OS temp dir) is empty afterwards.
   */
  tempDirBase?: string;
}

/**
 * Precedence (highest first): explicit `options`, env vars
 * (`AGILE_PORT`, `AGILE_SOCKET_PATH`), `agile.config.yaml`, built-in default.
 */
export function discoverConfig(options: DiscoverConfigOptions = {}): AgileConfig {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(cwd, options.tempDirBase);
  const stateRoot = join(repoRoot, '.agile');
  const fileConfig = readConfigFile(repoRoot);

  const envPort = process.env.AGILE_PORT ? Number(process.env.AGILE_PORT) : undefined;
  const port = options.port ?? envPort ?? fileConfig.port ?? DEFAULT_PORT;

  const defaultSocketPath = join(repoRoot, '.agile-daemon.sock');
  const socketPath =
    options.socketPath ??
    process.env.AGILE_SOCKET_PATH ??
    fileConfig.socketPath ??
    defaultSocketPath;

  // See lock.ts for why this lives at the repo root, not inside `.agile/`.
  const lockPath = join(repoRoot, '.agile-daemon.lock');

  // T045: env wins over the file, same precedence as `port`/`socketPath`
  // above. Credentials are *not* read here — `sync/config.ts` pulls
  // `JIRA_EMAIL`/`JIRA_API_TOKEN` straight from the environment so they
  // never live on an object that anything might serialise into `.agile/`.
  const envPollInterval = process.env.JIRA_POLL_INTERVAL_MS
    ? Number(process.env.JIRA_POLL_INTERVAL_MS)
    : undefined;
  const jira: JiraConfig = {
    ...(fileConfig.jira ?? {}),
    ...(process.env.JIRA_BASE_URL ? { baseUrl: process.env.JIRA_BASE_URL } : {}),
    ...(process.env.JIRA_PROJECT_KEY ? { project: process.env.JIRA_PROJECT_KEY } : {}),
    ...(envPollInterval !== undefined && Number.isFinite(envPollInterval)
      ? { pollIntervalMs: envPollInterval }
      : {}),
  };

  return {
    repoRoot,
    stateRoot,
    port,
    socketPath,
    lockPath,
    ...(Object.keys(jira).length > 0 ? { jira } : {}),
  };
}
