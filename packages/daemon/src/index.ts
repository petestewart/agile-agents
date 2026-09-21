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

export {
  discoverConfig,
  resolveHomePaths,
  readHomeConfigFile,
  stateHome,
  HOME_CONFIG_FILE_NAME,
  type HomePaths,
  type ResolveHomePathsOptions,
  type AgileConfig,
  type DiscoverConfigOptions,
} from './config';
export { DAEMON_CACHE_DIR, sandboxedSubprocessEnv } from './subprocess-env';
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
  PortInUseError,
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
export {
  runInit,
  PRODUCT_MD_STUB,
  type InitResult,
} from './init';

/**
 * Chromium discovery for the Playwright e2e suites. Exported so every e2e
 * suite shares one implementation rather than re-deriving the per-platform
 * browser layouts.
 */
export { resolveChromiumExecutable } from './feed/chromium';

// Feed snapshot and the event tailer (T020).
export {
  buildSnapshot,
  DEFAULT_SNAPSHOT_EVENT_LIMIT,
  type FeedProjectInfo,
  type FeedSnapshot,
  type FeedStatusInfo,
} from './feed';

// Validating state store over .agile/ (T005).
export * from './store';

// Comms bus (T006).
export * from './bus';

// Gates policy, HIL requests, circuit breaker (T018).
export * from './gates';

// Streams: the reshape's unit of work — stream service + stream.* RPC (T120).
export * from './streams';

// Questions store, and the inbox over questions/gates/streams (T040/T121).
export * from './questions';
export * from './inbox';

// Markdown docs per repo and per stream (T134).
export * from './docs';

// ACP permission policy by role (T010).
export * from './permissions';

// Claude hook gate: per-worktree settings.json, pre/post-tool-use + stop
// decisions, hook.* RPC methods (T009).
export * from './hook';

// What is left of the tool framework: `test_run` and the MCP server over
// the eight verbs (T011, reshaped by T130).
export * from './tools';

// Attaching a worker to a stream, the eight MCP verbs, and the attach.*/
// agent.* RPC families (T130).
export * from './attach';

// Agent session lifecycle and worktree manager (T012).
export * from './runner';

// The landing path: git plumbing, LandingService, land.* RPC (T019/T132).
export * from './landing';

// Tier-0 sandbox: profiles, backend detection, sandbox-exec/container
// renderers, wrapAgentCommand (T026).
export * from './sandbox';

// Pi adapter: the agile Pi extension source, its installer, gate env (T022).
export * from './pi';
