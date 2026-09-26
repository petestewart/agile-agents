/**
 * T363: the pure half of a node's page as a chat (design/cockpit-ui.md §3,
 * §7). How a thread line shows (your bubble, the agent's prose, a one-line
 * system row), who wrote it in words, what Send will do, which tabs apply,
 * the header's actions, and the Changes tab's diff split into files. No DOM,
 * so plain `bun test` covers every rule here; the components only render.
 */

import type { InboxItem, SessionRef, ThreadEntry } from '@agile-agents/shared';
import type { IconName } from '../components/Icon';
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

const cap = (word: string): string => (word ? word[0]?.toUpperCase() + word.slice(1) : word);

/**
 * A model id in words: `claude-opus-5-5` → "Claude Opus 5.5", `sonnet` →
 * "Claude Sonnet", the provider's own default → "Gemini default model".
 * Anything else reads as its id.
 */
export function modelLabel(vendor: string, model: string | undefined): string {
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

/** "Claude Opus 5.5 · low": what a session runs, or what one would start with. */
export function sessionLabel(session: { vendor: string; model?: string; effort?: string }): string {
  const model = modelLabel(session.vendor, session.model);
  return session.effort ? `${model} · ${session.effort}` : model;
}

/** Who wrote a thread line, for the chat's name row. */
export interface ChatAuthor {
  /** "You", "Claude", "Coordinator", "agile". */
  name: string;
  /** The session's role in words ("worker", "coordinator", "reviewer"), when an agent wrote it. */
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
  return { name: vendorLabel(session.vendor), role: session.role, vendor: session.vendor };
}

/** The node's own agent in a sentence: "Claude" for a live or last session, else "The agent". */
export function agentName(sessions: readonly Pick<SessionRef, 'vendor' | 'role'>[]): string {
  const own = [...sessions].reverse().find((s) => s.role === 'worker' || s.role === 'coordinator');
  return own ? vendorLabel(own.vendor) : 'The agent';
}

// ---------------------------------------------------------------- chat rows

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
    return entry.kind === 'event' || entry.kind === 'line' ? 'system' : 'agent';
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

/** The thread as chat rows: hidden lines dropped, same-author runs marked, day breaks labelled. */
export function chatRows<
  E extends Pick<ThreadEntry, 'ts' | 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>,
>(entries: readonly E[], now: number = Date.now()): ChatRow<E>[] {
  const rows: ChatRow<E>[] = [];
  let lastDay: string | undefined;
  let lastAuthor: string | undefined;
  entries.forEach((entry, index) => {
    const variant = chatVariant(entry);
    if (variant === undefined) return;
    const key = dayKey(entry.ts);
    const day = key !== lastDay && key !== '' ? dayLabel(entry.ts, now) : undefined;
    if (key !== '') lastDay = key;
    const message = variant === 'you' || variant === 'agent';
    const continued = message && day === undefined && lastAuthor === entry.by;
    lastAuthor = message ? entry.by : undefined;
    rows.push({ entry, index, variant, continued, ...(day ? { day } : {}) });
  });
  return rows;
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

const ROLE_WORD: Record<string, string> = {
  worker: 'Worker',
  coordinator: 'Coordinator',
  reviewer: 'Reviewer',
  lessons: 'Lessons',
  director: 'Director',
};

/**
 * A daemon line as a one-line system row. The text is the daemon's own,
 * verbatim, except three noisy lines: "stream created: …", "<role>
 * attached: vendor/model effort=… in /path" (the path is noise here) and
 * "session ended: its turn finished".
 */
export function systemLine(body: string): SystemLine {
  const created = /^stream created: (.+)$/s.exec(body);
  if (created) return { icon: 'plus', text: 'Node created', tone: 'muted' };
  const attached = /^(\w+) attached: ([^/\s]+)\/(\S+) effort=(\S+)/.exec(body);
  if (attached) {
    const [, role = '', vendor = '', model, effort] = attached;
    return {
      icon: 'play',
      text: `${ROLE_WORD[role] ?? cap(role)} started · ${sessionLabel({ vendor, model, effort })}`,
      tone: 'muted',
    };
  }
  if (/^session ended: its turn finished$/.test(body)) {
    return { icon: 'check', text: 'Turn finished', tone: 'muted' };
  }
  return { icon: systemIcon(body), text: body, tone: systemTone(body) };
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

/** One line of a question for the composer's "Answering: …" chip. */
export function oneLine(text: string, max = 90): string {
  const first = (text.split('\n').find((l) => l.trim() !== '') ?? '').trim().replace(/\s+/g, ' ');
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/** This node's open questions, oldest first (the one to answer by default is `[0]`). */
export function openQuestions(items: readonly InboxItem[], node: string): InboxItem[] {
  return items
    .filter((item) => item.kind === 'question' && item.stream === node)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

/**
 * Which question Send answers. `choice` is the viewer's pick: a question id,
 * `'message'` (write a plain line instead), or `undefined` (the oldest).
 * A pick that is no longer open falls back to the oldest.
 */
export function answerTarget(
  questions: readonly Pick<InboxItem, 'id'>[],
  choice: string | undefined,
): string | undefined {
  if (questions.length === 0 || choice === 'message') return undefined;
  if (choice !== undefined && questions.some((q) => q.id === choice)) return choice;
  return questions[0]?.id;
}

// ---------------------------------------------------------------- what Send does

export type SendAction = 'answer' | 'say' | 'start' | 'none';

export interface SendIntentInput {
  /** Not merged or closed. */
  open: boolean;
  merged?: boolean;
  /** The question Send answers, if any. */
  answering?: string;
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
    const hint = input.merged
      ? 'This node is merged. Its conversation is read-only.'
      : 'This node is closed. Its conversation is read-only.';
    return { action: 'none', hint, placeholder: hint };
  }
  if (input.answering !== undefined) {
    return {
      action: 'answer',
      hint: 'Answers the question. The agent gets your reply as written.',
      placeholder: 'Answer the question…',
    };
  }
  if (input.live) {
    const { name, working } = input.live;
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
  const agent = input.anyLive ? 'stop' : input.canStart ? 'start' : undefined;
  const merge = input.mergeable;
  const primary =
    merge && input.landReady
      ? 'merge'
      : agent === 'start' && input.startIsNext !== false
        ? 'agent'
        : undefined;
  return { ...(agent ? { agent } : {}), merge, ...(primary ? { primary } : {}) };
}

// ---------------------------------------------------------------- tabs

export type NodeTab = 'thread' | 'diff' | 'plan' | 'activity' | 'rules' | 'docs';

/** The tabs that apply to a node, in order; an empty one is left out rather than shown empty. */
export function nodeTabs(input: {
  role: 'project' | 'coordinating' | 'work' | 'conversation' | undefined;
  hasRepo: boolean;
  /** Parts or tangents under it: a plan may split them. */
  hasChildren?: boolean;
  hasPlanItem?: boolean;
  knowledge: number;
  docs: number;
}): NodeTab[] {
  const tabs: NodeTab[] = ['thread'];
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

/** The Delivery section's one-word state, in the order the panel reads it. */
export function deliveryBadge(s: {
  landed: boolean;
  closed?: boolean;
  conflict: boolean;
  prOpen: boolean;
  held: boolean;
  ready: boolean;
  mergedOutside: boolean;
}): DeliveryBadge {
  if (s.landed) return { label: 'Merged', tone: 'purple' };
  if (s.closed) return { label: 'Closed', tone: 'gray' };
  if (s.conflict) return { label: 'Conflict', tone: 'red' };
  if (s.prOpen) return { label: 'PR open', tone: 'blue' };
  if (s.mergedOutside) return { label: 'Merged outside', tone: 'purple' };
  if (s.held) return { label: 'Held', tone: 'amber' };
  if (s.ready) return { label: 'Can merge', tone: 'green' };
  return { label: 'Not ready', tone: 'gray' };
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
