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
  type HilRequest,
  type Question,
  type Rule,
  type SessionRef,
  type SessionRole,
  type SessionStatus,
  type Stream,
  type ThreadEntry,
  ulid,
} from '@agile-agents/shared';
import { readHomeConfigFile } from '../config';
import type { RuleStatsOutcome } from '../rules/service';
import type { BriefDoc } from '../runner/brief';
import { buildBrief } from '../runner/brief';
import type { CliInvocation } from '../runner/cli-bin';
import { type AgentSessionHandle, startAgentSession } from '../runner/session';
import { createWorktree, slugify } from '../runner/worktrees';
import type { StateStore } from '../store';
import { buildEvent } from '../store';
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
  inScope(streamId: string): Rule[];
  /** §5.7's counters, bumped by the ACP permission tier. Optional for brief-only fakes. */
  recordFired?(id: string, outcome: RuleStatsOutcome): Promise<unknown>;
}

export interface AttachOptions extends AttachFlags {
  role?: SessionRole;
  /** Appended after the brief: the lessons session's material and instruction (§5.5). The caller caps it. */
  briefAppendix?: string;
}

/** `detach: true`: the human pulled the plug, not a shutdown. */
export interface StopOptions {
  detach?: boolean;
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
  /** The gates, for the same rule. */
  gates?: OpenGatesSource;
  /** Test seam: inject a fake `spawnSession`. */
  spawn?: typeof spawnSession;
  /** Test seam: override the provider the resolved vendor maps to (the fake-agent transport). */
  provider?: (vendor: string, fallback: AcpProviderConfig) => AcpProviderConfig;
  now?: () => Date;
}

export class AttachService {
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

  constructor(private readonly options: AttachServiceOptions) {}

  private handles(role: SessionRole): Map<string, AgentSessionHandle> {
    let map = this.live.get(role);
    if (map === undefined) {
      map = new Map();
      this.live.set(role, map);
    }
    return map;
  }

  /** The live handle for a stream, for a caller that wants to prompt or stop it. */
  handleFor(streamId: string, role: SessionRole = 'worker'): AgentSessionHandle | undefined {
    return this.handles(role).get(streamId);
  }

  async attach(streamId: string, options: AttachOptions = {}): Promise<AttachResult> {
    const { store, streams } = this.options;
    const role: SessionRole = options.role ?? 'worker';

    const stream = streams.get(streamId);
    // One live session per role: a reviewer may run beside a worker on the
    // same worktree, but never beside a second reviewer (§4.2).
    const busy = liveSession(stream, role);
    if (busy !== undefined) throw new StreamBusyError(stream.id, busy.id, role);

    const repos = store.getRepos();
    const repoEntry = stream.repo === undefined ? undefined : repos[stream.repo];
    if (stream.repo !== undefined && repoEntry === undefined) {
      throw new UnregisteredRepoError(stream.repo);
    }

    const settings = resolveSessionSettings({
      flags: { vendor: options.vendor, model: options.model, effort: options.effort },
      ...(repoEntry !== undefined ? { repo: repoEntry } : {}),
      home: readHomeConfigFile(this.options.home),
    });
    const provider = this.options.provider
      ? this.options.provider(settings.vendor, settings.provider)
      : settings.provider;

    const sessionId = ulid();

    // 2. Branch + worktree, only for a stream that has a repo (§4.4).
    let worktreePath = stream.worktree;
    let branch = stream.branch;
    if (repoEntry !== undefined) {
      // §4.2: a reviewer never cuts a branch. On a never-attached stream it
      // reviews from the session dir, like a no-repo stream.
      if (worktreePath === undefined && role === 'worker') {
        const created = await createWorktree(repoEntry.path, {
          id: stream.id,
          slug: slugify(stream.title),
        });
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

    // 3. The brief.
    const ancestors = this.ancestorsOf(stream);
    const brief = buildBrief({
      role,
      stream,
      ancestors,
      thread: streams.readThread(stream.id, { limit: 500 }).entries,
      docs: this.options.docs?.docsForStream(stream.id) ?? [],
      // §5.3: the accepted rules in scope for this stream and its ancestors.
      rules: this.options.rules?.inScope(stream.id) ?? [],
    });
    // The lessons material rides after the brief, never inside it (the
    // brief's own ceiling protects its parts; the caller caps the appendix).
    const prompt =
      options.briefAppendix === undefined ? brief : `${brief}\n\n${options.briefAppendix}`;
    // What the agent was handed, beside its logs: "what did it see" is a
    // file read. Best effort: a full disk must not stop a session starting.
    try {
      writeFileSync(join(sessionDir, 'brief.md'), prompt);
    } catch {
      // Diagnostics only.
    }

    // 5. Record the session before it can produce anything. A reviewer never
    // moves `agent.status`: a read-only second opinion is not work (§4.2).
    if (role === 'worker') {
      await streams.update('daemon', stream.id, { agent: { status: 'working' } });
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
      sessionDir,
      provider,
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
        if (role === 'worker') {
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
    handle.stop();
  }

  /**
   * Delivery is a prompt: the answer goes into the live session as a new
   * turn, the only thing that makes a waiting vendor continue (an answer
   * once sat unread in a mailbox for 19 minutes). With no live session the
   * answer stays on the thread for the next attach's brief.
   */
  async deliverAnswer(sessionId: string, question: Question): Promise<void> {
    const handle = this.liveHandleBySession(sessionId);
    if (handle === undefined) {
      await this.options.streams.appendThread('daemon', question.stream, {
        kind: 'event',
        body: `answer recorded with no live session (${sessionId}); the next attach's brief carries it`.slice(
          0,
          800,
        ),
        ref: sessionId,
      });
      return;
    }
    await this.setSessionStatus(question.stream, sessionId, 'running').catch(() => {
      // Best effort: the prompt below is what matters.
    });
    void handle
      .prompt(
        `Answer to your question "${question.text}" from ${question.answered_by ?? 'human'}: ${
          question.answer ?? ''
        }\n\nContinue the work.`,
      )
      .catch(() => {
        // `runPromptTurn` already stopped the session and recorded why; the
        // exit path writes `blocked` on the stream.
      });
  }

  /**
   * The stream page's composer (§9.3): a human line, and if a worker is
   * attached, a prompt too. Turns are serialized (`runner/session.ts`), so
   * a line typed mid-turn is read when that turn ends; until then its
   * thread `ts` sits in the session's `queued` list, which the stream page
   * shows as waiting. A session already being let go gets no prompt: the
   * line stays on the thread for the next attach's brief.
   */
  async say(streamId: string, body: string): Promise<{ entry: ThreadEntry; prompted?: string }> {
    const entry = await this.options.streams.appendThread('human', streamId, {
      kind: 'line',
      body,
    });
    const handle = this.handleFor(streamId, 'worker');
    if (handle === undefined || handle.stopped()) return { entry };
    const sessionId = handle.sessionId;
    const busy = handle.turnsInFlight() > 0;
    if (!busy) {
      // Nothing is running, so nothing can end and let the session go
      // before the prompt below is queued.
      await this.setSessionStatus(streamId, sessionId, 'running').catch(() => {
        // Best effort: the prompt below is what matters.
      });
    }
    // Reserve the turn in the runner before any further await: a running
    // turn that ends meanwhile then sees this one queued and keeps the
    // session (T174 review). Marker writes are chained, so a fast delivery
    // never leaves a stale `queued` entry behind.
    let delivered = false;
    let markers: Promise<unknown> = Promise.resolve();
    const unqueue = (): void => {
      if (delivered) return;
      delivered = true;
      if (!busy) return;
      markers = markers
        .then(() =>
          this.setSessionQueued(streamId, sessionId, (queued) =>
            queued.filter((ts) => ts !== entry.ts),
          ),
        )
        .catch(() => {
          // The stream or session is gone; the exit path clears the list.
        });
    };
    void handle
      .prompt(sayPrompt(body), {
        onDelivered: () => {
          unqueue();
          if (busy) {
            void this.setSessionStatus(streamId, sessionId, 'running').catch(() => {
              // Best effort.
            });
          }
        },
      })
      .catch(() => {
        // `runPromptTurn` already stopped the session and recorded why, or
        // the session was stopped before the line was delivered.
        unqueue();
      });
    if (busy && !delivered) {
      markers = markers
        .then(() =>
          delivered
            ? undefined
            : this.setSessionQueued(streamId, sessionId, (queued) => [...queued, entry.ts]),
        )
        .catch(() => {
          // Best effort: the marker is display only.
        });
      await markers;
    }
    return { entry, prompted: sessionId };
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
    // `stop()` already holds the promise it awaits; dropping it cannot lose a write.
    this.exitHandled.delete(sessionId);
    try {
      await this.setSessionStatus(
        streamId,
        sessionId,
        ok ? 'stopped' : 'error',
        detached ? undefined : endedReason(reason, ok, vendorError),
      );
      // A human pulled the plug: back to `idle`. `done` would claim the kill finished the work.
      if (detached) {
        if (role === 'worker') {
          await this.options.streams.update('daemon', streamId, { agent: { status: 'idle' } });
        }
        await this.options.streams.appendThread('daemon', streamId, {
          kind: 'event',
          body: `${role} detached by human`,
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
        body: `session ended: ${reason}`.slice(0, 800),
        ref: sessionId,
      });
    } catch {
      // The stream or home went away mid-session: nothing to record on.
      return;
    }
    if (ok) await this.maybeAutoReview(streamId);
  }

  /** A reviewer's exit (§4.2): reports its findings; moves `agent.status` only when no worker is left. */
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
    if (liveSession(stream, 'worker') === undefined && stream.agent.status !== 'done') {
      await this.options.streams.update('daemon', streamId, { agent: { status: 'done' } });
    }
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
        handle.stop();
        await handle.exited;
        // `agile detach` prints from the RPC result, which must already be on disk.
        await handled;
      }),
    );
    return stopped;
  }

  /** Stops every live session: the daemon's shutdown path. */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.live.entries()].flatMap(([role, handles]) =>
        [...handles.keys()].map((streamId) => this.stop(streamId, role)),
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
  return [
    `The operator wrote on the stream: ${body}`,
    '',
    'Reply to the operator on the stream first, with `progress`: if it is a question, answer it directly; if it is an instruction, acknowledge it and follow it. Then continue the work.',
  ].join('\n');
}
