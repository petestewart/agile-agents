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
import { HookService, buildHookRpcMethods } from './hook';
import { type HttpServerHandle, startHttpServer } from './http';
import { type LockHandle, acquireLock } from './lock';
import { buildOracleRpcMethods } from './oracle';
import { type RpcServerHandle, startRpcServer } from './rpc';
import { StateStore, buildStateRpcMethods } from './store';
import { LiveRunner, ToolService, buildToolRpcMethods, loadToolRegistry } from './tools';

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
  // Hoisted (T020) so the same GateService instance backs both `gate.*` RPC
  // and the feed page's HIL snapshot/approve/delegate HTTP routes.
  const gateService = store ? new GateService(store) : undefined;
  // Hoisted (T011) so `bus.*` RPC, the hook service, and the tool service's
  // `bus_send` built-in all share one `Bus` instance over the same store.
  const bus = store ? new Bus(store, config.stateRoot) : undefined;
  // Tool registry (§7 "Tool framework"): loaded once at startup from
  // `.agile/tools/*/tool.yaml`. `LiveRunner` spawns a real short-lived Claude
  // ACP session per `runner.tier` call — the daemon's actual runtime path;
  // `FakeRunner` exists only for this package's own tests.
  const toolService =
    store && bus
      ? new ToolService({
          store,
          bus,
          registry: loadToolRegistry(config.stateRoot),
          runner: new LiveRunner(),
          repoRoot: config.repoRoot,
        })
      : undefined;
  const extraMethods =
    store && gateService && bus && toolService
      ? {
          ...buildStateRpcMethods(store),
          ...buildBusRpcMethods(bus),
          ...buildOracleRpcMethods(store),
          ...buildHaltRpcMethods(store),
          ...buildGateRpcMethods(gateService),
          ...buildHookRpcMethods(
            new HookService(store, bus, {
              repoRoot: config.repoRoot,
              gates: gateService,
            }),
          ),
          ...buildToolRpcMethods(toolService),
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
      store,
      gates: gateService,
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
        // Flush any pending deferred hook_decision/heartbeat commits (T009
        // review round, hot-path decision) — a graceful shutdown must not
        // lose a batch that hasn't hit its 5s debounce yet.
        await store?.flush();
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
