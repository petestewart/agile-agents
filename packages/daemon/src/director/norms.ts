/**
 * T303 (projects-design §12 "Suggests norms"): findings that repeat across
 * projects wake the Director, which may `propose_knowledge`. The proposal
 * reaches the operator as any other (`proposed`; only a human accepts).
 *
 * Material: reviewer/agent findings on every node in a project
 * (`agent.findings`) and PR review comments (`pr_review` routed events).
 * Two items are similar when they name the same file area (directory) or
 * share most of their wording. A cluster wakes the Director when at least
 * three of its items, across at least two projects, have not been reported
 * before.
 *
 * Bounded: each wake writes a daemon line on the Director's thread whose
 * `ref` (`norm:<source ids>`) records what was reported, so a restart never
 * re-reports a source; and at most `MAX_NORM_WAKES_PER_DAY` such lines are
 * written in any 24 hours.
 */

import { posix } from 'node:path';
import { DIRECTOR_NODE, type RoutedEvent, type Stream } from '@agile-agents/shared';
import { routeAndEmit } from '../events/router';
import type { RoutedEventService } from '../events/service';
import type { StateStore } from '../store';
import type { StreamService } from '../streams/service';

export const NORM_MIN_ITEMS = 3;
export const NORM_MIN_PROJECTS = 2;
export const MAX_NORM_WAKES_PER_DAY = 3;
/** Sources carried by one wake. */
const MAX_SOURCES = 8;
const NORM_REF = 'norm:';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Shared words over the shorter item's words (overlap coefficient). */
const WORDING_OVERLAP = 0.6;

const STOPWORDS = new Set(
  'the and for with this that from into not are was were but has have should must use when then than there here its also only any all can'.split(
    ' ',
  ),
);

export interface NormSource {
  /** `<node>#<index>` for a finding, `<event id>#<index>` for a PR comment. */
  id: string;
  project: string;
  node: string;
  file?: string;
  text: string;
}

export interface NormWatchOptions {
  store: StateStore;
  streams: StreamService;
  events: RoutedEventService;
  now?: () => Date;
}

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function area(file: string | undefined): string | undefined {
  if (file === undefined) return undefined;
  const dir = posix.dirname(file.replace(/\\/g, '/'));
  return dir === '.' || dir === '/' || dir === '' ? undefined : dir;
}

export function similar(a: NormSource, b: NormSource): boolean {
  const areaA = area(a.file);
  if (areaA !== undefined && areaA === area(b.file)) return true;
  const wa = words(a.text);
  const wb = words(b.text);
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared >= 2 && shared / Math.min(wa.size, wb.size) >= WORDING_OVERLAP;
}

/** Connected components under `similar`. */
export function clusters(sources: readonly NormSource[]): NormSource[][] {
  const parent = sources.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r] as number;
    return r;
  };
  for (let i = 0; i < sources.length; i++) {
    for (let j = i + 1; j < sources.length; j++) {
      if (similar(sources[i] as NormSource, sources[j] as NormSource)) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, NormSource[]>();
  sources.forEach((s, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), s]);
  });
  return [...groups.values()];
}

export function describeSource(s: NormSource, title?: string): string {
  return `${s.id} (project ${s.project}, node ${title ?? s.node})${s.file ? ` ${s.file}` : ''}: ${s.text.replace(/\s+/g, ' ').slice(0, 120)}`;
}

export class NormWatch {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NormWatchOptions) {}

  /** Every finding and PR review comment on a node that belongs to a project. */
  sources(): NormSource[] {
    const nodes = this.options.streams.list().filter((s) => s.project !== undefined);
    const byId = new Map<string, Stream>(nodes.map((s) => [s.id, s]));
    const out: NormSource[] = [];
    for (const s of nodes) {
      (s.agent.findings ?? []).forEach((f, i) => {
        out.push({
          id: `${s.id}#${i}`,
          project: s.project as string,
          node: s.id,
          file: f.file,
          text: f.text,
        });
      });
    }
    const repos = new Set(nodes.map((s) => s.repo).filter((r): r is string => r !== undefined));
    for (const repo of repos) {
      for (const event of this.options.events.forRepo(repo, 500)) {
        if (event.type !== 'pr_review' || event.subject === undefined) continue;
        const node = byId.get(event.subject);
        if (node === undefined) continue;
        const comments = (event.payload as { comments?: string[] }).comments ?? [];
        comments.forEach((text, i) => {
          out.push({
            id: `${event.id}#${i}`,
            project: node.project as string,
            node: node.id,
            text,
          });
        });
      }
    }
    return out;
  }

  /** Source ids already reported, and how many norm wakes in the last day. */
  private reported(): { ids: Set<string>; recent: number } {
    const ids = new Set<string>();
    let recent = 0;
    const since = (this.options.now?.() ?? new Date()).getTime() - DAY_MS;
    for (const line of this.options.store.readDirectorThread()) {
      if (line.by !== 'daemon' || !line.ref?.startsWith(NORM_REF)) continue;
      for (const id of line.ref.slice(NORM_REF.length).split(',')) ids.add(id);
      if (Date.parse(line.ts) >= since) recent++;
    }
    return { ids, recent };
  }

  /** Serialised: concurrent findings never double-report one cluster. */
  check(): Promise<RoutedEvent | undefined> {
    const run = this.chain.then(() => this.checkOnce());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async checkOnce(): Promise<RoutedEvent | undefined> {
    if (this.options.store.getDirector() === undefined) {
      await this.options.store.putDirector({
        thread: DIRECTOR_NODE,
        created_at: (this.options.now?.() ?? new Date()).toISOString(),
      });
    }
    const { ids, recent } = this.reported();
    if (recent >= MAX_NORM_WAKES_PER_DAY) return undefined;
    const fresh = this.sources().filter((s) => !ids.has(s.id));
    const cluster = clusters(fresh).find(
      (c) =>
        c.length >= NORM_MIN_ITEMS && new Set(c.map((s) => s.project)).size >= NORM_MIN_PROJECTS,
    );
    if (cluster === undefined) return undefined;
    const shown = cluster.slice(0, MAX_SOURCES);
    const projects = new Set(cluster.map((s) => s.project)).size;
    const titles = new Map(this.options.streams.list().map((s) => [s.id, s.title]));
    const body = [
      `norm suggestion: ${cluster.length} similar findings across ${projects} projects.`,
      ...shown.map((s) => `- ${describeSource(s, titles.get(s.node))}`),
      'If they share one cause, propose_knowledge (scope global, repo:<name> or project:<id>) with these ids as `sources`; the operator decides.',
    ]
      .join('\n')
      .slice(0, 800);
    await this.options.store.appendDirectorThread({
      ts: (this.options.now?.() ?? new Date()).toISOString(),
      by: 'daemon',
      kind: 'event',
      body,
      ref: `${NORM_REF}${cluster.map((s) => s.id).join(',')}`,
    });
    return routeAndEmit(
      this.options.events,
      { type: 'director_request', payload: { body }, by: 'daemon' },
      this.options.streams.list(),
    );
  }
}
