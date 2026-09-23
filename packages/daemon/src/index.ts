/** @agile-agents/daemon: `agiled`, the one long-lived daemon, and its public surface. */

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
  type InitResult,
} from './init';

/** Chromium discovery, shared by every Playwright e2e suite. */
export { resolveChromiumExecutable } from './feed/chromium';

export {
  buildSnapshot,
  DEFAULT_SNAPSHOT_EVENT_LIMIT,
  type FeedProjectInfo,
  type FeedSnapshot,
  type FeedStatusInfo,
} from './feed';

export * from './store';

export * from './bus';

export * from './gates';

export * from './streams';

export * from './rules';

export * from './questions';
export * from './inbox';

export * from './docs';

export * from './permissions';

export * from './hook';

export * from './tools';

export * from './attach';

export * from './runner';

export * from './landing';

export * from './sandbox';

export * from './pi';

export * from './classifier';
