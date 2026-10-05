/**
 * T392: what the agent is doing, step by step — the pure half.
 *
 * A step is one ACP tool call (`GET /api/streams/:id/steps`, then the live
 * `tool_call` events). While a turn runs, the chat shows its latest steps;
 * afterwards each agent reply carries the steps that led to it, folded to
 * one quiet row. Here: merging live events into the list, grouping steps by
 * the reply they belong to, and how a step reads (icon, title, status).
 * No DOM, so plain `bun test` covers it; `Chat.tsx` only renders.
 */

import type { Event, ThreadEntry } from '@agile-agents/shared';
import type { IconName } from '../components/Icon';
import { chatVariant } from './chat';
import type { AgentStep, StepPage } from './feed-types';

export type { AgentStep, StepPage };

/** How many steps the chat keeps for one node (the daemon sends up to 300). */
export const STEPS_MAX = 500;

// ---------------------------------------------------------------- merging

/**
 * A step's change as one `tool_call` event carries it: the first has kind,
 * title and status; later ones often only the new status.
 */
export interface StepUpdate {
  id: string;
  session?: string;
  ts: string;
  kind?: string;
  title?: string;
  status?: string;
}

/** Calls are unique per session, not across sessions. */
export function stepKey(step: { id: string; session?: string }): string {
  return `${step.session ?? ''}\u0000${step.id}`;
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

/** A live `/ws` event as a change to one of `node`'s steps, or `undefined`. */
export function stepUpdateOf(event: Event, node: string): StepUpdate | undefined {
  if (event.kind !== 'tool_call') return undefined;
  const data = event.data ?? {};
  if ((event.stream ?? text(data.stream)) !== node) return undefined;
  const id = text(data.toolCallId);
  if (id === undefined) return undefined;
  const session = event.session ?? event.agent;
  const kind = text(data.kind);
  const title = text(data.title);
  const status = text(data.status);
  return {
    id,
    ts: event.ts,
    ...(session !== undefined ? { session } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
  };
}

/** A call's status only moves forward: an event read late never undoes a newer read. */
function statusRank(status: string): number {
  if (status === 'pending') return 0;
  if (status === 'in_progress') return 1;
  return 2;
}

/**
 * `steps` (oldest first) with one update folded in. An unknown call is
 * added; an update to a call the list doesn't hold (no kind, no title) is
 * dropped. Returns the same array when nothing changed.
 */
export function applyStep(
  steps: readonly AgentStep[],
  update: StepUpdate,
  max: number = STEPS_MAX,
): AgentStep[] {
  const key = stepKey(update);
  const at = steps.findIndex((s) => stepKey(s) === key);
  if (at >= 0) {
    const old = steps[at] as AgentStep;
    const status =
      update.status !== undefined && statusRank(update.status) >= statusRank(old.status)
        ? update.status
        : old.status;
    const next: AgentStep = {
      ...old,
      kind: update.kind ?? old.kind,
      title: update.title ?? old.title,
      status,
    };
    if (next.kind === old.kind && next.title === old.title && next.status === old.status) {
      return steps as AgentStep[];
    }
    const out = steps.slice();
    out[at] = next;
    return out;
  }
  if (update.kind === undefined && update.title === undefined) return steps as AgentStep[];
  const added: AgentStep = {
    id: update.id,
    ...(update.session !== undefined ? { session: update.session } : {}),
    ts: update.ts,
    kind: update.kind ?? 'other',
    title: update.title ?? '',
    status: update.status ?? 'pending',
  };
  const out = [...steps, added];
  return out.length > max ? out.slice(out.length - max) : out;
}

/** The route's page (newest first) as the chat's list (oldest first), with events read meanwhile. */
export function stepsFromPage(page: StepPage, pending: readonly StepUpdate[] = []): AgentStep[] {
  let steps = page.steps.slice().reverse();
  for (const update of pending) steps = applyStep(steps, update);
  return steps;
}

// ---------------------------------------------------------------- grouping into turns

type Anchorable = Pick<ThreadEntry, 'ts' | 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>;

export interface StepGroups {
  /** The steps shown before a thread entry (its index in the list given): the work that led to it. */
  before: Map<number, AgentStep[]>;
  /** The steps after the last reply: the running turn's, or a turn that ended without one. */
  current: AgentStep[];
}

export interface GroupStepsOptions {
  /**
   * A turn is running. Its steps run from the agent's last reply, so a line
   * you sent mid-turn doesn't cut the live list in two.
   */
  live?: boolean;
  /** The thread starts part-way (older lines left out): steps before its first line are dropped. */
  truncated?: boolean;
  /**
   * The steps are the newest of more (the daemon caps them). The finished
   * turn holding the oldest may be missing some, so it shows none rather
   * than a wrong count.
   */
  partial?: boolean;
  /**
   * T509: the agent's narration folded into its turn's reply
   * (`narrationFolds`): those lines are no reply of their own, so the steps
   * around them belong to the reply they fold into.
   */
  folded?: ReadonlyMap<number, number>;
}

/**
 * Each step belongs to the reply that follows it in time: the next agent
 * line, or your next line when a turn ended without one (you stopped it).
 * A step and a reply stamped the same millisecond: the reply came first (the
 * runner writes an agent's words before the tool call that ends them).
 */
export function groupSteps(
  steps: readonly AgentStep[],
  entries: readonly Anchorable[],
  options: GroupStepsOptions = {},
): StepGroups {
  const before = new Map<number, AgentStep[]>();
  const current: AgentStep[] = [];
  const from = options.truncated ? entries[0]?.ts : undefined;
  const sorted = steps
    .filter((s) => from === undefined || s.ts >= from)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (sorted.length === 0) return { before, current };

  const anchors: { index: number; ts: string; agent: boolean }[] = [];
  entries.forEach((entry, index) => {
    const variant = chatVariant(entry);
    if (options.folded?.has(index)) return;
    if (variant === 'agent' || variant === 'you') {
      anchors.push({ index, ts: entry.ts, agent: variant === 'agent' });
    }
  });
  const lastAgent = [...anchors].reverse().find((a) => a.agent)?.ts;

  let next = 0;
  for (const step of sorted) {
    while (next < anchors.length && (anchors[next] as { ts: string }).ts <= step.ts) next += 1;
    const anchor = anchors[next];
    const running = options.live && (lastAgent === undefined || step.ts >= lastAgent);
    if (anchor === undefined || running) {
      current.push(step);
      continue;
    }
    const group = before.get(anchor.index);
    if (group) group.push(step);
    else before.set(anchor.index, [step]);
  }

  if (options.partial) {
    const oldest = sorted[0] as AgentStep;
    for (const [index, group] of before) {
      if (group.includes(oldest)) before.delete(index);
    }
  }
  return { before, current };
}

// ---------------------------------------------------------------- T509: narration

/** The daemon's line for a finished turn whose session stays (T465), as `lib/chat.ts` reads it. */
const TURN_FINISHED = 'turn finished';

/** A daemon line that ends an agent's turn: its session ended, or its turn finished (T465). */
function endsTurn(entry: Anchorable): boolean {
  return (
    entry.by === 'daemon' &&
    entry.kind === 'event' &&
    (entry.body === TURN_FINISHED ||
      entry.body.startsWith('session ended: ') ||
      /^\w+ (?:attached|detached by human)\b/.test(entry.body))
  );
}

export interface NarrationOptions {
  /** Whether the chat's main flow shows entry `index` (a line nested in a thread doesn't). */
  shown?: (index: number) => boolean;
  /** An entry that stays where it is (a thread is anchored to it). */
  keep?: (index: number) => boolean;
}

/**
 * T509: what the agent says between its steps ("Let me ask the operator
 * for approval:") is narration, not its reply. Within one turn of one
 * session (from your line, or a turn's end, to the next) only the last of
 * the agent's messages reads as the reply; each plain message before it
 * (`kind: 'line'`) folds into that reply's steps. A question, a proposal or
 * any other kind is never folded, nor is a daemon or system line. A turn
 * with one message is unchanged. Display only: nothing stored changes.
 * Returns each folded line's index and the index of the reply it folds into.
 *
 * A turn is told from the thread: your lines (and answers), the daemon's
 * "turn finished" and "session ended" lines, and a session starting or
 * stopping bound it. A turn that waited on a held call or a routed event
 * and went on with no such line reads as one.
 */
export function narrationFolds(
  entries: readonly Anchorable[],
  options: NarrationOptions = {},
): Map<number, number> {
  const folds = new Map<number, number>();
  let author: string | undefined;
  let turn: number[] = [];
  const close = (): void => {
    const reply = turn.at(-1);
    if (reply !== undefined) {
      for (const index of turn.slice(0, -1)) {
        if (entries[index]?.kind === 'line' && options.keep?.(index) !== true) {
          folds.set(index, reply);
        }
      }
    }
    author = undefined;
    turn = [];
  };
  entries.forEach((entry, index) => {
    if (options.shown !== undefined && !options.shown(index)) return;
    const variant = chatVariant(entry);
    if (variant === 'you' || endsTurn(entry)) {
      close();
      return;
    }
    if (variant !== 'agent' || !entry.by.startsWith('agent:')) return;
    if (author !== entry.by) close();
    author = entry.by;
    turn.push(index);
  });
  close();
  return folds;
}

/** T509: a reply's folded row, in order: its steps and the narration between them. */
export type FoldItem<E> = { step: AgentStep } | { note: E };

/**
 * The steps and the folded lines of one reply, oldest first. A line and a
 * step stamped the same millisecond: the line first (the runner writes an
 * agent's words before the tool call that ends them).
 */
export function foldItems<E extends { ts: string }>(
  steps: readonly AgentStep[],
  notes: readonly E[],
): FoldItem<E>[] {
  const out: FoldItem<E>[] = [];
  let s = 0;
  let n = 0;
  while (s < steps.length || n < notes.length) {
    const step = steps[s];
    const note = notes[n];
    if (note !== undefined && (step === undefined || note.ts <= step.ts)) {
      out.push({ note });
      n += 1;
    } else if (step !== undefined) {
      out.push({ step });
      s += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------- how a step reads

/** What a step shows as, from its status and whether its turn still runs. */
export type StepState = 'running' | 'done' | 'failed' | 'stopped';

export function stepState(status: string, live: boolean): StepState {
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return live ? 'running' : 'stopped';
  return 'done';
}

export const STEP_STATE_LABEL: Record<StepState, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Didn’t finish',
};

/**
 * "Worked through 12 steps", and how many failed. T509: a fold that holds
 * only the agent's earlier messages (no steps) reads "1 earlier message".
 */
export function stepsSummary(
  steps: readonly Pick<AgentStep, 'status'>[],
  notes = 0,
): {
  label: string;
  failed: number;
} {
  const n = steps.length;
  return {
    label:
      n === 0 && notes > 0
        ? `${notes} earlier ${notes === 1 ? 'message' : 'messages'}`
        : `Worked through ${n} ${n === 1 ? 'step' : 'steps'}`,
    failed: steps.filter((s) => s.status === 'failed').length,
  };
}

/** How many steps the live list shows before "+N earlier steps". */
export const LIVE_STEPS = 5;

/**
 * The live list's window: the newest `size` steps and how many are hidden
 * above. Never hides a single step behind a "+1" row.
 */
export function liveWindow<T>(
  steps: readonly T[],
  expanded: boolean,
  size: number = LIVE_STEPS,
): { shown: T[]; earlier: number } {
  if (expanded || steps.length <= size + 1) return { shown: steps.slice(), earlier: 0 };
  return { shown: steps.slice(steps.length - size), earlier: steps.length - size };
}

interface KindInfo {
  icon: IconName;
  /** The title when the call has none. */
  empty: string;
}

const KINDS: Record<string, KindInfo> = {
  read: { icon: 'file-text', empty: 'Read a file' },
  edit: { icon: 'pencil', empty: 'Edit a file' },
  delete: { icon: 'trash', empty: 'Delete a file' },
  move: { icon: 'arrow-right', empty: 'Move a file' },
  search: { icon: 'search', empty: 'Search' },
  execute: { icon: 'terminal', empty: 'Run a command' },
  think: { icon: 'lightbulb', empty: 'Think' },
  fetch: { icon: 'globe', empty: 'Fetch' },
  switch_mode: { icon: 'sliders', empty: 'Switch mode' },
  other: { icon: 'zap', empty: 'Use a tool' },
};

/** A piece of a step's title: `code` pieces (a command, a path) read in monospace. */
export interface TitlePart {
  text: string;
  code?: boolean;
}

export interface StepView {
  icon: IconName;
  parts: TitlePart[];
  /** The whole title on one line, for the row's tooltip. */
  full: string;
}

/** A step's title is clipped to about this many characters. */
export const STEP_TITLE_MAX = 72;

const COMMAND_START =
  /^(grep|rg|find|ls|cat|head|tail|sed|git|gh|bun|bunx|npm|npx|pnpm|yarn|node|python3?|cd|make|cargo|go|curl|mkdir|rm|mv|cp)\b/;
const PATHLIKE =
  /(^|\s)((?:https?:\/\/|~\/|\.{1,2}\/|\/)\S+|[\w.@-]+\/[\w./@-]+|[\w-]+\.[a-z][a-z0-9]{0,4})(?=[\s,:;)]|$)/g;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A command's first line, and "…" when it has more. */
function firstLine(s: string): string {
  const lines = s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const first = oneLine(lines[0] ?? '');
  return lines.length > 1 ? `${first} …` : first;
}

/** A path inside a node's worktree reads from the worktree's root. */
function shortPath(p: string): string {
  const inWorktree = /\/\.worktrees\/[^/]+\/(.+)$/.exec(p);
  return inWorktree ? (inWorktree[1] as string) : p;
}

const isPath = (s: string): boolean => !/\s/.test(s) && /[/.]/.test(s);

/** Plain words with their paths and URLs as code. */
function withPaths(line: string): TitlePart[] {
  const parts: TitlePart[] = [];
  let last = 0;
  for (const m of line.matchAll(PATHLIKE)) {
    const lead = m[1] as string;
    const path = m[2] as string;
    const start = (m.index ?? 0) + lead.length;
    if (start > last) parts.push({ text: line.slice(last, start) });
    parts.push({ text: shortPath(path), code: true });
    last = start + path.length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts;
}

function titleParts(kind: string, title: string): TitlePart[] {
  const t = title.trim();
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
  if (mcp) return [{ text: (mcp[2] as string).replace(/_/g, ' ') }, { text: ` · ${mcp[1]}` }];
  const whole = /^`([^`]+)`$/s.exec(t);
  if (whole) return [{ text: firstLine(whole[1] as string), code: true }];
  if (t.includes('`')) {
    // Between backticks is code; a lone trailing backtick leaves its piece plain.
    const pieces = t.split('`');
    const parts: TitlePart[] = [];
    pieces.forEach((piece, i) => {
      if (i % 2 === 1 && i < pieces.length - 1) {
        const value = firstLine(piece);
        if (value !== '')
          parts.push({ text: isPath(value) ? shortPath(value) : value, code: true });
      } else {
        const value = piece.replace(/\s+/g, ' ');
        if (value !== '') parts.push({ text: value });
      }
    });
    const first = parts[0];
    if (first && !first.code) first.text = first.text.trimStart();
    const last = parts[parts.length - 1];
    if (last && !last.code) last.text = last.text.trimEnd();
    return parts.filter((p) => p.text !== '');
  }
  const line = firstLine(t);
  if (kind === 'execute' || COMMAND_START.test(line)) return [{ text: line, code: true }];
  return withPaths(line);
}

/** Clips the parts to `max` characters: a long path loses its start first, then the end goes. */
function clipParts(parts: readonly TitlePart[], max: number): TitlePart[] {
  const length = (list: readonly TitlePart[]) => list.reduce((n, p) => n + p.text.length, 0);
  let over = length(parts) - max;
  if (over <= 0) return parts.slice();
  const shortened = parts.map((p) => {
    if (over <= 0 || !p.code || !isPath(p.text) || p.text.length <= 20) return p;
    const cut = Math.min(over + 1, p.text.length - 19);
    over -= cut - 1;
    return { ...p, text: `…${p.text.slice(cut)}` };
  });
  if (length(shortened) <= max) return shortened;
  const out: TitlePart[] = [];
  let room = max - 1;
  for (const p of shortened) {
    if (room <= 0) break;
    const text = p.text.length <= room ? p.text : p.text.slice(0, room).trimEnd();
    out.push({ ...p, text });
    room -= p.text.length;
  }
  const tail = out[out.length - 1];
  if (tail) out[out.length - 1] = { ...tail, text: `${tail.text}…` };
  return out;
}

/** How a step reads: its kind's icon, its title (code for a command or a path), clipped. */
export function stepView(step: Pick<AgentStep, 'kind' | 'title'>): StepView {
  const kind = KINDS[step.kind] ? step.kind : 'other';
  const info = KINDS[kind] as KindInfo;
  const title = step.title.trim();
  if (title === '') return { icon: info.icon, parts: [{ text: info.empty }], full: info.empty };
  const full = oneLine(title.replace(/`/g, ''));
  return {
    icon: info.icon,
    parts: clipParts(titleParts(kind, title), STEP_TITLE_MAX),
    full: full.length > 600 ? `${full.slice(0, 599)}…` : full,
  };
}

// ---------------------------------------------------------------- the running turn's clock

/**
 * T405: when the running turn began, for "working · 1m 12s": your line that
 * woke it (the first you sent after the agent's last reply), else its first
 * step. `undefined` when neither is known (a wake with no step yet).
 */
export function turnStartedAt(
  entries: readonly Anchorable[],
  current: readonly Pick<AgentStep, 'ts'>[],
): string | undefined {
  let woke: string | undefined;
  for (const entry of entries) {
    const variant = chatVariant(entry);
    if (variant === 'agent') woke = undefined;
    else if (variant === 'you' && woke === undefined) woke = entry.ts;
  }
  const first = current.reduce<string | undefined>(
    (min, step) => (min === undefined || step.ts < min ? step.ts : min),
    undefined,
  );
  if (woke === undefined) return first;
  return first === undefined || woke < first ? woke : first;
}

/** T405: how long, in words a glance reads: "8s", "1m 12s", "1h 3m". */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
