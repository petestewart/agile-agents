/**
 * `agiled` orchestration: wires config discovery, the per-repo lock, the
 * unix-socket JSON-RPC server, and the localhost HTTP+WebSocket server into
 * one start/stop lifecycle (design/agile-agents-design.md §18 "Technical
 * shape", §15 "one daemon per repo").
 */

import { existsSync } from 'node:fs';
import daemonPackageJson from '../package.json' with { type: 'json' };
import { Bus, buildBusRpcMethods } from './bus';
import { type AgileConfig, type DiscoverConfigOptions, discoverConfig } from './config';
import { GateService, buildGateRpcMethods } from './gates';
import { buildHaltRpcMethods } from './halts';
import { type HttpServerHandle, startHttpServer } from './http';
import { type LockHandle, acquireLock } from './lock';
import { buildOracleRpcMethods } from './oracle';
import { type RpcServerHandle, startRpcServer } from './rpc';
import { StateStore, buildStateRpcMethods } from './store';

export const DAEMON_VERSION: string = daemonPackageJson.version;

export interface DaemonHandle {
  config: AgileConfig;
  lock: LockHandle;
  rpc: RpcServerHandle;
  http: HttpServerHandle;
  startedAt: number;
  /** Graceful shutdown: closes both servers, then releases the lock. */
  stop(): Promise<void>;
}

export async function startDaemon(options: DiscoverConfigOptions = {}): Promise<DaemonHandle> {
  const config = discoverConfig(options);
  const lock = acquireLock(config.lockPath);
  const startedAt = Date.now();

  // `.agile/` may not exist yet (before `agile init`); state.* stays fully
  // stubbed in that case, same as T004 — only wire the real handlers when
  // there's a state root to open them against.
  // One StateStore instance is shared by every RPC namespace (same mutex,
  // same agile-state worktree).
  const store = existsSync(config.stateRoot) ? StateStore.open(config.stateRoot) : undefined;
  const extraMethods = store
    ? {
        ...buildStateRpcMethods(store),
        ...buildBusRpcMethods(new Bus(store, config.stateRoot)),
        ...buildOracleRpcMethods(store),
        ...buildHaltRpcMethods(store),
        ...buildGateRpcMethods(new GateService(store)),
      }
    : undefined;

  let rpc: RpcServerHandle;
  let http: HttpServerHandle;
  try {
    rpc = startRpcServer({
      socketPath: config.socketPath,
      version: DAEMON_VERSION,
      stateRoot: config.stateRoot,
      startedAt,
      extraMethods,
    });
  } catch (err) {
    lock.release();
    throw err;
  }

  try {
    http = startHttpServer({
      port: config.port,
      version: DAEMON_VERSION,
      stateRoot: config.stateRoot,
      startedAt,
    });
  } catch (err) {
    await rpc.close();
    lock.release();
    throw err;
  }

  let stopped = false;
  return {
    config,
    lock,
    rpc,
    http,
    startedAt,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await http.stop();
        await rpc.close();
      } finally {
        lock.release();
      }
    },
  };
}

/**
 * Wires SIGINT/SIGTERM to graceful shutdown. Kept separate from
 * `startDaemon` so tests (and anything embedding the daemon) can manage
 * their own lifecycle without touching process-wide signal handlers.
 */
export function installShutdownSignals(handle: DaemonHandle): void {
  const shutdown = () => {
    handle
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('error during shutdown:', err);
        process.exit(1);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
