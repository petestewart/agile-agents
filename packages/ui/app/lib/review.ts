/**
 * T393: review comments on a node's diff, and the one message they become.
 *
 * You comment on a line (or a run of lines) of the Changes tab; the comments
 * collect per node; "Add to message" turns them into one message in the
 * node's composer. This file is the pure part — anchoring a comment to diff
 * lines, telling when it is outdated, the message format — plus the small
 * in-memory store the comments live in for the browser session.
 *
 * A comment is anchored by row keys, not by row positions: `n42` is line 42
 * of the new side (an added or unchanged line), `o42` line 42 of the old side
 * (a removed line). It also keeps the lines' text as it was written against,
 * so when the diff changes it can tell it is outdated (the lines are gone, or
 * read differently), as GitHub does.
 */

import { THREAD_BODY_MAX_CHARS } from '@agile-agents/shared';
import { useSyncExternalStore } from 'react';
import type { DiffFile, DiffRow } from './chat';

export interface ReviewComment {
  /** Local only (React keys, edit/delete); never in the message. */
  id: string;
  path: string;
  /** The first and last line it covers, as row keys (`rowKey`); equal for one line. */
  start: string;
  end: string;
  /** The covered lines' text when it was written, without the diff marker. */
  quote: string[];
  /** Where it points: `12` or `12–14`, and whether those are removed lines (old side). */
  lines: string;
  removed: boolean;
  body: string;
}

/** A comment's anchor key for a diff row; hunk headers and notes have none. */
export function rowKey(row: DiffRow): string | undefined {
  if (row.kind === 'del') return row.old === undefined ? undefined : `o${row.old}`;
  if (row.kind === 'add' || row.kind === 'ctx') {
    return row.new === undefined ? undefined : `n${row.new}`;
  }
  return undefined;
}

/** A row's text without its `+`/`-`/space marker. */
export function lineText(row: DiffRow): string {
  return row.text.slice(1);
}

function indexOfKey(file: DiffFile, key: string): number {
  return file.rows.findIndex((row) => rowKey(row) === key);
}

/**
 * The lines from `start` to `end` (either order), or undefined when either is
 * no longer in the file's diff or a hunk header sits between them (a range
 * stays inside one hunk).
 */
export function rowsBetween(file: DiffFile, start: string, end: string): DiffRow[] | undefined {
  const a = indexOfKey(file, start);
  const b = indexOfKey(file, end);
  if (a < 0 || b < 0) return undefined;
  const rows = file.rows.slice(Math.min(a, b), Math.max(a, b) + 1);
  if (rows.some((row) => row.kind === 'hunk')) return undefined;
  return rows.filter((row) => rowKey(row) !== undefined);
}

/** `12` / `12–14` on the new side; only a run of removed lines counts on the old side. */
export function lineRef(rows: readonly DiffRow[]): { lines: string; removed: boolean } {
  const kept = rows.filter((r) => r.kind !== 'del' && r.new !== undefined).map((r) => r.new);
  const removed = kept.length === 0;
  const nums = (removed ? rows.map((r) => r.old) : kept).filter(
    (n): n is number => n !== undefined,
  );
  if (nums.length === 0) return { lines: '', removed };
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  return { lines: lo === hi ? `${lo}` : `${lo}–${hi}`, removed };
}

/** "Line 12", "Lines 12–14", "Removed line 12": the comment's header. */
export function lineLabel(c: Pick<ReviewComment, 'lines' | 'removed'>): string {
  const plural = c.lines.includes('–');
  const word = plural ? 'lines' : 'line';
  return c.removed ? `Removed ${word} ${c.lines}` : `${plural ? 'Lines' : 'Line'} ${c.lines}`;
}

/** A new comment on the lines from `start` to `end` of `file`, or undefined if they aren't there. */
export function newComment(
  file: DiffFile,
  start: string,
  end: string,
  body: string,
  id: string,
): ReviewComment | undefined {
  const rows = rowsBetween(file, start, end);
  if (!rows || rows.length === 0) return undefined;
  const first = rowKey(rows[0] as DiffRow) as string;
  const last = rowKey(rows[rows.length - 1] as DiffRow) as string;
  return {
    id,
    path: file.path,
    start: first,
    end: last,
    quote: rows.map(lineText),
    ...lineRef(rows),
    body: body.trim(),
  };
}

/** The lines it was written on are gone from the diff, or read differently now. */
export function isOutdated(c: ReviewComment, files: readonly DiffFile[]): boolean {
  const file = files.find((f) => f.path === c.path);
  if (!file) return true;
  const rows = rowsBetween(file, c.start, c.end);
  if (!rows) return true;
  const now = rows.map(lineText);
  return now.length !== c.quote.length || now.some((text, i) => text !== c.quote[i]);
}

/** "1 comment on 1 file", "3 comments on 2 files". */
export function reviewSummary(comments: readonly ReviewComment[]): string {
  const files = new Set(comments.map((c) => c.path)).size;
  const n = comments.length;
  return `${n} comment${n === 1 ? '' : 's'} on ${files} file${files === 1 ? '' : 's'}`;
}

/**
 * Comments in reading order: by file in the diff's order (files no longer in
 * the diff last), then by where their first line sits in the file.
 */
export function orderComments(
  comments: readonly ReviewComment[],
  files: readonly DiffFile[],
): ReviewComment[] {
  const fileIndex = (c: ReviewComment): number => {
    const i = files.findIndex((f) => f.path === c.path);
    return i < 0 ? files.length : i;
  };
  const rowIndex = (c: ReviewComment): number => {
    const file = files.find((f) => f.path === c.path);
    const i = file ? indexOfKey(file, c.start) : -1;
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return comments
    .map((c, order) => ({ c, order, file: fileIndex(c), row: rowIndex(c) }))
    .sort((a, b) => a.file - b.file || a.row - b.row || a.order - b.order)
    .map((x) => x.c);
}

// ---------------------------------------------------------------- the message

export const REVIEW_HEADING = 'Review of the changes:';

/** How long a quoted line may be before it is clipped with "…". */
export const QUOTE_MAX = 80;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Markdown inline code for any text: a fence one backtick longer than any run inside it. */
export function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Up to three lines quote themselves; a longer run quotes its first and last line. */
function quoteLines(quote: readonly string[], max: number): string[] {
  const lines = quote.map((l) => l.trim()).filter((l) => l !== '');
  const shown = lines.length <= 3 ? lines : [lines[0] as string, '…', lines.at(-1) as string];
  return shown.map((l) => (l === '…' ? l : codeSpan(clip(l, max))));
}

function formatWith(
  ordered: readonly ReviewComment[],
  files: readonly DiffFile[],
  quoteMax: number | undefined,
): string {
  const items = ordered.map((c, i) => {
    const notes = [c.removed ? ' (removed)' : '', isOutdated(c, files) ? ' (outdated)' : ''];
    const head = `${i + 1}. ${codeSpan(`${c.path}:${c.lines}`)}${notes.join('')}`;
    const quote = quoteMax === undefined ? [] : quoteLines(c.quote, quoteMax);
    const body = c.body
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '');
    return [head, ...[...quote, ...body].map((l) => `   ${l}`)].join('\n');
  });
  return [REVIEW_HEADING, '', ...items].join('\n');
}

/**
 * The review as one message: a heading, then one numbered item per comment
 * in reading order — `path:line`, the line quoted as code, the comment.
 *
 * It fits in `max` characters (a thread line's cap by default) by clipping
 * the quotes shorter, then leaving them out (the path and line still point
 * at them); `fits` is false only when even that is too long.
 */
export function formatReview(
  comments: readonly ReviewComment[],
  files: readonly DiffFile[],
  max: number = THREAD_BODY_MAX_CHARS,
): { text: string; fits: boolean } {
  const ordered = orderComments(comments, files);
  let text = '';
  for (const quoteMax of [QUOTE_MAX, 40, undefined]) {
    text = formatWith(ordered, files, quoteMax);
    if (text.length <= max) return { text, fits: true };
  }
  return { text, fits: false };
}

// ---------------------------------------------------------------- the draft

/** A thread line's cap: what the review and the draft share. */
export const MESSAGE_MAX = THREAD_BODY_MAX_CHARS;

/** The review after whatever is already in the composer, a blank line between. */
export function appendToDraft(draft: string, text: string): string {
  const before = draft.trimEnd();
  return before === '' ? text : `${before}\n\n${text}`;
}

/** How many characters a review may take once appended to `draft`. */
export function roomAfter(draft: string): number {
  const before = draft.trimEnd();
  return MESSAGE_MAX - (before === '' ? 0 : before.length + 2);
}

// ---------------------------------------------------------------- the store

/** A comment being written or edited, and where: kept with the comments so a tab switch keeps it. */
export interface ReviewDraft {
  path: string;
  start: string;
  end: string;
  text: string;
  /** Editing this comment rather than writing a new one. */
  editing?: string;
}

export interface NodeReview {
  comments: readonly ReviewComment[];
  draft?: ReviewDraft;
}

const EMPTY: NodeReview = { comments: [] };

/**
 * Review comments per node, for this browser session (in memory: they
 * outlive tab and node switches, not a reload). Subscribable, so the
 * Changes tab and its count in the tab bar read the same thing.
 */
export class ReviewStore {
  private byNode = new Map<string, NodeReview>();
  private listeners = new Set<() => void>();
  private seq = 0;

  get(node: string): NodeReview {
    return this.byNode.get(node) ?? EMPTY;
  }

  set(node: string, next: NodeReview): void {
    if (next.comments.length === 0 && next.draft === undefined) this.byNode.delete(node);
    else this.byNode.set(node, next);
    for (const fn of this.listeners) fn();
  }

  update(node: string, fn: (review: NodeReview) => NodeReview): void {
    this.set(node, fn(this.get(node)));
  }

  /** A fresh local id for a comment. */
  nextId(): string {
    this.seq += 1;
    return `c${this.seq}`;
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
}

export const reviews = new ReviewStore();

/** A node's review comments and open draft, re-rendering on change. */
export function useReview(node: string): NodeReview {
  return useSyncExternalStore(
    reviews.subscribe,
    () => reviews.get(node),
    () => reviews.get(node),
  );
}
