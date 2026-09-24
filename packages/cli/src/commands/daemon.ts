/**
 * `agile daemon start|stop|status` (T112 — D9, design/cockpit-design.md
 * §7.1: "started once (`agile daemon start`, detached, pidfile and port in
 * `config.yaml`) and **never exits because work finished**").
 *
 * `start` spawns a detached child that runs the daemon in the foreground
 * (`agile daemon start --foreground`, the same process this file's
 * `runDaemonForeground` serves) with its stdio redirected to
 * `<home>/log/agiled.log`. The child writes the pidfile itself — it holds
 * the per-home lock (`daemon/lock.ts`), so the pidfile and the lock are one
 * file and cannot disagree. The parent waits for that file to appear, prints
 * the pid, and exits; closing the terminal does not take the daemon with it
 * (`detached: true` puts the child in its own process group, so a terminal
 * SIGHUP never reaches it).
 *
 * A second `start` is a no-op that prints the running pid.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import {
  type HomePaths,
  installShutdownSignals,
  readHomeConfigFile,
  resolveHomePaths,
  startDaemon,
} from '@agile-agents/daemon';
import {
  type ClassifierKeyStatus,
  type ResolvedSessionDefaults,
  formatSessionDefaults,
  resolveSessionDefaults,
} from '@agile-agents/shared';
import { callRpc } from '../client';

/** How long `start` waits for the child to write its pidfile before giving up. */
const START_TIMEOUT_MS = 20_000;
/** How long `stop` waits for the daemon to exit after SIGTERM. */
const STOP_TIMEOUT_MS = 10_000;
const POLL_MS = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    return false;
  }
}

/**
 * T210: `$AGILE_HOME` that exists and is not a directory, as one line naming
 * the variable and the path; `undefined` when it is fine (or unset/missing,
 * which `init` creates).
 */
export function agileHomeProblem(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.AGILE_HOME;
  if (!home) return undefined;
  try {
    if (statSync(home).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  return `AGILE_HOME=${home} exists and is not a directory; point AGILE_HOME at a directory (or unset it for ~/.agile/)`;
}

export interface PortHolder {
  pid: number;
  /** The holder's full command line (`ps -o args=`), else lsof's short name. */
  command: string;
  /** Whether the command looks like an `agiled` (a detached `agile daemon start --foreground`). */
  looksLikeAgiled: boolean;
}

/**
 * T210: who listens on `port`, via `lsof` when it is installed. `null` when
 * lsof is unavailable; `undefined` when nothing listens.
 */
export function portHolder(port: number): PortHolder | undefined | null {
  const lsof = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc'], {
    encoding: 'utf8',
  });
  if (lsof.error) return null;
  const lines = (lsof.stdout ?? '').split('\n');
  const pidLine = lines.find((l) => l.startsWith('p'));
  if (!pidLine) return undefined;
  const pid = Number.parseInt(pidLine.slice(1), 10);
  if (!Number.isFinite(pid)) return undefined;
  const short = lines.find((l) => l.startsWith('c'))?.slice(1) ?? '?';
  const ps = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  const command = (ps.stdout ?? '').trim() || short;
  const looksLikeAgiled = /agiled|daemon start --foreground/.test(command);
  return { pid, command, looksLikeAgiled };
}

/** One clause describing the holder of `port`, for an error or hint line. */
export function describePortHolder(
  port: number,
  holder: PortHolder | undefined | null = portHolder(port),
): string {
  if (holder === null)
    return `holder unknown (lsof not available; try: ss -ltnp 'sport = :${port}')`;
  if (holder === undefined) return 'no listener found now';
  return `held by pid ${holder.pid} (${holder.command}), which ${
    holder.looksLikeAgiled
      ? 'looks like another agiled (a daemon from a different AGILE_HOME?)'
      : 'does not look like an agiled'
  }`;
}

/** The pid in `<home>/agiled.pid`, or `undefined` when there is no live daemon. */
export function runningPid(paths: HomePaths): number | undefined {
  if (!existsSync(paths.pidPath)) return undefined;
  const pid = Number.parseInt(readFileSync(paths.pidPath, 'utf8').trim(), 10);
  if (!Number.isFinite(pid)) return undefined;
  return isAlive(pid) ? pid : undefined;
}

/**
 * The detached child's entry point: the daemon in the foreground, for the
 * life of the process. Nothing here ever resolves — the daemon does not exit
 * because work finished; it exits on SIGINT/SIGTERM (`agile daemon stop`).
 */
export async function runDaemonForeground(): Promise<never> {
  // T122: the EM delegate is gone, so every gate whose owner is not the
  // human parks as pending until something decides it (T140's landing path).
  // T125: no cwd — the daemon's config comes from the state home alone, so
  // it starts from any directory, git repo or not.
  /**
   * T127: a daemon that cannot start must *exit*, promptly. Letting the
   * rejection propagate only set `process.exitCode` and left the loop to
   * drain — with a state home open (store flush timer, gate tick, an
   * already-bound listener) the child could stay alive with nothing
   * serving, which is exactly what made `agile daemon start` wait out its
   * full pidfile timeout. One line to stderr (the child's stdio is the
   * home's log, which is where `start` reads the reason from) and out.
   */
  let handle: Awaited<ReturnType<typeof startDaemon>>;
  try {
    handle = await startDaemon();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  installShutdownSignals(handle);
  console.log(
    `agiled started: pid=${handle.lock.pid} ` +
      `http=http://127.0.0.1:${handle.http.port} socket=${handle.rpc.socketPath} ` +
      `home=${handle.config.home}`,
  );
  return new Promise<never>(() => {});
}

export interface DaemonStartOptions {
  cwd?: string;
  home?: string;
  /**
   * The CLI entry the detached child re-invokes (`<entry> daemon start
   * --foreground`). Defaults to this process's own entry, which is what the
   * real `agile` binary wants; a test that calls `runDaemonStart` from the
   * test runner has to name the entry itself.
   */
  cliEntry?: string;
}

/**
 * The last non-empty line of the child's log — the reason a child that died
 * before writing its pidfile gives for dying (T127). `agiled`'s own typed
 * errors (`PortInUseError`, `LockError`) are one line each and are the last
 * thing written, so this is the message the operator needs; Bun's own
 * `Failed to start server.` line sits above it.
 */
function lastLogLine(logPath: string): string | undefined {
  if (!existsSync(logPath)) return undefined;
  const lines = readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.at(-1);
}

export async function runDaemonStart(options: DaemonStartOptions = {}): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  const paths = resolveHomePaths(options.home ? { home: options.home } : {});

  const already = runningPid(paths);
  if (already !== undefined) {
    return `agiled already running: pid=${already} home=${paths.home}`;
  }
  // A pidfile whose holder is gone would otherwise make the child fail to
  // take the lock for a process that no longer exists.
  if (existsSync(paths.pidPath)) rmSync(paths.pidPath, { force: true });

  mkdirSync(paths.logDir, { recursive: true });
  const logFd = openSync(paths.logPath, 'a');

  const child = spawn(
    process.execPath,
    [options.cliEntry ?? process.argv[1] ?? 'agile', 'daemon', 'start', '--foreground'],
    {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...(options.home ? { AGILE_HOME: options.home } : {}) },
    },
  );

  /**
   * T127: the child's exit is *evented*, not polled. `child.exitCode` is
   * only filled in once the runtime has reaped the child, and the child was
   * `unref()`ed immediately after `spawn` — on a platform where the unref'd
   * process watcher is no longer polled, the poll never saw the exit and
   * `start` sat out the full 20 s even though the daemon had died in under
   * a second. The child stays ref'd until the outcome is known and is
   * unref'd on the way out, which is all `detached` needs to survive the
   * parent anyway.
   */
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // Exit first: a child that died may have published a transient
      // pidfile on the way, and a dead daemon is never a started one.
      if (exited) {
        const reason =
          lastLogLine(paths.logPath) ??
          `it exited before writing a pidfile and wrote nothing to ${paths.logPath}`;
        const holder = reason.includes('address in use')
          ? ` Port ${paths.port} is ${describePortHolder(paths.port)}.`
          : '';
        throw new Error(`agiled did not start: ${reason}${holder}`);
      }
      const pid = runningPid(paths);
      if (pid !== undefined) {
        return (
          `agiled started: pid=${pid} http=http://127.0.0.1:${paths.port} ` +
          `socket=${paths.socketPath} home=${paths.home} log=${paths.logPath}`
        );
      }
      await sleep(POLL_MS);
    }
    throw new Error(
      `agiled did not start (no pidfile at ${paths.pidPath} after ${START_TIMEOUT_MS}ms, and the process is still running). See ${paths.logPath}.`,
    );
  } finally {
    child.unref();
  }
}

export async function runDaemonStop(home?: string): Promise<string> {
  const paths = resolveHomePaths(home ? { home } : {});
  const pid = runningPid(paths);
  if (pid === undefined) {
    // Clear a stale pidfile so the next `start` doesn't have to.
    if (existsSync(paths.pidPath)) rmSync(paths.pidPath, { force: true });
    const holder = portHolder(paths.port);
    const hint = holder
      ? `; but port ${paths.port} is ${describePortHolder(paths.port, holder)}${holder.looksLikeAgiled ? ' — stop it with the AGILE_HOME it was started with' : ''}`
      : '';
    return `agiled is not running (home=${paths.home})${hint}`;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      // The daemon releases its own lock on a graceful shutdown; a crash
      // between SIGTERM and release would leave the file behind.
      if (existsSync(paths.pidPath)) rmSync(paths.pidPath, { force: true });
      return `agiled stopped: pid=${pid}`;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`agiled (pid ${pid}) did not exit within ${STOP_TIMEOUT_MS}ms`);
}

export interface DaemonStatusReport {
  running: boolean;
  pid?: number;
  home: string;
  port: number;
  socketPath: string;
  pidPath: string;
  logPath: string;
  /** T167: from the running daemon's `daemon.status` — the key's source, never the key. */
  classifier?: ClassifierKeyStatus;
  /** T170 (D17): what a session attached with nothing named gets (home config + built-in). */
  sessionDefaults?: ResolvedSessionDefaults;
}

/**
 * T167: asks the running daemon where its classifier key comes from. A
 * daemon that does not answer in time leaves the line out rather than
 * failing `status`, which is about the pidfile first.
 */
export async function withClassifierStatus(
  report: DaemonStatusReport,
): Promise<DaemonStatusReport> {
  if (!report.running) return report;
  try {
    const status = await callRpc<{ classifier?: ClassifierKeyStatus }>(
      report.socketPath,
      'daemon.status',
      {},
      { timeoutMs: 2000 },
    );
    return status.classifier ? { ...report, classifier: status.classifier } : report;
  } catch {
    return report;
  }
}

/** `classifier key: loaded (from config.yaml)` · `classifier key: none loaded` — never the key. */
export function formatClassifierKeyLine(status: ClassifierKeyStatus): string {
  if (status.source === 'none')
    return 'classifier key: none loaded (set one in Settings or TYPESAFE_API_KEY)';
  const from = status.source === 'config' ? 'config.yaml' : 'TYPESAFE_API_KEY';
  if (!status.loaded) return `classifier key: present (from ${from}) but provider is off`;
  return `classifier key: loaded (from ${from})`;
}

export function daemonStatusReport(home?: string): DaemonStatusReport {
  const paths = resolveHomePaths(home ? { home } : {});
  const pid = runningPid(paths);
  return {
    running: pid !== undefined,
    ...(pid !== undefined ? { pid } : {}),
    home: paths.home,
    port: paths.port,
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    logPath: paths.logPath,
    ...sessionDefaultsFor(paths.home),
  };
}

/** A malformed `config.yaml` leaves the line out rather than failing `status`. */
function sessionDefaultsFor(home: string): { sessionDefaults?: ResolvedSessionDefaults } {
  try {
    return { sessionDefaults: resolveSessionDefaults({ home: readHomeConfigFile(home) }) };
  } catch {
    return {};
  }
}

/** T166: the state home comes first — it is what an operator checks. */
export function formatDaemonStatus(report: DaemonStatusReport): string {
  const home = `home: ${report.home}`;
  const defaults = report.sessionDefaults
    ? `\nsession default: ${formatSessionDefaults(report.sessionDefaults)}`
    : '';
  if (!report.running) return `${home}\nagiled is not running${defaults}`;
  const running =
    `${home}\nagiled running: pid=${report.pid} http=http://127.0.0.1:${report.port} ` +
    `socket=${report.socketPath}`;
  const classifier = report.classifier ? `\n${formatClassifierKeyLine(report.classifier)}` : '';
  return `${running}${classifier}${defaults}`;
}
