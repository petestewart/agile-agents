/**
 * T419 (D42): Ask — one box that asks a question at the level you choose,
 * as its own thread. About a node, it makes a conversation under that node
 * (the node's own work goes on undisturbed); about the Director, it is a line
 * in the Director's thread. Pure: the components only render.
 *
 * T435: and the flows out of a conversation — where Turn into work puts the
 * work under a work node, and whether a parent still takes a Send to.
 */

import type { CockpitProjectRow, CockpitStreamRow } from './feed-types';
import { outline, titleFromGoal } from './tree';

/** What Ask can be about: `'director'`, or a node's id. */
export const DIRECTOR_TARGET = 'director';

export interface AskTarget {
  value: string;
  /** "The Director", or the node's title. */
  title: string;
  /** The node's project, for the picker's groups. */
  project?: string;
  role?: CockpitStreamRow['role'];
  depth: number;
  /** T435: the node's row, for its status dot (absent for the Director). */
  row?: CockpitStreamRow;
}

/** T435: merged or closed — nothing there acts on a question or a line any more. */
export function isFinished(row: Pick<CockpitStreamRow, 'human_status'>): boolean {
  return row.human_status === 'landed' || row.human_status === 'closed';
}

/**
 * One group's nodes in the tree's reading order, T435: the open ones first
 * (indented by their open ancestors only), then the merged and closed ones,
 * flat.
 */
function readingOrder(rows: readonly CockpitStreamRow[], project: string | undefined): AskTarget[] {
  const ordered = outline(rows);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const openDepth = (row: CockpitStreamRow): number => {
    let depth = 0;
    const seen = new Set<string>([row.id]);
    for (let at = row.parent; at !== undefined && !seen.has(at); ) {
      seen.add(at);
      const up = byId.get(at);
      if (up === undefined) break;
      if (!isFinished(up)) depth++;
      at = up.parent;
    }
    return depth;
  };
  const target = (row: CockpitStreamRow, depth: number): AskTarget => ({
    value: row.id,
    title: row.title,
    ...(project !== undefined ? { project } : {}),
    role: row.role,
    depth,
    row,
  });
  return [
    ...ordered.filter(({ row }) => !isFinished(row)).map(({ row }) => target(row, openDepth(row))),
    ...ordered.filter(({ row }) => isFinished(row)).map(({ row }) => target(row, 0)),
  ];
}

/**
 * The Director first, then every node, project by project, in the tree's
 * reading order; T435: each project's merged and closed nodes last.
 */
export function askTargets(
  rows: readonly CockpitStreamRow[],
  projects: readonly CockpitProjectRow[],
): AskTarget[] {
  const out: AskTarget[] = [{ value: DIRECTOR_TARGET, title: 'The Director', depth: 0 }];
  const named = new Set(projects.map((p) => p.id));
  for (const project of projects) {
    out.push(
      ...readingOrder(
        rows.filter((r) => r.project === project.id),
        project.name,
      ),
    );
  }
  // Nodes in no known project (an older home) still count.
  out.push(
    ...readingOrder(
      rows.filter((r) => !named.has(r.project ?? '')),
      undefined,
    ),
  );
  return out;
}

/** The line under Ask's box: where the question goes, and what it leaves alone. */
export function askHint(target: AskTarget | undefined): string {
  if (target === undefined || target.value === DIRECTOR_TARGET) {
    return 'Goes to the Director’s thread. It sees every project, and can draft work from what you decide.';
  }
  if (target.role === 'project') {
    return `A conversation under ${target.title}: its own thread, with the project in view.`;
  }
  return `A conversation under ${target.title}: its own thread, so ${target.title}’s work goes on undisturbed.`;
}

// ---------------------------------------------------------------- T435: out of a conversation

/**
 * T435 (audit r6 #19): the node a conversation's Send to goes to — its
 * parent, while that is open. A merged or closed parent has no agent to act
 * on it, so the action isn't offered.
 */
export function sendUpTarget<R extends Pick<CockpitStreamRow, 'id' | 'human_status'>>(
  conversation: { role: CockpitStreamRow['role'] | undefined; parent?: string | undefined },
  rows: readonly R[],
): R | undefined {
  if (conversation.role !== 'conversation' || conversation.parent === undefined) return undefined;
  const parent = rows.find((r) => r.id === conversation.parent);
  return parent !== undefined && !isFinished(parent) ? parent : undefined;
}

/** T435 (audit r6 #3): where Turn into work puts the work, when the conversation sits under work. */
export type TurnWhere = 'next-to' | 'under';

/**
 * T435: what a new child with a repository does to its parent — a work
 * node becomes a coordinator (its agent restarts as one); anything else
 * takes it as it is. `undefined` when nothing changes.
 */
export function coordinatesIt(
  parent: Pick<CockpitStreamRow, 'title' | 'role'> | undefined,
): string | undefined {
  return parent?.role === 'work'
    ? `${parent.title} will coordinate it; its agent restarts as a coordinator.`
    : undefined;
}

/**
 * T435 (audit r6 #16): a conversation that has answered, so its header
 * offers what follows (Turn into work…, Send to <parent>) rather than
 * Restart agent, which would only ask its question again.
 */
export function hasReplied(
  role: CockpitStreamRow['role'] | undefined,
  thread: readonly { by: string; kind: string }[],
): boolean {
  return (
    role === 'conversation' && thread.some((e) => e.kind === 'line' && e.by.startsWith('agent:'))
  );
}

/**
 * T435 (audit r6 #27): a conversation turned into work keeps a title you
 * gave it; one that is still its question is renamed from the new goal —
 * the question as asked, the placeholder Ask cut from it, or any title that
 * asks (the cheap model names a question as one: "Does import handle Excel
 * files?"), which never names work.
 */
export function keepsTitle(title: string, question: string): boolean {
  const t = title.trim();
  if (/\?\s*$/.test(t)) return false;
  return t !== question.trim() && t !== titleFromGoal(question).trim();
}

// ---------------------------------------------------------------- T435: focus after Ask

let focusOnArrival: string | undefined;

/** T435 (audit r6 #20): Ask opened this node; its composer takes focus once it shows. */
export function focusComposerOn(id: string): void {
  focusOnArrival = id;
}

/** True once for the node Ask just opened (the page then focuses its composer). */
export function takeComposerFocus(id: string): boolean {
  if (focusOnArrival !== id) return false;
  focusOnArrival = undefined;
  return true;
}
