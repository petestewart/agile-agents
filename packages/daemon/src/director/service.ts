/**
 * The Director (T300, projects-design §12, §14.11, P16): one agent above
 * every project. It is a singleton record (`director.yaml`), not a node, with
 * its own thread (`threads/director.jsonl`) and routed-event queue
 * (`events/queue/director.jsonl`).
 *
 * Session mechanics are the coordinator's (P20, T280): no worktree, the cwd
 * is a scratch dir under `sessions/<id>/`, and the session runs under the
 * `coordinator` permission table (writes only inside that dir, no network).
 * The Director has no role of its own in `SESSION_ROLES`: its needs of the
 * permission layer are exactly a coordinator's, and a new role would touch
 * every per-role table for no difference in policy. What makes it the
 * Director is the record it lives in and the principal `director` on every
 * line it writes.
 *
 * Lifecycle: `say` appends the human line and emits `director_request`,
 * which the router sends to `director`. Delivery (the attach service's
 * `SessionDelivery`) prompts a live session, or asks `wake`, which starts
 * one. A session ends at the end of a turn with nothing more waiting; the
 * next line wakes a fresh one, whose brief carries the recent thread.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AcpProviderConfig, spawnSession } from '@agile-agents/acp-client';
import {
  DIRECTOR_NODE,
  type DirectorRecord,
  type InboxItem,
  type KnowledgeItem,
  type RoutedEvent,
  type SessionRef,
  type SessionStatus,
  THREAD_BODY_MAX_CHARS,
  type ThreadEntry,
  ulid,
} from '@agile-agents/shared';
import { resolveSessionSettings } from '../attach/resolve';
import { readHomeConfigFile } from '../config';
import type { AutonomyService } from '../coordination/autonomy';
import type { DeliveryTarget, SessionDelivery } from '../events/delivery';
import { routeAndEmit } from '../events/router';
import type { RoutedEventService } from '../events/service';
import { WakeBudget } from '../events/wake';
import { directorReadScope } from '../permissions/visibility';
import type { CliInvocation } from '../runner/cli-bin';
import { type AgentSessionHandle, startAgentSession } from '../runner/session';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';
import {
  DEFAULT_DIRECTOR_WAKE_BUDGET_PER_HOUR,
  directorDigest,
  findStuck,
  stuckAfterMs,
} from './sight';

/** Thread lines the brief carries, newest last. */
const BRIEF_THREAD_LINES = 40;

export interface DirectorServiceOptions {
  store: StateStore;
  streams: StreamService;
  events: RoutedEventService;
  home: string;
  socketPath?: string;
  cliBin?: string | CliInvocation;
  /** Test seam: inject a fake `spawnSession`. */
  spawn?: typeof spawnSession;
  /** Test seam: the provider the resolved vendor maps to. */
  provider?: (vendor: string, fallback: AcpProviderConfig) => AcpProviderConfig;
  now?: () => Date;
  /** T302: the digest's inbox and norms, and the stuck-node suggestion cards. */
  inbox?: { list(): InboxItem[] };
  knowledge?: { list(options: { status: 'accepted' }): KnowledgeItem[] };
  autonomy?: AutonomyService;
}

export interface DirectorView {
  record: DirectorRecord | undefined;
  thread: ThreadEntry[];
  live: boolean;
}

export function directorBrief(thread: readonly ThreadEntry[], digest?: string): string {
  const recent = thread.slice(-BRIEF_THREAD_LINES);
  return [
    '# You are the Director',
    '',
    'You sit above every project in this workspace: the engineering director of its agents.',
    'The operator talks to you on your own thread. Reply there: everything you write in this',
    'session is posted to it. You never merge, accept a norm, or answer a question as if you',
    'were the operator. Your working directory is a scratch dir; you may write only there.',
    '',
    'Your tools (the `agile` MCP server): `draft_tree`, `create_project`, `create_node`,',
    '`start_node`, `add_waits_on` and `restart_node`. Each is gated by the project’s Director',
    'level: at Advise it becomes a draft the operator creates with one click; at Organise it is',
    'applied (restart only at Run). Say on your thread what you drafted or did.',
    '',
    'Across projects: propose `add_waits_on` where two nodes overlap, and say so when work in',
    'one project is about to break a norm set in another. For a stuck node, suggest what to do',
    '(`restart_node` is a card until Run). Answer "what needs me today?" from the snapshot',
    'below, not from memory: the inbox first, then stuck nodes, overlaps and open waits.',
    '',
    ...(digest !== undefined ? [digest, ''] : []),
    '## Your thread (most recent last)',
    '',
    ...(recent.length === 0
      ? ['(empty)']
      : recent.map((e) => `- [${e.ts}] ${e.by}: ${e.body.replace(/\s+/g, ' ')}`)),
    '',
    'Pending messages for you follow as their own turn.',
  ].join('\n');
}

export class DirectorService {
  private handle: AgentSessionHandle | undefined;
  private starting: Promise<void> | undefined;
  private delivery: SessionDelivery | undefined;
  private stopped = false;
  private sightTimer: ReturnType<typeof setInterval> | undefined;
  /** Nodes already flagged stuck (one card and one wake per episode). */
  private readonly flagged = new Set<string>();
  private readonly wakeBudget: WakeBudget;

  constructor(private readonly options: DirectorServiceOptions) {
    this.wakeBudget = new WakeBudget(() => this.now().getTime());
  }

  /** T302: the snapshot every project is read from, taken now. */
  digest(): string {
    const { store, streams, home } = this.options;
    return directorDigest({
      streams: streams.list(),
      projects: store.listProjects(),
      inbox: this.options.inbox?.list() ?? [],
      knowledge: this.options.knowledge?.list({ status: 'accepted' }) ?? [],
      lastThreadTs: (node) => store.readThread(node).at(-1)?.ts,
      now: this.now(),
      stuckAfterMs: stuckAfterMs(readHomeConfigFile(home)),
    });
  }

  /**
   * T302: each newly stuck node gets one Director suggestion (a `restart_node`
   * through the autonomy gate: a card below Run) and, within a bounded
   * budget, one `director_request` so the Director can say what to do.
   */
  async checkStuck(): Promise<string[]> {
    const { store, streams, home, autonomy } = this.options;
    if (autonomy === undefined || this.stopped) return [];
    const config = readHomeConfigFile(home);
    const stuck = findStuck({
      streams: streams.list(),
      lastThreadTs: (node) => store.readThread(node).at(-1)?.ts,
      now: this.now(),
      stuckAfterMs: stuckAfterMs(config),
    });
    const ids = new Set(stuck.map((s) => s.node));
    for (const id of this.flagged) if (!ids.has(id)) this.flagged.delete(id);
    const open = autonomy.listOpen();
    const flaggedNow: string[] = [];
    for (const s of stuck) {
      if (this.flagged.has(s.node)) continue;
      this.flagged.add(s.node);
      const held = open.some((p) => p.change.action === 'restart_node' && p.change.node === s.node);
      try {
        if (!held) {
          await autonomy.act(DIRECTOR_NODE, 'director', 'director', {
            action: 'restart_node',
            node: s.node,
          });
        }
      } catch (err) {
        await this.append(
          'daemon',
          'event',
          `stuck ${s.title}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 800),
        ).catch(() => undefined);
        continue;
      }
      flaggedNow.push(s.node);
      const limit = config.director?.wake_budget_per_hour ?? DEFAULT_DIRECTOR_WAKE_BUDGET_PER_HOUR;
      if (!this.wakeBudget.take(DIRECTOR_NODE, limit)) continue;
      await this.ensureRecord();
      await routeAndEmit(
        this.options.events,
        {
          type: 'director_request',
          payload: {
            body: `${s.title} [${s.node}] has been working with no activity for ${s.idleMinutes} min. Suggest what to do.`,
          },
          by: 'daemon',
        },
        streams.list(),
      );
    }
    return flaggedNow;
  }

  /** T302: the periodic stuck check. */
  startSight(intervalMs = 60_000): void {
    if (this.sightTimer !== undefined) return;
    this.sightTimer = setInterval(() => {
      void this.checkStuck().catch((err) => console.error('director stuck check failed:', err));
    }, intervalMs);
    this.sightTimer.unref?.();
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Wired once the attach service (which owns the one delivery) exists. */
  setDelivery(delivery: SessionDelivery): void {
    this.delivery = delivery;
  }

  view(limit = 500): DirectorView {
    const { store } = this.options;
    return {
      record: store.getDirector(),
      thread: store.readDirectorThread().slice(-limit),
      live: this.liveHandle() !== undefined,
    };
  }

  private async ensureRecord(): Promise<DirectorRecord> {
    const { store } = this.options;
    return (
      store.getDirector() ??
      (await store.putDirector({ thread: DIRECTOR_NODE, created_at: this.now().toISOString() }))
    );
  }

  private append(
    by: 'human' | 'director' | 'daemon',
    kind: ThreadEntry['kind'],
    body: string,
    ref?: string,
  ) {
    const capped =
      body.length > THREAD_BODY_MAX_CHARS ? `${body.slice(0, THREAD_BODY_MAX_CHARS - 1)}…` : body;
    return this.options.store.appendDirectorThread({
      ts: this.now().toISOString(),
      by,
      kind,
      body: capped,
      ...(ref !== undefined ? { ref } : {}),
    });
  }

  /** `agile director say`, the cockpit's composer: the line, then `director_request`. */
  async say(body: string): Promise<{ entry: ThreadEntry; event: RoutedEvent }> {
    const text = body.trim();
    if (text.length === 0) throw new Error('director say: the line is empty');
    await this.ensureRecord();
    const entry = await this.append('human', 'line', text);
    const event = await routeAndEmit(
      this.options.events,
      {
        type: 'director_request',
        payload: { body: text.slice(0, 800) },
        by: 'human',
        ref: entry.ts,
      },
      this.options.streams.list(),
    );
    return { entry, event };
  }

  private liveHandle(): AgentSessionHandle | undefined {
    const h = this.handle;
    return h !== undefined && !h.stopped() ? h : undefined;
  }

  /** Delivery's view of the live Director session. */
  target(): DeliveryTarget | undefined {
    const handle = this.liveHandle();
    if (handle === undefined) return undefined;
    return {
      sessionId: handle.sessionId,
      busy: () => handle.turnsInFlight() > 0,
      prompt: (text, opts) => handle.prompt(text, opts),
    };
  }

  /** Pending `director_request`s and no live session: start one. */
  wake(_pending: readonly RoutedEvent[]): void {
    if (this.stopped || this.liveHandle() !== undefined || this.starting !== undefined) return;
    this.starting = this.start()
      .catch(async (err) => {
        await this.append(
          'daemon',
          'event',
          `could not start the Director: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            800,
          ),
        ).catch(() => undefined);
      })
      .finally(() => {
        this.starting = undefined;
      });
  }

  private async setSession(session: SessionRef): Promise<void> {
    const record = await this.ensureRecord();
    await this.options.store.putDirector({ ...record, session });
  }

  private async start(): Promise<void> {
    const { store, streams, home } = this.options;
    await this.ensureRecord();
    const settings = resolveSessionSettings({ home: readHomeConfigFile(home) });
    const provider = this.options.provider
      ? this.options.provider(settings.vendor, settings.provider)
      : settings.provider;
    const sessionId = ulid();
    const sessionDir = join(home, 'sessions', sessionId);
    mkdirSync(sessionDir, { recursive: true });
    const brief = directorBrief(store.readDirectorThread(), this.digest());
    try {
      writeFileSync(join(sessionDir, 'brief.md'), brief);
    } catch {
      // Diagnostics only.
    }
    // The coordinator's permission table (see the header).
    const session: SessionRef = {
      id: sessionId,
      vendor: settings.vendor,
      model: settings.model,
      role: 'coordinator',
      status: 'starting',
      ...(provider.effort !== undefined ? { effort: settings.effort } : {}),
    };
    await this.setSession(session);
    await this.append(
      'daemon',
      'event',
      `director attached: ${settings.vendor}/${settings.model} effort=${settings.effort}`,
      sessionId,
    );
    const handle = startAgentSession({
      store,
      streams,
      owner: {
        id: DIRECTOR_NODE,
        appendOutput: (body, ref) => this.append('director', 'line', body, ref),
      },
      session,
      role: 'coordinator',
      worktreePath: sessionDir,
      readScope: directorReadScope(() => store.getRepos(), home),
      brief,
      sessionDir,
      provider,
      ...(this.options.spawn !== undefined ? { spawn: this.options.spawn } : {}),
      ...(this.options.cliBin !== undefined ? { cliBin: this.options.cliBin } : {}),
      ...(this.options.socketPath !== undefined ? { socketPath: this.options.socketPath } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      onTurnEnd: (info) => {
        void this.onTurnEnd(handle, info.queued);
      },
    });
    this.handle = handle;
    await this.setSessionStatus(session, 'running');
    void handle.exited.then(async (info) => {
      if (this.handle === handle) this.handle = undefined;
      await this.setSessionStatus(
        session,
        'stopped',
        info.ok ? undefined : `${info.reason}${info.vendorError ? `: ${info.vendorError}` : ''}`,
      ).catch(() => undefined);
      // Anything that arrived as the session ended goes to a fresh one.
      if (!this.stopped && this.options.events.pendingFor(DIRECTOR_NODE).length > 0) {
        this.delivery?.notify(DIRECTOR_NODE);
      }
    });
  }

  private async setSessionStatus(
    session: SessionRef,
    status: SessionStatus,
    endedReason?: string,
  ): Promise<void> {
    const current = this.options.store.getDirector()?.session;
    // A late write from an older session must not overwrite a newer session's status.
    if (current !== undefined && current.id !== session.id) return;
    await this.setSession({
      ...(current ?? session),
      status,
      ...(endedReason !== undefined ? { ended_reason: endedReason.slice(0, 300) } : {}),
    });
  }

  /** A turn ended: deliver what waits, else let the session go. */
  private async onTurnEnd(handle: AgentSessionHandle, queued: number): Promise<void> {
    if (this.handle !== handle || queued > 0) return;
    if (this.delivery?.waiting(DIRECTOR_NODE)) {
      if (await this.delivery.flushWhenReady(DIRECTOR_NODE)) return;
    }
    if (this.handle !== handle) return;
    handle.stop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.sightTimer !== undefined) clearInterval(this.sightTimer);
    await this.starting;
    const handle = this.handle;
    if (handle === undefined) return;
    handle.stop();
    await handle.exited;
  }
}
