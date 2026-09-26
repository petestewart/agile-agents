/**
 * T388: the pure half of the opt-in browser notifications. Which Needs me
 * items are new since the last frame, which of them still wait while you
 * are away, and what one notification says about them — in words, never
 * ids. No DOM, so plain `bun test` covers it; `use-notify.ts` asks the
 * browser and raises the notification.
 *
 *  - Items there at the first frame are never new: you saw them load.
 *  - An item is known by its kind and its record's id, for the whole
 *    session: one that leaves and comes back is not new again.
 *  - Several new items become one notification ("3 new things need you").
 */

import type { InboxItem } from '@agile-agents/shared';
import {
  branchName,
  cardTitle,
  fullText,
  gateView,
  isLandGate,
  knowledgeView,
  noChangesText,
  planView,
  proposalOf,
  questionView,
  statusText,
} from './inbox';

/** Every Needs me notification carries this tag, so a newer one replaces the last instead of stacking. */
export const NOTIFY_TAG = 'agile-needs-me';

/** The test from Settings has its own tag, so it never replaces a real one. */
export const NOTIFY_TEST_TAG = 'agile-test';

/** A notification's title and body are short: the OS clips the rest anyway. */
export const TITLE_MAX_CHARS = 80;
export const BODY_MAX_CHARS = 140;
/** A node's title inside a notification's title. */
const NODE_MAX_CHARS = 56;
/** One headline in a several-items body, so "and 2 more" still fits. */
const HEADLINE_IN_LIST = 56;

// ---------------------------------------------------------------- which items are new

/**
 * An item's identity across frames. The kind is part of it: a node's
 * `blocked` and `done` items share the node's id, and a node that was
 * blocked and is now finished is news. T391: so is its time — a node's
 * `done` item carries the node's id, and its `ts` is when the agent last
 * finished, so a node that finishes again after your reply is news again,
 * while a card that only leaves a frame and comes back is not.
 */
export function itemKey(item: Pick<InboxItem, 'kind' | 'id' | 'ts'>): string {
  return `${item.kind}:${item.id}:${item.ts}`;
}

export interface InboxDiff {
  /** Every item seen this session, the new ones included. */
  seen: Set<string>;
  /** The items in this frame not seen before, in the frame's order. */
  fresh: InboxItem[];
}

/**
 * The items in `items` not seen before. `seen` is `undefined` before the
 * first frame: then everything is seen and nothing is new.
 */
export function diffInbox(
  seen: ReadonlySet<string> | undefined,
  items: readonly InboxItem[],
): InboxDiff {
  const next = new Set(seen ?? []);
  const fresh: InboxItem[] = [];
  for (const item of items) {
    const key = itemKey(item);
    if (next.has(key)) continue;
    next.add(key);
    if (seen !== undefined) fresh.push(item);
  }
  return { seen: next, fresh };
}

/**
 * What arrived while you were away and still waits: the earlier new items
 * that are still in the frame (as the frame has them now), then the fresh
 * ones. An item answered elsewhere in the meantime drops out.
 */
export function stillWaiting(
  pending: readonly InboxItem[],
  fresh: readonly InboxItem[],
  items: readonly InboxItem[],
): InboxItem[] {
  const now = new Map(items.map((item) => [itemKey(item), item]));
  const out: InboxItem[] = [];
  const added = new Set<string>();
  for (const item of [...pending, ...fresh]) {
    const key = itemKey(item);
    const current = now.get(key);
    if (current === undefined || added.has(key)) continue;
    added.add(key);
    out.push(current);
  }
  return out;
}

// ---------------------------------------------------------------- words

/** What the notification may know about a node from the cockpit's rows. */
export interface NodeFacts {
  title?: string;
  /** T380: finished with nothing to merge. */
  nothing_to_merge?: boolean;
}

export type NodeLookup = (id: string) => NodeFacts | undefined;

/** Cuts at a word boundary and adds "…" when the text is longer than `max`. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const hard = text.slice(0, max - 1);
  const space = hard.lastIndexOf(' ');
  const cut = space > max * 0.6 ? hard.slice(0, space) : hard;
  return `${cut.replace(/[\s,;:.—–-]+$/, '')}…`;
}

/**
 * The first line that says something, as plain text: Markdown's headings,
 * bullets, quotes, emphasis, code ticks and link syntax dropped, spaces
 * collapsed. A notification shows no Markdown.
 */
export function plainLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw
      .trim()
      .replace(/^```.*$/, '')
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s*/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*|__|`/g, '')
      .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s.,;:!?)]|$)/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim();
    if (line !== '') return line;
  }
  return '';
}

function nodeTitle(item: InboxItem, lookup: NodeLookup | undefined): string | undefined {
  if (item.stream === undefined) return undefined;
  const title = lookup?.(item.stream)?.title ?? item.stream_path.at(-1);
  return title === undefined || title.trim() === ''
    ? undefined
    : clip(title.trim(), NODE_MAX_CHARS);
}

function noChanges(item: InboxItem, lookup: NodeLookup | undefined): boolean {
  return (
    item.kind === 'done' &&
    item.stream !== undefined &&
    lookup?.(item.stream)?.nothing_to_merge === true
  );
}

/** "raised on a node": `Question on Ledger export`; alone when it has no node. */
function on(what: string, node: string | undefined): string {
  return node === undefined ? what : `${what} on ${node}`;
}

/** "a state of a node": `Ready to merge: Add CSV import`; alone when it has no node. */
function of(what: string, node: string | undefined): string {
  return node === undefined ? what : `${what}: ${node}`;
}

/**
 * One item's headline: what it is and where, in words. `Question on Ledger
 * export format`, `Ready to merge: Add CSV import`, `Action to allow on
 * Checkout`, `Decision proposed on Pricing`, `Knowledge to review`.
 */
export function itemHeadline(item: InboxItem, lookup?: NodeLookup): string {
  const node = nodeTitle(item, lookup);
  switch (item.kind) {
    case 'question':
      return on('Question', node);
    case 'gate':
      return isLandGate(item) ? of('Merge to approve', node) : on('Action to allow', node);
    case 'rule_accept':
      return on(cardTitle(item), node);
    case 'rule_batch':
      return cardTitle(item);
    case 'plan_approve':
      return of('Plan to approve', node);
    case 'plan_waiting':
      return of('Waiting for the plan', node);
    case 'proposal':
      return on(cardTitle(item), node);
    case 'done':
      return of(noChanges(item, lookup) ? 'Finished, no changes' : 'Ready to merge', node);
    case 'blocked':
      return of('Blocked', node);
  }
}

/** One item's body: the first line of what its card says, plain and clipped. */
export function itemLine(item: InboxItem, lookup?: NodeLookup): string {
  let text: string;
  switch (item.kind) {
    case 'question':
      text = plainLine(questionView(item).text);
      break;
    case 'gate': {
      const gate = gateView(item);
      if (gate.land) {
        text =
          gate.branch !== undefined && gate.target !== undefined
            ? `Merge ${branchName(gate.branch)} into ${gate.target}`
            : plainLine(gate.reason);
      } else {
        const action = gate.action !== undefined ? plainLine(gate.action) : '';
        const reason = plainLine(gate.reason);
        text = action !== '' && reason !== '' ? `${action} — ${reason}` : action || reason;
      }
      break;
    }
    case 'rule_accept':
      text = plainLine(knowledgeView(item).text);
      break;
    case 'plan_approve': {
      const plan = planView(item);
      text =
        plan !== undefined && plan.owners.length > 0
          ? plainLine(plan.owners.join('; '))
          : plainLine(fullText(item));
      break;
    }
    case 'proposal':
      text = plainLine(proposalOf(item).summary);
      break;
    case 'done':
      text = plainLine(noChanges(item, lookup) ? noChangesText(item) : statusText(item));
      break;
    case 'blocked':
      text = plainLine(statusText(item));
      break;
    default:
      text = plainLine(fullText(item));
  }
  return clip(text, BODY_MAX_CHARS);
}

export interface NotificationContent {
  title: string;
  body: string;
  tag: string;
  /** The node a click opens; absent opens Needs me (several items, or knowledge on no node). */
  node?: string;
}

/**
 * The one notification for what waits: the item itself when there is one,
 * else a count ("3 new things need you") over the first headlines. A click
 * opens the item's node, or Needs me for several.
 */
export function notificationFor(
  items: readonly InboxItem[],
  lookup?: NodeLookup,
): NotificationContent | undefined {
  const [first] = items;
  if (first === undefined) return undefined;
  if (items.length === 1) {
    return {
      title: clip(itemHeadline(first, lookup), TITLE_MAX_CHARS),
      body: itemLine(first, lookup),
      tag: NOTIFY_TAG,
      ...(first.stream !== undefined ? { node: first.stream } : {}),
    };
  }
  const shown = items.slice(0, 2).map((item) => clip(itemHeadline(item, lookup), HEADLINE_IN_LIST));
  const rest = items.length - shown.length;
  const body = rest > 0 ? `${shown.join(' · ')} · and ${rest} more` : shown.join(' · ');
  return {
    title: `${items.length} new things need you`,
    body: clip(body, BODY_MAX_CHARS),
    tag: NOTIFY_TAG,
  };
}
