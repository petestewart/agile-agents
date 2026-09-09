/**
 * @agile-agents/daemon
 *
 * agiled: the Agile Agents daemon (state store, bus, gates, agent runner).
 *
 * T004 scope: config discovery, the per-repo lock, the unix-socket JSON-RPC
 * API (bus, state, hook, gate namespaces stubbed; daemon.ping/daemon.status
 * real), localhost HTTP+WebSocket (/health, /ws), graceful shutdown, and
 * `agile init`'s state bootstrap. See design/agile-agents-design.md §4, §5,
 * §15, §17, §18.
 */

export const PACKAGE_NAME = '@agile-agents/daemon';

export { discoverConfig, type AgileConfig, type DiscoverConfigOptions } from './config';
export { acquireLock, LockError, type LockHandle } from './lock';
export {
  startRpcServer,
  dispatch,
  buildMethods,
  type RpcServerHandle,
  type RpcServerOptions,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type DaemonStatus,
} from './rpc';
export {
  startHttpServer,
  type HttpServerHandle,
  type HttpServerOptions,
  type HealthPayload,
} from './http';
export {
  startDaemon,
  installShutdownSignals,
  DAEMON_VERSION,
  type DaemonHandle,
} from './daemon';
export { runInit, AlreadyInitialisedError, STATE_BRANCH, type InitResult } from './init';

// Role briefs and ceremony templates (T013).
export * from './briefs';

// Validating state store over .agile/ (T005).
export * from './store';

// Comms bus (T006).
export * from './bus';
