/**
 * Config discovery (design/agile-agents-design.md §18 "Technical shape").
 *
 * Two resolvers live here:
 *
 *  - `resolveHomePaths` — port, socket, pidfile and log paths from the state
 *    home alone (T112, D9). No repo needed; this is what a client with no
 *    repo cwd uses to find the one long-lived daemon.
 *  - `discoverConfig` — the above plus the git toplevel of the cwd and the
 *    optional per-repo `agile.config.yaml` overlay, for the code paths that
 *    genuinely operate on a repo.
 *
 * DESIGN-GAP: the design does not specify a config file name or shape;
 * `agile.config.yaml` with `{ port?, socketPath? }` is the smallest thing
 * that satisfies "config discovery" in the T004 scope line.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DAEMON_PORT, type HomeConfig, validateHomeConfig } from '@agile-agents/shared';
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
  /** Repo toplevel (git rev-parse --show-toplevel) the command was run from. */
  repoRoot: string;
  /**
   * The state home (T111, PLAN.md §5, D9): `AGILE_HOME` if set, else
   * `~/.agile/`. One home serves every registered repo; nothing is written
   * under the repo any more.
   */
  home: string;
  /** Alias for `home` — the root every store path is relative to. */
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

/**
 * The state home (T111, PLAN.md §5, D9): `$AGILE_HOME` if set, else
 * `~/.agile/`. One home serves every registered repo; nothing daemon-owned
 * is ever written inside a repo. Exported so the handful of callers that
 * only have a repo root in hand (the runner's brief assembly, the
 * pre-commit hook renderer) resolve the same home as `discoverConfig`.
 */
export function stateHome(): string {
  return process.env.AGILE_HOME ?? join(homedir(), '.agile');
}
export const CONFIG_FILE_NAME = 'agile.config.yaml';

/** `<home>/config.yaml` — the state home's own config (T112). */
export const HOME_CONFIG_FILE_NAME = 'config.yaml';

/**
 * Everything a client needs to reach the daemon, resolved from the state
 * home **alone** — no repo cwd (T112, design/cockpit-design.md §7.1). This
 * is what `agile status`/`agile tail`/`agile daemon status` use: the daemon
 * is one process for every registered repo, so "which daemon" is a question
 * the home answers, not the directory the operator happens to be standing
 * in.
 */
export interface HomePaths {
  /** The state home itself (`$AGILE_HOME`, default `~/.agile/`). */
  home: string;
  /** HTTP port for the cockpit/API. */
  port: number;
  /** Unix socket path for the JSON-RPC API. */
  socketPath: string;
  /** Pidfile for the detached daemon — in the home, one daemon per home. */
  pidPath: string;
  /** `<home>/log/` — where the detached daemon's stdio is redirected. */
  logDir: string;
  /** `<home>/log/agiled.log` — the detached daemon's stdout+stderr. */
  logPath: string;
  /** `<home>/log/events.jsonl` — the append-only event log `agile tail` reads. */
  eventsPath: string;
}

/** Reads `<home>/config.yaml` through the strict schema. Missing file = `{}`. */
export function readHomeConfigFile(home: string): HomeConfig {
  const path = join(home, HOME_CONFIG_FILE_NAME);
  if (!existsSync(path)) return {};
  const parsed = parseYaml(readFileSync(path, 'utf8'));
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path}: ${HOME_CONFIG_FILE_NAME} must be a mapping, got ${typeof parsed}`);
  }
  return validateHomeConfig(parsed);
}

export interface ResolveHomePathsOptions {
  home?: string;
  port?: number;
  socketPath?: string;
}

/**
 * Precedence (highest first): explicit options, env (`AGILE_PORT`,
 * `AGILE_SOCKET_PATH`), `<home>/config.yaml`, built-in default.
 */
export function resolveHomePaths(options: ResolveHomePathsOptions = {}): HomePaths {
  const home = options.home ?? stateHome();
  const file = readHomeConfigFile(home);
  const envPort = process.env.AGILE_PORT ? Number(process.env.AGILE_PORT) : undefined;
  const port = options.port ?? envPort ?? file.port ?? DEFAULT_DAEMON_PORT;
  const socketPath =
    options.socketPath ??
    process.env.AGILE_SOCKET_PATH ??
    file.socketPath ??
    join(home, 'agiled.sock');
  const logDir = join(home, 'log');
  return {
    home,
    port,
    socketPath,
    pidPath: join(home, 'agiled.pid'),
    logDir,
    logPath: join(logDir, 'agiled.log'),
    eventsPath: join(logDir, 'events.jsonl'),
  };
}

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
  /** Overrides the state home (env: `AGILE_HOME`, default `~/.agile/`). */
  home?: string;
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
  const home = options.home ?? stateHome();
  const stateRoot = home;
  const fileConfig = readConfigFile(repoRoot);

  // T112 (D9): the port, the socket and the pidfile belong to the *home*,
  // not to a repo — one long-lived daemon serves every registered repo, and
  // a client with no repo cwd has to be able to find it (`resolveHomePaths`,
  // which `agile status`/`agile daemon *` use on their own). The per-repo
  // `agile.config.yaml` stays an overlay between the env and the home for an
  // operator who wants a repo-specific socket or port.
  const homePaths = resolveHomePaths({ home });
  const envPort = process.env.AGILE_PORT ? Number(process.env.AGILE_PORT) : undefined;
  const port = options.port ?? envPort ?? fileConfig.port ?? homePaths.port;
  const socketPath =
    options.socketPath ??
    process.env.AGILE_SOCKET_PATH ??
    fileConfig.socketPath ??
    homePaths.socketPath;

  const lockPath = homePaths.pidPath;

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
    home,
    stateRoot,
    port,
    socketPath,
    lockPath,
    ...(Object.keys(jira).length > 0 ? { jira } : {}),
  };
}
