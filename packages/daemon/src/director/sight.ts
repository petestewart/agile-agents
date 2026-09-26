/**
 * T302 (projects-design §12 "Sees across projects", "Keeps things moving"):
 * the Director's digest of every project, built from the store at the moment
 * it is asked, never from the session's memory. Its brief carries it, so
 * "what needs me today?" is answered from this snapshot.
 *
 * A node is stuck when its agent is `working` and nothing has happened on it
 * (its agent half or its thread) for longer than `director.stuck_after_minutes`
 * in the home `config.yaml` (default 60).
 */

import {
  type HomeConfig,
  type InboxItem,
  type KnowledgeItem,
  type Project,
  type Stream,
  formatKnowledgeScope,
} from '@agile-agents/shared';
import { findOverlaps } from '../sync/overlap';

export const DEFAULT_STUCK_AFTER_MINUTES = 60;
/** Daemon-emitted Director wakes (stuck nodes) per hour, past which only the card is made. */
export const DEFAULT_DIRECTOR_WAKE_BUDGET_PER_HOUR = 6;
/** Lines per digest section: signal over volume. */
const SECTION_MAX = 20;

export function stuckAfterMs(config: HomeConfig): number {
  return (config.director?.stuck_after_minutes ?? DEFAULT_STUCK_AFTER_MINUTES) * 60_000;
}

export interface SightInput {
  streams: readonly Stream[];
  projects: readonly Project[];
  inbox: readonly InboxItem[];
  /** Accepted knowledge; the digest lists the project-scoped norms. */
  knowledge: readonly KnowledgeItem[];
  /** Last thread line time per node, for the stuck check. */
  lastThreadTs: (node: string) => string | undefined;
  now: Date;
  stuckAfterMs: number;
}

export interface StuckNode {
  node: string;
  title: string;
  project?: string;
  idleMinutes: number;
}

function open(s: Stream): boolean {
  return s.archived !== true && s.human.status !== 'landed' && s.human.status !== 'closed';
}

/** Working nodes with no activity for longer than the threshold, longest first. */
export function findStuck(
  input: Pick<SightInput, 'streams' | 'lastThreadTs' | 'now' | 'stuckAfterMs'>,
): StuckNode[] {
  const out: StuckNode[] = [];
  for (const s of input.streams) {
    if (!open(s) || s.agent.status !== 'working') continue;
    const times = [s.agent.updated_at, input.lastThreadTs(s.id)]
      .map((t) => (t === undefined ? Number.NaN : Date.parse(t)))
      .filter((t) => !Number.isNaN(t));
    if (times.length === 0) continue;
    const idle = input.now.getTime() - Math.max(...times);
    if (idle <= input.stuckAfterMs) continue;
    out.push({
      node: s.id,
      title: s.title,
      ...(s.project !== undefined ? { project: s.project } : {}),
      idleMinutes: Math.floor(idle / 60_000),
    });
  }
  return out.sort((a, b) => b.idleMinutes - a.idleMinutes);
}

function capped(lines: string[]): string[] {
  if (lines.length === 0) return ['(none)'];
  if (lines.length <= SECTION_MAX) return lines;
  return [...lines.slice(0, SECTION_MAX), `- … and ${lines.length - SECTION_MAX} more`];
}

/** The digest: projects, overlaps, waits-on, stuck nodes, cross-project norms, the inbox. */
export function directorDigest(input: SightInput): string {
  const byId = new Map(input.streams.map((s) => [s.id, s]));
  const projectName = new Map(input.projects.map((p) => [p.id, p.name]));
  const name = (id: string): string => {
    const s = byId.get(id);
    if (s === undefined) return id;
    const p = s.project !== undefined ? projectName.get(s.project) : undefined;
    return p !== undefined ? `${s.title} (${p})` : s.title;
  };
  const live = input.streams.filter(open);

  const projects = input.projects
    .filter((p) => p.archived !== true)
    .map((p) => {
      const nodes = live.filter((s) => s.project === p.id);
      const counts = new Map<string, number>();
      for (const s of nodes) counts.set(s.agent.status, (counts.get(s.agent.status) ?? 0) + 1);
      const summary = [...counts].map(([k, n]) => `${n} ${k}`).join(', ') || 'no open nodes';
      return `- ${p.name} [${p.id}] (director: ${p.autonomy.director}): ${summary}`;
    });

  const overlaps = findOverlaps(input.streams).map(
    (o) =>
      `- ${name(o.nodes[0])} and ${name(o.nodes[1])} on ${o.repo}: ${o.files.slice(0, 5).join(', ')}${
        o.files.length > 5 ? ` (+${o.files.length - 5})` : ''
      }`,
  );

  const waits = live.flatMap((s) =>
    (s.waits_on ?? [])
      .filter((w) => w.satisfied_at === undefined)
      .map(
        (w) =>
          `- ${name(s.id)} waits on ${name(w.node)} [${byId.get(w.node)?.agent.status ?? '?'}]`,
      ),
  );

  const stuck = findStuck(input).map(
    (s) => `- ${name(s.node)} [${s.node}]: working, no activity for ${s.idleMinutes} min`,
  );

  const norms = input.knowledge
    .filter((k) => k.status === 'accepted' && k.scope.kind === 'project')
    .map((k) => {
      const scope = formatKnowledgeScope(k.scope);
      const project = k.scope.kind === 'project' ? projectName.get(k.scope.project) : undefined;
      return `- ${project ?? scope} ${k.kind}${k.name !== undefined ? ` "${k.name}"` : ''}: ${k.text.replace(/\s+/g, ' ').slice(0, 160)}`;
    });

  const inbox = input.inbox.map(
    (i) =>
      `- ${i.kind}${i.stream !== undefined ? ` on ${name(i.stream)}` : ''}: ${i.context.replace(/\s+/g, ' ')}`,
  );

  return [
    `## Snapshot (${input.now.toISOString()})`,
    '',
    '### Projects',
    ...capped(projects),
    '',
    '### Overlaps (two live nodes changing the same files)',
    ...capped(overlaps),
    '',
    '### Waits on (open)',
    ...capped(waits),
    '',
    `### Stuck (working, idle over ${Math.round(input.stuckAfterMs / 60_000)} min)`,
    ...capped(stuck),
    '',
    '### Project norms (check work in one project against another’s)',
    ...capped(norms),
    '',
    `### Inbox (${input.inbox.length} waiting on the operator)`,
    ...capped(inbox),
  ].join('\n');
}
