/**
 * `agiled` orchestration: wires config discovery, the lock, the service
 * graph, the unix-socket JSON-RPC server and the localhost HTTP+WebSocket
 * server into one start/stop lifecycle.
 */

import { existsSync } from 'node:fs';
import { ACP_PROVIDERS, type spawnSession } from '@agile-agents/acp-client';
import { type ThreadEntry, isHarnessId, trackerStatus } from '@agile-agents/shared';
import daemonPackageJson from '../package.json' with { type: 'json' };
import { AttachService, VerbService, buildAttachRpcMethods } from './attach';
import {
  type BridgeDownloader,
  BridgeInstallService,
  type BridgeUnzipper,
  providerIn,
} from './bridges';
import { Bus, buildBusRpcMethods } from './bus';
import {
  type Classifier,
  ClassifierKeyService,
  JevClassifier,
  TYPESAFE_API_KEY_ENV,
} from './classifier';
import {
  type AgileConfig,
  type DiscoverConfigOptions,
  discoverConfig,
  readHomeConfigFile,
} from './config';
import { AutonomyService } from './coordination/autonomy';
import { CardService } from './coordination/cards';
import { ContractService } from './coordination/contracts';
import { PlanService, planMoveCoordination } from './coordination/plans';
import { SiblingService } from './coordination/siblings';
import {
  ClassifierDiffRules,
  DeliveryService,
  SessionShipReviewer,
  ShipChecks,
  buildDeliveryRpcMethods,
  git,
  wireLandGateResolution,
} from './delivery';
import { DirectorService, NormWatch, buildDirectorRpcMethods } from './director';
import { DocsService, buildDocsRpcMethods } from './docs';
import {
  type EmitRouted,
  KnowledgeWakeJudge,
  type OpenQuestionOf,
  RoutedEventService,
  emitTransitions,
  makeEmitter,
} from './events';
import { GateService, buildGateRpcMethods } from './gates';
import type { DelegateFn } from './gates';
import { PrPoller } from './github/poller';
import { createGitHubRest, ghTokenSource, githubAuthAvailable } from './github/rest';
import {
  type CommandRunner,
  HarnessUpdateService,
  bridgesOf,
  bunCommandRunner,
  offlineCommandRunner,
} from './harness';
import {
  HookService,
  HookSightings,
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
import {
  ChatThreads,
  QuestionService,
  QuestionThreads,
  buildQuestionRpcMethods,
  wireQuestionSupersession,
} from './questions';
import { CHOOSE_AGAIN_END_REASON, ModelPolicyService, buildModelPolicyRpcMethods } from './routing';
import { type RpcServerHandle, startRpcServer } from './rpc';
import { missingVendorCommand, resolveCliBin } from './runner';
import { installedCliFor } from './runner/installed-cli';
import { ModelCatalog, sessionVendorIndex } from './runner/model-catalog';
import {
  VendorCheckService,
  buildVendorCheckRpcMethods,
  vendorsLeftOut,
} from './runner/vendor-check';
import { StateStore, buildStateRpcMethods } from './store';
import { migrateHome } from './store/migrate';
import {
  AutoClose,
  type MoveCoordination,
  RepoInPlaceService,
  StreamService,
  TitleNamer,
  type TitleRun,
  buildStreamRpcMethods,
  claudeTitleRun,
} from './streams';
import { MainSync, OverlapTracker, SymbolWatcher } from './sync';
import { trackerFromConfig } from './trackers/create';
import { TrackerLinks } from './trackers/link';
import { TrackerStatusPush } from './trackers/push';
import { buildTrackerRpcMethods } from './trackers/rpc';
import { buildTrackerSettingsRpcMethods } from './trackers/settings';

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
  /**
   * T414 (D41): the model call that names untitled nodes. Default: `claude -p`
   * with Haiku when the CLI is on the PATH (never under `bun test`); `null` turns it off.
   */
  titleRun?: TitleRun | null;
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
  /** Test seam (T341): every agent and Director session's `spawnSession` (the fake agent offline). */
  spawn?: typeof spawnSession;
  /**
   * T481 (D50): runs the vendor CLIs' version checks and updates. Default:
   * the real runner, except under `bun test`, where nothing runs (and no
   * check is scheduled) unless a test injects one.
   */
  harnessRunner?: CommandRunner;
  /**
   * T500: how a downloaded bridge's archive is fetched and unpacked. Default:
   * HTTPS and `unzip`, except under `bun test`, where nothing is fetched or
   * unpacked unless a test injects fakes.
   */
  bridgeDownload?: BridgeDownloader;
  bridgeUnzip?: BridgeUnzipper;
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
  // so construction order is never a trap. One the startup migration can
  // reach before it is built is a `let`, so it reads as `undefined` (T337).
  let trackerPush: TrackerStatusPush | undefined;
  let autoClose: AutoClose | undefined;
  // T465 (D48): the attach service, once built: a node closed or merged ends its resting session.
  let restingSessions: AttachService | undefined;
  // T497: a node's latest open question, once the question service is built.
  let openQuestionOf: OpenQuestionOf | undefined;
  const streamService: StreamService | undefined = store
    ? new StreamService(store, {
        // T244: record changes that are routed events (child_status, pr_merged, …).
        onUpdated: async (before, after): Promise<void> => {
          if (emitRouted) {
            await emitTransitions(emitRouted, streamService, (node) => openQuestionOf?.(node))(
              before,
              after,
            );
          }
          // T283: the node's status card follows its record.
          await cardService?.refresh(after);
          // T324: Node → tracker (off unless the project turns it on); never blocks the update.
          void trackerPush?.onUpdated(before, after);
          // T478: a node set to auto-close closes itself when its goal is met; never blocks.
          void autoClose?.onUpdated(before, after);
          // T465: awaited, so a merge's worktree removal comes after the session ended.
          await restingSessions?.onNodeUpdated(before, after);
        },
        // T333: a move is refused while a plan awaits approval (read lazily; built below).
        coordination: {
          planAwaitingApproval: (node): boolean =>
            moveCoordination?.planAwaitingApproval(node) === true,
          namedIn: (parent, child): string[] => moveCoordination?.namedIn(parent, child) ?? [],
        },
        // T361: a live agent follows its node's role change (read lazily; built below).
        onTreeChanged: async (nodes): Promise<void> => attachService?.followRoles(nodes),
        // T504 (§7): a promoted thread's lines as the chat shows them (read lazily; built below).
        threadLines: (node, thread): ThreadEntry[] | undefined =>
          chatThreads?.linesOf(node, thread),
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
          // T338: approval supersedes the parts' questions it answers (the service is built below).
          questions: {
            supersedeByPlan: async (node, version) =>
              questionService?.supersedeByPlan(node, version),
          },
          // T336: a part waiting for the plan starts when the approved plan gives it paths.
          start: async (id: string): Promise<unknown> => {
            if (attachService === undefined) throw new Error('attach is not available');
            return attachService.startWithPending(id);
          },
        })
      : undefined;
  const moveCoordination: MoveCoordination | undefined =
    planService && contractService ? planMoveCoordination(planService, contractService) : undefined;
  // T282: the autonomy gate for a coordinator's structural changes, and its proposals.
  const autonomyService =
    store && streamService
      ? new AutonomyService({
          store,
          streams: streamService,
          ...(planService ? { plans: planService } : {}),
          ...(contractService ? { contracts: contractService } : {}),
          ...(projectService ? { projects: projectService } : {}),
          ...(emitRouted ? { emit: emitRouted } : {}),
        })
      : undefined;
  // T467 (D46): each vendor's model list, read once from the sessions'
  // session-state files (newest first) and kept up to date as sessions open.
  const modelCatalog = streamService
    ? new ModelCatalog({
        home: config.home,
        vendorOfSession: sessionVendorIndex(streamService),
        ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
        // T480 (D49): Refresh lists what the installed CLI offers, as a session would run.
        installedCli: (vendor) => {
          try {
            return installedCliFor(vendor, readHomeConfigFile(config.home));
          } catch {
            return undefined;
          }
        },
      }).load()
    : undefined;
  // T489 (D58): the vendor self-check. Its latest result per vendor is read from the
  // probe sessions' `self-check.json` files; a check also refreshes the model catalog.
  // Under `bun test` it never spawns a real vendor: without the fake spawn it refuses.
  const underTestSpawn = process.env.NODE_ENV === 'test' && options.spawn === undefined;
  // T500: the servers this app downloads (Antigravity's), on the operator's say only.
  // Under `bun test` nothing is fetched or unpacked unless a test injects fakes.
  const underTestBridges = process.env.NODE_ENV === 'test';
  const refuseUnderTest = async (): Promise<never> => {
    throw new Error('nothing is downloaded or unpacked under bun test');
  };
  const bridgeInstalls: BridgeInstallService | undefined = store
    ? new BridgeInstallService({
        home: config.home,
        store,
        provider: (vendor) => ACP_PROVIDERS[vendor],
        ...(options.bridgeDownload !== undefined
          ? { download: options.bridgeDownload }
          : underTestBridges
            ? { download: refuseUnderTest }
            : {}),
        ...(options.bridgeUnzip !== undefined
          ? { unzip: options.bridgeUnzip }
          : underTestBridges
            ? { unzip: refuseUnderTest }
            : {}),
        onChange: () => vendorChecks?.onChange?.(),
        onError: (err) =>
          console.error(`bridge install: ${err instanceof Error ? err.message : String(err)}`),
      })
    : undefined;
  const vendorChecks: VendorCheckService | undefined = store
    ? new VendorCheckService({
        home: config.home,
        store,
        ...(bridgeInstalls ? { installs: bridgeInstalls } : {}),
        ...(options.spawn !== undefined
          ? {
              spawn: options.spawn,
              // A downloaded bridge is installed or not whatever the transport (T500).
              missing: (vendor) => bridgeInstalls?.missing(vendor),
            }
          : underTestSpawn
            ? {
                spawn: () => {
                  throw new Error('the vendor self-check never runs a real vendor under bun test');
                },
              }
            : {}),
        installedCli: (vendor) => {
          try {
            return installedCliFor(vendor, readHomeConfigFile(config.home));
          } catch {
            return undefined;
          }
        },
        // T481's last read of the vendor's CLI (declared below; read at each check).
        cliVersion: (vendor): string | undefined =>
          isHarnessId(vendor) ? harnessUpdates?.statusOf(vendor).version : undefined,
        onSessionState: (vendor, state, session) => modelCatalog?.record(vendor, state, session),
        onError: (err) =>
          console.error(`vendor checks: ${err instanceof Error ? err.message : String(err)}`),
      }).load()
    : undefined;
  // T482: the model policy (node → ancestors → project → home → built-in), and the lock.
  const modelPolicy: ModelPolicyService | undefined =
    store && streamService
      ? new ModelPolicyService({
          store,
          streams: streamService,
          ...(modelCatalog ? { models: () => modelCatalog.all() } : {}),
          ...(options.spawn === undefined
            ? {
                installed: (vendor) =>
                  missingVendorCommand(providerIn(config.home, ACP_PROVIDERS[vendor])) ===
                  undefined,
              }
            : {}),
          // T465: a resting session ends, so the next start lets the policy pick (declared below).
          onChooseAgain: async (id: string): Promise<void> =>
            attachService?.endResting(id, CHOOSE_AGAIN_END_REASON),
          // T484: a step up ends a resting session (T465) and is recorded as a routed event.
          endResting: async (id: string, why: string): Promise<void> =>
            attachService?.endResting(id, why),
          ...(emitRouted ? { emitRouted } : {}),
          // T489 (D58): Choose leaves out a vendor whose last self-check kept its own model.
          ...(vendorChecks ? { leftOut: () => vendorsLeftOut(vendorChecks.capabilities()) } : {}),
          // T483: the chooser asks the daemon's classifier tier, bounded by its timeout.
          classifier,
          chooserTimeoutMs: () => config.classifier.timeout_ms,
          // A preview says "Jev picks" only when a start could ask it (never the key itself).
          chooserReady: () =>
            config.classifier.provider !== 'off' &&
            (config.classifier.api_key !== undefined ||
              (process.env[TYPESAFE_API_KEY_ENV] ?? '') !== ''),
          ...(planService ? { plans: planService } : {}),
        })
      : undefined;
  // T506: the hook tells the runner which sessions it saw (Codex's fail-closed check).
  const hookSightings = new HookSightings();
  // Attach and questions know about each other: the turn-end rule asks
  // what is open, and an answer is delivered by prompting the session.
  const attachService: AttachService | undefined =
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
          // T300: the `director` queue's delivery and wakes (declared below).
          director: () => directorService,
          // T454: with `knowledge_wake: jev`, Jev's say on the other conversations in scope.
          knowledgeWake: new KnowledgeWakeJudge({
            store,
            streams: () => streamService.list(),
            home: config.home,
            classifier,
            config: config.classifier,
          }),
          onWorkerTurnEnd: (id) => {
            void mainSync?.turnEnded(id).catch((err) => console.error('main sync failed:', err));
          },
          ...(modelCatalog ? { models: modelCatalog } : {}),
          ...(modelPolicy ? { routing: modelPolicy } : {}),
          hookSightings,
          ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
        })
      : undefined;
  if (attachService) restingSessions = attachService;
  // T300 (P16): the Director, above every project; its delivery is the attach service's.
  const directorService =
    store && streamService && routedEvents
      ? new DirectorService({
          store,
          streams: streamService,
          events: routedEvents,
          home: config.home,
          socketPath: config.socketPath,
          cliBin: { command: cliBin.command, args: cliBin.args },
          // T302: the digest's inbox (declared below) and norms, and stuck-node cards.
          inbox: { list: () => inboxService?.list() ?? [] },
          ...(rulesService ? { knowledge: rulesService } : {}),
          ...(autonomyService ? { autonomy: autonomyService } : {}),
          ...(modelCatalog ? { models: modelCatalog } : {}),
          hookSightings,
          ...(options.spawn !== undefined ? { spawn: options.spawn } : {}),
        })
      : undefined;
  directorService?.startSight();
  if (directorService && attachService) directorService.setDelivery(attachService.delivery);
  // T303: findings and PR review comments that repeat across projects wake the Director.
  const normWatch =
    directorService && store && streamService && routedEvents
      ? new NormWatch({ store, streams: streamService, events: routedEvents })
      : undefined;
  const checkNorms = () => {
    void normWatch?.check().catch((err) => console.error('norm watch failed:', err));
  };
  routedEvents?.onEmitted((event) => {
    if (event.type === 'pr_review') checkNorms();
  });
  // T301: the Director's start_node / restart_node (restart: stop the node's agent, start it again).
  if (autonomyService && attachService) {
    autonomyService.setAgents({
      start: (node) => attachService.attach(node),
      restart: async (node) => {
        const reason = 'restarted by the Director';
        await attachService.stop(node, 'worker', { reason });
        await attachService.stop(node, 'coordinator', { reason });
        return attachService.attach(node);
      },
    });
  }
  const questionService: QuestionService | undefined =
    store && streamService
      ? new QuestionService(store, streamService, {
          deliver: async (sessionId, question): Promise<void> => {
            await attachService?.deliverAnswer(sessionId, question);
          },
          // T502 (D62): a reply in a choice question's thread, to its agent (started if none runs).
          ...(attachService
            ? {
                reply: async (question, text) =>
                  (
                    await attachService.say(question.stream, text, {
                      start: true,
                      question: { id: question.id, text: question.text },
                    })
                  ).entry,
              }
            : {}),
        })
      : undefined;
  // T502: question threads (by ref and by cause), for Needs me and the node page.
  const questionThreads =
    streamService && questionService
      ? new QuestionThreads({
          streams: streamService,
          questions: questionService,
          ...(routedEvents ? { events: routedEvents } : {}),
        })
      : undefined;
  // T503/T504: chat threads on a node's turns (the node page, the rail, a promotion's seed).
  const chatThreads: ChatThreads | undefined = streamService
    ? new ChatThreads({
        streams: streamService,
        ...(questionService ? { questions: questionService } : {}),
        ...(routedEvents ? { events: routedEvents } : {}),
      })
    : undefined;
  if (questionService) {
    openQuestionOf = (node) => {
      const open = questionService.listOpen().filter((q) => q.stream === node);
      const latest = open.sort((a, b) => a.raised_at.localeCompare(b.raised_at)).at(-1);
      if (latest === undefined) return undefined;
      const parent = streamService?.get(node).parent;
      return {
        text: latest.text,
        toCoordinator:
          latest.coordinator !== undefined &&
          latest.coordinator === parent &&
          latest.passed_up_at === undefined,
      };
    };
  }

  // T481 (D50): each vendor's CLI kept up to date (Off, Alert or Auto). Its checks start
  // after startup (`start()` below); under `bun test` nothing runs unless a test injects a runner.
  const underTest = process.env.NODE_ENV === 'test';
  const harnessUpdates: HarnessUpdateService | undefined = store
    ? new HarnessUpdateService({
        store,
        run: options.harnessRunner ?? (underTest ? offlineCommandRunner : bunCommandRunner),
        ...(routedEvents ? { events: routedEvents } : {}),
        bridges: bridgesOf(ACP_PROVIDERS),
        onError: (err) =>
          console.error(`harness updates: ${err instanceof Error ? err.message : String(err)}`),
        // T489: a new CLI version (read by a check, or installed by an update) gets a self-check.
        ...(vendorChecks && !underTestSpawn
          ? {
              onVersions: (versions, reason) => {
                vendorChecks.noteVersions(versions, reason === 'update' ? 'update' : 'new_version');
              },
            }
          : {}),
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
          ...(harnessUpdates ? { harness: harnessUpdates } : {}),
          ...(questionThreads ? { threads: questionThreads } : {}),
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
          // T484: a merge refused twice for the same reason steps the node's model up.
          ...(modelPolicy
            ? {
                onRefused: (id: string, key: string, words: string) =>
                  modelPolicy.escalation.mergeRefused(id, key, words),
              }
            : {}),
        })
      : undefined;
  // T478: auto-close reads the branch through landing's preflight and the worktree by git.
  if (streamService && landingService && store) {
    autoClose = new AutoClose({
      streams: streamService,
      preflight: (id) => landingService.preflight(id),
      uncommitted: (node) => {
        const repoRoot = node.repo !== undefined ? store.getRepos()[node.repo]?.path : undefined;
        if (node.worktree === undefined || repoRoot === undefined) return false;
        const status = git(['status', '--porcelain=v1'], node.worktree, repoRoot);
        if (status.exitCode !== 0) return true;
        return status.stdout.split('\n').some((l) => l.length > 0 && !l.startsWith('??'));
      },
      log: (message) => console.error(message),
    });
  }
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
          onFinding: checkNorms,
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
          // T484 (D56): `escalate`, and the quiet-turn count's `progress`.
          ...(modelPolicy ? { escalation: modelPolicy.escalation } : {}),
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
  // T444: sessions a daemon that died mid-turn left "running" end first, so their nodes
  // read idle (not Working for good) and the wake below can start them again.
  if (attachService) {
    try {
      await attachService.endOrphansAtStart();
    } catch (err) {
      console.error('agiled: could not end sessions left by the last run:', err);
    }
  }
  // T482 (D54): projects that predate model routing keep Default, stamped once, before any start.
  if (modelPolicy) {
    try {
      await modelPolicy.stampExistingProjects();
    } catch (err) {
      console.error('agiled: could not stamp the projects’ model choice:', err);
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

  // T349: cards written before the `question` state read `blocked` for a node waiting on you.
  if (cardService) {
    try {
      await cardService.refreshQuestionCards();
    } catch (err) {
      console.error('agiled: could not refresh question cards:', err);
    }
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

  // T321: tracker links — the goal from the issue; edits as `external_changed`.
  const trackersConfig = () => {
    try {
      return readHomeConfigFile(config.home).trackers;
    } catch {
      return undefined;
    }
  };
  const trackerLinks =
    store && streamService
      ? new TrackerLinks({
          streams: streamService,
          project: (id) => {
            try {
              return store.getProject(id);
            } catch {
              return undefined;
            }
          },
          configured: () => {
            const t = trackersConfig();
            return (['jira', 'linear'] as const).filter((s) => t?.[s]?.token !== undefined);
          },
          tracker: (system) => trackerFromConfig(system, trackersConfig()),
          ...(emitRouted ? { emit: emitRouted } : {}),
        })
      : undefined;
  trackerLinks?.start();
  if (store) {
    trackerPush = new TrackerStatusPush({
      project: (id) => {
        try {
          return store.getProject(id);
        } catch {
          return undefined;
        }
      },
      tracker: (system) => trackerFromConfig(system, trackersConfig()),
    });
  }

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
          ...buildTrackerSettingsRpcMethods(store),
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
                      stopSessions: (id: string) =>
                        attachService.stop(id, undefined, { detach: true }),
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
          ...(modelPolicy ? buildModelPolicyRpcMethods(modelPolicy) : {}),
          ...(vendorChecks ? buildVendorCheckRpcMethods(vendorChecks) : {}),
          ...(trackerLinks ? buildTrackerRpcMethods(trackerLinks) : {}),
          ...(directorService ? buildDirectorRpcMethods(directorService) : {}),
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
              sightings: hookSightings,
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
  // T414 (D41): untitled nodes are named by a cheap model, off the create path.
  const modelRun = options.titleRun === null ? undefined : (options.titleRun ?? claudeTitleRun());
  // T434: Settings' quick drafts switch, read per call so turning it off holds at once.
  const titleRun: TitleRun | undefined =
    modelRun && store
      ? async (prompt) => (quickDraftsOn(store) ? modelRun(prompt) : undefined)
      : modelRun;
  const titleNamer =
    streamService && titleRun
      ? new TitleNamer({
          streams: streamService,
          run: titleRun,
          onError: (err) =>
            console.error(
              `naming a node failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
        })
      : undefined;
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
    ...(modelPolicy ? { routing: modelPolicy } : {}),
    ...(directorService ? { director: directorService } : {}),
    questions: questionService,
    ...(questionThreads ? { questionThreads } : {}),
    ...(chatThreads ? { chatThreads } : {}),
    inbox: inboxService,
    ...(rulesService ? { rules: rulesService } : {}),
    ...(rulesService && ruleEvals ? { ruleEvals } : {}),
    ...(classifierKey ? { classifierKey } : {}),
    ...(landingService ? { landing: landingService } : {}),
    ...(titleNamer ? { titleNamer } : {}),
    ...(titleRun ? { cheapModel: titleRun } : {}),
    quickDraftsAvailable: modelRun !== undefined,
    // T437: the model lists mark a vendor whose command isn't on PATH.
    vendorMissing: (vendor) => missingVendorCommand(providerIn(config.home, ACP_PROVIDERS[vendor])),
    ...(modelCatalog ? { models: modelCatalog } : {}),
    ...(vendorChecks ? { vendorChecks } : {}),
    ...(prPoller ? { prCheck: (id: string) => prPoller.pollNow(id) } : {}),
    ...(attachService ? { attach: attachService } : {}),
    ...(routedEvents ? { events: routedEvents } : {}),
    ...(repoInPlace ? { repoInPlace } : {}),
    ...(docsService ? { docs: docsService } : {}),
    ...(planService ? { plans: planService } : {}),
    ...(contractService ? { contracts: contractService } : {}),
    ...(autonomyService ? { autonomy: autonomyService } : {}),
    ...(trackerLinks ? { trackerLinks } : {}),
    ...(harnessUpdates ? { harnessUpdates } : {}),
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
      // T481: each vendor CLI's version and whether an update is known.
      ...(harnessUpdates ? { harnessStatus: () => harnessUpdates.status().harnesses } : {}),
      // T320 (D31): configured or not, read per call; never a token.
      trackerStatus: () => {
        try {
          return trackerStatus(readHomeConfigFile(config.home).trackers);
        } catch {
          return trackerStatus(undefined);
        }
      },
    });
    await rpc.listening;
  } catch (err) {
    lock.release();
    await http.stop();
    throw err;
  }
  // T481: the first check a little after start, then daily (unref'd timers).
  if (harnessUpdates && (options.harnessRunner !== undefined || !underTest)) {
    harnessUpdates.start();
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
        harnessUpdates?.stop();
        vendorChecks?.stop();
        overlapTracker?.stop();
        prPoller?.stop();
        trackerLinks?.stop();
        mainSync?.stop();
        // Sessions are child processes: stop them first so their exit writes land.
        attachService?.delivery.stop();
        await Promise.all([attachService?.stopAll(), directorService?.stop()]);
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

/** T434: the quick drafts switch (absent = on); an unreadable config leaves it on. */
function quickDraftsOn(store: StateStore): boolean {
  try {
    return store.getHomeConfig().quick_drafts !== false;
  } catch {
    return true;
  }
}
