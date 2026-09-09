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
import { sandboxedSubprocessEnv } from './subprocess-env';

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
}

const DEFAULT_PORT = 4600;
const CONFIG_FILE_NAME = 'agile.config.yaml';

interface RawConfigFile {
  port?: number;
  socketPath?: string;
}

function findRepoRoot(startDir: string): string {
  // No repo root is known yet — this call is what discovers it — so `startDir`
  // (the closest thing on hand, per the caller's own cwd) is used as the
  // sandbox cache root instead, same shape as `dockerProbeEnv`'s no-repo-root
  // fallback.
  const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
    cwd: startDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: sandboxedSubprocessEnv(startDir, 'git'),
  });
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`not a git repository (looked from ${startDir}): ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).trim();
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
}

/**
 * Precedence (highest first): explicit `options`, env vars
 * (`AGILE_PORT`, `AGILE_SOCKET_PATH`), `agile.config.yaml`, built-in default.
 */
export function discoverConfig(options: DiscoverConfigOptions = {}): AgileConfig {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(cwd);
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

  return { repoRoot, stateRoot, port, socketPath, lockPath };
}
