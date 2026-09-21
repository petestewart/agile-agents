/**
 * Config discovery (design/cockpit-design.md §7.1, §7.5).
 *
 * Two resolvers live here, and neither one touches a repo:
 *
 *  - `resolveHomePaths` — port, socket, pidfile and log paths from the state
 *    home alone (T112, D9). No repo needed; this is what a client with no
 *    repo cwd uses to find the one long-lived daemon.
 *  - `discoverConfig` — the same paths, packaged as the `AgileConfig` the
 *    daemon starts from.
 *
 * T125: the per-repo `agile.config.yaml` overlay and the `git rev-parse
 * --show-toplevel` probe that used to find the repo it lived in are both
 * gone — §7.5 deletes "the host-local `.agile-daemon.lock` /
 * `.agile-daemon.sock` / `agile.config.yaml` triple". The daemon is one
 * process for every *registered* repo (`repos.yaml`), so the directory the
 * operator happens to be standing in when they run `agile daemon start` is
 * not an input at all: `agile daemon start` from `/tmp` starts a daemon.
 * Config comes from `<home>/config.yaml`, the environment and explicit
 * options, in that order of increasing precedence.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DAEMON_PORT, type HomeConfig, validateHomeConfig } from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';

export interface AgileConfig {
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

export interface DiscoverConfigOptions {
  /** Overrides applied after env + `<home>/config.yaml` — used by tests and CLI flags. */
  port?: number;
  socketPath?: string;
  /** Overrides the state home (env: `AGILE_HOME`, default `~/.agile/`). */
  home?: string;
}

/**
 * Precedence (highest first): explicit `options`, env vars (`AGILE_PORT`,
 * `AGILE_SOCKET_PATH`), `<home>/config.yaml`, built-in default. No git, no
 * cwd, no per-repo file — see this module's header (T125).
 */
export function discoverConfig(options: DiscoverConfigOptions = {}): AgileConfig {
  const home = options.home ?? stateHome();
  const homePaths = resolveHomePaths({
    home,
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.socketPath !== undefined ? { socketPath: options.socketPath } : {}),
  });

  return {
    home,
    stateRoot: home,
    port: homePaths.port,
    socketPath: homePaths.socketPath,
    lockPath: homePaths.pidPath,
  };
}
