/**
 * T368: the Director page's words (design/cockpit-ui.md §2, projects-design
 * §12): its session in a line, what a held draft is and what its button
 * says, a draft tree's parts with their waits resolved to titles, and the
 * autonomy levels in words. Pure: no DOM, covered by `bun test`.
 */

import type { Autonomy, AutonomyProposal, DraftTreeFields } from '@agile-agents/shared';
import { modelLabel } from './chat';

export interface DirectorSessionLike {
  status: string;
  vendor: string;
  model?: string;
}

export interface DirectorState {
  /** The header's line: "Claude Opus 5.5 · Working", or how the next message starts it. */
  text: string;
  /** A turn is in flight: the chat shows "Director is working". */
  working: boolean;
  /** An agent is attached (working, or waiting for you). */
  live: boolean;
}

export function directorState(
  session: DirectorSessionLike | undefined,
  live: boolean,
): DirectorState {
  if (session === undefined) {
    return { text: 'Not started — your first message starts it.', working: false, live: false };
  }
  const model = modelLabel(session.vendor, session.model);
  const working = live && (session.status === 'running' || session.status === 'starting');
  if (working) return { text: `${model} · Working`, working, live };
  if (live) return { text: `${model} · Ready`, working, live };
  if (session.status === 'error') {
    return { text: `${model} · Stopped with an error`, working, live };
  }
  return { text: `${model} · Asleep — a message or an event wakes it`, working, live };
}

/** What Send does, under the composer. */
export function directorHint(state: DirectorState): string {
  if (state.working) return 'Queued: the Director reads it when this turn ends.';
  if (state.live) return 'Goes to the Director now.';
  return 'Wakes the Director with your message.';
}

type Change = AutonomyProposal['change'];

/** A held change's primary button: what pressing it does. */
export function draftActionLabel(change: Pick<Change, 'action'>): string {
  if (change.action.startsWith('create_')) return 'Create';
  if (change.action === 'start_node') return 'Start';
  if (change.action === 'restart_node') return 'Restart';
  return 'Apply';
}

/**
 * The card's heading: "New work in Blog", "New project Shop", "Start
 * Changelog". Ids read as names through the lookups; a node the cockpit
 * no longer knows reads as "a node".
 */
export function draftHeading(
  change: Change,
  projectName: (id: string) => string | undefined,
  nodeTitle: (id: string) => string | undefined,
): string {
  switch (change.action) {
    case 'create_tree': {
      const where = change.tree.new_project ?? projectName(change.tree.project ?? '');
      return where ? `New work in ${where}` : 'New work';
    }
    case 'create_project':
      return `New project ${change.name}`;
    case 'create_node':
      return `New node ${change.node.title}`;
    case 'start_node':
      return `Start ${nodeTitle(change.node) ?? 'a node'}`;
    case 'restart_node':
      return `Restart ${nodeTitle(change.node) ?? 'a node'}`;
    case 'add_child':
      return `New part ${change.title}`;
    case 'add_waits_on':
      return `${nodeTitle(change.child) ?? 'A node'} waits on ${nodeTitle(change.on) ?? 'a node'}`;
    case 'approve_contract':
      return `Contract ${change.title}`;
    case 'set_owner':
      return `Ownership for ${nodeTitle(change.child) ?? 'a node'}`;
  }
}

export interface DraftPart {
  title: string;
  goal: string;
  repo?: string;
  /** The titles of the parts it waits on. */
  waitsOn: string[];
}

/** A draft tree's parts, their `after` indexes resolved to the other parts' titles. */
export function draftParts(tree: Pick<DraftTreeFields, 'parts'>): DraftPart[] {
  return tree.parts.map((part) => ({
    title: part.title,
    goal: part.goal,
    ...(part.repo !== undefined ? { repo: part.repo } : {}),
    waitsOn: (part.after ?? []).map((i) => tree.parts[i]?.title ?? `part ${i + 1}`),
  }));
}

/** The Director's autonomy per project, in words (projects-design §12). */
export const DIRECTOR_AUTONOMY: Record<Autonomy, { label: string; hint: string }> = {
  advise: { label: 'Advise', hint: 'Drafts work; you press Create.' },
  organise: { label: 'Organise', hint: 'Creates and starts work itself, and tells you.' },
  run: { label: 'Run', hint: 'Also approves routine contract changes and restarts stuck work.' },
};
