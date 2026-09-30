/**
 * `AttachService`: `agile attach <stream>`, the one path that turns a
 * stream into a running agent session (design §4.1). In order:
 *
 *   1. refuse if the stream already has a live session in that role (§2.3);
 *   2. create the branch and worktree if the stream has a repo, on first
 *      attach, never on stream create (§4.4);
 *   3. assemble the brief (`runner/brief.ts`);
 *   4. spawn the vendor ACP session in the worktree with the hook config
 *      installed (`runner/session.ts`);
 *   5. record the `SessionRef` and set `agent.status: working`.
 *
 * Session exit is handled here too: the runner resolves `exited`, this
 * service writes what it means onto the stream. Every write is principal
 * `daemon` (lifecycle writes, §2.2).
 *
 * T465 (D48): a worker's or coordinator's finished turn leaves its session
 * alive and idle ("resting"): the node reads `done`, and the next message
 * or wake is prompted into the same session. It ends after an idle timeout,
 * a Stop, a role change, the node closing or merging, or the daemon
 * stopping; the next start resumes it with ACP `session/load` when it can.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AcpProviderConfig,
  resolveAcpProvider,
  type spawnSession,
} from '@agile-agents/acp-client';
import {
  type AgentCommand,
  DEFAULT_SESSION_IDLE_MINUTES,
  DIRECTOR_NODE,
  type Effort,
  EffortSchema,
  type HilRequest,
  type KnowledgeItem,
  type ModelPick,
  type ModelPickRecord,
  type NodeRole,
  type Plan,
  type Question,
  type ReposConfig,
  type RoutedEvent,
  SESSION_MODEL_MAX_CHARS,
  type SessionRef,
  type SessionRole,
  type SessionStatus,
  type SessionVendor,
  type StatusCard,
  type Stream,
  type StreamPrincipal,
  type ThreadEntry,
  isAgentRole,
  liveChildrenOf,
  nodeRole,
  partsOf,
  resolveVendorFailure,
  routedPickLine,
  slashCommandOf,
  ulid,
  validateStreamCreateInput,
} from '@agile-agents/shared';
import { readHomeConfigFile } from '../config';
import type { ContractService } from '../coordination/contracts';
import type { PlanService } from '../coordination/plans';
import {
  type DeliveryTarget,
  REPLY_FIRST,
  SessionDelivery,
  type WakeDelivery,
} from '../events/delivery';
import type { KnowledgeWakeJudge } from '../events/knowledge-wake';
import { routeAndEmit } from '../events/router';
import { RoutedEventService } from '../events/service';
import {
  DAEMON_STOP_PREFIX,
  DEFAULT_WAKE_BUDGET_PER_HOUR,
  type PendingForWake,
  WakeBudget,
  notItsKnowledge,
  wakeVerdict,
} from '../events/wake';
import { type RouteBandGates, acpReadRouter } from '../hook/route-band';
import { settingsFileName } from '../hook/settings';
import type { RuleStatsOutcome } from '../knowledge/service';
import { repoScriptChecks } from '../permissions/command';
import { nodeReadScope } from '../permissions/policy-tables';
import { projectReadSettings } from '../permissions/posture';
import { CHOOSE_AGAIN_END_REASON, ModelPolicyService } from '../routing/policy';
import type { AboutParent, BriefDoc, WipNode } from '../runner/brief';
import { buildBrief, openWorkFor } from '../runner/brief';
import type { CliInvocation } from '../runner/cli-bin';
import { type InstalledCli, installedCliFor } from '../runner/installed-cli';
import type { ModelCatalog } from '../runner/model-catalog';
import {
  type AgentSessionHandle,
  type ContextUsage,
  type EffortPickResult,
  type ModelPickResult,
  missingVendorCommand,
  startAgentSession,
} from '../runner/session';
import { createWorktree, slugify } from '../runner/worktrees';
import type { StateStore } from '../store';
import { assertRepoHasCommits, buildEvent } from '../store';
import type { StreamService } from '../streams/service';
import {
  CRASH_RESTARTS_PER_HOUR,
  crashHandover,
  fallbackVendors,
  retryWontHelp,
  turnFailureWords,
} from './fallback';
import {
  type AttachFlags,
  effortIgnoredLine,
  providerTakesEffort,
  resolveSessionSettings,
} from './resolve';

/** A live session already exists in this role (one worker and one reviewer at most). RPC: -32602. */
export class StreamBusyError extends Error {
  constructor(
    public readonly stream: string,
    public readonly session: string,
    role: SessionRole = 'worker',
    /** The node's title, which the message names (T371); the id when absent. */
    title?: string,
  ) {
    super(
      `${title ?? `node ${stream}`} already has a live ${role === 'reviewer' ? 'reviewer' : 'agent'}; stop it before starting another`,
    );
    this.name = 'StreamBusyError';
  }
}

/** The stream names a repo that is no longer registered in `repos.yaml`. */
export class UnregisteredRepoError extends Error {
  constructor(public readonly repo: string) {
    super(`repo ${repo} is not registered in this home`);
    this.name = 'UnregisteredRepoError';
  }
}

/** Session statuses that mean "still live". */
const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ['starting', 'running', 'idle'];

/** The live session on a stream in one role (a reviewer beside a worker is not a second worker). */
export function liveSession(stream: Stream, role: SessionRole = 'worker'): SessionRef | undefined {
  return stream.sessions.find(
    (session) => session.role === role && LIVE_SESSION_STATUSES.includes(session.status),
  );
}

/** The node's live agent session: its worker, or its coordinator (P20). */
/** T396: the start slot a role takes on a node: worker and coordinator share one (a node has one agent). */
function startKey(streamId: string, role: SessionRole): string {
  return `${streamId}:${isAgentRole(role) ? 'agent' : role}`;
}

function liveAgent(stream: Stream): SessionRef | undefined {
  return liveSession(stream, 'worker') ?? liveSession(stream, 'coordinator');
}

/**
 * P20 (T280): the agent a node runs as it stands now: a coordinator on a
 * coordinating node, or on a project root (T443: from the start, so "plan
 * this and split it" works before there is a part; a parentless node with a
 * repo of its own is still a single stream a worker runs on, the
 * pre-projects shape); a worker otherwise.
 */
function agentFor(
  stream: Stream,
  all: readonly Stream[],
): { children: Stream[]; shape: NodeRole; role: 'worker' | 'coordinator' } {
  const shape = nodeRole(stream, liveChildrenOf(stream.id, all), all);
  // D42: a coordinator's children are its parts; conversations under it are not.
  const children = partsOf(stream.id, all);
  const projectRoot = stream.project !== undefined && stream.repo === undefined;
  const coordinates =
    shape === 'coordinating' || (shape === 'project' && (children.length > 0 || projectRoot));
  return { children, shape, role: coordinates ? 'coordinator' : 'worker' };
}

/** T370: the ended reason of a session the daemon's shutdown stopped. */
export const DAEMON_SHUTDOWN_REASON = 'the daemon stopped';

/** T444: the ended reason of a session a daemon that died mid-turn left on record. */
export const DAEMON_RESTART_REASON = 'the daemon restarted during this turn';

/** T465: the ended reason of an idle session a dead daemon left on record (no turn was cut). */
export const DAEMON_RESTART_IDLE_REASON = 'the daemon restarted';

/** T465 (D48): the thread line of a finished turn whose session stays alive for the next message. */
export const TURN_FINISHED_LINE = 'turn finished';

/** T465: the thread line of a start that resumed the node's earlier session. */
export const RESUMED_LINE = 'resumed its earlier session';

function secondsWords(n: number): string {
  return `${n} second${n === 1 ? '' : 's'}`;
}

/** T465: why a resting session ended after its idle timeout, in words. */
export function idleEndReason(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const span =
    minutes >= 1
      ? `${minutes} minute${minutes === 1 ? '' : 's'}`
      : secondsWords(Math.max(1, Math.round(ms / 1000)));
  return `it sat idle for ${span} after its turn finished`;
}

/** Not closed, landed or archived: a node an agent may still work on. */
function isOpen(stream: Stream): boolean {
  return (
    stream.archived !== true && stream.human.status !== 'closed' && stream.human.status !== 'landed'
  );
}

/** What is still open: a turn that ends on an open question is waiting, not finished. */
export interface OpenQuestionsSource {
  listOpen(): Question[];
}

/**
 * Gates the turn-end rule treats like an open question: a Claude session
 * denied and told to wait for `HIL-…` ends its turn, and must not be
 * stopped before the approval can be prompted in.
 */
export interface OpenGatesSource {
  list(): HilRequest[];
  /** T457: raise and spend a routed read's gate at the ACP tier (`acpReadRouter`); both or neither. */
  request?: RouteBandGates['request'];
  consume?: RouteBandGates['consume'];
}

/** The docs a stream's brief sees. */
export interface BriefDocsSource {
  docsForStream(streamId: string): BriefDoc[];
}

/** The accepted rules in scope for the brief (§5.3). */
export interface BriefRulesSource {
  inScope(streamId: string): KnowledgeItem[];
  /** §5.7's counters, bumped by the ACP permission tier. Optional for brief-only fakes. */
  recordFired?(id: string, outcome: RuleStatsOutcome): Promise<unknown>;
}

export interface AttachOptions extends AttachFlags {
  role?: SessionRole;
  /** Appended after the brief: the lessons session's material and instruction (§5.5). The caller caps it. */
  briefAppendix?: string;
  /** T336: pending events handed over in the brief (a wake), so no digest repeats them. */
  wake?: readonly RoutedEvent[];
  /**
   * T482: the daemon carries the node's agent over to a new session with
   * these flags (a role change, a crash's retry or fallback), and says why.
   * Neither the operator's pick nor a routed one: the policy is not asked.
   * Without it, any flag is the operator's explicit pick (D53).
   */
  carried?: string;
}

/** `detach: true`: the human pulled the plug, not a shutdown. */
export interface StopOptions {
  detach?: boolean;
  /** T213: why the daemon stopped it (a reshape, a shutdown); the thread says so instead of an exit code. */
  reason?: string;
}

export interface AttachResult {
  session: SessionRef;
  stream: Stream;
  handle: AgentSessionHandle;
}

export interface AttachServiceOptions {
  store: StateStore;
  streams: StreamService;
  /** The state home: `<home>/sessions/<id>/` holds each session's logs. */
  home: string;
  /** The daemon's unix socket, handed to the session's hook command and MCP bridge. */
  socketPath?: string;
  /** How a spawned session invokes the `agile` CLI (`runner/cli-bin.ts`). */
  cliBin?: string | CliInvocation;
  docs?: BriefDocsSource;
  /** The open questions, for the turn-end rule. */
  questions?: OpenQuestionsSource;
  rules?: BriefRulesSource;
  /**
   * T281: plans and contracts for the coordinator's and each child's brief.
   * T389: `waitingForPlan` keeps `say {start}` off a part its plan hasn't started.
   */
  plans?: Pick<PlanService, 'get' | 'childView'> & Partial<Pick<PlanService, 'waitingForPlan'>>;
  contracts?: Pick<ContractService, 'forNode'>;
  /** The gates, for the same rule. */
  gates?: OpenGatesSource;
  /** Test seam: inject a fake `spawnSession`. */
  spawn?: typeof spawnSession;
  /** Test seam: override the provider the resolved vendor maps to (the fake-agent transport). */
  provider?: (vendor: string, fallback: AcpProviderConfig) => AcpProviderConfig;
  now?: () => Date;
  /** T226: a worker's turn ended (a deferred main sync runs now). */
  onWorkerTurnEnd?: (streamId: string) => void;
  /** T242: the routed events delivered to sessions (default: one over `store`). */
  events?: RoutedEventService;
  /** T242: how long an idle session waits for a burst to settle (default 250 ms). */
  deliveryDelayMs?: number;
  /** T243: the wake budget's clock (tests). */
  wakeClock?: () => number;
  /** T300 (P16): the Director, which takes the `director` queue's delivery and wakes. */
  director?: () => DirectorEndpoint | undefined;
  /** T454: Jev's say on waking a conversation for an item it did not propose (`knowledge_wake: jev`). */
  knowledgeWake?: Pick<KnowledgeWakeJudge, 'approvedFor' | 'consider'>;
  /** T465 test seam: how long a resting session lives, in ms (default: the home's `session_idle_minutes`). */
  sessionIdleMs?: number;
  /** T480 (D49) test seam: the installed CLI a vendor's bridge runs (default: PATH and the home's switch). */
  installedCli?: (vendor: string) => InstalledCli | undefined;
  /** T467 (D46): each vendor's model list, kept from every session's `session/new` reply. */
  models?: Pick<ModelCatalog, 'record'> & Partial<Pick<ModelCatalog, 'all'>>;
  /** T482: the model policy (default: one over `store` and `streams`). */
  routing?: ModelPolicyService;
}

/** What delivery needs of the Director (`director/service.ts`). */
export interface DirectorEndpoint {
  target(): DeliveryTarget | undefined;
  wake(pending: readonly RoutedEvent[]): void;
}

/** P5: the project step of the session defaults; absent when the project names nothing. */
/** T283: each child's card for the coordinator brief; a corrupt one is named, not defaulted. */
function childCards(
  store: StateStore,
  children: readonly { id: string }[],
): Map<string, StatusCard | { error: string }> {
  const out = new Map<string, StatusCard | { error: string }>();
  for (const c of children) {
    try {
      const card = store.getCard(c.id);
      if (card !== undefined) out.set(c.id, card);
    } catch (err) {
      out.set(c.id, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

function projectSession(store: StateStore, id: string) {
  try {
    return store.getProject(id).session;
  } catch {
    return undefined;
  }
}

/** T458: the registered repos a node may read, by name (its read scope's roots). */
function readableRepoNames(repos: ReposConfig, readRoots: readonly string[]): Set<string> {
  return new Set(
    Object.entries(repos)
      .filter(([, entry]) => readRoots.includes(entry.path))
      .map(([name]) => name),
  );
}

/** T456: the project step of the crash settings; absent when unreadable. */
function projectVendorFailure(store: StateStore, id: string) {
  try {
    return store.getProject(id).vendor_failure;
  } catch {
    return undefined;
  }
}

/** T281: the coordinator's own plan, as a spreadable field. */
function planOf(plans: AttachServiceOptions['plans'], node: string): { plan?: Plan } {
  const plan = plans?.get(node);
  return plan === undefined ? {} : { plan };
}

/** T281: a worker's (or reviewer's) part of its parent's approved plan. */
function childPlanOf(
  plans: AttachServiceOptions['plans'],
  stream: Stream,
  role: SessionRole,
): { plan?: NonNullable<ReturnType<PlanService['childView']>> } {
  if (role === 'coordinator' || role === 'lessons') return {};
  const plan = plans?.childView(stream);
  return plan === undefined ? {} : { plan };
}

/** P20: the project's coordinator autonomy; absent when the project is unreadable. */
function projectAutonomy(store: StateStore, id: string) {
  try {
    return store.getProject(id).autonomy.coordinator;
  } catch {
    return undefined;
  }
}

export class AttachService {
  /** T242: pending routed events reach the node's worker as one digest (P10). */
  readonly delivery: SessionDelivery;
  private readonly events: RoutedEventService;
  /** Per-stream chain of `queued` marker writes, so a fast delivery never leaves a stale marker. */
  private readonly markers = new Map<string, Promise<unknown>>();
  /** Live handles, one map per role: a reviewer coexists with a worker (§4.2). */
  private readonly live = new Map<SessionRole, Map<string, AgentSessionHandle>>([
    ['worker', new Map()],
    ['reviewer', new Map()],
    // The one-shot retro session (§5.5): a third role, never a second worker.
    ['lessons', new Map()],
  ]);

  /** Each live session's exit handling, so `stop()` resolves only after the exit path has written. */
  private readonly exitHandled = new Map<string, Promise<void>>();

  /** Sessions being stopped by `agile detach`: the exit path writes `idle`, not `done`. */
  private readonly detaching = new Set<string>();
  /** Sessions the daemon stopped on purpose, with the reason the thread gives. */
  private readonly stopReasons = new Map<string, string>();
  /** T341: sessions stopped because their turn finished with nothing open (the normal end). */
  private readonly turnFinished = new Set<string>();
  /** T432: every session `stop()` ended: its exit code (a SIGTERM's) is no crash. */
  private readonly stopping = new Set<string>();

  /** T243 (P11): wakes per node in the last hour, and wakes being started now. */
  private readonly wakeBudget: WakeBudget;
  /** T351: conversations woken per accepted knowledge item (D36 D10). */
  private readonly waking = new Set<string>();
  /**
   * T396: starts in flight, per node and slot (`<id>:agent`, `<id>:reviewer`, …).
   * "One agent per node" is checked before the async work of a start (the
   * worktree, the spawn), so two starts at once — a wake and a click — would
   * both pass it; a second start waits for the first, then sees it live.
   */
  private readonly starting = new Map<string, Promise<unknown>>();
  /** Nodes already sent to the inbox for a spent budget (one thread line per episode). */
  private readonly overBudget = new Set<string>();
  /** T361: nodes whose agent is being restarted in a new role. */
  private readonly roleRestarts = new Set<string>();
  /**
   * T456: per node, the failure its agent is being recovered from: whether
   * the retry is spent and which vendors were tried. It ends when an agent
   * there finishes a turn, or the node's agent ends any other way.
   */
  private readonly crashes = new Map<string, { retried: boolean; tried: Set<string> }>();
  /** T456: restarts after a crash per node in the last hour (`CRASH_RESTARTS_PER_HOUR`). */
  private readonly crashBudget: WakeBudget;
  /** T456: `stopAll()` ran (the daemon is shutting down): no crash is recovered. */
  private closing = false;
  /**
   * T465 (D48): resting sessions (alive and idle after a finished turn), by
   * session id, with the timer that ends each after the idle timeout.
   */
  private readonly resting = new Map<string, ReturnType<typeof setTimeout>>();
  /** T465: why the daemon ended a resting session, for its thread line. */
  private readonly restEnds = new Map<string, string>();
  /** T465: per node, the rest and rouse writes in order (a rouse never lands under a rest). */
  private readonly restWrites = new Map<string, Promise<unknown>>();

  constructor(private readonly options: AttachServiceOptions) {
    this.events = options.events ?? new RoutedEventService(options.store);
    this.wakeBudget = new WakeBudget(options.wakeClock);
    this.crashBudget = new WakeBudget(options.wakeClock);
    this.delivery = new SessionDelivery({
      wake: (node, pending) => {
        if (node === DIRECTOR_NODE) return options.director?.()?.wake(pending);
        void this.wake(node, pending).catch((err) => console.error('wake failed:', err));
      },
      events: this.events,
      titleOf: (id) =>
        options.streams.list({ include_archived: true }).find((s) => s.id === id)?.title,
      ...(options.deliveryDelayMs !== undefined ? { delayMs: options.deliveryDelayMs } : {}),
      lineBody: (node, ts) => {
        try {
          const thread = options.store.readThread(node);
          for (let i = thread.length - 1; i >= 0; i--) {
            const e = thread[i];
            if (e?.ts === ts && e.by === 'human') return e.body;
          }
        } catch {
          // Gone: the event's own copy is all there is.
        }
        return undefined;
      },
      target: (node) => {
        if (node === DIRECTOR_NODE) return options.director?.()?.target();
        const handle = this.agentHandle(node);
        if (handle === undefined || handle.stopped()) return undefined;
        // T465: a resting session is prompted only for what would wake the node (`wake`).
        if (this.resting.has(handle.sessionId)) return undefined;
        return {
          sessionId: handle.sessionId,
          busy: () => handle.turnsInFlight() > 0,
          prompt: (text, opts) => {
            const turn = handle.prompt(text, opts);
            // Back to work: an idle (waiting) session is running again.
            void this.setSessionStatus(node, handle.sessionId, 'running').catch(() => {
              // Best effort: the prompt is what matters.
            });
            return turn;
          },
          isCommand: (line) => {
            const name = slashCommandOf(line);
            return name !== undefined && handle.commands().some((c) => c.name === name);
          },
        };
      },
      onDelivered: (node, sessionId, events) => {
        // T174's "queued" marker: a human line's thread `ts` rides in `ref`.
        const done = new Set(
          events.flatMap((e) => (e.type === 'human_line' && e.ref ? [e.ref] : [])),
        );
        if (done.size > 0) {
          this.chainMarker(node, () =>
            this.setSessionQueued(node, sessionId, (queued) =>
              queued.filter((ts) => !done.has(ts)),
            ),
          );
        }
      },
    });
  }

  /**
   * T243 (P11): a node with pending events and no live worker. Starts a
   * worker when the policy says so and the budget allows; past the budget
   * the node is `blocked` (an inbox item) and its events stay pending.
   * T465 (D48): a node whose session is resting is woken the same way, but
   * into that session: it takes the events as a digest, no new agent starts.
   */
  private async wake(node: string, pending: readonly RoutedEvent[]): Promise<void> {
    if (this.waking.has(node) || this.startingAgent(node)) return;
    const { streams } = this.options;
    let stream: Stream;
    try {
      stream = streams.get(node);
    } catch {
      return;
    }
    const rested = this.restingHandle(node);
    if (rested === undefined && liveAgent(stream) !== undefined) return;
    const all = streams.list();
    const role = nodeRole(stream, liveChildrenOf(stream.id, all), all);
    const judge = this.options.knowledgeWake;
    const heard = (e: PendingForWake) => judge?.approvedFor(node, e) === true;
    const verdict = wakeVerdict(stream, role, pending, heard);
    if (verdict === 'no_trigger' && role === 'conversation') {
      // T454: asked off this path; a yes looks at the node again.
      judge?.consider(stream, pending, () => this.delivery.notify(node));
    }
    if (verdict !== 'wake') return;
    const limit =
      readHomeConfigFile(this.options.home).events?.wake_budget_per_hour ??
      DEFAULT_WAKE_BUDGET_PER_HOUR;
    if (!this.wakeBudget.take(node, limit)) {
      if (this.overBudget.has(node)) return;
      this.overBudget.add(node);
      await streams.update('daemon', node, {
        agent: { status: 'blocked' },
        human: { status: 'waiting_on_you' },
      });
      await streams.appendThread('daemon', node, {
        kind: 'event',
        body: `wake budget spent (${limit} wakes in the last hour); ${pending.length} event(s) stay pending until you restart the agent`,
      });
      return;
    }
    this.overBudget.delete(node);
    this.waking.add(node);
    try {
      await streams.appendThread('daemon', node, {
        kind: 'event',
        // T341: event types read as words on the thread, as on the Activity tab.
        body: `woken by ${[...new Set(pending.map((e) => e.type.replace(/_/g, ' ')))].join(', ')}${
          pending.some((e) => notItsKnowledge(stream, role, e) && heard(e))
            ? ' (Jev judged the decision relevant)'
            : ''
        }`.slice(0, 800),
        // T465: the resting session it went to, so the chat can fold this wake into its reply.
        ...(rested !== undefined ? { ref: rested.sessionId } : {}),
      });
      if (rested !== undefined) {
        // T465: back to work in the same session; delivery sends the events as its digest.
        await this.rouse(node, rested);
        this.delivery.notify(node);
        return;
      }
      // T336: the first prompt carries the events, so the agent never has to ask for them.
      await this.attach(node, { wake: pending });
    } catch (err) {
      await streams
        .appendThread('daemon', node, {
          kind: 'event',
          body: `could not wake the agent: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            800,
          ),
        })
        .catch(() => undefined);
    } finally {
      this.waking.delete(node);
    }
  }

  /**
   * T336: starts a node's agent with its pending events in the brief (a
   * part its approved plan starts), rather than as a digest after it.
   */
  startWithPending(id: string, flags: AttachFlags = {}): Promise<AttachResult> {
    return this.attach(id, { ...flags, wake: this.events.pendingFor(id).map((p) => p.event) });
  }

  /** T243: at daemon start (after `recover()`), every node with pending events is considered. */
  wakePending(): void {
    if (this.events.pendingFor(DIRECTOR_NODE).length > 0) this.delivery.notify(DIRECTOR_NODE);
    for (const stream of this.options.streams.list()) {
      if (this.events.pendingFor(stream.id).length > 0) this.delivery.notify(stream.id);
    }
  }

  /** Serializes `queued` marker writes per stream (display only, best effort). */
  private chainMarker(streamId: string, write: () => Promise<unknown>): Promise<unknown> {
    const next = (this.markers.get(streamId) ?? Promise.resolve()).then(write).catch(() => {
      // The stream or session is gone; the exit path clears the list.
    });
    this.markers.set(streamId, next);
    return next;
  }

  private handles(role: SessionRole): Map<string, AgentSessionHandle> {
    let map = this.live.get(role);
    if (map === undefined) {
      map = new Map();
      this.live.set(role, map);
    }
    return map;
  }

  /** The node's live agent handle: its worker, or its coordinator (P20). */
  agentHandle(streamId: string): AgentSessionHandle | undefined {
    return this.handleFor(streamId, 'worker') ?? this.handleFor(streamId, 'coordinator');
  }

  /** The live handle for a stream, for a caller that wants to prompt or stop it. */
  handleFor(streamId: string, role: SessionRole = 'worker'): AgentSessionHandle | undefined {
    return this.handles(role).get(streamId);
  }

  /**
   * T204 (P5): `node new` starts the node's agent: a worker for a work
   * node, a worktree-less session for a conversation node. `start: false`
   * (`--no-start`, "Start later") skips it. The node is made either way; a
   * failed start is a thread line, not a failed create.
   */
  async createNode(
    principal: StreamPrincipal,
    rawInput: unknown,
    options: { requireProject?: boolean } = {},
  ): Promise<Stream> {
    const { start, ...input } = validateStreamCreateInput(rawInput);
    const { streams } = this.options;
    const created = await streams.create(principal, input, options);
    if (start === false) return created;
    const all = streams.list();
    const role = nodeRole(created, liveChildrenOf(created.id, all), all);
    if (role !== 'work' && role !== 'conversation') return created;
    try {
      return (await this.attach(created.id)).stream;
    } catch (err) {
      await streams.appendThread('daemon', created.id, {
        kind: 'line',
        body: `could not start the agent: ${err instanceof Error ? err.message : String(err)}`,
      });
      return streams.get(created.id);
    }
  }

  /**
   * T361: a tree change (a child created, moved, closed, deleted or
   * restored) can change a node's derived role. A live agent whose role no
   * longer fits (a worker on a node that now coordinates, or a coordinator
   * on one that no longer does) is stopped for that reason (a daemon stop,
   * so the node is not "stopped by the human") and started again in its
   * new role with the same vendor, model and effort, as + Repo does. Only
   * live agents: a node with none, or one the human stopped, is left alone.
   * `nodes` and their ancestors are checked (a tangent's role reaches its
   * conversation, D33).
   */
  async followRoles(nodes: readonly string[]): Promise<void> {
    const byId = new Map(
      this.options.streams.list({ include_archived: true }).map((s) => [s.id, s]),
    );
    const check = new Set<string>();
    for (const start of nodes) {
      for (let at: string | undefined = start; at !== undefined && !check.has(at); ) {
        check.add(at);
        at = byId.get(at)?.parent;
      }
    }
    for (const id of check) await this.followRole(id);
  }

  private async followRole(id: string): Promise<void> {
    const { streams } = this.options;
    if (this.roleRestarts.has(id) || this.waking.has(id)) return;
    const current = this.handleFor(id, 'worker') !== undefined ? 'worker' : 'coordinator';
    const handle = this.handleFor(id, current);
    if (handle === undefined || handle.stopped()) return;
    let stream: Stream;
    try {
      stream = streams.get(id);
    } catch {
      return;
    }
    if (!isOpen(stream)) return;
    const { shape, role } = agentFor(stream, streams.list());
    if (role === current) return;
    const was = stream.sessions.find((s) => s.id === handle.sessionId);
    const why =
      shape === 'project'
        ? role === 'coordinator'
          ? 'the project root now has parts'
          : 'the project root has no parts left'
        : `role changed to ${shape}`;
    // T465: a resting agent's work is finished: it ends, and the next message starts the new role.
    if (this.resting.has(handle.sessionId)) {
      await this.endResting(id, why);
      return;
    }
    this.roleRestarts.add(id);
    // Held so no wake starts an agent in the gap; pending events go to the new one.
    const release = this.delivery.hold(id);
    try {
      await this.stop(id, current, { reason: why });
      let body: string;
      try {
        await this.attach(id, {
          ...(was?.vendor !== undefined ? { vendor: was.vendor } : {}),
          ...(was?.model !== undefined ? { model: was.model } : {}),
          ...(was?.effort !== undefined ? { effort: was.effort } : {}),
          carried: `restarted in its new role (${why})`,
        });
        body = `${why}: restarted its agent as ${role === 'coordinator' ? 'the coordinator' : 'a worker'}`;
      } catch (err) {
        body = `${why}: could not restart its agent: ${err instanceof Error ? err.message : String(err)}`;
      }
      await streams.appendThread('daemon', id, { kind: 'event', body: body.slice(0, 800) });
    } finally {
      release();
      this.roleRestarts.delete(id);
    }
  }

  async attach(streamId: string, options: AttachOptions = {}): Promise<AttachResult> {
    const key = startKey(streamId, options.role ?? 'worker');
    const before = this.starting.get(key);
    const run = (before ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.attachNow(streamId, options));
    this.starting.set(key, run);
    try {
      return await run;
    } finally {
      if (this.starting.get(key) === run) this.starting.delete(key);
    }
  }

  /** T396: an agent start for the node is in flight (a wake or a line need not start another). */
  private startingAgent(streamId: string): boolean {
    return this.starting.has(startKey(streamId, 'worker'));
  }

  private async attachNow(streamId: string, options: AttachOptions): Promise<AttachResult> {
    // T465: a resting agent is not busy: it ends, and this start goes ahead (and may resume it).
    if (isAgentRole(options.role ?? 'worker')) {
      await this.endResting(streamId, 'a new agent was started here');
    }
    const wake =
      options.wake !== undefined && options.wake.length > 0
        ? this.delivery.inBrief(streamId, options.wake)
        : undefined;
    try {
      const result = await this.attachSession(streamId, options, wake);
      if (wake !== undefined) void result.handle.exited.finally(wake.release);
      return result;
    } catch (err) {
      wake?.release();
      throw err;
    }
  }

  private async attachSession(
    streamId: string,
    options: AttachOptions,
    wake: WakeDelivery | undefined,
  ): Promise<AttachResult> {
    const { store, streams } = this.options;
    const stream = streams.get(streamId);
    // P20 (T280): the agent of a coordinating node or a project root is a
    // coordinator: no worktree, the session dir, every write denied.
    // T443: a project's root coordinates from the start; a parentless node
    // with a repo of its own is still a single stream a worker runs on.
    const all = streams.list();
    const { children, shape, role: agentRole } = agentFor(stream, all);
    const coordinates = agentRole === 'coordinator';
    const requested: SessionRole = options.role ?? 'worker';
    const role: SessionRole = requested === 'worker' && coordinates ? 'coordinator' : requested;
    // One live session per role: a reviewer may run beside a worker on the
    // same worktree, but never beside a second reviewer (§4.2). A node has
    // one agent, worker or coordinator.
    const busy = isAgentRole(role) ? liveAgent(stream) : liveSession(stream, role);
    if (busy !== undefined) throw new StreamBusyError(stream.id, busy.id, role, stream.title);

    const repos = store.getRepos();
    const repoEntry = stream.repo === undefined ? undefined : repos[stream.repo];
    if (stream.repo !== undefined && repoEntry === undefined) {
      throw new UnregisteredRepoError(stream.repo);
    }

    const project =
      stream.project === undefined ? undefined : projectSession(store, stream.project);
    // T482 (D53, D55): an agent start is the operator's explicit pick (any flag),
    // a carried one (the daemon restarting it, `carried`), or routed (anything else).
    const agentStart = isAgentRole(role);
    const flagged =
      options.vendor !== undefined || options.model !== undefined || options.effort !== undefined;
    const routedStart = agentStart && options.carried === undefined;
    // "Let the policy choose again" sets the kept pick aside for this start.
    const repick = routedStart && stream.human.choose_again === true;
    // T464: a node that has run starts again on its last agent's vendor, model and effort;
    // the defaults choose only for a node that never ran (or whose vendor is gone).
    const kept =
      agentStart && options.vendor === undefined && options.model === undefined && !repick
        ? lastAgentSession(stream, (v) => this.installed(v as SessionVendor))
        : undefined;
    const layers = {
      ...(project !== undefined ? { project } : {}),
      ...(repoEntry !== undefined ? { repo: repoEntry } : {}),
      home: readHomeConfigFile(this.options.home),
    };
    let settings = resolveSessionSettings({
      flags: {
        vendor: options.vendor ?? kept?.vendor,
        model: options.model ?? kept?.model,
        effort: options.effort ?? kept?.effort,
      },
      ...layers,
    });
    // T482: the policy's say. Explicit and kept picks run as resolved; a routed pick is
    // made here, once, at the node's first start (or after a choose-again), then clamped.
    let pick: ModelPick | undefined;
    if (routedStart) {
      const triple = { vendor: settings.vendor, model: settings.model, effort: settings.effort };
      const routing = this.routing();
      if (flagged) {
        pick = routing.pickForStart({ stream, explicit: triple, fallback: triple }).pick;
      } else if (kept !== undefined) {
        pick = routing.pickForStart({ stream, kept: triple, fallback: triple }).pick;
      } else {
        pick = routing.pickForStart({ stream, fallback: triple }).pick;
        settings = resolveSessionSettings({
          flags: { vendor: pick.vendor, model: pick.model, effort: pick.effort },
          ...layers,
        });
      }
    }
    const provider = this.options.provider
      ? this.options.provider(settings.vendor, settings.provider)
      : settings.provider;

    const sessionId = ulid();

    // 2. Branch + worktree, only for a stream that has a repo (§4.4).
    // D20: a coordinating node has no worktree; its session runs in the session dir.
    const coordinating = coordinates;
    let worktreePath = coordinating ? undefined : stream.worktree;
    let branch = stream.branch;
    if (repoEntry !== undefined && !coordinating) {
      // §4.2: a reviewer never cuts a branch. On a never-attached stream it
      // reviews from the session dir, like a no-repo stream.
      if (worktreePath === undefined && role === 'worker') {
        assertRepoHasCommits(stream.repo as string, repoEntry);
        // T288: a helper branches off its parent's branch.
        const host = stream.helper_of !== undefined ? streams.get(stream.helper_of) : undefined;
        if (host !== undefined && host.branch === undefined) {
          throw new Error(
            `${stream.title} is a helper, and its parent ${host.title} has no branch yet; start the parent's agent first`,
          );
        }
        const created = await createWorktree(
          repoEntry.path,
          { id: stream.id, slug: slugify(stream.title) },
          host?.branch !== undefined ? { baseRef: `refs/heads/${host.branch}` } : {},
        );
        worktreePath = created.path;
        branch = created.branch;
      }
      if (worktreePath !== undefined) {
        await streams.update('daemon', stream.id, { worktree: worktreePath, branch });
      }
    }
    // The retro starts after `land` removed the worktree: run it in the
    // session dir rather than fail to spawn.
    if (role === 'lessons' && worktreePath !== undefined && !existsSync(worktreePath)) {
      worktreePath = undefined;
    }
    // A stream with no worktree runs in its session dir under the home.
    const sessionDir = join(this.options.home, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const cwd = worktreePath ?? sessionDir;
    // P4: refuse before any session or status write when the hook settings
    // would have to change a tracked file.
    settingsFileName(cwd);

    const session: SessionRef = {
      id: sessionId,
      vendor: settings.vendor,
      model: settings.model,
      role,
      status: 'starting',
      ...(providerTakesEffort(provider) ? { effort: settings.effort } : {}),
      ...(worktreePath !== undefined ? { worktree: worktreePath } : {}),
    };

    // D12: a vendor with no effort mapping still starts; the thread says the level was ignored.
    if (!providerTakesEffort(provider)) {
      await streams.appendThread('daemon', stream.id, {
        kind: 'event',
        body: effortIgnoredLine(settings.vendor, settings.effort),
      });
    }

    // T330 (§4.4, P20): the same read scope the hook tier gives this node (T457: and posture).
    const readScope = nodeReadScope(
      stream,
      () => repos,
      this.options.home,
      projectReadSettings(store),
    );
    // 3. The brief. It names the repos the node may read (a work node: the
    // others than its own), so the agent knows where they are. T457: its
    // project's own repos first, then the others, then the project's Always dirs.
    const projectRepos = this.projectRepos(stream);
    const readableRepos = [
      ...Object.entries(repos)
        .filter(([name, entry]) => readScope.readRoots.includes(entry.path) && name !== stream.repo)
        .map(([name, entry]) => ({
          name,
          path: entry.path,
          ...(projectRepos.has(name) ? { own: true as const } : {}),
        })),
      ...readScope.readRoots
        .filter((root) => !Object.values(repos).some((entry) => entry.path === root))
        .map((root) => ({ path: root })),
    ];
    const inWorktree = worktreePath !== undefined;
    const ancestors = this.ancestorsOf(stream);
    const brief = buildBrief({
      ...(!inWorktree || readableRepos.length > 0 || readScope.posture === 'trusted'
        ? { readableRepos, inWorktree, readPosture: readScope.posture }
        : {}),
      role,
      stream,
      ancestors,
      thread: streams.readThread(stream.id, { limit: 500 }).entries,
      docs: this.options.docs?.docsForStream(stream.id) ?? [],
      // §5.3: the accepted rules in scope for this stream and its ancestors.
      rules: this.options.rules?.inScope(stream.id) ?? [],
      // T339: the repo's own check commands, for a session that has its worktree.
      ...(repoEntry !== undefined && worktreePath !== undefined
        ? { checks: repoEntry.checks ?? repoScriptChecks(worktreePath) }
        : {}),
      ...(role === 'coordinator'
        ? {
            coordinator: {
              children,
              cards: childCards(store, children),
              autonomy:
                stream.autonomy ??
                (stream.project === undefined
                  ? undefined
                  : projectAutonomy(store, stream.project)) ??
                'advise',
              ...planOf(this.options.plans, stream.id),
              contracts: this.options.contracts?.forNode(stream.id) ?? [],
            },
          }
        : {}),
      ...childPlanOf(this.options.plans, stream, role),
      // T420 (D42): a conversation is told its question is the human's, and about its parent.
      // T458: and about its project's other open work it can read.
      ...(shape === 'conversation'
        ? {
            conversation: {
              ...this.aboutParent(stream, all, readableRepoNames(repos, readScope.readRoots)),
              ...this.openWork(stream, all, repos, readScope.readRoots),
            },
          }
        : {}),
    });
    // T465 (D48): a start with something to hand over resumes the node's last
    // session, when the vendor can and nothing about the agent changed.
    const resumeFrom =
      wake !== undefined && options.briefAppendix === undefined
        ? resumableSession(stream, role, settings, provider)
        : undefined;
    // The lessons material rides after the brief, never inside it (the
    // brief's own ceiling protects its parts; the caller caps the appendix).
    // T336: a woken session is told what woke it, after everything else.
    const prompt = [brief, options.briefAppendix, wake?.text]
      .filter((part): part is string => part !== undefined)
      .join('\n\n');
    // What the agent was handed, beside its logs: "what did it see" is a
    // file read. Best effort: a full disk must not stop a session starting.
    try {
      writeFileSync(join(sessionDir, 'brief.md'), prompt);
    } catch {
      // Diagnostics only.
    }

    // T437: a vendor that isn't installed is refused before anything is recorded,
    // so the node never reads "Working" for a session that can't exist.
    if (this.options.spawn === undefined) {
      const missing = missingVendorCommand(provider);
      if (missing !== undefined) {
        if (isAgentRole(role)) {
          await streams
            .update('daemon', stream.id, {
              agent: {
                status: 'blocked',
                progress: `${FAILED_START_PREFIX}${missing}`.slice(0, 800),
              },
            })
            .catch(() => {});
        }
        throw new Error(missing);
      }
    }

    // 5. Record the session before it can produce anything. A reviewer never
    // moves `agent.status`: a read-only second opinion is not work (§4.2).
    if (isAgentRole(role)) {
      // T176: a worker on the branch makes the last land's conflict stale.
      await streams.update('daemon', stream.id, {
        agent: {
          status: 'working',
          // T437: an earlier failure's line is not this session's news.
          ...(isFailureProgress(stream.agent.progress) ? { progress: undefined } : {}),
          // T482 (§8): what this start runs, and why.
          pick: pickRecord(stream, settings, provider, sessionId, pick, options.carried),
        },
        ...(stream.land_conflict ? { land_conflict: null } : {}),
      });
      // D55: the choose-again is spent by this start.
      if (repick) {
        await store.updateStream('daemon', stream.id, (s) => {
          const { choose_again: _spent, ...human } = s.human;
          return { ...s, human };
        });
      }
    }
    const recorded = await this.pushSession(stream.id, session);
    await streams.appendThread('daemon', stream.id, {
      kind: 'event',
      body: `${role} attached: ${settings.vendor}/${settings.model} effort=${settings.effort}${
        worktreePath !== undefined ? ` in ${worktreePath}` : ''
      }`,
      ref: sessionId,
    });
    // T482: a routed pick says what it chose and why; an explicit pick outside the
    // preset models says it runs as picked (D53). A kept pick says nothing new.
    const pickLine =
      pick === undefined || pick.how === 'kept'
        ? undefined
        : pick.how === 'explicit'
          ? pick.note
          : routedPickLine(
              { ...pick, vendor: settings.vendor, model: settings.model },
              this.routing().catalogModels(),
            );
    if (pickLine !== undefined) {
      await streams.appendThread('daemon', stream.id, {
        kind: 'event',
        body: pickLine.slice(0, 800),
        ref: sessionId,
      });
    }
    await store.appendEvent(
      buildEvent('agent_put', {
        agent: sessionId,
        data: {
          stream: stream.id,
          attached: true,
          vendor: settings.vendor,
          model: settings.model,
          effort: settings.effort,
        },
      }),
    );
    // 4. Spawn. T437: a spawn that throws (a sandbox or extension refusal) ends the
    // session it recorded: `error` with the reason, the node `blocked`, never "Working".
    let handle: AgentSessionHandle;
    try {
      handle = startAgentSession({
        store,
        streams,
        stream: recorded,
        session,
        role,
        worktreePath: cwd,
        brief: prompt,
        ...(wake !== undefined ? { onBriefDelivered: () => wake.delivered(sessionId) } : {}),
        ...(resumeFrom?.acp_session_id !== undefined && wake !== undefined
          ? {
              resume: { acpSessionId: resumeFrom.acp_session_id, prompt: wake.digest },
              onResume: (result: { ok: true } | { ok: false; error: string }) => {
                void this.onResumed(stream.id, sessionId, result);
              },
            }
          : {}),
        onAcpSession: (acpSessionId: string) => {
          void this.setSessionAcpId(stream.id, sessionId, acpSessionId);
        },
        ...(this.options.models !== undefined
          ? {
              onSessionState: (state: Record<string, unknown>) =>
                this.options.models?.record(provider.id, state, sessionId),
            }
          : {}),
        onModel: (result: ModelPickResult) => {
          void this.onModelPicked(stream.id, sessionId, result);
        },
        onEffort: (result: EffortPickResult) => {
          void this.onEffortPicked(stream.id, sessionId, result);
        },
        sessionDir,
        ...(() => {
          const cli = this.installedCliFor(provider.id);
          return cli !== undefined ? { installedCli: cli } : {};
        })(),
        provider,
        readScope,
        // T457: a read the Ask posture held raises the same card as the hook tier's.
        ...this.readRouter(stream.id, sessionId, cwd),
        ...(this.options.rules !== undefined ? { rules: this.options.rules } : {}),
        ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
        ...(this.options.cliBin !== undefined ? { cliBin: this.options.cliBin } : {}),
        ...(this.options.socketPath !== undefined ? { socketPath: this.options.socketPath } : {}),
        ...(this.options.now !== undefined ? { now: this.options.now } : {}),
        onTurnEnd: (info) => {
          void this.onTurnEnd(stream.id, sessionId, role, info.queued);
        },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.setSessionStatus(stream.id, sessionId, 'error', reason.slice(0, 300)).catch(
        () => {},
      );
      if (isAgentRole(role)) {
        await streams
          .update('daemon', stream.id, {
            agent: { status: 'blocked', progress: `${FAILED_START_PREFIX}${reason}`.slice(0, 800) },
          })
          .catch(() => {});
      }
      throw err;
    }
    this.handles(role).set(stream.id, handle);
    await this.setSessionStatus(stream.id, sessionId, 'running');

    // Findings already on the stream, so the reviewer's exit reports only its own.
    const findingsBefore = streams.get(stream.id).agent.findings?.length ?? 0;
    this.exitHandled.set(
      sessionId,
      handle.exited.then((info) =>
        this.onExit(
          info.stream,
          sessionId,
          info.reason,
          info.ok,
          role,
          findingsBefore,
          info.vendorError,
          info.exitCode,
          info.agentSaid,
        ),
      ),
    );

    return { session, stream: streams.get(stream.id), handle };
  }

  /** Root→leaf ancestors of a stream, excluding the stream itself. */
  private ancestorsOf(stream: Stream): Stream[] {
    const chain: Stream[] = [];
    const seen = new Set<string>([stream.id]);
    let parentId = stream.parent;
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId);
      let parent: Stream;
      try {
        parent = this.options.streams.get(parentId);
      } catch {
        break;
      }
      chain.unshift(parent);
      parentId = parent.parent;
    }
    return chain;
  }

  private async pushSession(streamId: string, session: SessionRef): Promise<Stream> {
    return this.options.store.updateStream('daemon', streamId, (before) => ({
      ...before,
      sessions: [...before.sessions, session],
    }));
  }

  private async setSessionStatus(
    streamId: string,
    sessionId: string,
    status: SessionStatus,
    ended_reason?: string,
  ): Promise<void> {
    await this.options.store.updateStream('daemon', streamId, (before) => ({
      ...before,
      sessions: before.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        // An ended session has nothing waiting: its queued lines just stay on the thread.
        const ended = status === 'stopped' || status === 'error';
        const { queued, ...rest } = s;
        return {
          ...rest,
          status,
          ...(ended_reason ? { ended_reason } : {}),
          ...(!ended && queued !== undefined ? { queued } : {}),
        };
      }),
    }));
  }

  /** The open question this session is waiting on, if any. */
  private openQuestionFor(streamId: string, sessionId: string): Question | undefined {
    try {
      return this.options.questions
        ?.listOpen()
        .find((question) => question.stream === streamId && question.session === sessionId);
    } catch {
      // The home was torn down: "nothing open" ends the session rather than stranding it.
      return undefined;
    }
  }

  /** T457: the names of the repos the node's project lists (none without a readable project). */
  private projectRepos(stream: Stream): ReadonlySet<string> {
    if (stream.project === undefined) return new Set();
    try {
      return new Set(this.options.store.getProject(stream.project).repos);
    } catch {
      return new Set();
    }
  }

  /** T457: the ACP tier's route for a held Ask read, when the gates can raise and spend. */
  private readRouter(
    stream: string,
    session: string,
    worktreePath: string,
  ): { routeRead?: NonNullable<ReturnType<typeof acpReadRouter>> } {
    const gates = this.options.gates;
    if (gates?.request === undefined || gates.consume === undefined) return {};
    return {
      routeRead: acpReadRouter({
        gates: { list: () => gates.list(), request: gates.request, consume: gates.consume },
        store: this.options.store,
        session,
        stream,
        worktreePath,
      }),
    };
  }

  /**
   * The routed call this session is waiting on: a gate that is `pending`,
   * or approved but not yet spent (the retry hasn't happened yet).
   */
  private openGateFor(streamId: string, sessionId: string): HilRequest | undefined {
    try {
      return this.options.gates
        ?.list()
        .find(
          (gate) =>
            gate.gate === 'classifier_review' &&
            gate.stream === streamId &&
            gate.session === sessionId &&
            (gate.status === 'pending' ||
              (gate.decision === 'approve' && gate.consumed_at === undefined)),
        );
    } catch {
      // The home was torn down: "nothing open".
      return undefined;
    }
  }

  /**
   * What the end of a prompt turn means (§2.3). A session with an open
   * question or an open `classifier_review` gate is waiting: it stays
   * alive, goes `idle`, and the stream says `question`/`waiting_on_you`
   * until the answer or decision is prompted in. Otherwise the work is
   * finished. T465 (D48): a worker's or coordinator's session then rests
   * (`rest`): alive and idle, the node `done`, until the next message or
   * the idle timeout. A reviewer's or the lessons pass's is stopped, and the
   * exit path records it. A Claude session told to wait for a gate ends its
   * turn, so the gate half is the normal path.
   */
  private async onTurnEnd(
    streamId: string,
    sessionId: string,
    role: SessionRole,
    queued = 0,
  ): Promise<void> {
    const handle = this.handles(role).get(streamId);
    if (handle === undefined || handle.sessionId !== sessionId) return;
    // T456: an agent that finishes a turn works; a later crash is a new failure.
    if (isAgentRole(role)) this.crashes.delete(streamId);
    // T174: a prompt queued behind this turn (a human line, an answer) is
    // never dropped by letting the session go here; it runs as its own
    // turn, and that turn's end decides again.
    if (queued > 0) return;
    // T242: routed events waiting on this node go in as one digest turn,
    // and that turn's end decides again.
    if (isAgentRole(role) && this.delivery.waiting(streamId)) {
      if (await this.delivery.flushWhenReady(streamId)) return;
      if (this.handles(role).get(streamId) !== handle) return;
    }
    if (role === 'worker') this.options.onWorkerTurnEnd?.(streamId);
    const waitingOnQuestion = this.openQuestionFor(streamId, sessionId) !== undefined;
    const waitingOnGate = this.openGateFor(streamId, sessionId) !== undefined;
    if (waitingOnQuestion || waitingOnGate) {
      try {
        // The hook that raised a gate knows nothing of stream statuses, so
        // this rule writes them (for questions too, or a stream waiting on
        // an open question once read `working` for eleven minutes). Only a
        // worker moves `agent.status` (§4.2). Written before the session's
        // `idle`, so a decision delivered the moment `idle` appears cannot
        // be overwritten by this turn's trailing write.
        if (isAgentRole(role)) {
          await this.options.streams.update('daemon', streamId, {
            agent: { status: 'question' },
            human: { status: 'waiting_on_you' },
          });
        }
        await this.setSessionStatus(streamId, sessionId, 'idle');
      } catch {
        // The stream is gone; the exit path below is what cleans up.
      }
      return;
    }
    if (isAgentRole(role)) {
      await this.rest(streamId, sessionId, role);
      return;
    }
    this.turnFinished.add(sessionId);
    handle.stop();
  }

  /**
   * T465 (D48): a finished turn's session stays alive and idle. The node
   * reads `done` as before (Replies, Ready to merge and auto-close follow
   * it), the thread says the turn finished, and the idle timer starts.
   * The session is marked `idle` before the node `done`, so what the `done`
   * write sets off (auto-close's merge check) already sees it resting.
   */
  private async rest(streamId: string, sessionId: string, role: SessionRole): Promise<void> {
    // Ended meanwhile (a Stop while the turn-end rule ran): the exit path has written.
    const handle = this.handles(role).get(streamId);
    if (handle === undefined || handle.sessionId !== sessionId || handle.stopped()) return;
    const ms = this.idleMs();
    this.resting.set(
      sessionId,
      unrefTimer(
        setTimeout(() => {
          void this.endResting(streamId, idleEndReason(ms), sessionId).catch((err) =>
            console.error('idle session end failed:', err),
          );
        }, ms),
      ),
    );
    // Written in order with a rouse or an end that follows at once (`restWrite`).
    const wrote = await this.restWrite(streamId, async () => {
      await this.setSessionStatus(streamId, sessionId, 'idle');
      await this.options.streams.update('daemon', streamId, { agent: { status: 'done' } });
      await this.options.streams.appendThread('daemon', streamId, {
        kind: 'event',
        body: TURN_FINISHED_LINE,
        ref: sessionId,
      });
      return true;
    }).catch(() => false);
    // The same as a worker's clean exit did before (§4.2).
    if (wrote && role === 'worker') await this.maybeAutoReview(streamId);
  }

  /**
   * T465 (D48): a resting session takes a new turn: the node works again,
   * and a `goal_met` from an earlier turn of the same session no longer
   * counts (auto-close reads the turn that ends next).
   */
  private async rouse(streamId: string, handle: AgentSessionHandle): Promise<void> {
    const sessionId = handle.sessionId;
    const timer = this.resting.get(sessionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.resting.delete(sessionId);
    await this.restWrite(streamId, async () => {
      await this.options.streams.update('daemon', streamId, {
        agent: { status: 'working', goal_met: undefined },
      });
      await this.setSessionStatus(streamId, sessionId, 'running');
    }).catch(() => {
      // The node is gone; the prompt (or its failure) is what matters.
    });
  }

  /** T465: runs a rest or rouse write after the node's earlier ones. */
  private restWrite<T>(streamId: string, write: () => Promise<T>): Promise<T> {
    const run = (this.restWrites.get(streamId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(write);
    this.restWrites.set(
      streamId,
      run.catch(() => undefined),
    );
    return run;
  }

  /** T465: the node's agent handle when its session is resting. */
  private restingHandle(streamId: string): AgentSessionHandle | undefined {
    const handle = this.agentHandle(streamId);
    return handle !== undefined && !handle.stopped() && this.resting.has(handle.sessionId)
      ? handle
      : undefined;
  }

  /**
   * T465 (D48): ends the node's resting session, if it has one (`sessionId`:
   * only that one), for `why` (the thread line). The node stays `done`.
   * Resolves once the exit path has written.
   */
  async endResting(streamId: string, why: string, sessionId?: string): Promise<void> {
    const handle = this.restingHandle(streamId);
    if (handle === undefined || (sessionId !== undefined && handle.sessionId !== sessionId)) return;
    this.restEnds.set(handle.sessionId, why);
    await this.stop(streamId, handle.role);
  }

  /**
   * T465 (D48): a node closed, merged or deleted ends its resting session
   * (the stream service's `onUpdated`, awaited: a merge removes the worktree
   * after it).
   */
  async onNodeUpdated(before: Stream, after: Stream): Promise<void> {
    const ended = (s: Stream) =>
      s.archived === true || s.human.status === 'closed' || s.human.status === 'landed';
    if (!ended(after) || ended(before)) return;
    const why =
      after.archived === true
        ? 'the node was deleted'
        : after.human.status === 'landed'
          ? 'the node was merged'
          : 'the node was closed';
    await this.endResting(after.id, why).catch((err) =>
      console.error('ending a resting session failed:', err),
    );
  }

  /** T480 (D49): the installed CLI a new `vendor` session's bridge runs, if any. */
  private installedCliFor(vendor: string): InstalledCli | undefined {
    if (this.options.installedCli !== undefined) return this.options.installedCli(vendor);
    try {
      return installedCliFor(vendor, readHomeConfigFile(this.options.home));
    } catch {
      // An unreadable config: the bundled copy, as before.
      return undefined;
    }
  }

  /** T465: how long a finished turn's session is kept (the home's setting; a test's seam). */
  private idleMs(): number {
    if (this.options.sessionIdleMs !== undefined) return this.options.sessionIdleMs;
    let minutes = DEFAULT_SESSION_IDLE_MINUTES;
    try {
      minutes = readHomeConfigFile(this.options.home).session_idle_minutes ?? minutes;
    } catch {
      // An unreadable config: the default.
    }
    return minutes * 60_000;
  }

  /** T465: records the vendor's ACP session id on the session, for a later resume. */
  private async setSessionAcpId(
    streamId: string,
    sessionId: string,
    acpSessionId: string,
  ): Promise<void> {
    await this.options.store
      .updateStream('daemon', streamId, (before) => ({
        ...before,
        sessions: before.sessions.map((s) =>
          s.id === sessionId ? { ...s, acp_session_id: acpSessionId.slice(0, 200) } : s,
        ),
      }))
      .catch(() => {
        // The node is gone: nothing to resume.
      });
  }

  /**
   * T467 (D46): a picked model the vendor did not take. The thread says so
   * in words, and the session's record names what the vendor runs instead
   * (so what shows, and what a later start keeps, is what really ran).
   */
  private async onModelPicked(
    streamId: string,
    sessionId: string,
    result: ModelPickResult,
  ): Promise<void> {
    if (result.ok) return;
    const actual = result.actual;
    if (actual !== undefined) {
      await this.options.store
        .updateStream('daemon', streamId, (before) => ({
          ...before,
          sessions: before.sessions.map((s) =>
            s.id === sessionId ? { ...s, model: actual.slice(0, SESSION_MODEL_MAX_CHARS) } : s,
          ),
        }))
        .catch(() => {
          // The node is gone: nothing to show.
        });
    }
    await this.options.streams
      .appendThread('daemon', streamId, {
        kind: 'event',
        body: result.line.slice(0, 800),
        ref: sessionId,
      })
      .catch(() => {});
  }

  /**
   * T488: a picked effort the vendor did not take. The thread says so in
   * words, and the session's record names the level it runs when that is
   * one of D12's (so a later start keeps what really ran).
   */
  private async onEffortPicked(
    streamId: string,
    sessionId: string,
    result: EffortPickResult,
  ): Promise<void> {
    if (result.ok) return;
    const actual = EffortSchema.safeParse(result.actual);
    if (actual.success) {
      await this.options.store
        .updateStream('daemon', streamId, (before) => ({
          ...before,
          sessions: before.sessions.map((s) =>
            s.id === sessionId ? { ...s, effort: actual.data } : s,
          ),
        }))
        .catch(() => {
          // The node is gone: nothing to show.
        });
    }
    await this.options.streams
      .appendThread('daemon', streamId, {
        kind: 'event',
        body: result.line.slice(0, 800),
        ref: sessionId,
      })
      .catch(() => {});
  }

  /** T465: the thread says whether the start resumed the earlier session, or why it started fresh. */
  private async onResumed(
    streamId: string,
    sessionId: string,
    result: { ok: true } | { ok: false; error: string },
  ): Promise<void> {
    if (!result.ok) {
      console.error(`session/load failed for ${sessionId}; started fresh: ${result.error}`);
    }
    await this.options.streams
      .appendThread('daemon', streamId, {
        kind: 'event',
        body: result.ok
          ? RESUMED_LINE
          : `could not resume its earlier session (${result.error}); started fresh from the brief`.slice(
              0,
              800,
            ),
        ref: sessionId,
      })
      .catch(() => {});
  }

  /**
   * T242: an answer is an `answer` event to the asking node (§15). Its
   * live worker gets it as a digest turn, the only thing that makes a
   * waiting vendor continue; with none it stays pending for the next session.
   */
  async deliverAnswer(sessionId: string, question: Question): Promise<void> {
    const stream = this.options.streams.get(question.stream);
    await routeAndEmit(
      this.events,
      {
        type: 'answer',
        subject: stream.id,
        payload: {
          question: cap(question.text),
          answer: cap(question.answer ?? '') || '(empty)',
        },
        ref: question.id,
        by: 'human',
      },
      [stream],
    );
    if (this.liveHandleBySession(sessionId) === undefined) {
      await this.options.streams.appendThread('daemon', question.stream, {
        kind: 'event',
        body: `answer recorded with no live session (${sessionId}); the next session gets it`.slice(
          0,
          800,
        ),
        ref: sessionId,
      });
    }
  }

  /**
   * T461: the slash commands the node's live agent advertises (empty with
   * none running, or before its vendor has listed them), and that agent's
   * vendor. A line starting with one is sent to it as typed (`SessionDelivery`).
   */
  commandsFor(streamId: string): { running: boolean; vendor?: string; commands: AgentCommand[] } {
    const handle = this.agentHandle(streamId);
    if (handle === undefined || handle.stopped()) return { running: false, commands: [] };
    const vendor = this.sessionVendor(streamId, handle.sessionId);
    return {
      running: true,
      ...(vendor !== 'agent' ? { vendor } : {}),
      commands: [...handle.commands()],
    };
  }

  /**
   * The stream page's composer (§9.3): a human line, and a `human_line`
   * event to the node (T242). A live idle worker gets it as a digest turn
   * within the delivery delay; a line typed mid-turn is read when that
   * turn ends, and until then its thread `ts` sits in the session's
   * `queued` list, which the stream page shows as waiting. With no live
   * worker the event stays pending for the next session.
   */
  async say(
    streamId: string,
    body: string,
    options: { start?: boolean; session?: AttachFlags } = {},
  ): Promise<{ entry: ThreadEntry; prompted?: string; started?: true }> {
    // Held from before the first write: a turn ending before the emit keeps the session.
    const release = this.delivery.hold(streamId);
    let entry: ThreadEntry;
    let handle: AgentSessionHandle | undefined;
    let busy = false;
    let started: AttachResult | undefined;
    try {
      // T471: closed is inactive, not read-only: a message reopens it (and a start wakes it).
      const node = this.options.streams.get(streamId);
      if (node.human.status === 'closed' && node.archived !== true) {
        await this.options.streams.reopen('human', streamId);
      }
      entry = await this.options.streams.appendThread('human', streamId, { kind: 'line', body });
      handle = this.agentHandle(streamId);
      if (handle?.stopped()) handle = undefined;
      // T465 (D48): a resting session takes the line in the same session, context and all.
      if (handle !== undefined) await this.rouse(streamId, handle);
      busy = handle !== undefined && handle.turnsInFlight() > 0;
      await routeAndEmit(
        this.events,
        {
          type: 'human_line',
          subject: streamId,
          payload: { body: cap(body) },
          ref: entry.ts,
          by: 'human',
        },
        [this.options.streams.get(streamId)],
      );
      // T361: still held, so no wake races it and no digest repeats the line.
      // T389: a part waiting for its coordinator's plan starts with the plan, not a line.
      if (
        handle === undefined &&
        options.start === true &&
        this.options.plans?.waitingForPlan?.(this.options.streams.get(streamId)) !== true
      ) {
        started = await this.startFor(streamId, options.session);
      }
    } finally {
      release();
    }
    if (started !== undefined) return { entry, prompted: started.session.id, started: true };
    if (handle === undefined) return { entry };
    const sessionId = handle.sessionId;
    if (busy) {
      const ts = entry.ts;
      await this.chainMarker(streamId, async () => {
        // Skipped when the digest already carried it.
        const still = this.events.pendingFor(streamId).some((p) => p.event.ref === ts);
        if (still) await this.setSessionQueued(streamId, sessionId, (q) => [...q, ts]);
      });
    }
    return { entry, prompted: sessionId };
  }

  /**
   * T361: a line sent with `start` to a node with no live agent (never
   * started, or stopped) starts one with the session defaults, as creating
   * the node would have: a worker on a work node or a conversation, the
   * coordinator on a coordinating node or a project root with parts. Its
   * pending events, the line among them, are handed over in the brief.
   * Not on a closed, landed or deleted node, nor a parentless single stream
   * (T443: a project's root starts its coordinator, parts or not). A
   * failed start is a thread line; the line stays pending.
   * T423: `flags` (the composer's model chip) name the vendor, model and
   * effort, as attach's flags do; the defaults fill the rest.
   */
  private async startFor(id: string, flags: AttachFlags = {}): Promise<AttachResult | undefined> {
    const { streams } = this.options;
    const stream = streams.get(id);
    if (
      !isOpen(stream) ||
      liveAgent(stream) !== undefined ||
      this.waking.has(id) ||
      this.startingAgent(id)
    ) {
      return undefined;
    }
    const { shape, role } = agentFor(stream, streams.list());
    if (shape === 'project' && role !== 'coordinator') return undefined;
    try {
      return await this.startWithPending(id, flags);
    } catch (err) {
      await streams.appendThread('daemon', id, {
        kind: 'event',
        body: `could not start the agent: ${err instanceof Error ? err.message : String(err)}`.slice(
          0,
          800,
        ),
      });
      return undefined;
    }
  }

  /** Rewrites a session's `queued` list (thread `ts` of lines waiting on a turn). */
  private async setSessionQueued(
    streamId: string,
    sessionId: string,
    change: (queued: string[]) => string[],
  ): Promise<void> {
    await this.options.store.updateStream('daemon', streamId, (before) => ({
      ...before,
      sessions: before.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const { queued: _drop, ...rest } = s;
        const next = change(s.queued ?? []).slice(-50);
        return next.length > 0 ? { ...rest, queued: next } : rest;
      }),
    }));
  }

  /**
   * A `classifier_review` gate was decided; the blocked session is usually
   * still live, holding after a deny. Delivered by prompt, like an answer;
   * with no live session it stays on the thread.
   */
  async deliverGateDecision(sessionId: string, gate: HilRequest): Promise<void> {
    const approved = gate.decision === 'approve';
    const note = gate.note !== undefined ? `: ${gate.note}` : '';
    // T460b: the call in words, never the gate's id (agents repeated it to the human).
    const call = heldCallWords(gate);
    const line = approved
      ? `The human approved ${call}${note} — retry the call now.`
      : `The human denied ${call}${note} — do not retry it; do the work another way or ask on the stream.`;
    const handle = this.liveHandleBySession(sessionId);
    if (handle === undefined) {
      await this.options.streams.appendThread('daemon', gate.stream, {
        kind: 'event',
        body: `gate decision recorded with no live session (${sessionId}): ${line}`.slice(0, 800),
        ref: sessionId,
      });
      return;
    }
    await this.setSessionStatus(gate.stream, sessionId, 'running').catch(() => {
      // Best effort: the prompt below is what matters.
    });
    // As with an answered question: back to work.
    await this.options.streams
      .update('daemon', gate.stream, { agent: { status: 'working' }, human: { status: 'open' } })
      .catch(() => {
        // Best effort: the prompt is the delivery.
      });
    void handle.prompt(`${line}\n\nContinue the work.`).catch(() => {
      // `runPromptTurn` already stopped the session and recorded why.
    });
  }

  /** The exit path: what the session's end means for the stream (§2.3). */
  private async onExit(
    streamId: string,
    sessionId: string,
    reason: string,
    ok: boolean,
    role: SessionRole,
    findingsBefore: number,
    vendorError?: string,
    exitCode?: number,
    agentSaid?: string,
  ): Promise<void> {
    const handles = this.handles(role);
    if (handles.get(streamId)?.sessionId === sessionId) handles.delete(streamId);
    const detached = this.detaching.delete(sessionId);
    const stopReason = this.stopReasons.get(sessionId);
    this.stopReasons.delete(sessionId);
    const stoppedByUs = this.stopping.delete(sessionId);
    // T341: the daemon ended it after a finished turn; the kill's exit code says nothing.
    const endedAfterTurn = this.turnFinished.delete(sessionId);
    const finishedTurn = endedAfterTurn && ok && vendorError === undefined;
    // T432 (D43): the vendor exited non-zero on its own (not a stop of ours, not after a
    // finished turn): a crash or a refusal (a login, a bad model), never finished work.
    const crashed =
      ok && exitCode !== undefined && exitCode !== 0 && !endedAfterTurn && !stoppedByUs;
    // T460: a turn the vendor failed (a login refusal answers the prompt this way,
    // the process still alive), not a stop of ours: recovered like a crash.
    const failedTurn =
      !ok && !endedAfterTurn && !stoppedByUs && reason.startsWith(PROMPT_FAILED_PREFIX);
    const failedWords = failedTurn
      ? turnFailureWords({
          vendor: this.sessionVendor(streamId, sessionId),
          label: this.vendorLabel(this.sessionVendor(streamId, sessionId)),
          said: agentSaid,
          vendorError,
          message: reason.slice(PROMPT_FAILED_PREFIX.length),
        })
      : undefined;
    // `stop()` already holds the promise it awaits; dropping it cannot lose a write.
    this.exitHandled.delete(sessionId);
    // T465 (D48): a resting session's end is no news about the work: the node stays `done`.
    const restTimer = this.resting.get(sessionId);
    if (restTimer !== undefined) {
      clearTimeout(restTimer);
      this.resting.delete(sessionId);
    }
    const restEnd = this.restEnds.get(sessionId);
    this.restEnds.delete(sessionId);
    if (restTimer !== undefined && isAgentRole(role)) {
      this.crashes.delete(streamId);
      const why = restEnd ?? stopReason ?? (stoppedByUs ? 'it was stopped' : undefined);
      // The vendor's process ended on its own while idle: said as it is, never a crash to recover.
      const failed = why === undefined && !detached && (!ok || (exitCode ?? 0) !== 0);
      const own = why === undefined ? endedReason(reason, !failed, vendorError) : undefined;
      // After the rest's own writes, which an idle timeout may overtake.
      await this.restWrite(streamId, async () => {
        await this.setSessionStatus(
          streamId,
          sessionId,
          failed ? 'error' : 'stopped',
          detached ? undefined : why !== undefined ? `${DAEMON_STOP_PREFIX}${why}` : own,
        );
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: (detached
            ? `${role} detached by human`
            : `session ended: ${why ?? own ?? reason}`
          ).slice(0, 800),
          ref: sessionId,
        });
      }).catch(() => {
        // The stream or home went away: nothing to record on.
      });
      // What arrived while it was ending found it still on record: the wake policy looks again.
      if (this.delivery.waiting(streamId)) this.delivery.notify(streamId);
      return;
    }
    // T456: any end but a crash ends the failure being recovered from.
    if (isAgentRole(role) && !crashed && !failedTurn) this.crashes.delete(streamId);
    try {
      await this.setSessionStatus(
        streamId,
        sessionId,
        (ok && !crashed) || detached || stopReason !== undefined ? 'stopped' : 'error',
        detached
          ? undefined
          : stopReason !== undefined
            ? `${DAEMON_STOP_PREFIX}${stopReason}`
            : failedWords !== undefined
              ? `${TURN_FAILED_PREFIX}${failedWords}`.slice(0, 300)
              : endedReason(reason, ok, vendorError),
      );
      // A human pulled the plug: back to `idle`. `done` would claim the kill finished the work.
      if (detached) {
        if (isAgentRole(role)) {
          await this.options.streams.update('daemon', streamId, { agent: { status: 'idle' } });
        }
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: `${role} detached by human`,
          ref: sessionId,
        });
        return;
      }
      // Stopped on purpose: not a crash and not finished work, so `idle`.
      if (stopReason !== undefined) {
        if (isAgentRole(role)) {
          await this.options.streams.update('daemon', streamId, { agent: { status: 'idle' } });
        }
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: `${role} stopped: ${stopReason}`.slice(0, 800),
          ref: sessionId,
        });
        return;
      }
      if (role === 'reviewer') {
        await this.onReviewerExit(streamId, sessionId, reason, findingsBefore);
        return;
      }
      // The retro is not the stream's work: report on the thread, leave `agent.status`.
      if (role === 'lessons') {
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: `lessons session ended: ${reason}`.slice(0, 800),
          ref: sessionId,
        });
        return;
      }
      // T456: a crashed agent is started again, or another vendor in its place, while
      // the settings and the cap allow. The node stays working; D43 is the end state.
      if (crashed && isAgentRole(role)) {
        if (await this.recoverCrash(streamId, sessionId, vendorError, exitCode)) return;
      }
      // T460: the agent's own words name the failure (Claude Code's login refusal).
      if (failedTurn && isAgentRole(role)) {
        if (await this.recoverCrash(streamId, sessionId, agentSaid ?? vendorError, undefined))
          return;
      }
      await this.options.streams.update('daemon', streamId, {
        agent: {
          status: ok && !crashed ? 'done' : 'blocked',
          // T437: the reason travels with the status (Needs me, Overview, Events).
          ...(crashed
            ? {
                progress: `${CRASHED_PREFIX}${vendorError ?? `exit code ${exitCode}`}`.slice(
                  0,
                  800,
                ),
              }
            : failedWords !== undefined && isAgentRole(role)
              ? { progress: `${CRASHED_PREFIX}${failedWords}`.slice(0, 800) }
              : {}),
        },
      });
      await this.options.streams.appendThread('daemon', streamId, {
        kind: 'event',
        body: `session ended: ${
          finishedTurn
            ? 'its turn finished'
            : failedWords !== undefined
              ? `${TURN_FAILED_PREFIX}${failedWords}`
              : (endedReason(reason, ok && !crashed, vendorError) ?? reason)
        }`.slice(0, 800),
        ref: sessionId,
      });
    } catch {
      // The stream or home went away mid-session: nothing to record on.
      return;
    }
    if (ok && !crashed && role === 'worker') await this.maybeAutoReview(streamId);
  }

  /**
   * T456 (D43 follow-up): a node whose agent crashed, per its
   * `vendor_failure` settings (project, then repo, then home). First the
   * same vendor, model and effort once more (`retry`), unless the failure
   * is one a retry can't fix (`retryWontHelp`); then the next vendor on
   * `fallback` that is installed and, unless `allow_hookless`, has pre-tool
   * hooks when the crashed one had them, with that vendor's own default
   * model (D40). Each starts on the same node, worktree and thread, its
   * brief saying the last agent stopped mid-turn (`crashHandover`), and is
   * recorded as an `agent_restarted` event. At most `CRASH_RESTARTS_PER_HOUR`
   * per node. True when an agent started (the node stays working and the
   * parent is not told); false when D43's block follows.
   */
  private async recoverCrash(
    streamId: string,
    sessionId: string,
    vendorError: string | undefined,
    exitCode: number | undefined,
  ): Promise<boolean> {
    const { streams } = this.options;
    const stream = streams.get(streamId);
    const crashed = stream.sessions.find((s) => s.id === sessionId);
    if (this.closing || !isOpen(stream) || crashed === undefined) return false;
    const policy = this.vendorFailureFor(stream);
    const episode = this.crashes.get(streamId) ?? { retried: false, tried: new Set<string>() };
    this.crashes.set(streamId, episode);
    const attempted = episode.tried.size > 0;
    episode.tried.add(crashed.vendor);
    const reason = vendorError ?? `exit code ${exitCode}`;
    const retry =
      policy.retry && !episode.retried && retryWontHelp(vendorError, exitCode) === undefined;
    const next = [
      ...(retry ? [{ vendor: crashed.vendor, retry: true }] : []),
      ...fallbackVendors(policy, crashed.vendor, episode.tried, (v) => this.installed(v)).map(
        (vendor) => ({ vendor: vendor as string, retry: false }),
      ),
    ];
    let failed = { label: this.vendorLabel(crashed.vendor), reason };
    const note = (body: string) =>
      streams.appendThread('daemon', streamId, {
        kind: 'event',
        body: body.slice(0, 800),
        ref: sessionId,
      });
    if (next.length > 0 && !this.crashBudget.take(streamId, CRASH_RESTARTS_PER_HOUR)) {
      await note(
        `${failed.label} failed (${reason}); not restarted: ${CRASH_RESTARTS_PER_HOUR} restarts in the last hour`,
      );
      this.crashes.delete(streamId);
      return false;
    }
    // Held so no wake starts an agent in the gap; pending events go to the new one.
    const release = this.delivery.hold(streamId);
    try {
      for (const attempt of next) {
        if (attempt.retry) episode.retried = true;
        episode.tried.add(attempt.vendor);
        const to = this.vendorLabel(attempt.vendor);
        await note(
          `${failed.label} failed (${failed.reason}); ${attempt.retry ? 'retrying once' : `switched to ${to}`}`,
        );
        try {
          const { session } = await this.attach(streamId, {
            vendor: attempt.vendor,
            carried: attempt.retry
              ? 'retried once after a crash'
              : `switched to ${to} after a crash (the vendor fallback)`,
            ...(attempt.retry ? { model: crashed.model } : {}),
            ...(attempt.retry && crashed.effort !== undefined ? { effort: crashed.effort } : {}),
            briefAppendix: crashHandover({
              failed: this.vendorLabel(crashed.vendor),
              reason,
              retry: attempt.retry,
              inWorktree: crashed.worktree !== undefined,
            }),
            wake: this.events.pendingFor(streamId).map((p) => p.event),
          });
          const after = streams.get(streamId);
          await routeAndEmit(
            this.events,
            {
              type: 'agent_restarted',
              subject: streamId,
              ...(after.project !== undefined ? { project: after.project } : {}),
              ...(after.repo !== undefined ? { repo: after.repo } : {}),
              payload: {
                action: attempt.retry ? 'retry' : 'switch',
                from: crashed.vendor,
                to: attempt.vendor,
                model: cap(session.model),
                reason: cap(reason),
              },
              ref: session.id,
              by: 'daemon',
            },
            [after],
          ).catch((err) => console.error('agent_restarted not recorded:', err));
          return true;
        } catch (err) {
          // Someone started an agent here meanwhile: nothing to recover.
          if (err instanceof StreamBusyError) return true;
          failed = { label: to, reason: err instanceof Error ? err.message : String(err) };
        }
      }
    } finally {
      release();
    }
    if (attempted || next.length > 0) {
      await note(`${failed.label} failed (${failed.reason}); no other agent to switch to`);
    }
    this.crashes.delete(streamId);
    return false;
  }

  /** T456: a node's crash settings, field by field: project, repo, home, built-in. */
  private vendorFailureFor(stream: Stream) {
    const { store } = this.options;
    return resolveVendorFailure(
      stream.project === undefined ? undefined : projectVendorFailure(store, stream.project),
      stream.repo === undefined ? undefined : store.getRepos()[stream.repo]?.vendor_failure,
      readHomeConfigFile(this.options.home).vendor_failure,
    );
  }

  /** T456: the provider a vendor runs as here (the test seam's transport, else the registry's). */
  private providerFor(vendor: string): AcpProviderConfig {
    const base = resolveAcpProvider(vendor);
    return this.options.provider ? this.options.provider(vendor, base) : base;
  }

  /** T460: the vendor a node's session ran. */
  private sessionVendor(streamId: string, sessionId: string): string {
    try {
      return (
        this.options.streams.get(streamId).sessions.find((s) => s.id === sessionId)?.vendor ??
        'agent'
      );
    } catch {
      return 'agent';
    }
  }

  private vendorLabel(vendor: string): string {
    try {
      return this.providerFor(vendor).label;
    } catch {
      return vendor;
    }
  }

  private routingService: ModelPolicyService | undefined;

  /** T482: the model policy service (the daemon's, or one over this service's store). */
  routing(): ModelPolicyService {
    if (this.options.routing !== undefined) return this.options.routing;
    if (this.routingService === undefined) {
      const models = this.options.models;
      this.routingService = new ModelPolicyService({
        store: this.options.store,
        streams: this.options.streams,
        // A test's transport seam (`provider`) is stateful; the policy never calls it.
        installed: (v) =>
          this.options.spawn !== undefined ||
          this.options.provider !== undefined ||
          missingVendorCommand(resolveAcpProvider(v)) === undefined,
        ...(models?.all !== undefined ? { models: () => models.all?.() ?? {} } : {}),
        onChooseAgain: (id) => this.endResting(id, CHOOSE_AGAIN_END_REASON),
      });
    }
    return this.routingService;
  }

  /** T456: attach's own not-installed check (T437), asked before a fallback is tried. */
  private installed(vendor: SessionVendor): boolean {
    return (
      this.options.spawn !== undefined ||
      missingVendorCommand(this.providerFor(vendor)) === undefined
    );
  }

  /**
   * A reviewer's exit (§4.2): reports its findings on the thread. A review
   * is not work, so it never moves `agent.status`: only a worker's or a
   * coordinator's (a work session's) exit does. A reviewer that died at spawn once marked a
   * never-worked stream `done` (CI, phase 9).
   */
  private async onReviewerExit(
    streamId: string,
    sessionId: string,
    reason: string,
    findingsBefore: number,
  ): Promise<void> {
    const stream = this.options.streams.get(streamId);
    const found = Math.max(0, (stream.agent.findings?.length ?? 0) - findingsBefore);
    await this.options.streams.appendThread('daemon', streamId, {
      kind: 'event',
      body: `review finished: ${found} finding${found === 1 ? '' : 's'} (${reason})`.slice(0, 800),
      ref: sessionId,
    });
  }

  /** §4.2's per-repo `auto_review` on a clean worker exit. Best effort: never fails the exit. */
  private async maybeAutoReview(streamId: string): Promise<void> {
    try {
      const stream = this.options.streams.get(streamId);
      if (stream.repo === undefined) return;
      const repoEntry = this.options.store.getRepos()[stream.repo];
      if (repoEntry?.auto_review !== true) return;
      if (liveSession(stream, 'reviewer') !== undefined) return;
      await this.attach(streamId, { role: 'reviewer' });
    } catch (err) {
      try {
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: `auto-review did not start: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            800,
          ),
        });
      } catch {
        // The stream is gone.
      }
    }
  }

  /**
   * Stops the live sessions on a stream, one role or all. Resolves once
   * they have exited and the exit path has written, and returns the
   * stopped session ids (`agile detach` prints from them).
   */
  async stop(streamId: string, role?: SessionRole, options: StopOptions = {}): Promise<string[]> {
    const roles = role !== undefined ? [role] : [...this.live.keys()];
    const stopped: string[] = [];
    await Promise.all(
      roles.map(async (each) => {
        const handle = this.handles(each).get(streamId);
        if (handle === undefined) return;
        stopped.push(handle.sessionId);
        // Captured before the stop: the exit path deletes its own entry.
        const handled = this.exitHandled.get(handle.sessionId);
        // Marked before anything can resolve `exited`: a detach, not a finish.
        if (options.detach === true) this.detaching.add(handle.sessionId);
        else if (options.reason !== undefined)
          this.stopReasons.set(handle.sessionId, options.reason);
        // T432: ours, whatever its exit code says.
        this.stopping.add(handle.sessionId);
        handle.stop();
        await handle.exited;
        // `agile detach` prints from the RPC result, which must already be on disk.
        await handled;
      }),
    );
    // T437: a session recorded as live with no process behind it (a start that died
    // before this fix, a daemon killed mid-start) is ended too, so Stop always works.
    const orphans = this.orphanSessions(streamId, role);
    for (const orphan of orphans) {
      await this.setSessionStatus(streamId, orphan.id, 'stopped').catch(() => {});
      stopped.push(orphan.id);
    }
    // T465: an idle one ends with no turn cut short: its node keeps what it says.
    if (orphans.some((o) => isAgentRole(o.role) && o.status !== 'idle')) {
      await this.options.streams
        .update('daemon', streamId, { agent: { status: 'idle' } })
        .catch(() => {});
    }
    return stopped;
  }

  /**
   * T444 (audit r7 #16): at daemon start no process is ours, so every
   * `starting`/`running` session on record was left by a daemon that died
   * mid-turn. Each ends (`stopped`, the daemon's own reason, so the node's
   * next event still wakes it), its node goes back to `idle`, and its thread
   * says so. Before this, such a node read "Working" for good and a line to
   * it only queued. Returns the nodes it touched.
   * T465: an `idle` session (resting after its turn, or waiting on a
   * question) ends too, with no turn cut short: its node keeps its status
   * (`done` stays finished), and its next message resumes it.
   */
  async endOrphansAtStart(): Promise<string[]> {
    const touched: string[] = [];
    for (const stream of this.options.streams.list()) {
      const orphans = this.orphanSessions(stream.id);
      if (orphans.length === 0) continue;
      const cut = orphans.filter((o) => o.status !== 'idle');
      for (const orphan of orphans) {
        await this.setSessionStatus(
          stream.id,
          orphan.id,
          'stopped',
          `${DAEMON_STOP_PREFIX}${orphan.status === 'idle' ? DAEMON_RESTART_IDLE_REASON : DAEMON_RESTART_REASON}`,
        ).catch(() => {});
      }
      if (cut.length === 0) {
        if (orphans.some((o) => isAgentRole(o.role))) {
          await this.options.streams
            .appendThread('daemon', stream.id, {
              kind: 'event',
              body: `session ended: ${DAEMON_RESTART_IDLE_REASON}`,
            })
            .catch(() => {});
        }
      } else if (cut.some((o) => isAgentRole(o.role))) {
        await this.options.streams
          .update('daemon', stream.id, { agent: { status: 'idle' } })
          .catch(() => {});
        await this.options.streams
          .appendThread('daemon', stream.id, {
            kind: 'event',
            body: `session ended: ${DAEMON_RESTART_REASON}`,
          })
          .catch(() => {});
      }
      touched.push(stream.id);
    }
    return touched;
  }

  /** T437: `starting`/`running` (T465: and `idle`) session records on a node that no live handle stands behind. */
  private orphanSessions(streamId: string, role?: SessionRole): SessionRef[] {
    let stream: Stream;
    try {
      stream = this.options.streams.get(streamId);
    } catch {
      return [];
    }
    return stream.sessions.filter(
      (s) =>
        (role === undefined || s.role === role) &&
        // T465: an idle one too (a resting session, or one waiting on a question).
        (s.status === 'starting' || s.status === 'running' || s.status === 'idle') &&
        this.handles(s.role).get(streamId)?.sessionId !== s.id &&
        // A start still in flight (T396) is not an orphan: its handle is on its way.
        !this.starting.has(startKey(streamId, s.role)),
    );
  }

  /**
   * Stops every live session: the daemon's shutdown path. A daemon stop
   * (T370): the kill ends no work, so the node goes back to `idle` (never
   * `done`, which read as "ready to merge" after a restart) and is not
   * "stopped by the human", so its next event wakes it again.
   */
  async stopAll(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.live.entries()].flatMap(([role, handles]) =>
        [...handles.keys()].map((streamId) =>
          this.stop(streamId, role, { reason: DAEMON_SHUTDOWN_REASON }),
        ),
      ),
    );
  }

  /** T411: a live session's context window, as its vendor last reported it. */
  contextFor(sessionId: string): ContextUsage | undefined {
    return this.liveHandleBySession(sessionId)?.contextUsage();
  }

  /** T420 (D42): the parent a conversation was asked under, as it stands, for its brief. */
  private aboutParent(
    stream: Stream,
    all: readonly Stream[],
    /** T458b: the repos it may read; a part on any other repo is left out. */
    readable?: ReadonlySet<string>,
  ): { about?: AboutParent } {
    const { store, streams } = this.options;
    if (stream.parent === undefined) return {};
    const parent = all.find((s) => s.id === stream.parent);
    if (parent === undefined) return {};
    let card: AboutParent['card'];
    try {
      card = store.getCard(parent.id);
    } catch (err) {
      card = { error: err instanceof Error ? err.message : String(err) };
    }
    const parts = partsOf(parent.id, all).filter(
      (p) => readable === undefined || p.repo === undefined || readable.has(p.repo),
    );
    const plan = this.options.plans?.get(parent.id);
    return {
      about: {
        node: parent,
        role: nodeRole(parent, liveChildrenOf(parent.id, all), all),
        ...(card !== undefined ? { card } : {}),
        thread: streams.readThread(parent.id, { limit: 60 }).entries,
        ...(parts.length > 0 ? { parts } : {}),
        ...(plan !== undefined ? { plan } : {}),
      },
    };
  }

  /** T458: the project's open work nodes on repos the conversation can read, for its brief. */
  private openWork(
    stream: Stream,
    all: readonly Stream[],
    repos: ReposConfig,
    readRoots: readonly string[],
  ): { work?: WipNode[] } {
    if (stream.project === undefined) return {};
    const readable = readableRepoNames(repos, readRoots);
    const { store } = this.options;
    return {
      work: openWorkFor(stream, all, readable).map((node) => {
        let card: WipNode['card'];
        try {
          card = store.getCard(node.id);
        } catch {
          // An unreadable card is left out; its node still shows its progress line.
        }
        const threadAt = store.threadUpdatedAt(node.id);
        return {
          node,
          ...(card !== undefined ? { card } : {}),
          ...(threadAt !== undefined ? { threadAt } : {}),
        };
      }),
    };
  }

  private liveHandleBySession(sessionId: string): AgentSessionHandle | undefined {
    return [...this.live.values()]
      .flatMap((byStream) => [...byStream.values()])
      .find((each) => each.sessionId === sessionId);
  }
}

/** T437: the progress line a failed start or a vendor crash leaves, so Needs me, Overview and Events say why. */
export const FAILED_START_PREFIX = 'The agent couldn’t start: ';
export const CRASHED_PREFIX = 'The agent stopped with an error: ';
/**
 * T464: the node's most recent worker or coordinator session whose vendor
 * is still installed: what a start without a pick runs again.
 */
export function lastAgentSession(
  stream: Pick<Stream, 'sessions'>,
  installed: (vendor: string) => boolean,
): SessionRef | undefined {
  for (let i = stream.sessions.length - 1; i >= 0; i--) {
    const s = stream.sessions[i];
    if (s !== undefined && isAgentRole(s.role)) return installed(s.vendor) ? s : undefined;
  }
  return undefined;
}

/**
 * T482 (§8): the node's `agent.pick` for this start. A routed or explicit
 * pick records how; a kept one keeps the record it came from (so Details
 * still says how the model was first picked); a carried start (a role
 * change, a crash) keeps it when the model is the same, else says why.
 */
function pickRecord(
  stream: Stream,
  settings: { vendor: string; model: string; effort: Effort },
  provider: Pick<AcpProviderConfig, 'effort' | 'effortOption'>,
  session: string,
  pick: ModelPick | undefined,
  carried: string | undefined,
): ModelPickRecord {
  const ran = {
    vendor: settings.vendor,
    model: settings.model,
    ...(providerTakesEffort(provider) ? { effort: settings.effort } : {}),
  };
  const before = stream.agent.pick;
  const same = before !== undefined && before.vendor === ran.vendor && before.model === ran.model;
  if ((pick === undefined || pick.how === 'kept') && same && before !== undefined) {
    return { ...before, ...ran, session };
  }
  const at = new Date().toISOString();
  if (pick === undefined) {
    return {
      ...ran,
      how: 'default',
      why: (carried ?? 'started by the daemon').slice(0, 300),
      session,
      at,
    };
  }
  return {
    ...ran,
    how: pick.how,
    ...(pick.base !== undefined ? { base: pick.base } : {}),
    why: pick.why.slice(0, 300),
    ...(pick.note !== undefined ? { note: pick.note.slice(0, 500) } : {}),
    session,
    at,
  };
}

/** T460b: a held call as the agent knows it: its tool and path or command. */
export function heldCallWords(gate: Pick<HilRequest, 'call'>): string {
  const call = gate.call;
  if (call === undefined) return 'your held call';
  const target = call.path ?? call.command;
  const shown =
    target === undefined ? '' : `: ${target.length > 200 ? `${target.slice(0, 199)}…` : target}`;
  return `your held ${call.tool} call${shown}`;
}

/** T460: the session's end after a failed turn (`session ended: turn failed: …`). */
export const TURN_FAILED_PREFIX = 'turn failed: ';
/** The runner's reason for a session it stopped on a failed turn. */
const PROMPT_FAILED_PREFIX = 'prompt failed: ';

/** A daemon-written failure line on `agent.progress` (a new start clears it). */
function isFailureProgress(progress: string | undefined): boolean {
  return (
    progress !== undefined &&
    (progress.startsWith(FAILED_START_PREFIX) || progress.startsWith(CRASHED_PREFIX))
  );
}

/** T465: a timer that never keeps the daemon's process alive on its own. */
function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/**
 * T465 (D48): the node's last agent session, when a start may resume it
 * with `session/load`: the vendor can load a session, the session ended
 * cleanly with its ACP session id on record, and the start runs the same
 * role, vendor, model and effort (a picked other model starts fresh).
 */
export function resumableSession(
  stream: Pick<Stream, 'sessions'>,
  role: SessionRole,
  settings: { vendor: string; model: string; effort: string },
  provider: Pick<AcpProviderConfig, 'loadSession' | 'effort' | 'effortOption'>,
): SessionRef | undefined {
  if (!provider.loadSession || !isAgentRole(role)) return undefined;
  const last = lastAgentSession(stream, () => true);
  if (
    last === undefined ||
    last.role !== role ||
    last.status !== 'stopped' ||
    last.acp_session_id === undefined ||
    last.vendor !== settings.vendor ||
    last.model !== settings.model ||
    (providerTakesEffort(provider) && last.effort !== settings.effort)
  ) {
    return undefined;
  }
  return last;
}

/** A vendor failure's exit reason plus its last stderr line, for the sessions strip. A clean end says nothing. */
export function endedReason(
  reason: string,
  ok: boolean,
  vendorError: string | undefined,
): string | undefined {
  if (ok && vendorError === undefined) return undefined;
  const text =
    vendorError === undefined || reason.includes(vendorError)
      ? reason
      : `${reason}: ${vendorError}`;
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

/**
 * T174: the prompt a composer line becomes. The old wording ("Continue the
 * work.") let a worker read a question and carry on without answering.
 */
export function sayPrompt(body: string): string {
  return [`The operator wrote on the stream: ${body}`, '', REPLY_FIRST].join('\n');
}

/** A routed event's payload strings are capped (the full text is on the thread). */
function cap(text: string): string {
  return text.length > 800 ? `${text.slice(0, 799)}…` : text;
}
