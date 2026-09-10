/**
 * `agiled` orchestration: wires config discovery, the per-repo lock, the
 * unix-socket JSON-RPC server, and the localhost HTTP+WebSocket server into
 * one start/stop lifecycle (design/agile-agents-design.md §18 "Technical
 * shape", §15 "one daemon per repo").
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TicketId } from '@agile-agents/shared';
import daemonPackageJson from '../package.json' with { type: 'json' };
import { registerArchitectTools } from './architect';
import { Bus, buildBusRpcMethods } from './bus';
import { roleOf } from './bus/routing';
import { type AgileConfig, type DiscoverConfigOptions, discoverConfig } from './config';
import { EM_TOOLS, EmLoop, type EmToolDeps, buildEmRpcMethods } from './em';
import { pickCurrentSprint } from './feed';
import { GateService, buildGateRpcMethods } from './gates';
import type { DelegateFn } from './gates';
import { buildHaltRpcMethods } from './halts';
import { HandoffCoordinator, buildHandoffRpcMethods, registerHandoffTools } from './handoff';
import { HookService, buildHookRpcMethods } from './hook';
import { type HttpServerHandle, startHttpServer } from './http';
import { type LockHandle, acquireLock } from './lock';
import { MergeOwner, buildMergeRpcMethods, sprintReviewApproved } from './merge';
import { buildOracleRpcMethods } from './oracle';
import { QaProtocol, buildQaRpcMethods, decideQaRead, registerQaTools } from './qa';
import { QuotaService, buildQuotaRpcMethods } from './quota';
import {
  REVIEW_BUILTIN_TOOLS,
  ReviewProtocol,
  type ReviewVerbDeps,
  buildReviewRpcMethods,
  reviewDispute,
  reviewGet,
  reviewSubmit,
  rulesList,
} from './review';
import { type RpcServerHandle, startRpcServer } from './rpc';
import {
  Runner,
  advanceArchitectInbox,
  advanceDoneTickets,
  advanceEngineerVerdicts,
  advanceHilResolutions,
  advanceQaSpawns,
  advanceReviewRequests,
  buildRunnerRpcMethods,
  resolveCliBin,
} from './runner';
import type { AgentSessionOptions } from './runner';
import { StateStore, buildStateRpcMethods } from './store';
import { LiveRunner, ToolService, buildToolRpcMethods, loadToolRegistry } from './tools';

export const DAEMON_VERSION: string = daemonPackageJson.version;

/** Gate + EM ceremony tick cadence — same 30 s as the heartbeat tunable (CLAUDE.md). */
export const CEREMONY_TICK_MS = 30 * 1000;

export interface DaemonHandle {
  config: AgileConfig;
  lock: LockHandle;
  rpc: RpcServerHandle;
  http: HttpServerHandle;
  startedAt: number;
  /**
   * The daemon's own internal object graph, exposed for a caller that
   * wants to drive ceremonies directly in-process rather than over the
   * unix socket (T021's `agile run`: an unattended sprint has no human/
   * live-vendor EM session to poll `gate.*`/`em.*` RPC on its own timer,
   * so a driver calls `emLoop.tick()`/`gateService` itself). `undefined`
   * for every field when `.agile/` doesn't exist yet (pre-`agile init`),
   * same condition `extraMethods` below already gates on.
   */
  store?: StateStore;
  bus?: Bus;
  gateService?: GateService;
  runner?: Runner;
  mergeOwner?: MergeOwner;
  reviewProtocol?: ReviewProtocol;
  qaProtocol?: QaProtocol;
  emLoop?: EmLoop;
  /** Graceful shutdown: closes both servers, then releases the lock. */
  stop(): Promise<void>;
}

export interface StartDaemonOptions extends DiscoverConfigOptions {
  /**
   * Test/offline-run seam: overrides every spawned engineer/reviewer/qa
   * session's underlying ACP transport (forwarded to `Runner`'s own
   * `spawn` option, `runner/session.ts`'s `AgentSessionOptions['spawn']`).
   * Real usage never sets this — `LiveRunner`/the default `spawnSession`
   * stay in effect. `agile run`'s offline/fixture mode is the one caller
   * (T021): no vendor login in this container, so the demo e2e substitutes
   * the same fake-agent transport `runner/*.test.ts` already uses.
   */
  runnerSpawn?: AgentSessionOptions['spawn'];
  /**
   * Test/offline-run seam: `GateService`'s own decision delegate
   * (`gates/service.ts`) — a gate whose policy owner resolves to `em` (or
   * `architect`) is decided synchronously by this function instead of
   * waiting on a live EM/architect session to call `gate.respond` itself.
   * Real usage never sets this (a live EM session answers its own gates);
   * `agile run`'s offline mode does, since it never spawns one.
   */
  gateDelegate?: DelegateFn;
  /**
   * Test-only seam: the daemon's own clock, threaded to `Bus` (heartbeat
   * timestamps + coalescing, `bus/bus.ts`) and `Runner` (forwarded to every
   * spawned session's own `now`, `runner/session.ts`) so a test can run a
   * real heartbeat-coalescing window (`StateStore.heartbeat`'s
   * `HEARTBEAT_COALESCE_MS`, 30s) or a real liveness timeout in
   * well-under-a-second of actual wall-clock time — e.g. an accelerated
   * clock, not a counter mock, so ordering/proportional gaps stay real.
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
  // One StateStore instance is shared by every RPC namespace (same mutex,
  // same agile-state worktree).
  const store = existsSync(config.stateRoot) ? StateStore.open(config.stateRoot) : undefined;
  // Hoisted (T020) so the same GateService instance backs both `gate.*` RPC
  // and the feed page's HIL snapshot/approve/delegate HTTP routes.
  const gateService = store
    ? new GateService(store, options.gateDelegate ? { delegate: options.gateDelegate } : {})
    : undefined;
  // Hoisted (T011) so `bus.*` RPC, the hook service, and the tool service's
  // `bus_send` built-in all share one `Bus` instance over the same store.
  const bus = store ? new Bus(store, config.stateRoot, { now: options.now }) : undefined;
  // Quota records + routing data (T023): fed by every session's
  // `usage_update` through the runner; read by `quota.*` RPC, `agile
  // status`, and the feed header.
  const quotaService = store && bus ? new QuotaService({ store, bus }) : undefined;
  // QA protocol (T017, §13): fresh clone per ticket, contract-path deny,
  // criteria runs, verdicts. Constructed before the tool service and the
  // runner because both take closures over it.
  const qaProtocol =
    store && bus ? new QaProtocol({ store, bus, repoRoot: config.repoRoot }) : undefined;
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
          // Review fix (T011): resolved per call, not memoized — the current
          // sprint can change over the daemon's life. Same "latest started,
          // ties by id" rule the feed snapshot uses (`pickCurrentSprint`),
          // reused rather than re-derived so the two never drift apart.
          currentSprintId: () => pickCurrentSprint(store.listSprints())?.id,
          // T017: `read_summary` reads the file itself, so a QA session
          // could otherwise bypass the hook-tier contract-path deny (§13)
          // through this tool. Same `decideQaRead` the hook tier relies on,
          // resolved against the QA clone (`runner/worktrees.ts`'s
          // `.worktrees/<TKT>-qa` convention).
          pathGuard: (ctx, absolutePath) => {
            if (roleOf(ctx.agent) !== 'qa' || !ctx.ticket) return { allow: true };
            const ticket = store.getTicket(ctx.ticket as TicketId);
            return decideQaRead(
              {
                role: 'qa',
                ticket,
                worktreePath: join(config.repoRoot, '.worktrees', `${ticket.id}-qa`),
              },
              absolutePath,
            );
          },
        })
      : undefined;
  // Agent runner (T012): worktree placement, brief assembly, ACP session
  // wiring, and the periodic liveness/redelivery sweep — see runner/runner.ts.
  const cliBin = resolveCliBin();
  if (cliBin.source === 'missing') {
    console.error(
      'agiled: no `agile` CLI found (no AGILE_CLI_BIN, no workspace entry, nothing on $PATH) — spawned sessions will have no hooks or MCP tools; set AGILE_CLI_BIN',
    );
  }
  const runner =
    store && bus
      ? new Runner({
          store,
          bus,
          repoRoot: config.repoRoot,
          // How spawned sessions reach this daemon's own CLI for their hook
          // command and MCP server — resolved to something that actually
          // runs on this host (`runner/cli-bin.ts`), never assumed on $PATH.
          cliBin,
          socketPath: config.socketPath,
          gateService,
          // T017: a QA spawn opens the protocol's round for that ticket
          // (criteria parsing, env resolution) against the fresh clone.
          onQaSpawn: qaProtocol
            ? (ticket, worktree) => qaProtocol.start(ticket, worktree)
            : undefined,
          spawn: options.runnerSpawn,
          now: options.now,
        })
      : undefined;
  runner?.startSweep();
  // Merge and integration owner (T019, §15): ticket branch -> integration
  // on QA accept (`merge.ticket`), integration -> main gated on the latest
  // `sprint_review` HIL decision (fail-closed via `sprintReviewApproved`).
  const mergeOwner =
    store && bus && gateService
      ? new MergeOwner(store, bus, config.repoRoot, {
          gateApproved: () => sprintReviewApproved(gateService),
        })
      : undefined;
  // Review protocol (T016, §12) — hoisted above the ceremony timer (T021)
  // so the pipeline glue below can call `reviewProtocol.start` on an
  // engineer's `review_request`; re-used, not re-constructed, by the
  // role-scoped verb provider block further down.
  const reviewProtocol =
    store && bus && runner
      ? new ReviewProtocol({ store, bus, runner, repoRoot: config.repoRoot })
      : undefined;

  // EM protocol loop (T015, §9–§11/§16): sprint planning, assignment,
  // standups/quorum, discovery triage hand-off, sprint review. Its delegated
  // sprint-review path merges integration -> main through the merge owner
  // and only plans the next sprint once that merge actually landed.
  const emLoop =
    store && bus && runner && gateService && mergeOwner
      ? new EmLoop({
          store,
          bus,
          runner,
          gateService,
          sprintReview: {
            mergeIntegrationToMain: async () => {
              const outcome = await mergeOwner.mergeIntegrationToMain();
              if (outcome.status !== 'merged') {
                throw new Error(
                  `integration -> main merge did not land (${outcome.status}): ${outcome.summary}`,
                );
              }
            },
          },
        })
      : undefined;
  // Handoff coordinator (T024, §10): exactly one instance for the daemon's
  // lifetime — its quota-event cursor is seeded once at construction, so a
  // per-tick instance would never see a `quota_low`/`quota_exhausted`.
  const handoffCoordinator =
    store && bus && runner && quotaService
      ? new HandoffCoordinator({
          store,
          bus,
          runner,
          quota: quotaService,
          repoRoot: config.repoRoot,
        })
      : undefined;
  // Ceremony driver: one daemon-level interval ticks the gate service (HIL
  // deadline fallthrough, §16 — nothing else calls `GateService.tick()`),
  // then the handoff coordinator over every ticket (pausing a stuck-ready
  // ticket must precede `assignReady`, which runs inside the EM tick), then
  // the EM loop, then this pipeline glue. Cadence matches the runner sweep
  // / heartbeat tunable (30 s); errors are logged, never fatal to the
  // daemon.
  // T021 "wiring gaps": the three hand-offs off the architecture sketch's
  // data-flow paragraph nothing else drives (see `runner/pipeline-glue.ts`'s
  // header) — an engineer's `review_request`, a reviewer's approve-into-
  // `in_qa`, and QA landing a ticket on `done`. Each `Set` is process-local
  // idempotency bookkeeping, same rationale as `EmLoop`'s own
  // `calledHalts`/`escalatedHalts`/`seenDiscoveryStanzas`.
  const seenReviewRequests = new Set<string>();
  const seenEngineerVerdicts = new Set<string>();
  const seenHilResolutions = new Set<string>();
  const seenArchitectInbox = new Set<string>();
  const qaSpawned = new Set<TicketId>();
  const mergedDone = new Set<TicketId>();
  async function advancePipeline(): Promise<void> {
    if (store && bus && reviewProtocol && runner)
      await advanceReviewRequests(store, bus, reviewProtocol, runner, seenReviewRequests);
    if (store && bus && runner)
      await advanceEngineerVerdicts(store, bus, runner, seenEngineerVerdicts);
    if (gateService && runner) await advanceHilResolutions(gateService, runner, seenHilResolutions);
    if (bus && runner) await advanceArchitectInbox(bus, runner, seenArchitectInbox);
    if (store && runner) await advanceQaSpawns(store, runner, qaSpawned);
    if (store && mergeOwner) await advanceDoneTickets(store, mergeOwner, mergedDone);
  }
  const ceremonyTimer =
    gateService && emLoop
      ? setInterval(() => {
          void (async () => {
            try {
              await gateService.tick();
              if (handoffCoordinator && store) {
                await handoffCoordinator.tick(store.listTickets().map((t) => t.id));
              }
              await emLoop.tick();
              await advancePipeline();
            } catch (err) {
              console.error('ceremony tick failed:', err);
            }
          })();
        }, CEREMONY_TICK_MS)
      : undefined;
  ceremonyTimer?.unref();

  // Role-scoped verb providers (T014 architect; T016 review; T015 em; T017
  // adds qa). Each provider is only *listed* for its roles; the verbs
  // themselves re-check the caller's role, so a mis-scoped listing can never
  // widen what an agent may do.
  let reviewDeps: ReviewVerbDeps | undefined;
  if (toolService && store && bus && runner) {
    const architect = registerArchitectTools({ store });
    if (qaProtocol) {
      const qaTools = registerQaTools(qaProtocol);
      toolService.registerProvider({
        roles: ['qa'],
        listTools: () =>
          qaTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSpec: t.inputSpec,
          })),
        callTool: (ctx, name, input) => {
          const tool = qaTools.find((t) => t.name === name);
          if (!tool) throw new Error(`unknown qa verb: ${name}`);
          return tool.handler(ctx, input);
        },
      });
    }
    if (handoffCoordinator) {
      const handoffTools = registerHandoffTools();
      toolService.registerProvider({
        roles: ['em', 'human'],
        listTools: () =>
          handoffTools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSpec: t.inputSpec,
          })),
        callTool: (ctx, name, input) => {
          const tool = handoffTools.find((t) => t.name === name);
          if (!tool) throw new Error(`unknown handoff verb: ${name}`);
          return tool.handler({ store, bus }, ctx, input);
        },
      });
    }
    if (emLoop && gateService && mergeOwner) {
      const emDeps: EmToolDeps = {
        store,
        bus,
        gateService,
        runner,
        sprintReview: {
          mergeIntegrationToMain: async () => {
            const outcome = await mergeOwner.mergeIntegrationToMain();
            if (outcome.status !== 'merged') {
              throw new Error(
                `integration -> main merge did not land (${outcome.status}): ${outcome.summary}`,
              );
            }
          },
        },
      };
      toolService.registerProvider({
        roles: ['em'],
        listTools: () =>
          EM_TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSpec: t.inputSpec,
          })),
        callTool: (ctx, name, input) => {
          const tool = EM_TOOLS.find((t) => t.name === name);
          if (!tool) throw new Error(`unknown em verb: ${name}`);
          return tool.handler(emDeps, ctx, input);
        },
      });
    }
    toolService.registerProvider({
      roles: ['architect'],
      listTools: () =>
        architect
          .listTools()
          .map((t) => ({ name: t.name, description: t.description, inputSpec: t.inputSpec })),
      callTool: (ctx, name, input) =>
        architect.callTool({ agent: ctx.agent, ticket: ctx.ticket }, name, input),
    });

    // Review protocol (T016, §12): `diff_summary` + reviewer verbs for the
    // reviewer role, `review_dispute` (+ `review_get`) for the engineer
    // role. Reuses the instance hoisted above the ceremony timer (T021) —
    // guaranteed constructed here, since it shares this block's exact
    // `store && bus && runner` guard.
    reviewDeps = { protocol: reviewProtocol as ReviewProtocol, store, stateRoot: config.stateRoot };
    const deps = reviewDeps;
    const reviewToolDeps = { store, bus, repoRoot: config.repoRoot };
    const STRING = { type: 'string', optional: false } as const;
    const STRING_OPT = { type: 'string', optional: true } as const;
    const NUMBER = { type: 'number', optional: false } as const;
    const ARRAY_OPT = { type: 'array', optional: true } as const;
    const OBJECT = { type: 'object', optional: false } as const;
    const reviewGetTool = {
      name: 'review_get',
      description: "Read one round's stored review verdict for the caller's ticket.",
      inputSpec: { round: NUMBER, pass: STRING_OPT },
      handler: reviewGet,
    };
    const reviewerVerbs = [
      ...REVIEW_BUILTIN_TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSpec: t.inputSpec,
        handler: (ctx: { agent: string; ticket?: string }, input: unknown) =>
          t.handler(reviewToolDeps, ctx, input),
      })),
      {
        name: 'review_submit',
        // Measured on the first live run with verbs (2026-09-10): this spec
        // advertised `verdict` as an OBJECT while `VerdictSchema` requires
        // the string enum, and `pass` as required — the reviewer retried
        // review_submit 34 times against the zod rejection and no review
        // record ever landed. The description now spells out the exact
        // shape so the model gets it right on the first call.
        description:
          "Submit this round's verdict for the caller's ticket (reviewer-only). " +
          'Input: { round: 1-based integer, verdict: "approve" | "request_changes" | "escalate", ' +
          'findings?: [{ severity: "blocker" | "major" | "minor" | "nit", location: { path, line? }, ' +
          'message, rule?: "RULE-###" | oracle_ref?: "DEC-####" (exactly one of the two) }], ' +
          'pass?: "primary" (default) | "security" }. Findings default to []; a clean pass is ' +
          'verdict "approve" with findings [].',
        inputSpec: { round: NUMBER, pass: STRING_OPT, verdict: STRING, findings: ARRAY_OPT },
        handler: (ctx: { agent: string; ticket?: string }, input: unknown) =>
          reviewSubmit(deps, ctx, input),
      },
      {
        ...reviewGetTool,
        handler: (ctx: { agent: string; ticket?: string }, input: unknown) =>
          reviewGet(deps, ctx, input),
      },
      {
        name: 'rules_list',
        description: 'List the review rules a finding must cite (reviewer-only).',
        inputSpec: {},
        handler: (ctx: { agent: string; ticket?: string }, input: unknown) =>
          rulesList(deps, ctx, input),
      },
    ];
    const engineerVerbs = [
      {
        ...reviewGetTool,
        handler: (ctx: { agent: string; ticket?: string }, input: unknown) =>
          reviewGet(deps, ctx, input),
      },
      {
        name: 'review_dispute',
        description:
          'Dispute one review finding by its round-trip identity (path/line + citation) (engineer-only).',
        inputSpec: { finding: OBJECT },
        handler: (ctx: { agent: string; ticket?: string }, input: unknown) =>
          reviewDispute(deps, ctx, input),
      },
    ];
    for (const [roles, verbs] of [
      [['reviewer'], reviewerVerbs],
      [['engineer'], engineerVerbs],
    ] as const) {
      toolService.registerProvider({
        roles,
        listTools: () =>
          verbs.map((v) => ({ name: v.name, description: v.description, inputSpec: v.inputSpec })),
        callTool: (ctx, name, input) => {
          const verb = verbs.find((v) => v.name === name);
          if (!verb) throw new Error(`unknown review verb: ${name}`);
          return verb.handler(ctx, input);
        },
      });
    }
  }

  const extraMethods =
    store && gateService && bus && toolService && runner && mergeOwner
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
          ...buildRunnerRpcMethods(runner),
          ...(reviewDeps ? buildReviewRpcMethods(reviewDeps) : {}),
          ...buildMergeRpcMethods(mergeOwner),
          ...(emLoop ? buildEmRpcMethods(emLoop, store) : {}),
          ...(qaProtocol ? buildQaRpcMethods(qaProtocol) : {}),
          ...(quotaService ? buildQuotaRpcMethods(quotaService, store) : {}),
          ...(handoffCoordinator ? buildHandoffRpcMethods(handoffCoordinator, store, bus) : {}),
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
      quota: quotaService,
      // T025 review round 1 (blocker 3, manager-granted): without this the
      // control room's EM chat and Oracle propose-edit routes 503 forever
      // — `bus` is already constructed above for the RPC `bus.*` methods.
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
    runner,
    mergeOwner,
    reviewProtocol,
    qaProtocol,
    emLoop,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        // Stops the sweep and every live session's underlying process
        // (graceful — same `stop()` path a `runner.stop` RPC call takes);
        // does not wait on each session's own exit/crash cleanup, so this
        // never blocks shutdown on a slow-to-die agent.
        if (ceremonyTimer) clearInterval(ceremonyTimer);
        runner?.stopAll();
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
