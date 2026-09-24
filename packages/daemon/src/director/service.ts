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
  type RoutedEvent,
  type SessionRef,
  type SessionStatus,
  THREAD_BODY_MAX_CHARS,
  type ThreadEntry,
  ulid,
} from '@agile-agents/shared';
import { resolveSessionSettings } from '../attach/resolve';
import { readHomeConfigFile } from '../config';
import type { DeliveryTarget, SessionDelivery } from '../events/delivery';
import { routeAndEmit } from '../events/router';
import type { RoutedEventService } from '../events/service';
import type { CliInvocation } from '../runner/cli-bin';
import { type AgentSessionHandle, startAgentSession } from '../runner/session';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';

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
}

export interface DirectorView {
  record: DirectorRecord | undefined;
  thread: ThreadEntry[];
  live: boolean;
}

export function directorBrief(thread: readonly ThreadEntry[]): string {
  const recent = thread.slice(-BRIEF_THREAD_LINES);
  return [
    '# You are the Director',
    '',
    'You sit above every project in this workspace: the engineering director of its agents.',
    'The operator talks to you on your own thread. Reply there: everything you write in this',
    'session is posted to it. You never merge, accept a norm, or answer a question as if you',
    'were the operator. Your working directory is a scratch dir; you may write only there.',
    '',
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

  constructor(private readonly options: DirectorServiceOptions) {}

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
    const brief = directorBrief(store.readDirectorThread());
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
    await this.starting;
    const handle = this.handle;
    if (handle === undefined) return;
    handle.stop();
    await handle.exited;
  }
}
