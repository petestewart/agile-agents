/**
 * T419 (D42): Ask — one box that asks a question at the level you choose,
 * as its own thread. About a node, it makes a conversation under that node
 * (the node's own work goes on undisturbed); about the Director, it is a line
 * in the Director's thread. Pure: the components only render.
 */

import type { CockpitProjectRow, CockpitStreamRow } from './feed-types';
import { outline } from './tree';

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
}

/** The Director first, then every node, project by project, in the tree's reading order. */
export function askTargets(
  rows: readonly CockpitStreamRow[],
  projects: readonly CockpitProjectRow[],
): AskTarget[] {
  const out: AskTarget[] = [{ value: DIRECTOR_TARGET, title: 'The Director', depth: 0 }];
  const named = new Set(projects.map((p) => p.id));
  for (const project of projects) {
    for (const { row, depth } of outline(rows.filter((r) => r.project === project.id))) {
      out.push({ value: row.id, title: row.title, project: project.name, role: row.role, depth });
    }
  }
  // Nodes in no known project (an older home) still count.
  for (const { row, depth } of outline(rows.filter((r) => !named.has(r.project ?? '')))) {
    out.push({ value: row.id, title: row.title, role: row.role, depth });
  }
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
