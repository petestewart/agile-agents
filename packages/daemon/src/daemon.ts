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
import { AttachService, VerbService, buildAttachRpcMethods } from './attach';
import { Bus, buildBusRpcMethods } from './bus';
import { type AgileConfig, type DiscoverConfigOptions, discoverConfig } from './config';
import { DocsService, buildDocsRpcMethods } from './docs';
import { GateService, buildGateRpcMethods } from './gates';
import type { DelegateFn } from './gates';
import { HookService, buildHookRpcMethods } from './hook';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService, buildInboxRpcMethods } from './inbox';
import { LandingService, buildLandingRpcMethods, wireLandGateResolution } from './landing';
import { LessonsService } from './lessons';
import { type LockHandle, acquireLock } from './lock';
import { QuestionService, buildQuestionRpcMethods } from './questions';
import { type RpcServerHandle, startRpcServer } from './rpc';
import { RulesService, buildRuleRpcMethods } from './rules';
import { resolveCliBin } from './runner';
import { StateStore, buildStateRpcMethods } from './store';
import { StreamService, buildStreamRpcMethods } from './streams';

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
  rulesService?: RulesService;
  lessonsService?: LessonsService;
  inboxService?: InboxService;
  attachService?: AttachService;
  verbService?: VerbService;
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
  // T141 (§5.5): `close` and `land` both end a stream, and both hand it to
  // the retro. Read lazily — `lessonsService` is built below, once the
  // services it drives exist.
  const streamService = store
    ? new StreamService(store, {
        onStreamEnd: async (id) => {
          await lessonsService?.onStreamEnd(id);
        },
      })
    : undefined;
  // How spawned sessions reach this daemon's own CLI for their hook command
  // and MCP server — resolved to something that actually runs on this host
  // (`runner/cli-bin.ts`), never assumed on $PATH.
  const cliBin = resolveCliBin();
  // T140: rules — the system's memory of decisions (cockpit design §5). The
  // attach service reads `inScope` for every brief, and T143's hook will
  // read the same function.
  const rulesService =
    store && streamService ? new RulesService({ store, streams: streamService }) : undefined;
  // T137: the attach service and the question service know about each
  // other — the turn-end rule asks what is still open, and an answer is
  // delivered by prompting the live session. Both directions are read
  // lazily through closures, so neither construction order is a trap.
  const attachService =
    store && streamService
      ? new AttachService({
          store,
          streams: streamService,
          home: config.home,
          socketPath: config.socketPath,
          cliBin: { command: cliBin.command, args: cliBin.args },
          // Both read lazily: `docsService` and `questionService` are built
          // below, and are only ever called once the daemon is serving.
          docs: { docsForStream: (id) => docsService?.docsForStream(id) ?? [] },
          questions: { listOpen: () => questionService?.listOpen() ?? [] },
          ...(rulesService ? { rules: rulesService } : {}),
        })
      : undefined;
  const questionService: QuestionService | undefined =
    store && streamService
      ? new QuestionService(store, streamService, {
          deliver: async (sessionId, question): Promise<void> => {
            await attachService?.deliverAnswer(sessionId, question);
          },
        })
      : undefined;

  // The inbox (§3): everything waiting on the human, across all streams.
  const inboxService =
    streamService && questionService && gateService
      ? new InboxService({
          streams: streamService,
          questions: questionService,
          gates: gateService,
          ...(rulesService ? { rules: rulesService } : {}),
        })
      : undefined;
  // T134: docs are plain Markdown under `<repo>/.agile-docs/` and
  // `<home>/streams/<id>.docs/` — read-only, no index, no state of their own.
  const docsService =
    store && streamService ? new DocsService(store, streamService, config.stateRoot) : undefined;
  // T132: the landing path (§8.2). A repo with `land_gate: true` raises its
  // gate through the same `GateService`, and approving that gate is what
  // performs the merge — hence the wiring call below.
  const landingService =
    store && streamService
      ? new LandingService({
          store,
          streams: streamService,
          ...(gateService ? { gates: gateService } : {}),
          onStreamEnd: async (id) => {
            await lessonsService?.onStreamEnd(id);
          },
        })
      : undefined;
  if (gateService && landingService) wireLandGateResolution(gateService, landingService);
  // T141: the retro (§5.5). It reads the stream's findings, denials and
  // questions and starts one read-only `lessons` session over them; the
  // proposals it makes are ordinary `propose_rule` writes, capped at three.
  const lessonsService: LessonsService | undefined =
    store && streamService && attachService && rulesService
      ? new LessonsService({
          store,
          streams: streamService,
          attach: attachService,
          rules: rulesService,
          questions: { list: () => questionService?.list() ?? [] },
        })
      : undefined;
  // Hoisted (T011) so `bus.*` RPC and the hook service share one `Bus`
  // instance over the same store.
  const bus = store ? new Bus(store, config.stateRoot, { now: options.now }) : undefined;
  // T130: attaching a worker to a stream, and the eight verbs an attached
  // session gets (cockpit design §4.1). The verb surface is fixed — there
  // is no tool registry any more.
  const verbService =
    store && streamService && questionService
      ? new VerbService({
          store,
          streams: streamService,
          questions: questionService,
          ...(docsService ? { docs: docsService } : {}),
          ...(rulesService ? { rules: rulesService } : {}),
          // T141's three-proposal cap, read lazily like every other
          // back-reference in this graph.
          proposalLimit: {
            assertCanPropose: (caller) => lessonsService?.assertCanPropose(caller),
          },
        })
      : undefined;
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
    store && gateService && bus
      ? {
          ...buildStateRpcMethods(store),
          ...buildBusRpcMethods(bus),
          ...buildGateRpcMethods(gateService),
          ...(questionService ? buildQuestionRpcMethods(questionService) : {}),
          ...(streamService ? buildStreamRpcMethods(streamService) : {}),
          ...(inboxService ? buildInboxRpcMethods(inboxService) : {}),
          ...(rulesService ? buildRuleRpcMethods(rulesService) : {}),
          ...(docsService ? buildDocsRpcMethods(docsService) : {}),
          ...(landingService ? buildLandingRpcMethods(landingService) : {}),
          ...buildHookRpcMethods(
            // T125: no repo root either — an agent record's worktree is
            // absolute in practice, and a relative one now fails closed
            // rather than resolving against whatever cwd `agiled` was
            // started in.
            new HookService(store, bus, {}),
          ),
          ...(attachService && verbService
            ? buildAttachRpcMethods(attachService, verbService)
            : {}),
        }
      : undefined;

  /**
   * Bind the port **before** taking the lock (T127). The lock file is the
   * pidfile, and `agile daemon start` waits for that file to appear: taking
   * it first meant a daemon that then failed to bind had already published
   * a pidfile, and the parent reported `agiled started` for a process that
   * was dying. Binding first means the pidfile only ever appears for a
   * daemon that is actually serving. The unix socket still comes *after*
   * the lock — `startRpcServer` unlinks a stale socket path, which a second
   * daemon on the same home must never do to the live one.
   */
  const http: HttpServerHandle = startHttpServer({
    port: config.port,
    hostname: '127.0.0.1',
    version: DAEMON_VERSION,
    stateRoot: config.stateRoot,
    home: config.home,
    startedAt,
    store,
    gates: gateService,
    streams: streamService,
    questions: questionService,
    inbox: inboxService,
    bus,
  });

  let lock: LockHandle;
  try {
    lock = acquireLock(config.lockPath);
  } catch (err) {
    await http.stop();
    throw err;
  }

  let rpc: RpcServerHandle;
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
    await http.stop();
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
    rulesService,
    lessonsService,
    inboxService,
    attachService,
    verbService,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (gateTimer) clearInterval(gateTimer);
        // Every attached session is a child process of this daemon: stop
        // them before the servers go, so their exit writes still land.
        await attachService?.stopAll();
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
