/**
 * T321 (projects-design §10, §14.10, §15): link a node to one Jira/Linear
 * issue, pull its goal, and turn later edits into `external_changed`.
 *
 * - `link(id, key)` reads the issue through the tracker port and sets the
 *   node's goal from its title and description (acceptance criteria live in
 *   the description in both systems' plain text), plus `external_link`.
 * - `tick()` re-reads every linked node that is due (every 5 min) and, when
 *   the title or description hash moved, rewrites the goal, adds a thread
 *   line and emits `external_changed` to the node.
 *
 * Tracker text is untrusted external data. It only ever lands in the goal,
 * framed as the issue's text; the event summary and thread line are built
 * by the daemon from the key and which fields changed, never from the text.
 */

import { createHash } from 'node:crypto';
import type { Project, Stream, TrackerSystem } from '@agile-agents/shared';
import type { EmitRouted } from '../events/producers';
import type { StreamService } from '../streams/service';
import { TrackerError, type TrackerIssue, type TrackerPort } from './port';

export const TRACKER_POLL_MS = 5 * 60_000;
/** How often `start()` looks for due links. */
export const TRACKER_POLL_TICK_MS = 30_000;
/** The goal's cap: a long description is cut, not refused. */
export const LINKED_GOAL_MAX_CHARS = 8_000;

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

export interface TrackerLinksOptions {
  streams: StreamService;
  /** The node's project, for its `tracker.system`. */
  project?: (id: string) => Project | undefined;
  /** Systems with a token in `config.yaml` (read fresh each call). */
  configured: () => TrackerSystem[];
  /** A port for a system; throws a `TrackerError` when it is not configured. */
  tracker: (system: TrackerSystem) => TrackerPort;
  emit?: EmitRouted;
  now?: () => Date;
}

export class TrackerLinks {
  private readonly now: () => Date;
  /** Epoch ms each linked node is next due. */
  private readonly due = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | undefined;

  constructor(private readonly options: TrackerLinksOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** The node's project's system, or the only configured one. */
  systemFor(stream: Stream, system?: TrackerSystem): TrackerSystem {
    if (system !== undefined) return system;
    const fromProject =
      stream.project !== undefined
        ? this.options.project?.(stream.project)?.tracker?.system
        : undefined;
    if (fromProject !== undefined) return fromProject;
    const configured = this.options.configured();
    if (configured.length === 1 && configured[0] !== undefined) return configured[0];
    throw new TrackerError(
      configured.length === 0
        ? 'no tracker is configured: set trackers.jira or trackers.linear in config.yaml'
        : "both trackers are configured: set the project's tracker or pass --system",
      'validation',
    );
  }

  /** Links `id` to `key` and sets its goal from the issue. `null` key unlinks. */
  async link(
    id: string,
    key: string | null,
    options: { system?: TrackerSystem } = {},
  ): Promise<Stream> {
    const stream = this.options.streams.get(id);
    if (key === null) {
      if (stream.external_link === undefined) return stream;
      const prior = stream.external_link.key;
      // `undefined` drops the key: the YAML writer omits it.
      const cleared = await this.options.streams.update('human', id, { external_link: undefined });
      await this.options.streams.appendThread('human', id, {
        kind: 'event',
        body: `unlinked from ${prior}`,
      });
      this.due.delete(id);
      return cleared;
    }
    const k = key.trim().toUpperCase();
    if (!KEY_RE.test(k)) {
      throw new TrackerError(
        `invalid issue key: ${key.slice(0, 40)} (want e.g. SHOP-11)`,
        'validation',
      );
    }
    const system = this.systemFor(stream, options.system);
    const issue = await this.options.tracker(system).getIssue(k);
    const updated = await this.options.streams.update('human', id, {
      goal: goalFrom(system, issue),
      external_link: linkFrom(system, issue, this.now()),
    });
    await this.options.streams.appendThread('human', id, {
      kind: 'event',
      body: `linked to ${issue.key} (${system}); the goal was set from the issue`,
    });
    this.due.set(id, this.now().getTime() + TRACKER_POLL_MS);
    return updated;
  }

  start(intervalMs = TRACKER_POLL_TICK_MS): void {
    if (intervalMs <= 0 || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => console.error('tracker poll failed:', messageOf(err)));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Re-reads every due linked node; one tick at a time. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runTick().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runTick(): Promise<void> {
    const t = this.now().getTime();
    const linked = this.options.streams
      .list()
      .filter((s) => s.external_link !== undefined && s.human.status !== 'closed');
    for (const id of this.due.keys()) {
      if (!linked.some((s) => s.id === id)) this.due.delete(id);
    }
    for (const stream of linked) {
      const due = this.due.get(stream.id) ?? t;
      if (due > t) continue;
      this.due.set(stream.id, t + TRACKER_POLL_MS);
      try {
        await this.pollOne(stream);
      } catch (err) {
        // A rate limit or auth failure stops this tick; the next one retries.
        console.error(`tracker poll ${stream.external_link?.key}: ${messageOf(err)}`);
        if (err instanceof TrackerError && (err.kind === 'rate_limited' || err.kind === 'auth')) {
          return;
        }
      }
    }
  }

  private async pollOne(stream: Stream): Promise<void> {
    const link = stream.external_link;
    if (link === undefined) return;
    const issue = await this.options.tracker(link.system).getIssue(link.key);
    const titleChanged = issue.title !== link.synced.title;
    const descChanged = hashText(issue.description) !== link.synced.description_hash;
    if (!titleChanged && !descChanged) return;
    const what =
      titleChanged && descChanged
        ? 'title and description'
        : titleChanged
          ? 'title'
          : 'description';
    await this.options.streams.update('daemon', stream.id, {
      goal: goalFrom(link.system, issue),
      external_link: linkFrom(link.system, issue, this.now()),
    });
    await this.options.streams.appendThread('daemon', stream.id, {
      kind: 'event',
      body: `${link.key}'s ${what} changed in ${link.system}; the goal was updated`,
    });
    await this.options.emit?.({
      type: 'external_changed',
      subject: stream.id,
      by: 'daemon',
      ...(stream.project !== undefined ? { project: stream.project } : {}),
      payload: { key: link.key, summary: `${what} changed` },
    });
  }
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function linkFrom(
  system: TrackerSystem,
  issue: TrackerIssue,
  at: Date,
): NonNullable<Stream['external_link']> {
  return {
    system,
    key: issue.key,
    url: issue.url,
    kind: issue.kind,
    synced: {
      title: issue.title.trim() || issue.key,
      description_hash: hashText(issue.description),
      at: at.toISOString(),
    },
  };
}

/** The goal: the issue's title and text, framed as the issue's own words. */
export function goalFrom(system: TrackerSystem, issue: TrackerIssue): string {
  const title = issue.title.trim() || issue.key;
  const body = issue.description.trim();
  const head = `${title}\n\nFrom ${system} issue ${issue.key} (${issue.url}). The text below is the issue's description as written there:`;
  const goal = body
    ? `${head}\n\n${body}`
    : `${title}\n\nFrom ${system} issue ${issue.key} (${issue.url}); it has no description.`;
  return goal.length > LINKED_GOAL_MAX_CHARS
    ? `${goal.slice(0, LINKED_GOAL_MAX_CHARS - 1)}…`
    : goal;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
