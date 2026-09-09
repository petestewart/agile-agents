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

// Oracle write guard + ripple walk, and halts (T007).
export * from './oracle';
export {
  QUORUM_TIMEOUT_MS,
  activeHaltsFor,
  buildHaltRpcMethods,
  createHalt,
  evaluateQuorum,
  recordStandupReport,
  releaseHalt,
  type CreateHaltInput,
} from './halts';

// Gates policy, HIL requests, circuit breaker (T018).
export * from './gates';

// ACP permission policy by role (T010).
export * from './permissions';

// Claude hook gate: per-worktree settings.json, pre/post-tool-use + stop
// decisions, hook.* RPC methods (T009).
export * from './hook';

// Tool framework: registry, cache, runner, read_summary/test_run, built-in
// daemon-verb tools, MCP server factory, tool.* RPC methods (T011).
export * from './tools';

// Agent runner and worktree manager: worktree placement, brief assembly,
// ACP session wiring, and the runner.* RPC methods (T012).
export * from './runner';

// Architect: refinement, pointing, discovery triage (T014).
export * from './architect';

// Review protocol: diff_summary, findings/verdicts, rules, disputes,
// review.* RPC methods (T016).
export * from './review';

// Merge and integration owner: ticket -> integration -> main, pre-commit
// halt guard, merge.* RPC methods (T019).
export * from './merge';

// EM protocol: sprint planning/assignment, board, standups + quorum,
// discovery hand-off, sprint review + retro, EmLoop, em.* RPC (T015).
export * from './em';

// QA protocol: clone env, criteria, contract-path deny, rerun/flaky, report,
// QaProtocol, qa_* verbs, qa.* RPC (T017).
export * from './qa';

// Quota records, routing policy, barometer data, quota.* RPC (T023).
export * from './quota';

// Tier-0 sandbox: profiles, backend detection, sandbox-exec/container
// renderers, wrapAgentCommand (T026).
export * from './sandbox';
