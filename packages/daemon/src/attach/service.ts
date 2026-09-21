/**
 * `AttachService` — `agile attach <stream>`: the one path that turns a
 * stream into a running agent session (design/cockpit-design.md §4.1).
 *
 * In order, exactly as the design lists it:
 *
 *   1. refuse if the stream already has a live session — "one live worker
 *      at a time per stream" (§2.3);
 *   2. create the branch and the worktree **if the stream has a repo**, on
 *      first attach and never on stream create, so a planning stream never
 *      touches git (§4.4, the hardened T113 path);
 *   3. assemble the brief (`runner/brief.ts`);
 *   4. spawn the vendor ACP session with the worktree as cwd and the hook
 *      config installed (`runner/session.ts`);
 *   5. push the `SessionRef` onto `stream.sessions` and set
 *      `agent.status: working`.
 *
 * Session exit is handled here too, not in the runner: the runner resolves
 * `exited`, this service writes what the exit means onto the stream —
 * `SessionRef.status: stopped|error`, `agent.status: done` (or `blocked`),
 * and a `daemon` thread entry saying so.
 *
 * Every stream write from this module is principal `daemon`: these are
 * lifecycle writes, which is exactly what §2.2 reserves the daemon
 * principal for.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpProviderConfig, spawnSession } from '@agile-agents/acp-client';
import {
  type SessionRef,
  type SessionRole,
  type SessionStatus,
  type Stream,
  ulid,
} from '@agile-agents/shared';
import { readHomeConfigFile } from '../config';
import { buildBrief } from '../runner/brief';
import type { CliInvocation } from '../runner/cli-bin';
import { type AgentSessionHandle, startAgentSession } from '../runner/session';
import { createWorktree, slugify } from '../runner/worktrees';
import type { StateStore } from '../store';
import { buildEvent } from '../store';
import type { StreamService } from '../streams/service';
import { type AttachFlags, effortIgnoredLine, resolveSessionSettings } from './resolve';

/**
 * A stream that already has a live session **in the role being attached**.
 * §2.3's rule is "one live worker per stream"; T131 adds a reviewer that may
 * coexist with a worker, but at most one of each. Typed so the RPC edge
 * reports -32602.
 */
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

/** Session statuses that mean "still live" — §2.3's one-worker rule. */
const LIVE_SESSION_STATUSES: readonly SessionStatus[] = ['starting', 'running', 'idle'];

/**
 * The live session on a stream in one role. Role-scoped since T131: a
 * reviewer runs beside the worker on the same worktree, so a running
 * reviewer must not read as "this stream already has a worker".
 */
export function liveSession(stream: Stream, role: SessionRole = 'worker'): SessionRef | undefined {
  return stream.sessions.find(
    (session) => session.role === role && LIVE_SESSION_STATUSES.includes(session.status),
  );
}

export interface AttachOptions extends AttachFlags {
  role?: SessionRole;
}

export interface AttachResult {
  session: SessionRef;
  stream: Stream;
  handle: AgentSessionHandle;
}

export interface AttachServiceOptions {
  store: StateStore;
  streams: StreamService;
  /** The state home — `<home>/sessions/<id>/` holds each session's logs. */
  home: string;
  /** The daemon's unix socket, handed to the session's hook command and MCP bridge. */
  socketPath?: string;
  /** How a spawned session invokes the `agile` CLI (`runner/cli-bin.ts`). */
  cliBin?: string | CliInvocation;
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
  ]);

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
      // §4.2: the reviewer is "a second session on the same worktree" — it
      // never cuts a branch of its own. A reviewer on a stream that was
      // never attached (no worktree yet) reviews the thread from the
      // session dir, exactly as a no-repo stream does.
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
    // A planning stream runs in the state home's own session directory: it
    // has no repo, so there is nothing to check out and nothing to cd into.
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

    // D12: a vendor with no effort mapping still starts — the thread says
    // the level was ignored rather than the record claiming it applied.
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
      docs: [],
      rules: [],
    });

    // 5. Record the session before it can produce anything, so a stream
    // never has a running process it doesn't know about. A reviewer never
    // moves `agent.status`: that field describes the stream's work, and a
    // read-only second opinion is not work in progress (§4.2).
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
      brief,
      sessionDir,
      provider,
      ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
      ...(this.options.cliBin !== undefined ? { cliBin: this.options.cliBin } : {}),
      ...(this.options.socketPath !== undefined ? { socketPath: this.options.socketPath } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
    });
    this.handles(role).set(stream.id, handle);
    await this.setSessionStatus(stream.id, sessionId, 'running');

    // How many findings the stream already carried, so the reviewer's exit
    // line can report the ones *this* review produced (§4.2).
    const findingsBefore = streams.get(stream.id).agent.findings?.length ?? 0;
    void handle.exited.then((info) =>
      this.onExit(info.stream, sessionId, info.reason, info.ok, role, findingsBefore),
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
  ): Promise<void> {
    await this.options.store.updateStream('daemon', streamId, (before) => ({
      ...before,
      sessions: before.sessions.map((s) => (s.id === sessionId ? { ...s, status } : s)),
    }));
  }

  /** The exit path: what the session's end means for the stream (§2.3). */
  private async onExit(
    streamId: string,
    sessionId: string,
    reason: string,
    ok: boolean,
    role: SessionRole,
    findingsBefore: number,
  ): Promise<void> {
    const handles = this.handles(role);
    if (handles.get(streamId)?.sessionId === sessionId) handles.delete(streamId);
    try {
      await this.setSessionStatus(streamId, sessionId, ok ? 'stopped' : 'error');
      if (role === 'reviewer') {
        await this.onReviewerExit(streamId, sessionId, reason, findingsBefore);
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
      // The stream was deleted (or the home went away) while the session
      // was running — nothing left to record it on.
      return;
    }
    if (ok) await this.maybeAutoReview(streamId);
  }

  /**
   * A reviewer's exit (§4.2). It reports what the review produced and
   * leaves `agent.status` alone — the worker owns that field. Only a stream
   * with no worker left running has no one else to move it to `done`.
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
    if (liveSession(stream, 'worker') === undefined && stream.agent.status !== 'done') {
      await this.options.streams.update('daemon', streamId, { agent: { status: 'done' } });
    }
  }

  /**
   * §4.2's "optional per repo: auto-review when `agent.status` becomes
   * `done`" — `RepoEntry.auto_review`. Best-effort: a review that cannot be
   * started must never turn a clean worker exit into a failure.
   */
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
        // The stream is gone — nothing left to record it on.
      }
    }
  }

  /**
   * Stops the live sessions on a stream — one role, or every role when no
   * role is named (`agile detach <stream>` means "stop what is running on
   * this stream", reviewer included). Resolves once they have exited.
   */
  async stop(streamId: string, role?: SessionRole): Promise<void> {
    const roles = role !== undefined ? [role] : [...this.live.keys()];
    await Promise.all(
      roles.map(async (each) => {
        const handle = this.handles(each).get(streamId);
        if (handle === undefined) return;
        handle.stop();
        await handle.exited;
      }),
    );
  }

  /** Stops every live session — the daemon's own shutdown path. */
  async stopAll(): Promise<void> {
    await Promise.all(
      [...this.live.entries()].flatMap(([role, handles]) =>
        [...handles.keys()].map((streamId) => this.stop(streamId, role)),
      ),
    );
  }
}
