/**
 * T416: errors in words (design/cockpit-ui.md §7 "Errors"): what a refused
 * merge or a failed send says, where it says it, and the fix it names as a
 * button. Pure, so plain `bun test` covers it; the card (`DecisionCard.tsx`)
 * and the node page (`StreamPage.tsx`) only render what this returns.
 */

import { tidyIds } from './chat';

/** What a write button's tooltip says while the daemon is away (`offline` in the feed). */
export const RECONNECTING = 'Reconnecting to the daemon…';

/** A failed send while the daemon is away: the draft stays, Retry sends it. */
export const SEND_UNREACHABLE = 'Couldn’t reach the daemon; your message wasn’t sent.';

/**
 * A `fetch` that never reached the daemon: Chrome's "Failed to fetch",
 * Firefox's "NetworkError when attempting to fetch resource.", Safari's
 * "Load failed", Bun's "fetch failed" — a `TypeError`, never an HTTP reply.
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && isNetworkMessage(err.message);
}

/** The same, for a message already turned into text (the Delivery hook keeps only that). */
export function isNetworkMessage(message: string): boolean {
  return /^(?:failed to fetch|networkerror\b.*|load failed|fetch failed|network request failed)\.?$/i.test(
    message.trim(),
  );
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/** A sentence ends with a stop: "main moved; rebase the branch first" → "…first." */
function sentence(text: string): string {
  const trimmed = capitalise(text.trim());
  return trimmed === '' || /[.!?…:)]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What a failed write says: the daemon's reason as a sentence, or that it wasn't reached. */
export function writeFailure(err: unknown, unreachable = SEND_UNREACHABLE): string {
  if (isNetworkError(err)) return unreachable;
  return sentence(err instanceof Error ? err.message : String(err));
}

/** The one thing a refused merge's reason says will fix it, as a button. */
export type MergeFix =
  /** The target moved on: the agent brings its branch up to date (a prepared message). */
  | { kind: 'rebase'; label: string; message: string }
  /** The merge conflicts: the agent merges the target in and fixes it (a prepared message). */
  | { kind: 'conflicts'; label: string; message: string }
  /** An agent is still live on the node: stop it, then merge. */
  | { kind: 'stop'; label: string };

export interface MergeRefusal {
  /** The reason in words: no "merge refused:" prefix, a capital, a stop. */
  text: string;
  fix?: MergeFix;
}

/** The daemon's own lead-ins, which the UI's "Couldn't merge" already says. */
const LEAD_IN = /^\s*(?:(?:merge|land(?:ing)?|delivery)\s+)?refused\s*[:—-]\s*/i;

/** Strips every leading "merge refused:" (the daemon's line, maybe wrapped more than once). */
export function stripRefusal(raw: string): string {
  let text = raw.trim();
  for (;;) {
    const next = text.replace(LEAD_IN, '');
    if (next === text) return text;
    text = next;
  }
}

/** "main moved", "behind main", "rebase", "out of date": the branch needs the target's new commits. */
const BEHIND = /\brebase\b|\bmoved\b|\bbehind\b|out of date|not up to date|update the branch/i;
/** "still has a live agent; stop it or let it finish before merging". */
const LIVE_AGENT = /still has a live agent|stop (?:it|the agent) (?:or|and|first)/i;

/** The prepared message for "Ask the agent to rebase": what moved, and what to do. */
export function rebaseMessage(target: string, reason: string): string {
  return [
    `The merge into ${target} was refused: ${reason}`,
    `Bring your branch up to date with ${target} (merge or rebase it in), fix anything that breaks, run the tests and commit. Tell me when it is ready to merge again.`,
  ].join('\n\n');
}

/** The prepared message for "Ask the agent to fix the conflicts": which files, and what to do. */
export function conflictMessage(target: string, files: readonly string[]): string {
  const list = files.length > 0 ? `: ${files.map((f) => `\`${f}\``).join(', ')}` : '';
  return [
    `Merging into ${target} conflicts${list}.`,
    `Merge ${target} into your branch, resolve the conflicts, run the tests and commit. Tell me when it is ready to merge again.`,
  ].join('\n\n');
}

/**
 * A refused merge in words, and the fix it names when one is clear
 * (design/cockpit-ui.md §7: "A refused action names the reason and, if
 * there is one, the fix"). `target` is the branch it merges into.
 */
export function mergeRefusal(raw: string, target = 'main'): MergeRefusal {
  // T413's rule: a node branch by its name, no ids, in primary text.
  const text = sentence(tidyIds(stripRefusal(raw)));
  if (LIVE_AGENT.test(text)) {
    return { text, fix: { kind: 'stop', label: 'Stop the agent' } };
  }
  if (BEHIND.test(text)) {
    return {
      text,
      fix: {
        kind: 'rebase',
        label: 'Ask the agent to rebase',
        message: rebaseMessage(target, text),
      },
    };
  }
  return { text };
}

/** A merge that conflicts (`blocked`): in words, with "Ask the agent to fix the conflicts". */
export function mergeConflict(target: string, files: readonly string[]): MergeRefusal {
  const n = files.length;
  return {
    text: `Merging into ${target} conflicts in ${n} ${n === 1 ? 'file' : 'files'}.`,
    fix: {
      kind: 'conflicts',
      label: 'Ask the agent to fix the conflicts',
      message: conflictMessage(target, files),
    },
  };
}
