/**
 * Config discovery (§7.1, §7.5). Neither resolver touches a repo: the
 * daemon is one process for every registered repo, so the operator's cwd
 * is not an input (`agile daemon start` from `/tmp` starts a daemon).
 * `resolveHomePaths` gives port, socket, pidfile and log paths from the
 * home alone; `discoverConfig` packages them as `AgileConfig`. Precedence,
 * lowest first: `<home>/config.yaml`, the environment, explicit options.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ClassifierConfig,
  DEFAULT_DAEMON_PORT,
  type HomeConfig,
  validateClassifierConfig,
  validateHomeConfig,
} from '@agile-agents/shared';
import { parse as parseYaml } from 'yaml';

export interface AgileConfig {
  /** The state home (D9): `$AGILE_HOME`, else `~/.agile/`. */
  home: string;
  /** Alias for `home`: the root every store path is relative to. */
  stateRoot: string;
  /** HTTP port; 0 lets the OS pick. */
  port: number;
  /** Unix socket for the JSON-RPC API. */
  socketPath: string;
  /** PID/lock file (see lock.ts). */
  lockPath: string;
  /** The classifier tier's config (§6.2, D5), defaults applied; "not configured" is `off` or no key. */
  classifier: ClassifierConfig;
}

/** The state home (D9): `$AGILE_HOME`, else `~/.agile/`. Nothing daemon-owned is written inside a repo. */
export function stateHome(): string {
  return process.env.AGILE_HOME ?? join(homedir(), '.agile');
}

/** `<home>/config.yaml`. */
export const HOME_CONFIG_FILE_NAME = 'config.yaml';

/** Everything a client needs to reach the daemon, from the home alone (§7.1): "which daemon" is the home's answer. */
export interface HomePaths {
  /** The state home. */
  home: string;
  /** HTTP port for the cockpit/API. */
  port: number;
  /** Unix socket path for the JSON-RPC API. */
  socketPath: string;
  /** Pidfile: one daemon per home. */
  pidPath: string;
  /** `<home>/log/`. */
  logDir: string;
  /** `<home>/log/agiled.log`: the detached daemon's stdout+stderr. */
  logPath: string;
  /** `<home>/log/events.jsonl`: the event log `agile tail` reads. */
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
  /** Overrides applied last (tests and CLI flags). */
  port?: number;
  socketPath?: string;
  /** The state home (env `AGILE_HOME`, default `~/.agile/`). */
  home?: string;
}

/** The daemon's config: `resolveHomePaths` plus the classifier block. */
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
    classifier: validateClassifierConfig(readHomeConfigFile(home).classifier),
  };
}
