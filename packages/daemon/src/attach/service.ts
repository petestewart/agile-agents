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
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpProviderConfig, spawnSession } from '@agile-agents/acp-client';
import {
  DIRECTOR_NODE,
  type HilRequest,
  type KnowledgeItem,
  type NodeRole,
  type Plan,
  type Question,
  type RoutedEvent,
  type SessionRef,
  type SessionRole,
  type SessionStatus,
  type StatusCard,
  type Stream,
  type StreamPrincipal,
  type ThreadEntry,
  isAgentRole,
  liveChildrenOf,
  nodeRole,
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
import { routeAndEmit } from '../events/router';
import { RoutedEventService } from '../events/service';
import {
  DAEMON_STOP_PREFIX,
  DEFAULT_WAKE_BUDGET_PER_HOUR,
  WakeBudget,
  WakeFanout,
  fanoutTriggers,
  wakeVerdict,
} from '../events/wake';
import { settingsFileName } from '../hook/settings';
import type { RuleStatsOutcome } from '../knowledge/service';
import { repoScriptChecks } from '../permissions/command';
import { nodeReadScope } from '../permissions/policy-tables';
import type { BriefDoc } from '../runner/brief';
import { buildBrief } from '../runner/brief';
import type { CliInvocation } from '../runner/cli-bin';
import { type AgentSessionHandle, startAgentSession } from '../runner/session';
import { createWorktree, slugify } from '../runner/worktrees';
import type { StateStore } from '../store';
import { assertRepoHasCommits, buildEvent } from '../store';
import type { StreamService } from '../streams/service';
import { type AttachFlags, effortIgnoredLine, resolveSessionSettings } from './resolve';

/** A live session already exists in this role (one worker and one reviewer at most). RPC: -32602. */
export class StreamBusyError extends Error {
  constructor(
    public readonly stream: string,
    public readonly session: string,
    role: SessionRole = 'worker',
  ) {
    super(
      `stream ${stream} already has a live ${role} session (${session}); stop it before attaching`,
    );
    this.name = 'StreamBusyError';
  }
}

/** The stream names a repo that is no longer registered in `repos.yaml`. */
export class UnregisteredRepoError extends Error {
  constructor(public readonly repo: string) {
    super(`stream repo ${repo} is not registered in repos.yaml`);
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
function liveAgent(stream: Stream): SessionRef | undefined {
  return liveSession(stream, 'worker') ?? liveSession(stream, 'coordinator');
}

/**
 * P20 (T280): the agent a node runs as it stands now: a coordinator on a
 * coordinating node, or on a project root once it has children (a bare
 * root is still a single stream a worker runs on, the pre-projects shape);
 * a worker otherwise.
 */
function agentFor(
  stream: Stream,
  all: readonly Stream[],
): { children: Stream[]; shape: NodeRole; role: 'worker' | 'coordinator' } {
  const children = liveChildrenOf(stream.id, all);
  const shape = nodeRole(stream, children, all);
  const coordinates =
    shape === 'coordinating' ||
    (shape === 'project' && children.some((c) => c.helper_of !== stream.id));
  return { children, shape, role: coordinates ? 'coordinator' : 'worker' };
}

/** T370: the ended reason of a session the daemon's shutdown stopped. */
export const DAEMON_SHUTDOWN_REASON = 'the daemon stopped';

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
  /** T281: plans and contracts for the coordinator's and each child's brief. */
  plans?: Pick<PlanService, 'get' | 'childView'>;
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

  /** T243 (P11): wakes per node in the last hour, and wakes being started now. */
  private readonly wakeBudget: WakeBudget;
  /** T351: conversations woken per accepted knowledge item (D36 D10). */
  private readonly wakeFanout = new WakeFanout();
  private readonly waking = new Set<string>();
  /** Nodes already sent to the inbox for a spent budget (one thread line per episode). */
  private readonly overBudget = new Set<string>();
  /** T361: nodes whose agent is being restarted in a new role. */
  private readonly roleRestarts = new Set<string>();

  constructor(private readonly options: AttachServiceOptions) {
    this.events = options.events ?? new RoutedEventService(options.store);
    this.wakeBudget = new WakeBudget(options.wakeClock);
    this.delivery = new SessionDelivery({
      wake: (node, pending) => {
        if (node === DIRECTOR_NODE) return options.director?.()?.wake(pending);
        void this.wake(node, pending).catch((err) => console.error('wake failed:', err));
      },
      events: this.events,
      titleOf: (id) =>
        options.streams.list({ include_archived: true }).find((s) => s.id === id)?.title,
      ...(options.deliveryDelayMs !== undefined ? { delayMs: options.deliveryDelayMs } : {}),
      target: (node) => {
        if (node === DIRECTOR_NODE) return options.director?.()?.target();
        const handle = this.agentHandle(node);
        if (handle === undefined || handle.stopped()) return undefined;
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
   */
  private async wake(node: string, pending: readonly RoutedEvent[]): Promise<void> {
    if (this.waking.has(node)) return;
    const { streams } = this.options;
    let stream: Stream;
    try {
      stream = streams.get(node);
    } catch {
      return;
    }
    if (liveAgent(stream) !== undefined) return;
    const all = streams.list();
    const role = nodeRole(stream, liveChildrenOf(stream.id, all), all);
    if (wakeVerdict(stream, role, pending) !== 'wake') return;
    // T351: an item past its fan-out waits for this conversation's next turn.
    const fanout = fanoutTriggers(role, pending);
    if (fanout.length > 0 && !this.wakeFanout.take(fanout)) return;
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
        body: `woken by ${[...new Set(pending.map((e) => e.type.replace(/_/g, ' ')))].join(', ')}`.slice(
          0,
          800,
        ),
      });
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
  startWithPending(id: string): Promise<AttachResult> {
    return this.attach(id, { wake: this.events.pendingFor(id).map((p) => p.event) });
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
    // A project root counts once it has children: a bare root is still a
    // single stream a worker runs on (the pre-projects shape).
    const { children, role: agentRole } = agentFor(stream, streams.list());
    const coordinates = agentRole === 'coordinator';
    const requested: SessionRole = options.role ?? 'worker';
    const role: SessionRole = requested === 'worker' && coordinates ? 'coordinator' : requested;
    // One live session per role: a reviewer may run beside a worker on the
    // same worktree, but never beside a second reviewer (§4.2). A node has
    // one agent, worker or coordinator.
    const busy = isAgentRole(role) ? liveAgent(stream) : liveSession(stream, role);
    if (busy !== undefined) throw new StreamBusyError(stream.id, busy.id, role);

    const repos = store.getRepos();
    const repoEntry = stream.repo === undefined ? undefined : repos[stream.repo];
    if (stream.repo !== undefined && repoEntry === undefined) {
      throw new UnregisteredRepoError(stream.repo);
    }

    const project =
      stream.project === undefined ? undefined : projectSession(store, stream.project);
    const settings = resolveSessionSettings({
      flags: { vendor: options.vendor, model: options.model, effort: options.effort },
      ...(project !== undefined ? { project } : {}),
      ...(repoEntry !== undefined ? { repo: repoEntry } : {}),
      home: readHomeConfigFile(this.options.home),
    });
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
            `helper ${stream.id}: its parent ${host.id} has no branch yet; start the parent first`,
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
      ...(provider.effort !== undefined ? { effort: settings.effort } : {}),
      ...(worktreePath !== undefined ? { worktree: worktreePath } : {}),
    };

    // D12: a vendor with no effort mapping still starts; the thread says the level was ignored.
    if (provider.effort === undefined) {
      await streams.appendThread('daemon', stream.id, {
        kind: 'event',
        body: effortIgnoredLine(settings.vendor, settings.effort),
      });
    }

    // T330 (§4.4, P20): the same read scope the hook tier gives this node.
    const readScope = nodeReadScope(stream, () => repos, this.options.home);
    // 3. The brief. It names the repos the node may read (a work node: the
    // others than its own), so the agent knows where they are.
    const readableRepos = Object.entries(repos)
      .filter(([name, entry]) => readScope.readRoots.includes(entry.path) && name !== stream.repo)
      .map(([name, entry]) => ({ name, path: entry.path }));
    const inWorktree = worktreePath !== undefined;
    const ancestors = this.ancestorsOf(stream);
    const brief = buildBrief({
      ...(!inWorktree || readableRepos.length > 0 ? { readableRepos, inWorktree } : {}),
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
    });
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

    // 5. Record the session before it can produce anything. A reviewer never
    // moves `agent.status`: a read-only second opinion is not work (§4.2).
    if (isAgentRole(role)) {
      // T176: a worker on the branch makes the last land's conflict stale.
      await streams.update('daemon', stream.id, {
        agent: { status: 'working' },
        ...(stream.land_conflict ? { land_conflict: null } : {}),
      });
    }
    const recorded = await this.pushSession(stream.id, session);
    await streams.appendThread('daemon', stream.id, {
      kind: 'event',
      body: `${role} attached: ${settings.vendor}/${settings.model} effort=${settings.effort}${
        worktreePath !== undefined ? ` in ${worktreePath}` : ''
      }`,
      ref: sessionId,
    });
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
    // 4. Spawn.
    const handle = startAgentSession({
      store,
      streams,
      stream: recorded,
      session,
      role,
      worktreePath: cwd,
      brief: prompt,
      ...(wake !== undefined ? { onBriefDelivered: () => wake.delivered(sessionId) } : {}),
      sessionDir,
      provider,
      readScope,
      ...(this.options.rules !== undefined ? { rules: this.options.rules } : {}),
      ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
      ...(this.options.cliBin !== undefined ? { cliBin: this.options.cliBin } : {}),
      ...(this.options.socketPath !== undefined ? { socketPath: this.options.socketPath } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      onTurnEnd: (info) => {
        void this.onTurnEnd(stream.id, sessionId, role, info.queued);
      },
    });
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
   * finished: the session is stopped and the exit path (the one writer of
   * `done`/`blocked`) records it. A Claude session told to wait for a gate
   * ends its turn, so the gate half is the normal path.
   */
  private async onTurnEnd(
    streamId: string,
    sessionId: string,
    role: SessionRole,
    queued = 0,
  ): Promise<void> {
    const handle = this.handles(role).get(streamId);
    if (handle === undefined || handle.sessionId !== sessionId) return;
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
    this.turnFinished.add(sessionId);
    handle.stop();
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
    options: { start?: boolean } = {},
  ): Promise<{ entry: ThreadEntry; prompted?: string; started?: true }> {
    // Held from before the first write: a turn ending before the emit keeps the session.
    const release = this.delivery.hold(streamId);
    let entry: ThreadEntry;
    let handle: AgentSessionHandle | undefined;
    let busy = false;
    let started: AttachResult | undefined;
    try {
      entry = await this.options.streams.appendThread('human', streamId, { kind: 'line', body });
      handle = this.agentHandle(streamId);
      if (handle?.stopped()) handle = undefined;
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
      if (handle === undefined && options.start === true) started = await this.startFor(streamId);
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
   * Not on a closed, landed or deleted node, nor a bare project root. A
   * failed start is a thread line; the line stays pending.
   */
  private async startFor(id: string): Promise<AttachResult | undefined> {
    const { streams } = this.options;
    const stream = streams.get(id);
    if (!isOpen(stream) || liveAgent(stream) !== undefined || this.waking.has(id)) return undefined;
    const { shape, role } = agentFor(stream, streams.list());
    if (shape === 'project' && role !== 'coordinator') return undefined;
    try {
      return await this.startWithPending(id);
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
    const line = approved
      ? `${gate.id} approved${note} — retry the call now.`
      : `${gate.id} denied${note} — do not retry it; do the work another way or ask on the stream.`;
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
  ): Promise<void> {
    const handles = this.handles(role);
    if (handles.get(streamId)?.sessionId === sessionId) handles.delete(streamId);
    const detached = this.detaching.delete(sessionId);
    const stopReason = this.stopReasons.get(sessionId);
    this.stopReasons.delete(sessionId);
    // T341: the daemon ended it after a finished turn; the kill's exit code says nothing.
    const finishedTurn = this.turnFinished.delete(sessionId) && ok && vendorError === undefined;
    // `stop()` already holds the promise it awaits; dropping it cannot lose a write.
    this.exitHandled.delete(sessionId);
    try {
      await this.setSessionStatus(
        streamId,
        sessionId,
        ok || detached || stopReason !== undefined ? 'stopped' : 'error',
        detached
          ? undefined
          : stopReason !== undefined
            ? `${DAEMON_STOP_PREFIX}${stopReason}`
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
      await this.options.streams.update('daemon', streamId, {
        agent: { status: ok ? 'done' : 'blocked' },
      });
      await this.options.streams.appendThread('daemon', streamId, {
        kind: 'event',
        body: `session ended: ${finishedTurn ? 'its turn finished' : reason}`.slice(0, 800),
        ref: sessionId,
      });
    } catch {
      // The stream or home went away mid-session: nothing to record on.
      return;
    }
    if (ok && role === 'worker') await this.maybeAutoReview(streamId);
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
        handle.stop();
        await handle.exited;
        // `agile detach` prints from the RPC result, which must already be on disk.
        await handled;
      }),
    );
    return stopped;
  }

  /**
   * Stops every live session: the daemon's shutdown path. A daemon stop
   * (T370): the kill ends no work, so the node goes back to `idle` (never
   * `done`, which read as "ready to merge" after a restart) and is not
   * "stopped by the human", so its next event wakes it again.
   */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.live.entries()].flatMap(([role, handles]) =>
        [...handles.keys()].map((streamId) =>
          this.stop(streamId, role, { reason: DAEMON_SHUTDOWN_REASON }),
        ),
      ),
    );
  }

  private liveHandleBySession(sessionId: string): AgentSessionHandle | undefined {
    return [...this.live.values()]
      .flatMap((byStream) => [...byStream.values()])
      .find((each) => each.sessionId === sessionId);
  }
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
