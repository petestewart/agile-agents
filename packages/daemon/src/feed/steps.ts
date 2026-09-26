/**
 * T392: a node's agent steps, for the chat's "what is the agent doing" view.
 *
 * The runner records every ACP tool call as a `tool_call` event in
 * `log/events.jsonl` — `data: {stream, toolCallId, kind, title, status}`,
 * `agent` the session id — and each update to that call (pending →
 * in_progress → completed | failed, sometimes a better title) as another
 * event with the same `toolCallId`. A step is one call as its latest update
 * left it.
 *
 * `StepIndex` keeps every node's steps in memory, so a read never rescans the
 * log: the first read folds in the whole file once, and every later read
 * folds in only the bytes appended since (a partial trailing line waits for
 * its tail, as the feed tailer does). Each node keeps its newest
 * `STEPS_KEPT` steps; `total` still counts every one it ever had.
 */

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

/** One ACP tool call, as its latest update left it. */
export interface AgentStep {
  /** The ACP `toolCallId`. */
  id: string;
  /** The session that made the call. */
  session?: string;
  /** When the call was first seen. */
  ts: string;
  /** The ACP tool kind: read, edit, delete, move, search, execute, think, fetch, switch_mode, other. */
  kind: string;
  title: string;
  /** pending, in_progress, completed or failed. */
  status: string;
}

/** `GET /api/streams/:id/steps`: the newest steps first, and how many the node has had in all. */
export interface StepPage {
  steps: AgentStep[];
  total: number;
}

/** How many steps one read returns. */
export const STEPS_LIMIT = 300;
/** How many steps the index keeps per node. */
export const STEPS_KEPT = 500;
/** The read size while catching up on the log. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Every `tool_call` event line has this (the event's own `kind`, as `JSON.stringify` writes it). */
const TOOL_CALL_MARK = '"kind":"tool_call"';

interface NodeSteps {
  /** Keyed by session and call id, in the order first seen. */
  steps: Map<string, AgentStep>;
  total: number;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

export class StepIndex {
  private offset = 0;
  private carry: Buffer = Buffer.alloc(0);
  private readonly nodes = new Map<string, NodeSteps>();

  constructor(
    /** `<home>/log/events.jsonl`. */
    private readonly path: string,
    private readonly keep: number = STEPS_KEPT,
  ) {}

  /** The node's steps, newest first, at most `limit`. */
  stepsFor(node: string, limit: number = STEPS_LIMIT): StepPage {
    this.catchUp();
    const entry = this.nodes.get(node);
    if (entry === undefined) return { steps: [], total: 0 };
    const all = [...entry.steps.values()];
    const steps = all.slice(Math.max(0, all.length - limit)).reverse();
    return { steps: steps.map((s) => ({ ...s })), total: entry.total };
  }

  /** Folds in whatever the log gained since the last read. */
  catchUp(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size < this.offset) {
      // Truncated or replaced (the log is append-only, so defensive): start over.
      this.offset = 0;
      this.carry = Buffer.alloc(0);
      this.nodes.clear();
    }
    if (size === this.offset) return;
    const fd = openSync(this.path, 'r');
    try {
      while (this.offset < size) {
        const length = Math.min(CHUNK_BYTES, size - this.offset);
        const chunk = Buffer.alloc(length);
        const read = readSync(fd, chunk, 0, length, this.offset);
        if (read <= 0) break;
        this.offset += read;
        const combined = Buffer.concat([this.carry, chunk.subarray(0, read)]);
        const end = combined.lastIndexOf(0x0a) + 1;
        this.carry = combined.subarray(end);
        if (end > 0) this.foldLines(combined.subarray(0, end).toString('utf8'));
      }
    } finally {
      closeSync(fd);
    }
  }

  private foldLines(text: string): void {
    for (const line of text.split('\n')) {
      // Most lines are not tool calls: skip them without parsing.
      if (!line.includes(TOOL_CALL_MARK)) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      this.fold(event);
    }
  }

  /** One `tool_call` event into its node's steps; anything else is ignored. */
  fold(event: unknown): void {
    if (typeof event !== 'object' || event === null) return;
    const e = event as Record<string, unknown>;
    if (e.kind !== 'tool_call') return;
    const data = (typeof e.data === 'object' && e.data !== null ? e.data : {}) as Record<
      string,
      unknown
    >;
    const node = str(e.stream) ?? str(data.stream);
    const id = str(data.toolCallId);
    const ts = str(e.ts);
    if (node === undefined || id === undefined || ts === undefined) return;
    const session = str(e.session) ?? str(e.agent);
    const kind = str(data.kind);
    const title = str(data.title);
    const status = str(data.status);

    let entry = this.nodes.get(node);
    const key = `${session ?? ''}\u0000${id}`;
    const known = entry?.steps.get(key);
    if (known !== undefined) {
      if (kind !== undefined) known.kind = kind;
      if (title !== undefined) known.title = title;
      if (status !== undefined) known.status = status;
      return;
    }
    // An update (no kind, no title) to a call no longer held: nothing to show for it.
    if (kind === undefined && title === undefined) return;
    if (entry === undefined) {
      entry = { steps: new Map(), total: 0 };
      this.nodes.set(node, entry);
    }
    entry.steps.set(key, {
      id,
      ...(session !== undefined ? { session } : {}),
      ts,
      kind: kind ?? 'other',
      title: title ?? '',
      status: status ?? 'pending',
    });
    entry.total += 1;
    // Trim in batches, oldest first (a Map iterates in insertion order).
    if (entry.steps.size > this.keep + Math.ceil(this.keep / 4)) {
      const drop = entry.steps.size - this.keep;
      let n = 0;
      for (const k of entry.steps.keys()) {
        if (n++ >= drop) break;
        entry.steps.delete(k);
      }
    }
  }
}
