/**
 * `agiled` orchestration: wires config discovery, the per-repo lock, the
 * unix-socket JSON-RPC server, and the localhost HTTP+WebSocket server into
 * one start/stop lifecycle (design/agile-agents-design.md §18 "Technical
 * shape", §15 "one daemon per repo").
 */

import { type AgileConfig, type DiscoverConfigOptions, discoverConfig } from './config';
import { type HttpServerHandle, startHttpServer } from './http';
import { type LockHandle, acquireLock } from './lock';
import { type RpcServerHandle, startRpcServer } from './rpc';

export const DAEMON_VERSION = '0.0.0';

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

  let rpc: RpcServerHandle;
  let http: HttpServerHandle;
  try {
    rpc = startRpcServer({
      socketPath: config.socketPath,
      version: DAEMON_VERSION,
      stateRoot: config.stateRoot,
      startedAt,
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
      await http.stop();
      await rpc.close();
      lock.release();
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
