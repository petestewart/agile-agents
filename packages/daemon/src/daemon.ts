/**
 * `agiled` orchestration: wires config discovery, the per-repo lock, the
 * unix-socket JSON-RPC server, and the localhost HTTP+WebSocket server into
 * one start/stop lifecycle (design/agile-agents-design.md §18 "Technical
 * shape", §15 "one daemon per repo").
 *
 * T122 deleted the role and ceremony layer that used to be assembled here
 * (the resident EM and its loop, the architect planning turn, the oracle, QA,
 * halts/ripple, quota and handoff, the merge owner's promote-to-main path and
 * the review round machine). What is left is the substrate the reshape keeps:
 * streams, questions, gates, the inbox, the hook endpoint, tools and the two
 * servers.
 */

import { existsSync } from 'node:fs';
import daemonPackageJson from '../package.json' with { type: 'json' };
import { Bus, buildBusRpcMethods } from './bus';
import { type AgileConfig, type DiscoverConfigOptions, discoverConfig } from './config';
import { GateService, buildGateRpcMethods } from './gates';
import type { DelegateFn } from './gates';
import { HookService, buildHookRpcMethods } from './hook';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService, buildInboxRpcMethods } from './inbox';
import { type LockHandle, acquireLock } from './lock';
import { QuestionService, buildQuestionRpcMethods } from './questions';
import { type RpcServerHandle, startRpcServer } from './rpc';
import { resolveCliBin } from './runner';
import { StateStore, buildStateRpcMethods } from './store';
import { StreamService, buildStreamRpcMethods } from './streams';
import { LiveRunner, ToolService, buildToolRpcMethods, loadToolRegistry } from './tools';

export const DAEMON_VERSION: string = daemonPackageJson.version;

/** Gate tick cadence — same 30 s as the heartbeat tunable (CLAUDE.md). */
export const GATE_TICK_MS = 30 * 1000;

export interface DaemonHandle {
  config: AgileConfig;
  lock: LockHandle;
  rpc: RpcServerHandle;
  http: HttpServerHandle;
  startedAt: number;
  /**
   * The daemon's own internal object graph, exposed for a caller (a test,
   * or a Phase 3 per-stream driver) that wants to drive the daemon directly
   * in-process rather than over the unix socket. `undefined` for every field
   * when the state home doesn't exist yet (pre-`agile init`), same condition
   * `extraMethods` below already gates on.
   */
  store?: StateStore;
  bus?: Bus;
  gateService?: GateService;
  streamService?: StreamService;
  questionService?: QuestionService;
  inboxService?: InboxService;
  /** Graceful shutdown: closes both servers, then releases the lock. */
  stop(): Promise<void>;
}

export interface StartDaemonOptions extends DiscoverConfigOptions {
  /**
   * Test/offline-run seam: `GateService`'s own decision delegate
   * (`gates/service.ts`) — a gate whose policy owner does not resolve to the
   * human is decided synchronously by this function instead of waiting for a
   * `gate.respond` call. Real usage leaves it unset.
   */
  gateDelegate?: DelegateFn;
  /**
   * Gate tick cadence. Default `GATE_TICK_MS` (30 s); `0` disables the
   * daemon's own timer for a caller (a test) that drives `gateService.tick()`
   * itself — two concurrent drivers over the same gates double-decide.
   */
  gateTickMs?: number;
  /**
   * Test-only seam: the daemon's own clock, threaded to `Bus` (heartbeat
   * timestamps + coalescing, `bus/bus.ts`) so a test can run a real
   * heartbeat-coalescing window in well-under-a-second of wall-clock time.
   * Real usage never sets this (the daemon runs on the system clock).
   */
  now?: () => Date;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const config = discoverConfig(options);
  const lock = acquireLock(config.lockPath);
  const startedAt = Date.now();

  // `.agile/` may not exist yet (before `agile init`); state.* stays fully
  // stubbed in that case, same as T004 — only wire the real handlers when
  // there's a state root to open them against.
  const store = existsSync(config.stateRoot) ? StateStore.open(config.stateRoot) : undefined;
  // Hoisted (T020) so the same GateService instance backs both `gate.*` RPC
  // and the HIL snapshot/approve HTTP routes.
  const gateService = store
    ? new GateService(store, options.gateDelegate ? { delegate: options.gateDelegate } : {})
    : undefined;
  // T120/T121: one `StreamService` behind `stream.*` RPC, the questions
  // service (which writes thread entries and status flips) and the inbox.
  const streamService = store ? new StreamService(store) : undefined;
  const questionService =
    store && streamService ? new QuestionService(store, streamService) : undefined;
  // The inbox (§3): everything waiting on the human, across all streams.
  const inboxService =
    streamService && questionService && gateService
      ? new InboxService({
          streams: streamService,
          questions: questionService,
          gates: gateService,
        })
      : undefined;
  // Hoisted (T011) so `bus.*` RPC and the hook service share one `Bus`
  // instance over the same store.
  const bus = store ? new Bus(store, config.stateRoot, { now: options.now }) : undefined;
  // Tool registry: loaded once at startup from `.agile/tools/*/tool.yaml`.
  // `LiveRunner` spawns a real short-lived Claude ACP session per
  // `runner.tier` call; `FakeRunner` exists only for this package's tests.
  const toolService = store
    ? new ToolService({
        registry: loadToolRegistry(config.stateRoot),
        runner: new LiveRunner(),
        repoRoot: config.repoRoot,
      })
    : undefined;
  // How spawned sessions reach this daemon's own CLI for their hook command
  // and MCP server — resolved to something that actually runs on this host
  // (`runner/cli-bin.ts`), never assumed on $PATH.
  const cliBin = resolveCliBin();
  if (cliBin.source === 'missing') {
    console.error(
      'agiled: no `agile` CLI found (no AGILE_CLI_BIN, no workspace entry, nothing on $PATH) — spawned sessions will have no hooks or MCP tools; set AGILE_CLI_BIN',
    );
  }

  // One daemon-level interval ticks the gate service (HIL deadline
  // fallthrough, §16 — nothing else calls `GateService.tick()`). Errors are
  // logged, never fatal: the daemon is long-lived (D9) and never exits
  // because work finished.
  const gateTickMs = options.gateTickMs ?? GATE_TICK_MS;
  const gateTimer =
    gateService && gateTickMs > 0
      ? setInterval(() => {
          void gateService.tick().catch((err) => console.error('gate tick failed:', err));
        }, gateTickMs)
      : undefined;
  gateTimer?.unref();

  const extraMethods =
    store && gateService && bus && toolService
      ? {
          ...buildStateRpcMethods(store),
          ...buildBusRpcMethods(bus),
          ...buildGateRpcMethods(gateService),
          ...(questionService ? buildQuestionRpcMethods(questionService) : {}),
          ...(streamService ? buildStreamRpcMethods(streamService) : {}),
          ...(inboxService ? buildInboxRpcMethods(inboxService) : {}),
          ...buildHookRpcMethods(
            new HookService(store, bus, {
              repoRoot: config.repoRoot,
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
    await rpc.listening;
  } catch (err) {
    lock.release();
    throw err;
  }

  try {
    http = startHttpServer({
      port: config.port,
      version: DAEMON_VERSION,
      stateRoot: config.stateRoot,
      repoRoot: config.repoRoot,
      startedAt,
      store,
      gates: gateService,
      streams: streamService,
      questions: questionService,
      inbox: inboxService,
      bus,
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
    store,
    bus,
    gateService,
    streamService,
    questionService,
    inboxService,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (gateTimer) clearInterval(gateTimer);
        await http.stop();
        await rpc.close();
        // Flush any pending deferred hook_decision/heartbeat commits (T009
        // review round, hot-path decision) — a graceful shutdown must not
        // lose a batch that hasn't hit its 5s debounce yet.
        await store?.flush();
        // Cancels the deferred-flush timer outright (T012 QA round) — belt
        // and suspenders alongside the flush above, since `flush()` only
        // drains what's queued *now*, not anything a still-armed timer
        // might schedule after this returns.
        store?.close();
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
