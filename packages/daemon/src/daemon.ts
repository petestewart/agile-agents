/**
 * `agiled` orchestration: wires config discovery, the lock, the service
 * graph, the unix-socket JSON-RPC server and the localhost HTTP+WebSocket
 * server into one start/stop lifecycle.
 */

import { existsSync } from 'node:fs';
import daemonPackageJson from '../package.json' with { type: 'json' };
import { AttachService, VerbService, buildAttachRpcMethods } from './attach';
import { Bus, buildBusRpcMethods } from './bus';
import { type Classifier, ClassifierKeyService, JevClassifier } from './classifier';
import { type AgileConfig, type DiscoverConfigOptions, discoverConfig } from './config';
import { AutonomyService } from './coordination/autonomy';
import { CardService } from './coordination/cards';
import { ContractService } from './coordination/contracts';
import { PlanService } from './coordination/plans';
import { SiblingService } from './coordination/siblings';
import {
  ClassifierDiffRules,
  DeliveryService,
  SessionShipReviewer,
  ShipChecks,
  buildDeliveryRpcMethods,
  wireLandGateResolution,
} from './delivery';
import { DocsService, buildDocsRpcMethods } from './docs';
import { type EmitRouted, RoutedEventService, emitTransitions, makeEmitter } from './events';
import { GateService, buildGateRpcMethods } from './gates';
import type { DelegateFn } from './gates';
import { PrPoller } from './github/poller';
import { createGitHubRest, ghTokenSource, githubAuthAvailable } from './github/rest';
import {
  HookService,
  buildHookRpcMethods,
  wireClassifierRouteStats,
  wireGateDecisionDelivery,
} from './hook';
import { type HttpServerHandle, startHttpServer } from './http';
import { InboxService, buildInboxRpcMethods } from './inbox';
import { KnowledgeService, buildKnowledgeRpcMethods, ensureBuiltinKnowledge } from './knowledge';
import { LessonsService } from './lessons';
import { type LockHandle, acquireLock } from './lock';
import { ProjectService, buildProjectRpcMethods } from './projects';
import { QuestionService, buildQuestionRpcMethods, wireQuestionSupersession } from './questions';
import { type RpcServerHandle, startRpcServer } from './rpc';
import { resolveCliBin } from './runner';
import { StateStore, buildStateRpcMethods } from './store';
import { migrateHome } from './store/migrate';
import { RepoInPlaceService, StreamService, buildStreamRpcMethods } from './streams';
import { MainSync, OverlapTracker, SymbolWatcher } from './sync';

export const DAEMON_VERSION: string = daemonPackageJson.version;

/** Gate tick cadence (30 s). */
export const GATE_TICK_MS = 30 * 1000;

export interface DaemonHandle {
  config: AgileConfig;
  lock: LockHandle;
  rpc: RpcServerHandle;
  http: HttpServerHandle;
  startedAt: number;
  /**
   * The internal object graph, for a caller that drives the daemon
   * in-process. Every field is `undefined` before `agile init`.
   */
  store?: StateStore;
  bus?: Bus;
  gateService?: GateService;
  streamService?: StreamService;
  questionService?: QuestionService;
  rulesService?: KnowledgeService;
  lessonsService?: LessonsService;
  inboxService?: InboxService;
  attachService?: AttachService;
  verbService?: VerbService;
  /**
   * The classifier tier (§6.2), from `classifier:` in `config.yaml`. Always
   * present: an unconfigured tier's `ask` throws
   * `ClassifierUnavailableError`, which §6.4's fail policy consumes.
   */
  classifier: Classifier;
  /** Graceful shutdown: closes both servers, then releases the lock. */
  stop(): Promise<void>;
}

export interface StartDaemonOptions extends DiscoverConfigOptions {
  /** Test seam: the classifier (`bun test` has no network). Real usage gets a `JevClassifier`. */
  classifier?: Classifier;
  /** Test seam: whether GitHub auth is available (default: `gh auth token` succeeds). */
  githubAuth?: () => Promise<boolean>;
  /** Test/offline seam: `GateService`'s delegate. Real usage leaves it unset. */
  gateDelegate?: DelegateFn;
  /**
   * Gate tick cadence (default 30 s). `0` disables the timer for a test
   * that drives `gateService.tick()` itself (two drivers double-decide).
   */
  gateTickMs?: number;
  /** T227: the `touched` sweep interval; 0 disables it (tests). */
  overlapRecomputeMs?: number;
  /** Test seam: the clock threaded to `Bus` (heartbeat timestamps and coalescing). */
  now?: () => Date;
}

export async function startDaemon(options: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const config = discoverConfig(options);
  const startedAt = Date.now();
  // T221 (§18): whether `gh` can supply a token, never the token. T222's pr refusal asks it too.
  const githubAuth =
    options.githubAuth ?? (() => githubAuthAvailable(ghTokenSource(config.github.gh_command)));
  // The classifier tier (§6.2, D5), consumed by the hook and landing.
  const classifier: Classifier =
    options.classifier ?? new JevClassifier({ config: config.classifier });

  // The home may not exist yet (before `agile init`): then only the stub
  // handlers run.
  const store = existsSync(config.stateRoot) ? StateStore.open(config.stateRoot) : undefined;
  // One GateService behind `gate.*` RPC and the HTTP gate routes.
  const gateService = store
    ? new GateService(store, options.gateDelegate ? { delegate: options.gateDelegate } : {})
    : undefined;
  // A merge (land or a PR merged) hands the node to the retro (§17: after `merged`).
  // Every back-reference in this graph is read lazily through a closure,
  // so construction order is never a trap.
  const streamService: StreamService | undefined = store
    ? new StreamService(store, {
        // T244: record changes that are routed events (child_status, pr_merged, …).
        onUpdated: async (before, after): Promise<void> => {
          if (emitRouted) await emitTransitions(emitRouted)(before, after);
          // T283: the node's status card follows its record.
          await cardService?.refresh(after);
        },
      })
    : undefined;
  // T283: status cards; `read_card` and the cockpit read them.
  const cardService: CardService | undefined =
    store && streamService
      ? new CardService({
          store,
          streams: streamService,
          // T281: the contracts this node is a party to (read lazily; built below).
          reliesOn: (s) => contractService?.forParty(s.id).map((c) => c.id),
        })
      : undefined;
  const projectService =
    store && streamService ? new ProjectService(store, streamService) : undefined;
  // How spawned sessions reach this daemon's CLI for hooks and MCP,
  // resolved to something that runs on this host, never assumed on $PATH.
  const cliBin = resolveCliBin();
  // T240–T242: routed events, one service for every producer and the delivery.
  const routedEvents = store ? new RoutedEventService(store) : undefined;
  // T244: the producers' emit hook over that one service.
  const emitRouted: EmitRouted | undefined =
    routedEvents && streamService ? makeEmitter(routedEvents, streamService) : undefined;
  // Rules (§5): read by every brief, the hook and landing. T264: accepting emits.
  const rulesService =
    store && streamService
      ? new KnowledgeService({
          store,
          streams: streamService,
          ...(emitRouted ? { emitRouted } : {}),
        })
      : undefined;
  // T281: plans and contracts (§14.4) — the coordinator's verbs, briefs, the inbox card.
  const contractService =
    store && streamService
      ? new ContractService({
          store,
          streams: streamService,
          ...(emitRouted ? { emit: emitRouted } : {}),
        })
      : undefined;
  const planService =
    store && streamService && contractService
      ? new PlanService({
          store,
          streams: streamService,
          contracts: contractService,
          ...(emitRouted ? { emit: emitRouted } : {}),
          // T336: a part waiting for the plan starts when the approved plan gives it paths.
          start: async (id: string): Promise<unknown> => {
            if (attachService === undefined) throw new Error('attach is not available');
            return attachService.startWithPending(id);
          },
        })
      : undefined;
  // T282: the autonomy gate for a coordinator's structural changes, and its proposals.
  const autonomyService =
    store && streamService
      ? new AutonomyService({
          store,
          streams: streamService,
          ...(planService ? { plans: planService } : {}),
          ...(contractService ? { contracts: contractService } : {}),
        })
      : undefined;
  // Attach and questions know about each other: the turn-end rule asks
  // what is open, and an answer is delivered by prompting the session.
  const attachService =
    store && streamService
      ? new AttachService({
          store,
          streams: streamService,
          home: config.home,
          socketPath: config.socketPath,
          cliBin: { command: cliBin.command, args: cliBin.args },
          docs: { docsForStream: (id) => docsService?.docsForStream(id) ?? [] },
          questions: { listOpen: () => questionService?.listOpen() ?? [] },
          ...(rulesService ? { rules: rulesService } : {}),
          ...(planService ? { plans: planService } : {}),
          ...(contractService ? { contracts: contractService } : {}),
          // The turn-end rule treats an open routed call like an open question.
          ...(gateService ? { gates: gateService } : {}),
          ...(routedEvents ? { events: routedEvents } : {}),
          onWorkerTurnEnd: (id) => {
            void mainSync?.turnEnded(id).catch((err) => console.error('main sync failed:', err));
          },
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
          ...(planService ? { plans: planService } : {}),
          ...(contractService ? { contracts: contractService } : {}),
          ...(autonomyService ? { proposals: autonomyService } : {}),
        })
      : undefined;
  // Docs: plain Markdown under `<home>/repos/<name>/docs/` and `<home>/streams/<id>.docs/`.
  const docsService =
    store && streamService ? new DocsService(store, streamService, config.stateRoot) : undefined;
  // The landing path (§8.2) and its diff-level rule tier, which needs a
  // rules service (without one, landing keeps its allow-all default).
  const diffRules =
    store && streamService && rulesService
      ? new ClassifierDiffRules({
          rules: rulesService,
          classifier,
          config: config.classifier,
          streams: streamService,
          policy: () => store.getPolicy(),
          repos: () => store.getRepos(),
          ...(gateService ? { gates: gateService } : {}),
        })
      : undefined;
  // T262: the ship check — the classifier step, then a reviewer session
  // over the `review` items in scope; findings go back as `ship_findings`.
  let redeliver: ((streamId: string) => Promise<unknown>) | undefined;
  const shipChecks =
    diffRules && rulesService && store
      ? new ShipChecks({
          classifier: diffRules,
          rules: rulesService,
          policy: () => store.getPolicy(),
          ...(gateService ? { gates: gateService } : {}),
          ...(emitRouted ? { emit: emitRouted } : {}),
          ...(attachService && streamService
            ? {
                reviewer: new SessionShipReviewer({
                  attach: attachService,
                  streams: streamService,
                  onFinished: (id) => redeliver?.(id),
                }),
              }
            : {}),
        })
      : undefined;
  // T226: sync after merge — main merged into the other live nodes on the repo.
  const mainSync =
    store && streamService
      ? new MainSync({
          streams: streamService,
          repos: () => store.getRepos(),
          ...(options.overlapRecomputeMs !== undefined
            ? { intervalMs: options.overlapRecomputeMs }
            : {}),
          ...(emitRouted ? { emit: emitRouted } : {}),
        })
      : undefined;
  mainSync?.start();
  const landingService =
    store && streamService
      ? new DeliveryService({
          store,
          streams: streamService,
          ...(shipChecks ? { diffRules: shipChecks } : {}),
          ...(gateService ? { gates: gateService } : {}),
          github: (entry) =>
            createGitHubRest({
              apiUrl: config.github.api_url,
              ...(entry.github ? { repo: entry.github } : {}),
              tokenSource: ghTokenSource(config.github.gh_command),
            }),
          onStreamEnd: async (id) => {
            await lessonsService?.onStreamEnd(id);
          },
          ...(mainSync ? { onMainMoved: (repo, id) => mainSync.mainMoved(repo, id) } : {}),
          // T340: a deliver that finds the PR merged on GitHub records it at once.
          refreshPr: (id: string): Promise<unknown> | undefined => prPoller?.pollNow(id),
        })
      : undefined;
  if (gateService && landingService) wireLandGateResolution(gateService, landingService);
  if (landingService) redeliver = (id) => landingService.land(id);
  // Deciding a gate closes the question the same session left open; wired
  // before the delivery below so it is superseded before the prompt.
  if (gateService && questionService) wireQuestionSupersession(gateService, questionService);
  // Deciding a `classifier_review` gate prompts the blocked session.
  if (gateService && attachService) wireGateDecisionDelivery(gateService, attachService);
  // A human's answer on a routed classifier call counts in the rule's stats (a deny is a violation).
  if (gateService && rulesService) wireClassifierRouteStats(gateService, rulesService);

  // The retro (§5.5): one read-only `lessons` session over the stream's
  // findings, denials and questions; at most three proposals.
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
  // One `Bus` shared by `bus.*` RPC and the hook service.
  const bus = store ? new Bus(store, config.stateRoot, { now: options.now }) : undefined;
  // The eight verbs an attached session gets (§4.1).
  const verbService =
    store && streamService && questionService
      ? new VerbService({
          store,
          streams: streamService,
          questions: questionService,
          ...(docsService ? { docs: docsService } : {}),
          ...(rulesService ? { rules: rulesService } : {}),
          ...(routedEvents ? { events: routedEvents } : {}),
          ...(cardService ? { cards: cardService } : {}),
          ...(planService ? { plans: planService } : {}),
          ...(contractService ? { contracts: contractService } : {}),
          ...(autonomyService ? { autonomy: autonomyService } : {}),
          ...(routedEvents && emitRouted
            ? {
                siblings: new SiblingService({
                  streams: streamService,
                  emit: emitRouted,
                  events: routedEvents,
                }),
              }
            : {}),
          ...(emitRouted ? { emitRouted } : {}),
          // T246: an agent's push; its PR is then polled at the babysit cadence.
          ...(landingService
            ? {
                delivery: {
                  push: async (id: string) => {
                    const out = await landingService.push(id);
                    prPoller?.flag(id);
                    return out;
                  },
                },
              }
            : {}),
          // The three-proposal cap.
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

  // The gate tick (`human_timeout` fallthrough); nothing else calls
  // `tick()`. Errors are logged, never fatal: the daemon is long-lived (D9).
  const gateTickMs = options.gateTickMs ?? GATE_TICK_MS;
  const gateTimer =
    gateService && gateTickMs > 0
      ? setInterval(() => {
          void gateService.tick().catch((err) => console.error('gate tick failed:', err));
        }, gateTickMs)
      : undefined;
  gateTimer?.unref();

  // The classifier key behind Settings; mutates `config.classifier` in
  // place, which every key reader shares.
  const classifierKey = store
    ? new ClassifierKeyService({ config: config.classifier, store })
    : undefined;

  // §5.6's evals, shared by `rule.test` and the cockpit's "Test examples".
  const ruleEvals = store
    ? {
        classifier,
        bands: config.classifier.bands,
        timeout_ms: config.classifier.timeout_ms,
        events: store,
      }
    : undefined;

  // P10: an event stored with no delivery (a crash mid-emit) is routed again.
  if (routedEvents) {
    try {
      await routedEvents.recover();
    } catch (err) {
      console.error('agiled: could not recover routed events:', err);
    }
  }
  // T243: nodes left with pending events are considered for wake/delivery now.
  attachService?.wakePending();

  // §17.1 (T202): the one-shot, idempotent migration into projects.
  if (store && streamService && projectService && questionService) {
    await migrateHome({
      store,
      streams: streamService,
      projects: projectService,
      questions: questionService,
    });
  }

  // T284: the import index, changed exports on cards, and `symbol_changed`.
  const symbolWatcher =
    store && streamService
      ? new SymbolWatcher({
          store,
          streams: streamService,
          repos: () => store.getRepos(),
          ...(emitRouted ? { emit: emitRouted } : {}),
        })
      : undefined;
  // T227: overlap tracking — `touched` after edit hooks, commits and every 60 s.
  const overlapTracker =
    store && streamService
      ? new OverlapTracker({
          streams: streamService,
          repos: () => store.getRepos(),
          ...(options.overlapRecomputeMs !== undefined
            ? { intervalMs: options.overlapRecomputeMs }
            : {}),
          ...(emitRouted ? { emit: emitRouted } : {}),
          ...(symbolWatcher
            ? {
                afterTouched: (id: string) =>
                  symbolWatcher
                    .onTouched(id)
                    .catch((err) => console.error('symbol watch failed:', err)),
              }
            : {}),
        })
      : undefined;
  overlapTracker?.start();

  // T225: the PR poller — the node's open PR is its status.
  const prPoller =
    store && streamService
      ? new PrPoller({
          streams: streamService,
          repos: () => store.getRepos(),
          github: (entry) =>
            createGitHubRest({
              apiUrl: config.github.api_url,
              ...(entry.github ? { repo: entry.github } : {}),
              tokenSource: ghTokenSource(config.github.gh_command),
            }),
          ...(questionService ? { ask: (q) => questionService.raise(q) } : {}),
          ...(mainSync
            ? { onMainMoved: (repo: string, except?: string) => mainSync.mainMoved(repo, except) }
            : {}),
          onMerged: (id: string) => lessonsService?.onStreamEnd(id),
          ...(landingService ? { afterTick: () => landingService.settle() } : {}),
          ...(emitRouted ? { emit: emitRouted } : {}),
          home: config.home,
        })
      : undefined;
  prPoller?.start();

  // T205: "+ Repo" in place (projects-design §7), over the attach service's sessions.
  const repoInPlace =
    store && streamService && attachService
      ? new RepoInPlaceService(store, streamService, {
          attach: (id) => attachService.attach(id),
          stop: (id, reason) =>
            attachService.stop(id, undefined, reason !== undefined ? { reason } : {}),
        })
      : undefined;
  const extraMethods =
    store && gateService && bus
      ? {
          ...buildStateRpcMethods(store, { githubAuth }),
          ...buildBusRpcMethods(bus),
          ...buildGateRpcMethods(gateService),
          ...(questionService ? buildQuestionRpcMethods(questionService) : {}),
          ...(streamService
            ? buildStreamRpcMethods(streamService, {
                // `agile stream say` is the composer's path too.
                ...(attachService
                  ? {
                      create: (principal, input, opts) =>
                        attachService.createNode(principal, input, opts),
                      ...(repoInPlace ? { repoInPlace } : {}),
                      reply: {
                        say: (id: string, body: string) => attachService.say(id, body),
                        ...(questionService ? { questions: questionService } : {}),
                      },
                    }
                  : {}),
              })
            : {}),
          ...(projectService ? buildProjectRpcMethods(projectService) : {}),
          ...(inboxService ? buildInboxRpcMethods(inboxService) : {}),
          ...(rulesService ? buildKnowledgeRpcMethods(rulesService, ruleEvals) : {}),
          ...(docsService ? buildDocsRpcMethods(docsService) : {}),
          ...(landingService ? buildDeliveryRpcMethods(landingService) : {}),
          ...buildHookRpcMethods(
            // The route band needs the gates, the pattern tier the rules in
            // scope (a retired rule stops gating on the next call), and the
            // classifier tier its config (none configured ⇒ §6.4's fail
            // policy). No repo root: a relative worktree fails closed.
            new HookService(store, bus, {
              gates: gateService,
              agileHome: config.home,
              ...(rulesService ? { rules: rulesService } : {}),
              classifier: { ask: classifier, config: config.classifier },
              ...(overlapTracker
                ? {
                    onFilesMayHaveChanged: (stream: string) => {
                      void overlapTracker
                        .recompute(stream)
                        .catch((err) => console.error('overlap recompute failed:', err));
                    },
                  }
                : {}),
            }),
          ),
          ...(attachService && verbService
            ? buildAttachRpcMethods(attachService, verbService, landingService)
            : {}),
        }
      : undefined;

  /**
   * Bind the port before taking the lock: the lock file is the pidfile
   * `agile daemon start` waits for, so it must only appear for a daemon
   * that is actually serving. The unix socket comes after the lock, since
   * `startRpcServer` unlinks a stale socket a second daemon must never
   * unlink under the live one.
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
    ...(projectService ? { projects: projectService } : {}),
    questions: questionService,
    inbox: inboxService,
    ...(rulesService ? { rules: rulesService } : {}),
    ...(rulesService && ruleEvals ? { ruleEvals } : {}),
    ...(classifierKey ? { classifierKey } : {}),
    ...(landingService ? { landing: landingService } : {}),
    ...(prPoller ? { prCheck: (id: string) => prPoller.pollNow(id) } : {}),
    ...(attachService ? { attach: attachService } : {}),
    ...(routedEvents ? { events: routedEvents } : {}),
    ...(repoInPlace ? { repoInPlace } : {}),
    ...(docsService ? { docs: docsService } : {}),
    ...(planService ? { plans: planService } : {}),
    ...(contractService ? { contracts: contractService } : {}),
    ...(autonomyService ? { autonomy: autonomyService } : {}),
    githubAuth,
  });

  // §5.4's built-in pattern rules, idempotent, before any call is accepted
  // (a retired built-in stays retired).
  if (store) {
    try {
      await ensureBuiltinKnowledge(store);
    } catch (err) {
      // Not fatal: re-attempted on the next start.
      console.error('agiled: could not create the built-in rules:', err);
    }
  }

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
      // `agile daemon status`: whether a key is loaded and its source, never the key.
      ...(classifierKey ? { classifierStatus: () => classifierKey.status() } : {}),
      // T221 (§18): whether `gh` can supply a token, never the token.
      githubAuth,
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
    classifier,
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (gateTimer) clearInterval(gateTimer);
        overlapTracker?.stop();
        prPoller?.stop();
        mainSync?.stop();
        // Sessions are child processes: stop them first so their exit writes land.
        attachService?.delivery.stop();
        await attachService?.stopAll();
        await http.stop();
        await rpc.close();
        // Don't lose the rule stats since the last coalesced flush.
        if (rulesService) {
          await rulesService.flushStats();
          rulesService.dispose();
        }
        // Drain pending writes, then close the store.
        await store?.flush();
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
