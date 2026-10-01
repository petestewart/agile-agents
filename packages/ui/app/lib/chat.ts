/**
 * T363: the pure half of a node's page as a chat (design/cockpit-ui.md §3,
 * §7). How a thread line shows (your bubble, the agent's prose, a one-line
 * system row), who wrote it in words, what Send will do, which tabs apply,
 * the header's actions, and the Changes tab's diff split into files. No DOM,
 * so plain `bun test` covers every rule here; the components only render.
 */

import {
  EFFORT_IN_MODEL_VENDORS,
  type InboxItem,
  type SessionRef,
  type ThreadEntry,
  vendorTakesEffort,
} from '@agile-agents/shared';
import type { IconName } from '../components/Icon';
import { branchName } from './inbox';
import { type NodeStatusKey, statusOf } from './status';
import { isLiveSession, ruleHitOf } from './streams';

// ---------------------------------------------------------------- names

const VENDOR_LABEL: Record<string, string> = {
  claude: 'Claude',
  gemini: 'Gemini',
  cursor: 'Cursor',
  grok: 'Grok',
  pi: 'Pi',
  codex: 'Codex',
};

/** `claude` → "Claude"; an unknown vendor keeps its id, capitalised. */
export function vendorLabel(vendor: string): string {
  return VENDOR_LABEL[vendor] ?? (vendor ? vendor[0]?.toUpperCase() + vendor.slice(1) : 'Agent');
}

/** T488: whether `vendor` builds effort into each model instead of a setting of its own (Cursor). */
export function effortInModel(vendor: string): boolean {
  return (EFFORT_IN_MODEL_VENDORS as readonly string[]).includes(vendor);
}

/** T401, T488: why a vendor offers no effort level, in words. */
export function noEffortLine(vendor: string): string {
  return effortInModel(vendor)
    ? `${vendorLabel(vendor)} sets effort as part of each model: pick the model with the effort you want`
    : `${vendorLabel(vendor)} has no effort setting`;
}

const cap = (word: string): string => (word ? word[0]?.toUpperCase() + word.slice(1) : word);

/**
 * A model id in words: `claude-opus-5-5` → "Claude Opus 5.5", `sonnet` →
 * "Claude Sonnet", the provider's own default → "Gemini default model".
 * Anything else reads as its id. T467: a vendor's settings in brackets
 * are left off (Cursor's `grok-4.7[context=256k,fast=true]` → "grok-4.7";
 * the tooltip keeps the whole id).
 */
export function modelLabel(vendor: string, id: string | undefined): string {
  const model = id?.replace(/\[[^\]]*\]$/, '');
  if (model === undefined || model === '' || model === 'default') {
    return `${vendorLabel(vendor)} default model`;
  }
  const versioned = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (versioned) {
    const [, family = '', major, minor] = versioned;
    return `Claude ${cap(family)} ${major}${minor !== undefined ? `.${minor}` : ''}`;
  }
  if (vendor === 'claude' && /^(opus|sonnet|haiku|fable)$/.test(model))
    return `Claude ${cap(model)}`;
  return model;
}

/**
 * "Claude Opus 5.5 · low": what a session runs, or what one would start with.
 * T401: the effort only for a vendor that uses it ("Gemini default model").
 */
export function sessionLabel(session: { vendor: string; model?: string; effort?: string }): string {
  const model = modelLabel(session.vendor, session.model);
  return session.effort && vendorTakesEffort(session.vendor)
    ? `${model} · ${session.effort}`
    : model;
}

/**
 * T382: `sessionLabel`, with the agent named first when the model's name
 * does not say it — "Claude Opus 5.5 · low", "Gemini default model · low",
 * but "Codex · gpt-9 · low". For a place nothing else names the agent
 * (Running, a details session row, Settings' "starts with").
 */
export function agentLabel(session: { vendor: string; model?: string; effort?: string }): string {
  const label = sessionLabel(session);
  const vendor = session.vendor.replace(/[^a-z0-9]/gi, '');
  if (vendor === '' || new RegExp(`\\b${vendor}\\b`, 'i').test(label)) return label;
  return `${vendorLabel(session.vendor)} · ${label}`;
}

/**
 * T382: the raw ids behind a label, for its tooltip: "claude/claude-opus-5-5 ·
 * low effort" ("gemini/default · low effort (ignored)", T401).
 */
export function sessionIdText(session: {
  vendor: string;
  model?: string;
  effort?: string;
}): string {
  const model = session.model === undefined || session.model === '' ? 'default' : session.model;
  if (!session.effort) return `${session.vendor}/${model}`;
  // T401: a vendor without an effort setting records the level but never gets it.
  const ignored = vendorTakesEffort(session.vendor) ? '' : ' (ignored)';
  return `${session.vendor}/${model} · ${session.effort} effort${ignored}`;
}

/** T411: a token count a glance reads: 950, 46k, 1.2M. */
export function tokensText(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const m = n / 1_000_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}

/**
 * T411: how full an agent's context window is, for the meter by its model
 * chip: the share used, a level (`high` from 75%, `full` from 90%, when a
 * long session is worth restarting fresh), and the numbers in words.
 */
export function contextMeter(context: { used: number; size: number }): {
  percent: number;
  level: 'ok' | 'high' | 'full';
  title: string;
} {
  const percent = Math.min(100, Math.max(0, Math.round((context.used / context.size) * 100)));
  const level = percent >= 90 ? 'full' : percent >= 75 ? 'high' : 'ok';
  const title = `Context: ${tokensText(context.used)} of ${tokensText(context.size)} tokens used (${percent}%)`;
  return { percent, level, title };
}

/**
 * T413: "Claude Opus 5.5 · low effort": `sessionLabel` for a sentence (a
 * chat row), where a bare "low" would not say what it is. The effort only
 * for a vendor that uses it, as `sessionLabel`.
 */
export function sessionLabelLong(session: {
  vendor: string;
  model?: string;
  effort?: string;
}): string {
  const model = modelLabel(session.vendor, session.model);
  return session.effort && vendorTakesEffort(session.vendor)
    ? `${model} · ${session.effort} effort`
    : model;
}

/** T413: a session's role in words; the node's own agent is just "Agent". */
const SESSION_ROLE_WORD: Record<string, string> = {
  worker: 'Agent',
  coordinator: 'Coordinator',
  reviewer: 'Reviewer',
  lessons: 'Lessons pass',
  director: 'Director',
};

export function sessionRoleWord(role: string): string {
  return SESSION_ROLE_WORD[role] ?? cap(role);
}

/** T413: a session's state in words, for the details panel's session rows. */
const SESSION_STATUS_WORD: Record<SessionRef['status'], string> = {
  starting: 'Starting',
  running: 'Working',
  idle: 'Waiting for you',
  stopped: 'Ended',
  error: 'Failed',
};

export function sessionStatusWord(status: SessionRef['status']): string {
  return SESSION_STATUS_WORD[status] ?? status;
}

/**
 * T438 (audit r6 #4): why a session ended, in words, for Details → Agent:
 * a non-zero exit is "Stopped with an error" and the vendor's own line,
 * never "process exited (code 1)"; `error` tone only for a failure.
 */
export function endedReasonText(
  session: Pick<SessionRef, 'status' | 'ended_reason'>,
): { text: string; tone: 'error' | 'muted' } | undefined {
  const reason = session.ended_reason?.trim();
  if (!reason) return undefined;
  const exited = /^process exited \(code (-?\d+)\)(?:: (.+))?$/s.exec(reason);
  if (exited) {
    const [, code, why] = exited;
    if (code === '0') return { text: 'The process ended', tone: 'muted' };
    return {
      text: why
        ? `Stopped with an error: ${tidyIds(why)}`
        : `Stopped with an error (exit code ${code})`,
      tone: 'error',
    };
  }
  if (reason === 'its turn finished') return { text: 'Finished its turn', tone: 'muted' };
  // T460: a turn the vendor failed, already in words (a login refusal says how to log in).
  const turnFailed = /^turn failed: (.+)$/s.exec(reason);
  if (turnFailed) return { text: tidyIds(turnFailed[1] ?? ''), tone: 'error' };
  const text = tidyIds(reason);
  return {
    text: text.charAt(0).toUpperCase() + text.slice(1),
    tone: session.status === 'error' ? 'error' : 'muted',
  };
}

/**
 * T466: an agent's words without a verb it echoed in its text ("progress —
 * I'll count the files"): Codex wrote the `progress` verb's name into its
 * message instead of calling it.
 */
export function agentWords(body: string): string {
  return body.replace(/^\s*progress\s*(?:—|–|-|:)\s*/i, '');
}

/** Who wrote a thread line, for the chat's name row. */
export interface ChatAuthor {
  /** "You", "Claude", "Coordinator", "agile". */
  name: string;
  /**
   * A tag after the name when the writer is not the node's own agent
   * ("reviewer"). T413: the node's own worker or coordinator goes untagged.
   */
  role?: string;
  /** The vendor id, for the avatar's glyph. */
  vendor?: string;
}

export function chatAuthor(by: string, sessions: readonly SessionRef[]): ChatAuthor {
  if (by === 'human') return { name: 'You' };
  if (by === 'daemon') return { name: 'agile' };
  if (by === 'coordinator') return { name: 'Coordinator' };
  if (by === 'director') return { name: 'Director' };
  const id = by.startsWith('agent:') ? by.slice('agent:'.length) : by;
  const session = sessions.find((each) => each.id === id);
  if (session === undefined) return { name: 'Agent' };
  const own = session.role === 'worker' || session.role === 'coordinator';
  return {
    name: vendorLabel(session.vendor),
    ...(own ? {} : { role: session.role }),
    vendor: session.vendor,
  };
}

/** The node's own agent in a sentence: "Claude" for a live or last session, else "The agent". */
export function agentName(sessions: readonly Pick<SessionRef, 'vendor' | 'role'>[]): string {
  const own = [...sessions].reverse().find((s) => s.role === 'worker' || s.role === 'coordinator');
  return own ? vendorLabel(own.vendor) : 'The agent';
}

/**
 * T400: who the live block names while a turn runs, and what it is doing.
 * The node's own agent when it runs ("Claude is working"); else a running
 * reviewer ("Codex is reviewing"), not the idle worker's name.
 */
export function workingAs(sessions: readonly Pick<SessionRef, 'vendor' | 'role' | 'status'>[]): {
  name: string;
  doing: 'working' | 'reviewing';
} {
  const running = (s: Pick<SessionRef, 'status'>) =>
    s.status === 'starting' || s.status === 'running';
  const own = sessions.some((s) => (s.role === 'worker' || s.role === 'coordinator') && running(s));
  const reviewer = [...sessions].reverse().find((s) => s.role === 'reviewer' && running(s));
  if (!own && reviewer) return { name: vendorLabel(reviewer.vendor), doing: 'reviewing' };
  return { name: agentName(sessions), doing: 'working' };
}

// ---------------------------------------------------------------- chat rows

/**
 * T427: a worker's `propose_next` line ("next: <title> — <goal>", as
 * `VerbService.proposeNext` writes it) as the node it proposes, so the
 * chat can offer to create it. Anything else is `undefined`.
 */
export function proposedNext(
  entry: Pick<ThreadEntry, 'by' | 'kind' | 'body'>,
): { title: string; goal: string } | undefined {
  if (entry.kind !== 'proposal' || !entry.by.startsWith('agent:')) return undefined;
  const match = /^next: (.+?) — ([\s\S]+)$/.exec(entry.body.trim());
  const title = match?.[1]?.trim();
  const goal = match?.[2]?.trim();
  if (!title || !goal) return undefined;
  return { title, goal };
}

/**
 * How a line shows: `you` a right-aligned bubble, `agent` prose with a
 * name, `system` a compact muted row (the daemon's own bookkeeping, and
 * your own events such as creating the node), `rule_hit` a blocked-by-rule
 * row. `undefined`: not on your view at all (T347: written for the agent).
 */
export type ChatVariant = 'you' | 'agent' | 'system' | 'rule_hit';

export function chatVariant(
  entry: Pick<ThreadEntry, 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>,
): ChatVariant | undefined {
  if (entry.agent_only) return undefined;
  if (ruleHitOf(entry) !== undefined) return 'rule_hit';
  if (entry.by === 'human') return entry.kind === 'event' ? 'system' : 'you';
  if (entry.by === 'daemon') {
    // T446 (audit r7 #6): a daemon proposal (a part's contract proposal) is a row, not a message.
    return entry.kind === 'event' || entry.kind === 'line' || entry.kind === 'proposal'
      ? 'system'
      : 'agent';
  }
  // T446 (audit r7 #6): what a coordinator or the Director did on its own (a
  // change it applied, a proposal it made, a node it created) is a system row
  // with its own icon, not its chat message.
  if (entry.by === 'coordinator' || entry.by === 'director') {
    return entry.kind === 'event' || entry.kind === 'proposal' ? 'system' : 'agent';
  }
  return 'agent';
}

export interface ChatRow<E> {
  entry: E;
  /** The entry's index in the list given, so a caller maps it back to its thread line. */
  index: number;
  variant: ChatVariant;
  /** The same author wrote the message just above (no system row between): no name again. */
  continued: boolean;
  /** Set on the first row of each calendar day (local time): the divider's label. */
  day?: string;
  /**
   * T446 (audit r7 #17): the routine wake this reply answers, for its header
   * ("Woke for a merge" at `ts`); the wake's own rows are folded away.
   */
  wake?: { text: string; ts: string };
  /** T446: a system row's words when the fold rewrote them ("Woke for a merge · nothing new"). */
  system?: SystemLine;
}

/** "Today", "Yesterday", or "Mon, Sep 21" (with the year when it is not this year). */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const today = new Date(now);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(today) - startOf(at)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return at.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function dayKey(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
}

/**
 * T435 (audit r6 #10): a conversation's question as your first message, in
 * the thread's own list — one day divider over both — right after "Node
 * created" when that line is loaded (else first). `at` is where it went
 * (-1: no question); `threadIndex` maps a list index back to the thread's
 * (`undefined` for the question itself), `listIndex` the other way.
 */
export function withQuestion<E extends Pick<ThreadEntry, 'by' | 'kind' | 'body'>>(
  thread: readonly E[],
  question: E | undefined,
): {
  entries: E[];
  at: number;
  threadIndex: (i: number) => number | undefined;
  listIndex: (i: number) => number;
} {
  if (question === undefined) {
    return { entries: [...thread], at: -1, threadIndex: (i) => i, listIndex: (i) => i };
  }
  const first = thread[0];
  const at =
    first !== undefined && first.kind === 'event' && /^stream created: /.test(first.body) ? 1 : 0;
  return {
    entries: [...thread.slice(0, at), question, ...thread.slice(at)],
    at,
    threadIndex: (i) => (i === at ? undefined : i > at ? i - 1 : i),
    listIndex: (i) => (i >= at ? i + 1 : i),
  };
}

type FoldEntry = Pick<ThreadEntry, 'ts' | 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>;

/** T446: what `foldWakes` does to a thread: rows to hide, replies to head, rows to reword. */
export interface WakeFolds {
  hidden: Set<number>;
  wakes: Map<number, { text: string; ts: string }>;
  system: Map<number, SystemLine>;
}

/** How far after a "woken by" line its coordinator's "attached" line may sit. */
const WAKE_ATTACH_WITHIN = 4;

/** T465 (D48): the daemon's line for a finished turn whose session stays for the next message. */
const TURN_FINISHED = 'turn finished';
/** T465: the daemon's line for a start that resumed the node's earlier session. */
const RESUMED = 'resumed its earlier session';

/** T465: a coordinator started `session` before entry `before` (its "attached" line). */
function coordinatorStarted(
  entries: readonly FoldEntry[],
  before: number,
  session: string,
): boolean {
  for (let j = before - 1; j >= 0; j--) {
    const e = entries[j];
    if (e?.by === 'daemon' && e.ref === session && /^\w+ attached: /.test(e.body)) {
      return /^coordinator attached: /.test(e.body);
    }
  }
  return false;
}

/**
 * T446 (audit r7 #17): a coordinator's routine wake — woken by events, not
 * by your line or answer — folds into its reply: the "woken by", "Coordinator
 * started" and "Agent finished its turn" rows go, and the reply's header
 * says "Woke for a merge". A turn with no reply is one muted row, "Woke for
 * a merge · nothing new". A turn still running, or one that ended badly,
 * keeps its rows.
 * T465 (D48): a coordinator whose session rests is woken in that session:
 * its "woken by" line names the session, and "turn finished" ends the turn.
 * A resumed session's "Resumed its earlier session" row folds away too.
 */
export function foldWakes(entries: readonly FoldEntry[]): WakeFolds {
  const folds: WakeFolds = { hidden: new Set(), wakes: new Map(), system: new Map() };
  const daemonEvent = (e: FoldEntry | undefined): e is FoldEntry =>
    e !== undefined && e.by === 'daemon' && e.kind === 'event';
  entries.forEach((entry, i) => {
    if (!daemonEvent(entry)) return;
    const woken = /^woken by (.+)$/s.exec(entry.body);
    if (!woken) return;
    const types = (woken[1] ?? '').split(',').map((t) => t.trim());
    if (types.includes('human line') || types.includes('answer')) return;
    let at = -1;
    for (let j = i + 1; j < entries.length && j <= i + WAKE_ATTACH_WITHIN; j++) {
      const e = entries[j];
      if (!daemonEvent(e)) break;
      if (/^coordinator attached: /.test(e.body)) {
        at = j;
        break;
      }
    }
    // T465: woken in its resting session, which a coordinator started earlier.
    const resting =
      at < 0 && entry.ref !== undefined && coordinatorStarted(entries, i, entry.ref)
        ? entry.ref
        : undefined;
    const session = at >= 0 ? entries[at]?.ref : resting;
    if (session === undefined) return;
    let end = -1;
    const replies: number[] = [];
    const resumed: number[] = [];
    for (let k = (at >= 0 ? at : i) + 1; k < entries.length; k++) {
      const e = entries[k] as FoldEntry;
      if (
        daemonEvent(e) &&
        e.ref === session &&
        (/^session ended: /.test(e.body) || e.body === TURN_FINISHED)
      ) {
        end = k;
        break;
      }
      if (daemonEvent(e) && e.ref === session && e.body === RESUMED) resumed.push(k);
      if (e.by === `agent:${session}` && chatVariant(e) === 'agent') replies.push(k);
    }
    const body = entries[end]?.body;
    const ended =
      end >= 0 && (body === 'session ended: its turn finished' || body === TURN_FINISHED);
    if (!ended) return;
    const text = `Woke for ${listWords(types.map((t) => WAKE_WORD[t] ?? t))}`;
    if (at >= 0) folds.hidden.add(at);
    for (const k of resumed) folds.hidden.add(k);
    folds.hidden.add(end);
    const first = replies[0];
    if (first !== undefined) {
      folds.hidden.add(i);
      folds.wakes.set(first, { text, ts: entry.ts });
    } else {
      folds.system.set(i, { icon: 'check', text: `${text} · nothing new`, tone: 'muted' });
    }
  });
  return folds;
}

/** The thread as chat rows: hidden lines dropped, same-author runs marked, day breaks labelled. */
export function chatRows<
  E extends Pick<ThreadEntry, 'ts' | 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>,
>(entries: readonly E[], now: number = Date.now()): ChatRow<E>[] {
  const rows: ChatRow<E>[] = [];
  const folds = foldWakes(entries);
  let lastDay: string | undefined;
  let lastAuthor: string | undefined;
  entries.forEach((entry, index) => {
    const variant = chatVariant(entry);
    if (variant === undefined || folds.hidden.has(index)) return;
    const key = dayKey(entry.ts);
    const day = key !== lastDay && key !== '' ? dayLabel(entry.ts, now) : undefined;
    if (key !== '') lastDay = key;
    const message = variant === 'you' || variant === 'agent';
    const wake = folds.wakes.get(index);
    const continued = message && day === undefined && lastAuthor === entry.by && !wake;
    lastAuthor = message ? entry.by : undefined;
    const system = folds.system.get(index);
    rows.push({
      entry,
      index,
      variant,
      continued,
      ...(day ? { day } : {}),
      ...(wake ? { wake } : {}),
      ...(system ? { system } : {}),
    });
  });
  return rows;
}

/**
 * T447 (audit r7 #15): how many rows a long thread renders at first, and how
 * many more each "Show earlier" (or a scroll to the top) adds.
 */
export const THREAD_WINDOW = 80;

/**
 * T447: the last `size` of `rows` (all of them for `size` ≥ their count),
 * and how many are left above. The first row shown carries its day and its
 * author's head, which the hidden row before it would have shown. Each row
 * keeps its `index` into the entries, so the steps map still lines up.
 */
export function windowRows<E>(
  rows: readonly ChatRow<E>[],
  size: number,
): { rows: readonly ChatRow<E>[]; hidden: number } {
  const hidden = Math.max(0, rows.length - Math.max(0, size));
  if (hidden === 0) return { rows, hidden: 0 };
  const first = rows[hidden];
  if (first === undefined) return { rows: [], hidden };
  let day = first.day;
  for (let i = hidden; day === undefined && i >= 0; i--) day = rows[i]?.day;
  return {
    rows: [
      { ...first, continued: false, ...(day !== undefined ? { day } : {}) },
      ...rows.slice(hidden + 1),
    ],
    hidden,
  };
}

/** "14:05" in the viewer's local time: the time a message shows on hover. */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------- system rows

export interface SystemLine {
  icon: IconName;
  /** The row's text: the daemon's own words, tidied for a few noisy lines. */
  text: string;
  /** `warn` rows (a hold, a refusal, a failure) read amber rather than muted. */
  tone: 'muted' | 'warn';
}

/**
 * T413: what woke an agent, in words: the routed event types a "woken by"
 * line lists (as the daemon writes them, `_` read as spaces).
 */
const WAKE_WORD: Record<string, string> = {
  'human line': 'your message',
  answer: 'your answer',
  'director request': 'a request from the Director',
  'coordinator note': 'a note from its coordinator',
  'sibling ask': 'a question from another part',
  'sibling reply': 'a reply from another part',
  'child question': 'a question from a part',
  'tangent summary': 'a tangent’s summary',
  'pr review': 'a PR review',
  'ci failed': 'a failed check',
  'pr behind': 'its PR falling behind main',
  'pr merged': 'a merge',
  'pr closed': 'a closed PR',
  'main changed': 'a change on main',
  'sync conflict': 'a sync conflict',
  'ship findings': 'ship check findings',
  'child delivered': 'a part merging',
  'child status': 'news from a part',
  overlap: 'overlapping changes',
  'symbol changed': 'a changed symbol',
  'contract changed': 'a changed contract',
  'contract proposal': 'a contract proposal',
  'dependency satisfied': 'a node it waited on',
  'plan changed': 'a plan change',
  'external changed': 'a tracker update',
  'knowledge accepted': 'new knowledge',
};

/** "a, b and c". */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** T413: "Woke up for new knowledge and overlapping changes". */
export function wakeWords(types: string): string {
  const words = types
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .map((t) => WAKE_WORD[t] ?? t);
  return words.length === 0 ? 'Woke up' : `Woke up for ${listWords(words)}`;
}

/**
 * T413: a daemon line's ids and node branches out of its primary text: a
 * `stream/<id>-slug` branch reads as its slug, an `(<id>)` aside goes (the
 * row's tooltip keeps the whole line).
 */
export function tidyIds(text: string): string {
  return text
    .replace(/\bstream\/[0-9a-z]{26}-[\w./-]*\w/gi, (branch) => branchName(branch))
    .replace(/\s*\((?:[A-Z]+-)?[0-9A-HJKMNP-TV-Z]{26}\)/g, '');
}

/**
 * T438 (audit r6 #4): the agent failed to start or stopped with an error
 * (the chat's warning line), so an empty chat's "Tell the agent what to do"
 * would contradict it.
 */
export function agentFailed(
  thread: readonly Pick<ThreadEntry, 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>[],
): boolean {
  return thread.some(
    (e) =>
      chatVariant(e) === 'system' &&
      /^(?:could not start the agent: |session ended: turn failed: |session ended: process exited \(code (?!0\))-?\d+\))/.test(
        e.body,
      ),
  );
}

/**
 * A daemon line as a one-line system row. The text is the daemon's own,
 * except the lines it writes in its own terms (T413: an agent starting,
 * finishing its turn, waking, a sync, a wait that is over), and with ids
 * and full branch names left out (`tidyIds`).
 */
/** T446: who wrote a system row, and the node its line points to. */
export interface SystemLineMeta {
  /** The thread line's author: `coordinator` and `director` rows get their own icon. */
  by?: string;
  /** The line's `ref`: a node id links the title it names. */
  ref?: string;
  /** Whether the cockpit knows node `id` (so its link opens something). */
  known?: (id: string) => boolean;
}

const NODE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** T446: the icon of a change a coordinator or the Director made itself. */
function actorIcon(by: string | undefined): IconName | undefined {
  if (by === 'coordinator') return 'bot';
  if (by === 'director') return 'sparkles';
  return undefined;
}

/**
 * T446 (audit r7 #6): a line the daemon wrote before T446 in its own terms,
 * as it reads now: "coordinator (organise) applied: …", "plan v1 approved by
 * human", "plan drafted (2 children, 0 contracts)…", "1 child(ren) propose
 * (CP-…)". A line written since reads in words already.
 */
function olderWording(body: string): string {
  const applied = /^(?:coordinator|director) \((?:advise|organise|run)\) applied: (.+)$/s.exec(
    body,
  );
  if (applied) return `Applied: ${applied[1]}`;
  const decided = /^(applied|dismissed): (.+)$/s.exec(body);
  if (decided) return `You ${decided[1]}: ${decided[2]}`;
  const approved = /^plan v(\d+) approved by (human|coordinator|director)$/.exec(body);
  if (approved) {
    return approved[2] === 'human'
      ? `You approved plan v${approved[1]}`
      : `The ${approved[2] === 'director' ? 'Director' : 'coordinator'} approved plan v${approved[1]}`;
  }
  const own = /^plan v(\d+) approved: you own (.+)$/s.exec(body);
  if (own) return `Plan v${own[1]} approved: this part owns ${own[2]}`;
  const drafted =
    /^plan drafted \((\d+) child(?:ren)?, (\d+) contracts?\); waiting for approval$/.exec(body);
  if (drafted) {
    const [, n = '0', c = '0'] = drafted;
    const part = `${n} part${n === '1' ? '' : 's'}`;
    const contracts = c === '0' ? '' : ` and ${c} contract${c === '1' ? '' : 's'}`;
    return `Plan drafted for ${part}${contracts}; waiting for approval`;
  }
  const waits = /^(.+?) (waits?) for the plan: write it with plan_write .*$/s.exec(body);
  if (waits) return `${waits[1]} ${waits[2]} for the plan; each starts once the plan is approved`;
  const proposed =
    /^contract (.+?): (\d+) child\(ren\) propose \([^)]*\): ([\s\S]+?)\.* Reason: ([\s\S]*)$/.exec(
      body,
    );
  if (proposed) {
    const [, title, n, text, why] = proposed;
    const who = n === '1' ? 'A part proposes' : `${n} parts propose`;
    return `${who} a change to ${title}: ${text}${why ? `. Why: ${why}` : ''}`;
  }
  return body;
}

/**
 * T462: the hook's reason with the daemon's role names in words: "for is
 * not an allowed command for the engineer role" → "for is not an allowed
 * command"; "reviewer role denies all exec except read-only tools (…)" →
 * "a reviewer runs only read-only tools (…)".
 */
export function refusalWords(reason: string): string {
  return tidyIds(reason)
    .replace(/ for the (?:engineer|reviewer|coordinator) role\b/, '')
    .replace(/^reviewer role denies all exec except /, 'a reviewer runs only ')
    .replace(/^coordinator role denies exec except /, 'a coordinator runs only ');
}

export function systemLine(body: string, meta: SystemLineMeta = {}): SystemLine {
  const created = /^stream created: (.+)$/s.exec(body);
  // T446 (audit r7 #6): whoever wrote it (you, the daemon, a coordinator, the Director).
  if (created) return { icon: 'plus', text: 'Node created', tone: 'muted' };
  const actor = actorIcon(meta.by);
  const words = olderWording(body);
  // T446: "Added a part: "X" (web)", "You created "X" in Shop…": the title, bold, links its node.
  const made =
    /^((?:You )?(?:[Aa]dded a (?:part|node):|[Cc]reated|[Ss]tarted|[Rr]estarted)) "(.+?)"(.*)$/s.exec(
      words,
    );
  if (made) {
    const [, lead = '', title = '', rest = ''] = made;
    const ref = meta.ref;
    const link = ref !== undefined && NODE_ID.test(ref) && meta.known?.(ref) === true;
    return {
      icon: actor ?? (meta.by === 'human' ? 'check-circle' : 'plus'),
      text: `${lead} **${link ? ref : title}**${tidyIds(rest)}`,
      tone: 'muted',
    };
  }
  if (actor !== undefined) return { icon: actor, text: tidyIds(words), tone: 'muted' };
  // T446: a part's contract proposal (its card decides it).
  if (/^.+? (?:proposes|propose) a change to /s.test(words)) {
    return { icon: 'file-text', text: tidyIds(words), tone: 'muted' };
  }
  if (words !== body) return { icon: systemIcon(body), text: tidyIds(words), tone: 'muted' };
  const attached = /^(\w+) attached: ([^/\s]+)\/(\S+) effort=(\S+)/.exec(body);
  if (attached) {
    const [, role = '', vendor = '', model, effort] = attached;
    return {
      icon: 'play',
      text: `${sessionRoleWord(role)} started · ${sessionLabelLong({ vendor, model, effort })}`,
      tone: 'muted',
    };
  }
  // T421 (D42): a conclusion sent up from this conversation.
  const sent = /^sent to (.+?): (.*)$/s.exec(body);
  if (sent) return { icon: 'send', text: `Sent to ${sent[1]}: ${sent[2]}`, tone: 'muted' };
  if (/^session ended: its turn finished$/.test(body) || body === TURN_FINISHED) {
    return { icon: 'check', text: 'Agent finished its turn', tone: 'muted' };
  }
  // T465 (D48): a finished turn's session, kept for the next message, ended or came back.
  if (body === RESUMED) {
    return { icon: 'refresh', text: 'Resumed its earlier session', tone: 'muted' };
  }
  const idle = /^session ended: it sat idle for (.+) after its turn finished$/.exec(body);
  if (idle) {
    return { icon: 'square', text: `Session closed after ${idle[1]} idle`, tone: 'muted' };
  }
  // T432 (D43): the vendor's process ended on its own; non-zero is a failure, with its reason.
  const exited = /^session ended: process exited \(code (-?\d+)\)(?:: (.+))?$/s.exec(body);
  if (exited) {
    const [, code, why] = exited;
    if (code === '0') return { icon: 'square', text: 'The agent’s process ended', tone: 'muted' };
    return {
      icon: 'alert-triangle',
      text: `The agent stopped with an error${why ? `: ${tidyIds(why)}` : ` (exit code ${code})`}. Check its vendor is installed and logged in, then send a message to start it again.`,
      tone: 'warn',
    };
  }
  // T462: a call the permission hook refused or held, in words ("hook_deny" and role names are the daemon's).
  const refused = /^hook_deny: (denied|routed to the human) `(.*)` — (.+)$/s.exec(body);
  if (refused) {
    const [, outcome, target = '', why = ''] = refused;
    const held = outcome !== 'denied';
    return {
      icon: held ? 'clock' : 'lock',
      text: `${held ? 'Held for your approval' : 'Refused'}: \`${target}\` — ${refusalWords(why)}`,
      tone: held ? 'warn' : 'muted',
    };
  }
  // T460: a turn the vendor failed (a login refusal), in the daemon's words.
  const turnFailed = /^session ended: turn failed: (.+)$/s.exec(body);
  if (turnFailed) {
    return { icon: 'alert-triangle', text: tidyIds(turnFailed[1] ?? ''), tone: 'warn' };
  }
  // T438 (audit r6 #4): the start failed before the vendor ran (its command missing, a spawn error).
  const failed = /^could not start the agent: (.+)$/s.exec(body);
  if (failed) {
    const why = tidyIds(failed[1] ?? '').replace(/[.\s]+$/, '');
    return {
      icon: 'alert-triangle',
      text: `The agent couldn’t start: ${why}. Fix its install or login, then send a message to start it again.`,
      tone: 'warn',
    };
  }
  const woken = /^woken by (.+)$/s.exec(body);
  if (woken) return { icon: 'play', text: wakeWords(woken[1] ?? ''), tone: 'muted' };
  const waited = /^waits on (.+) satisfied$/s.exec(body);
  if (waited) {
    // The daemon joins several titles with ", "; a title may hold one too, so the text stays whole.
    const titles = waited[1] ?? '';
    return {
      icon: 'check-circle',
      text: `${titles} merged, so this no longer waits on ${titles.includes(', ') ? 'them' : 'it'}`,
      tone: 'muted',
    };
  }
  const synced = /^synced (\S+) into (\S+)( and pushed)?$/.exec(body);
  if (synced) {
    return {
      icon: 'refresh',
      text: `Synced ${synced[1]} into this branch${synced[3] ? ' and pushed it' : ''}`,
      tone: 'muted',
    };
  }
  const detached = /^(\w+) detached by human$/.exec(body);
  if (detached) {
    const who = sessionRoleWord(detached[1] ?? '');
    return { icon: 'square', text: `You stopped the ${who.toLowerCase()}`, tone: 'muted' };
  }
  const markedLanded = /^marked landed: (\S+) was already merged into (\S+)$/.exec(body);
  if (markedLanded) {
    return {
      icon: 'git-merge',
      text: `Marked as merged: ${branchName(markedLanded[1] ?? '')} was already in ${markedLanded[2]}`,
      tone: 'muted',
    };
  }
  // T385: you edited the goal on the page.
  const goal = /^goal changed: (.+)$/s.exec(body);
  if (goal) return { icon: 'pencil', text: `Goal changed: ${goal[1]}`, tone: 'muted' };
  return { icon: systemIcon(body), text: tidyIds(body), tone: systemTone(body) };
}

function systemTone(body: string): SystemLine['tone'] {
  return /\b(held|could not|failed|failing|error|refused|denied|conflict(ed)?|blocked)\b/i.test(
    body,
  )
    ? 'warn'
    : 'muted';
}

function systemIcon(body: string): IconName {
  const b = body.toLowerCase();
  if (/could not|failed|error|refused|denied|conflict/.test(b)) return 'alert-triangle';
  if (/\bheld\b|waits on|waiting for the plan/.test(b)) return 'clock';
  if (/pr #\d+|pull request/.test(b)) return 'git-pull-request';
  if (/\blanded\b|\bmerged\b|\bmerge\b/.test(b)) return 'git-merge';
  if (/synced|role changed|restarted/.test(b)) return 'refresh';
  if (/branched off|tangent/.test(b)) return 'git-fork';
  if (/repo added|work node|branch/.test(b)) return 'git-branch';
  if (/\bplan\b|contract/.test(b)) return 'list';
  if (/stopped|session ended|detached/.test(b)) return 'square';
  if (/attached|started|woken|woke/.test(b)) return 'play';
  if (/knowledge|decision|rule/.test(b)) return 'book-open';
  if (/closed/.test(b)) return 'x-circle';
  return 'info';
}

/** A rule hit's words without its prefix and the rule's id (the row links to the rule). */
export function ruleHitText(body: string): string {
  return body
    .replace(/^rule_hit:\s*/, '')
    .replace(/^K-[0-9A-HJKMNP-TV-Z]{26}\s*/, '')
    .trim();
}

// ---------------------------------------------------------------- questions

/**
 * T376: the question a thread line is about — its `ref` is the question's
 * record path (`questions/Q-….yaml`) — or `undefined`.
 */
export function questionIdOfRef(ref: string | undefined): string | undefined {
  return ref?.match(/(?:^|\/)(Q-[0-9A-HJKMNP-TV-Z]{26})\.yaml$/)?.[1];
}

/** This node's open questions, oldest first. T499: each one is answered in its own card. */
export function openQuestions(items: readonly InboxItem[], node: string): InboxItem[] {
  return items
    .filter((item) => item.kind === 'question' && item.stream === node)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

// ---------------------------------------------------------------- what Send does

/**
 * T423: `restart` stops the live agent and starts it again with the chip's
 * pick, the line its first prompt. T499: Send is for messages only; a
 * question is answered in its own card.
 */
export type SendAction = 'say' | 'start' | 'restart' | 'none';

export interface SendIntentInput {
  /** Not merged or closed. */
  open: boolean;
  merged?: boolean;
  /** The node's live agent: its name, and whether a turn is in flight. */
  live?: { name: string; working: boolean };
  /** T336: a part that starts when its coordinator's plan is approved; never started by a line. */
  waitingForPlan?: boolean;
  /** A line can start an agent here (a bare project root has none to start). */
  canStart: boolean;
  /** An agent ran here before. */
  hasRun: boolean;
  /** You stopped it. */
  stopped?: boolean;
  /** What a start runs: "Claude Opus 5.5 · low". */
  startWith?: string;
  /** T423: the model chip picked another model than the live agent's: Send restarts it with this. */
  restartWith?: string;
}

export interface SendIntent {
  action: SendAction;
  /** One short sentence under the box: what pressing Send does. */
  hint: string;
  placeholder: string;
}

export function sendIntent(input: SendIntentInput): SendIntent {
  const model = input.startWith ? ` with ${input.startWith}` : '';
  if (!input.open) {
    if (input.merged) {
      const hint = 'This node is merged. Its conversation is read-only.';
      return { action: 'none', hint, placeholder: hint };
    }
    // T471: closed is inactive, not read-only: a message reopens it and wakes its agent.
    return {
      action: 'start',
      hint: input.canStart
        ? `Reopens this node and wakes the agent${model}.`
        : 'Reopens this node and adds a note.',
      placeholder: 'Write to reopen it…',
    };
  }
  if (input.live) {
    const { name, working } = input.live;
    if (input.restartWith !== undefined) {
      return {
        action: 'restart',
        hint: working
          ? `Stops ${name}’s current step, restarts the agent with ${input.restartWith}, then sends this.`
          : `Restarts the agent with ${input.restartWith}, then sends this.`,
        placeholder: `Message ${name}…`,
      };
    }
    return working
      ? {
          action: 'say',
          hint: `Queued — ${name} reads it after its current step.`,
          placeholder: `Message ${name}…`,
        }
      : { action: 'say', hint: `Sends it to ${name} now.`, placeholder: `Message ${name}…` };
  }
  if (input.waitingForPlan) {
    return {
      action: 'say',
      hint: 'Adds a note. This part starts when its plan is approved.',
      placeholder: 'Add a note for when it starts…',
    };
  }
  if (!input.canStart) {
    return {
      action: 'say',
      hint: 'Adds a note to the thread. Start agent runs one here.',
      placeholder: 'Write a note…',
    };
  }
  if (input.stopped) {
    return {
      action: 'start',
      hint: `Restarts the agent${model}.`,
      placeholder: 'Tell the agent what to do next…',
    };
  }
  if (input.hasRun) {
    return {
      action: 'start',
      hint: `Wakes the agent${model}.`,
      placeholder: 'Tell the agent what to do next…',
    };
  }
  return {
    action: 'start',
    hint: `Starts the agent${model}.`,
    placeholder: 'Tell the agent what to do…',
  };
}

// ---------------------------------------------------------------- header

export interface AgentState {
  agent_status: 'idle' | 'working' | 'blocked' | 'question' | 'done';
  human_status: 'open' | 'waiting_on_you' | 'landed' | 'closed';
  waiting_for_plan?: boolean;
  live?: boolean;
  never_started?: boolean;
  stopped?: boolean;
}

/** The agent's half in words, for the line under the title ("Agent finished"). */
export function agentStateText(s: AgentState): string {
  if (s.human_status === 'landed') return 'Merged';
  if (s.human_status === 'closed') return 'Closed';
  if (s.waiting_for_plan) return 'Waiting for the plan';
  switch (s.agent_status) {
    case 'working':
      return 'Agent working';
    case 'question':
      return 'Agent asked you';
    case 'blocked':
      return 'Agent blocked';
    case 'done':
      return 'Agent finished';
    default:
      if (s.live) return 'Agent idle';
      if (s.never_started) return 'Agent not started';
      if (s.stopped) return 'Agent stopped';
      return 'Agent idle';
  }
}

export interface HeaderActionsInput {
  open: boolean;
  /** A worker or coordinator is live (starting, running or idle). */
  liveAgent: boolean;
  /** Any session is live (a reviewer too): Stop has something to stop. */
  anyLive: boolean;
  /**
   * T384: a live session is mid-turn (starting or running). An idle one is
   * waiting on you: Stop stays in the ⋯ menu then, and the composer leads.
   */
  anyBusy?: boolean;
  /** Start agent is offered (an open node, not a part waiting for its plan). */
  canStart: boolean;
  /**
   * Starting is the natural next step: its agent never ran, or you stopped
   * it. After a finished turn it stays a plain button (the next step is to
   * read, reply or merge).
   */
  startIsNext?: boolean;
  /** Merge has something to merge: commits ahead, a conflict to redo, or a result on show. */
  mergeable: boolean;
  /** The preflight says a merge would go through. */
  landReady: boolean;
  /**
   * T436 (audit r6 #28): a decision card is open at the end of the node's
   * chat (a plan to approve, a gate…): its button is the page's one primary,
   * so Start stays plain beside it.
   */
  decisionOpen?: boolean;
}

export interface HeaderActions {
  agent?: 'start' | 'stop';
  merge: boolean;
  /** Which control is the page's one filled button. */
  primary?: 'agent' | 'merge';
}

/** The header's agent control and Merge, and which one is the primary (design §1.1). */
export function headerActions(input: HeaderActionsInput): HeaderActions {
  if (!input.open) return { merge: false };
  const agent = input.anyLive
    ? input.anyBusy === false
      ? undefined
      : 'stop'
    : input.canStart
      ? 'start'
      : undefined;
  const merge = input.mergeable;
  const primary =
    merge && input.landReady
      ? 'merge'
      : agent === 'start' && input.startIsNext !== false && input.decisionOpen !== true
        ? 'agent'
        : undefined;
  return { ...(agent ? { agent } : {}), merge, ...(primary ? { primary } : {}) };
}

// ---------------------------------------------------------------- tabs

export type NodeTab = 'overview' | 'thread' | 'diff' | 'plan' | 'activity' | 'rules' | 'docs';

/**
 * The tabs that apply to a node, in order; an empty one is left out rather
 * than shown empty. The first is the one the page opens on: T387: a
 * project's root opens on its Overview, any other node on its chat.
 */
export function nodeTabs(input: {
  role: 'project' | 'coordinating' | 'work' | 'conversation' | undefined;
  /** T387: the root of a project (not just a node with no parent). */
  projectRoot?: boolean;
  hasRepo: boolean;
  /** Parts or tangents under it: a plan may split them. */
  hasChildren?: boolean;
  hasPlanItem?: boolean;
  knowledge: number;
  docs: number;
}): NodeTab[] {
  const tabs: NodeTab[] = input.projectRoot ? ['overview', 'thread'] : ['thread'];
  if (input.hasRepo) tabs.push('diff');
  if (
    input.role === 'coordinating' ||
    input.role === 'project' ||
    input.hasChildren ||
    input.hasPlanItem
  ) {
    tabs.push('plan');
  }
  tabs.push('activity');
  if (input.knowledge > 0) tabs.push('rules');
  if (input.docs > 0) tabs.push('docs');
  return tabs;
}

// ---------------------------------------------------------------- details panel

export const DETAILS_WIDE_PX = 1200;

/** The viewer's stored choice ('open' | 'closed'), else open on a wide window. */
export function detailsOpenFrom(stored: string | null | undefined, width: number): boolean {
  if (stored === 'open') return true;
  if (stored === 'closed') return false;
  return width >= DETAILS_WIDE_PX;
}

// ---------------------------------------------------------------- scrolling

/** Within `threshold` px of the bottom: new messages keep the view pinned there. */
export function isNearBottom(
  box: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = 96,
): boolean {
  return box.scrollHeight - box.scrollTop - box.clientHeight <= threshold;
}

// ---------------------------------------------------------------- the diff

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** Line numbers on each side; a hunk header or a note has neither. */
  old?: number;
  new?: number;
}

export interface DiffFile {
  path: string;
  /** The path before a rename. */
  from?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';
  additions: number;
  deletions: number;
  rows: DiffRow[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified diff (`git diff`) split into files, each with its hunks and numbered lines. */
export function parseDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      file = {
        path: m?.[2] ?? line.slice(11),
        status: 'modified',
        additions: 0,
        deletions: 0,
        rows: [],
      };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (file === undefined) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
        file.from = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) file.path = line.slice('rename to '.length);
      else if (line.startsWith('Binary files')) {
        file.status = 'binary';
        file.rows.push({ kind: 'meta', text: 'Binary file changed' });
      } else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) {
        file.path = line.replace(/^\+\+\+ b\//, '');
      }
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      file.rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      file.additions += 1;
      file.rows.push({ kind: 'add', text: line, new: newNo++ });
    } else if (line.startsWith('-')) {
      file.deletions += 1;
      file.rows.push({ kind: 'del', text: line, old: oldNo++ });
    } else if (line.startsWith(' ')) {
      file.rows.push({ kind: 'ctx', text: line, old: oldNo++, new: newNo++ });
    } else if (line.startsWith('\\')) {
      file.rows.push({ kind: 'meta', text: line });
    }
    // An empty line is the patch's final newline, not content.
  }
  return files;
}

export function diffTotals(files: readonly DiffFile[]): { additions: number; deletions: number } {
  return files.reduce(
    (sum, f) => ({
      additions: sum.additions + f.additions,
      deletions: sum.deletions + f.deletions,
    }),
    { additions: 0, deletions: 0 },
  );
}

// ---------------------------------------------------------------- delivery

export interface DeliveryBadge {
  label: string;
  tone: 'gray' | 'green' | 'amber' | 'blue' | 'purple' | 'red';
}

/** T436: the node statuses that are about its delivery, which the badge says in their own words. */
const DELIVERY_STATUS_KEYS: ReadonlySet<NodeStatusKey> = new Set([
  'pr_open',
  'ready',
  'no_changes',
  'merged_outside',
]);

function statusBadge(key: NodeStatusKey): DeliveryBadge {
  const { label, tone } = statusOf(key);
  return { label, tone };
}

/**
 * The Delivery section's one-word state, in the order the panel reads it.
 * T436 (audit r6 #24): where the node's own status says it (Merged, Ready
 * to merge, No changes, Already merged, PR open) the badge is that word in
 * that tone, as the header's pill; only what the status can't say (a
 * conflict, a hold, commits on a node still going) has words of its own.
 */
export function deliveryBadge(s: {
  landed: boolean;
  closed?: boolean;
  conflict: boolean;
  prOpen: boolean;
  held: boolean;
  ready: boolean;
  mergedOutside: boolean;
  /** The node's status (`lib/status.ts`). */
  status?: NodeStatusKey;
}): DeliveryBadge {
  if (s.landed) return statusBadge('merged');
  if (s.closed) return statusBadge('closed');
  if (s.conflict) return { label: 'Conflict', tone: 'red' };
  if (s.prOpen) return statusBadge('pr_open');
  if (s.held) return { label: 'Held', tone: 'amber' };
  if (s.status !== undefined && DELIVERY_STATUS_KEYS.has(s.status)) return statusBadge(s.status);
  if (s.mergedOutside) return statusBadge('merged_outside');
  if (s.ready) return { label: 'Can merge', tone: 'gray' };
  return { label: 'Not ready', tone: 'gray' };
}

/** T413: how a node delivers, in words (the Delivery section's last line). */
const DELIVERY_MODE_WORD: Record<'direct' | 'pr', string> = {
  direct: 'Direct merge',
  pr: 'Pull request',
};

const DELIVERY_STATUS_WORD: Record<string, string> = {
  not_started: 'not started',
  ship_checking: 'running the ship check',
  held: 'held',
  ready: 'ready',
  pr_open: 'PR open',
  merged: 'merged',
  closed_unmerged: 'closed without merging',
  conflict: 'conflict',
};

/** "Direct merge · held", "Pull request · PR open". */
export function deliveryStateWords(state: { mode: 'direct' | 'pr'; status: string }): string {
  return `${DELIVERY_MODE_WORD[state.mode] ?? state.mode} · ${
    DELIVERY_STATUS_WORD[state.status] ?? state.status.replace(/_/g, ' ')
  }`;
}

// ---------------------------------------------------------------- the goal

function sameWords(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .trim()
      .replace(/[\s.!?…]+$/u, '')
      .replace(/\s+/g, ' ')
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * T413: whether the chat opens with the Goal card. Not on a project's root
 * (its goal is the project's name), and not when the goal only repeats the
 * title; the details panel keeps the goal (and its Edit) either way.
 */
export function showGoalCard(input: {
  /** T477: absent for a node started with no goal: the card says so and offers Set a goal. */
  goal: string | undefined;
  title: string;
  projectRoot: boolean;
}): boolean {
  if (input.projectRoot) return false;
  if (input.goal === undefined) return true;
  if (input.goal.trim() === '') return false;
  return !sameWords(input.goal, input.title);
}

// ---------------------------------------------------------------- sessions

/** The node's own live agent (a worker or coordinator), if any. */
export function liveAgentOf<S extends Pick<SessionRef, 'role' | 'status'>>(
  sessions: readonly S[],
): S | undefined {
  return sessions.find(
    (s) => (s.role === 'worker' || s.role === 'coordinator') && isLiveSession(s),
  );
}
