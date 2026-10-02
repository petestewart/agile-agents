/**
 * T363: the chat pieces a node's page is built from (design/cockpit-ui.md
 * §7 "Chat"), kept free of any one stream so the Director can reuse them:
 *
 *  - `ChatScroll` — the scrolling column. It stays pinned to the bottom
 *    while you are there, and shows "New messages" when something arrives
 *    while you have scrolled up to read.
 *  - `MessageList` — the thread as a conversation: your lines as bubbles on
 *    the right, the agent's as prose under its name, the daemon's own
 *    bookkeeping as compact one-line system rows. Hover a message for its
 *    time and actions (Copy, and whatever the caller adds, e.g. Branch off).
 *  - `ThreadBody` — a message's markdown, folded past ~12 lines (T330).
 *  - `Thinking` — "<Agent> is working…", with its latest steps live (T392).
 *  - `StepsFold` — "Worked through 12 steps · 1 failed" before a reply, which
 *    opens to the list (T392), with the agent's earlier messages of the turn
 *    in order among the steps (T509); `useSteps` reads a node's steps and follows
 *    the live `tool_call` events. The rules are in `lib/steps.ts`.
 *  - `QuoteSelection` — a Quote button by selected text (T499); the quote
 *    itself is `lib/quote.ts`.
 *  - `QuestionThreadView` — a question's thread, nested under the line that
 *    asked it, or a child's question on a coordinator's chat (T502); where
 *    each goes is `lib/chat.ts`'s `placeQuestionThreads`.
 *
 * Every entry keeps `data-testid="thread-entry"` with `data-kind`/`data-by`
 * (a rule hit: `thread-rule-hit`), and every row's text stays in the DOM.
 */

import type { ChatThread, QuestionThread, ThreadAnchor, ThreadEntry } from '@agile-agents/shared';
import {
  type MutableRefObject,
  type PropsWithChildren,
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { getStreamSteps } from '../lib/api';
import {
  type ChatAuthor,
  THREAD_WINDOW,
  agentWords,
  chatRows,
  clockTime,
  contextMeter,
  isNearBottom,
  proposedNext,
  questionIdOfRef,
  questionThreadWords,
  repliesText,
  ruleHitText,
  systemLine,
  windowRows,
} from '../lib/chat';
import { useFeed, useOptionalFeed } from '../lib/feed-context';
import { ago } from '../lib/status';
import {
  type AgentStep,
  STEP_STATE_LABEL,
  type StepPage,
  type StepState,
  type StepUpdate,
  applyStep,
  elapsedText,
  foldItems,
  liveWindow,
  stepKey,
  stepState,
  stepUpdateOf,
  stepView,
  stepsFromPage,
  stepsSummary,
} from '../lib/steps';
import { ruleHitOf } from '../lib/streams';
import { anchorLabel, threadRepliesText, threadStateWords } from '../lib/threads';
import { Icon, type IconName } from './Icon';
import { Markdown, type PassageMark } from './Markdown';
import { Button, IconButton, Spinner, useCopy } from './ui';

/** T330: past ~12 lines a thread entry offers Show less (T475: it opens whole). */
export const THREAD_COLLAPSE_LINES = 12;

/** Long enough to fold: more than 12 source lines, or ~12 wrapped lines of prose. */
export function isLongThreadBody(body: string): boolean {
  return (
    body.split('\n').length > THREAD_COLLAPSE_LINES || body.length > THREAD_COLLAPSE_LINES * 100
  );
}

/**
 * T475: the messages you folded with Show less, by id, for as long as the
 * page is open (the chat's rows re-mount as it windows and re-renders).
 */
const folded = new Set<string>();

/**
 * A message's markdown, whole. T475: a long one is never folded until you
 * fold it with Show less (Pete: "i should never have to click show more to
 * see all the output"); your fold is kept for that message (`id`).
 */
export function ThreadBody({
  body,
  id,
  marks,
  onMark,
}: {
  body: string;
  id?: string;
  /** T503 (D64): passages threads are anchored to, highlighted with their counts. */
  marks?: readonly PassageMark[];
  onMark?: (thread: string) => void;
}): JSX.Element {
  const [isFolded, setFolded] = useState(() => id !== undefined && folded.has(id));
  const marked =
    marks !== undefined && marks.length > 0 ? { marks, ...(onMark ? { onMark } : {}) } : {};
  if (!isLongThreadBody(body)) return <Markdown text={body} {...marked} />;
  const toggle = (): void => {
    const next = !isFolded;
    if (id !== undefined) {
      if (next) folded.add(id);
      else folded.delete(id);
    }
    setFolded(next);
  };
  return (
    <>
      <Markdown
        text={body}
        className={isFolded ? 'cr-collapsed' : undefined}
        testId="thread-body"
        {...marked}
      />
      <button
        type="button"
        className="cr-fold"
        data-testid="thread-expand"
        aria-expanded={!isFolded}
        onClick={toggle}
      >
        {isFolded ? 'Show more' : 'Show less'}
        <Icon name={isFolded ? 'chevron-down' : 'chevron-up'} size={13} />
      </button>
    </>
  );
}

// ---------------------------------------------------------------- scrolling

/**
 * T392: something in the chat is about to open in place (a steps list).
 * The view stops following the bottom so what you opened stays where you
 * clicked, and follows again if you are still at the bottom afterwards.
 */
const ChatHold = createContext<() => void>(() => {});

/**
 * The chat's scroll area. `tick` changes whenever the content grows (a new
 * line, the thinking row, a decision card); `resetKey` is the conversation
 * (a different node starts at its bottom).
 */
export function ChatScroll({
  tick,
  resetKey,
  children,
  label,
}: PropsWithChildren<{ tick: unknown; resetKey: string; label?: string }>): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [unseen, setUnseen] = useState(false);

  const toBottom = useCallback((smooth = false) => {
    const el = ref.current;
    if (!el) return;
    if (smooth && typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
    pinned.current = true;
    setUnseen(false);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `resetKey` is the trigger: a new conversation opens at its end.
  useLayoutEffect(() => {
    toBottom();
  }, [resetKey, toBottom]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` is the trigger: the content grew.
  useLayoutEffect(() => {
    if (pinned.current) toBottom();
    else setUnseen(true);
  }, [tick]);

  const hold = useCallback(() => {
    pinned.current = false;
    // Two frames: after the opened content is laid out and observed.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el && isNearBottom(el)) pinned.current = true;
      }),
    );
  }, []);

  // Content that grows without a new line (text reflowing as a panel opens,
  // a card's buttons loading) keeps a pinned view at the bottom.
  useEffect(() => {
    const el = ref.current;
    const col = el?.firstElementChild;
    if (!el || !col || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(col);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="cr-chat-scroll-wrap">
      <div
        className="cr-chat-scroll"
        ref={ref}
        aria-label={label}
        onScroll={(e) => {
          const near = isNearBottom(e.currentTarget);
          pinned.current = near;
          if (near) setUnseen(false);
        }}
      >
        <div className="cr-chat-col">
          <ChatHold.Provider value={hold}>{children}</ChatHold.Provider>
        </div>
      </div>
      {unseen && (
        <button
          type="button"
          className="cr-chat-new"
          data-testid="chat-new-messages"
          onClick={() => toBottom(true)}
        >
          <Icon name="arrow-down" size={13} />
          New messages
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the message list

export type ChatEntry = Pick<ThreadEntry, 'ts' | 'by' | 'kind' | 'body' | 'ref' | 'agent_only'>;

const KIND_TAG: Partial<Record<ThreadEntry['kind'], { label: string; tone: string }>> = {
  question: { label: 'Question', tone: 'amber' },
  proposal: { label: 'Proposal', tone: 'accent' },
  finding: { label: 'Finding', tone: 'red' },
};

export interface MessageListProps<E extends ChatEntry> {
  entries: readonly E[];
  authorOf: (by: string) => ChatAuthor;
  /** The `data-by` each entry carries (the e2e suites read `human`, `daemon`, `agent`). */
  byAttr?: (by: string) => string;
  /** Hover actions beside Copy (a conversation's Branch off). */
  renderActions?: (entry: E, index: number) => ReactNode;
  /** Content under a message: a form, buttons, a "queued" marker. */
  renderExtra?: (entry: E, index: number) => ReactNode;
  /** A rule hit's "Open the rule". */
  onOpenRule?: (rule: string) => void;
  /**
   * T376: questions whose card is open below the chat. Their thread line folds
   * to one line pointing down, so the question doesn't read twice.
   */
  openQuestions?: ReadonlySet<string>;
  /**
   * T392: the steps that led to an entry, by its index (`groupSteps`): a
   * folded row at the top of an agent's reply, or before your line when a
   * turn ended without one.
   */
  steps?: ReadonlyMap<number, readonly AgentStep[]>;
  /**
   * T509: the agent's earlier messages of a turn, by the index of the
   * turn's reply (`narrationFolds`): they read inside its steps' fold, in
   * order with the steps, not as replies of their own.
   */
  narration?: ReadonlyMap<number, readonly E[]>;
  /**
   * T435: extra attributes on an entry's row, after its own (a conversation's
   * question, in the thread's list, is `data-testid="chat-question"`).
   */
  entryAttrs?: (entry: E, index: number) => Record<string, string> | undefined;
  /** T503 (D64): the passages of a turn its threads are anchored to; a click opens one. */
  marksOf?: (entry: E, index: number) => readonly PassageMark[] | undefined;
  onMark?: (thread: string) => void;
  /**
   * T447 (audit r7 #15): render only the newest `THREAD_WINDOW` rows of a
   * long thread; "Show earlier" (or scrolling to the top) adds more, and
   * find (Ctrl/⌘+F) shows them all. The value is the conversation: another
   * one starts from the newest rows again.
   */
  windowKey?: string;
  testid?: string;
  label?: string;
}

const defaultBy = (by: string): string => (by === 'human' || by === 'daemon' ? by : 'agent');

function Avatar({ author }: { author: ChatAuthor }): JSX.Element {
  const icon: IconName =
    author.name === 'agile' ? 'zap' : author.vendor === 'claude' ? 'sparkles' : 'bot';
  return (
    <span className="cr-avatar" data-vendor={author.vendor ?? author.name} aria-hidden="true">
      <Icon name={icon} size={13} />
    </span>
  );
}

function Time({ ts }: { ts: string }): JSX.Element {
  const at = new Date(ts);
  return (
    <time
      className="cr-msg-time"
      dateTime={ts}
      title={Number.isNaN(at.getTime()) ? ts : at.toLocaleString()}
    >
      {clockTime(ts)}
    </time>
  );
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const copy = useCopy();
  return (
    <IconButton
      icon="copy"
      label="Copy"
      size="sm"
      className="cr-msg-act"
      onClick={() => copy(text, 'Copied the message')}
    />
  );
}

/** The chat's scroll area around `el`. */
function scrollerOf(el: Element | null): HTMLElement | null {
  return el?.closest<HTMLElement>('.cr-chat-scroll') ?? null;
}

/**
 * T447 (audit r7 #15): a long thread's window. `more` is how many rows past
 * `THREAD_WINDOW` are shown; `showMore` adds a window's worth and keeps what
 * you were reading in place; scrolling near the top loads more by itself
 * (a scroll listener, so a jump to the top loads too); Ctrl/⌘+F shows every
 * row so the browser's find sees them. A new `key` (another conversation)
 * starts over. Set `hidden.current` to the rows still above on each render.
 */
function useThreadWindow(key: string | undefined): {
  more: number;
  showMore: () => void;
  list: RefObject<HTMLOListElement>;
  hidden: MutableRefObject<number>;
} {
  const [state, setState] = useState<{ key: string | undefined; more: number }>({ key, more: 0 });
  const more = state.key === key ? state.more : 0;
  const list = useRef<HTMLOListElement>(null);
  const hidden = useRef(0);
  // Distance from the bottom before rows were added above, to keep the view where it was.
  const keep = useRef<number | undefined>(undefined);
  const grow = useCallback(
    (by: number) => {
      const el = scrollerOf(list.current);
      if (el) keep.current = el.scrollHeight - el.scrollTop;
      setState((s) => ({ key, more: (s.key === key ? s.more : 0) + by }));
    },
    [key],
  );
  const showMore = useCallback(() => grow(THREAD_WINDOW), [grow]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `more` is the trigger: rows were added above.
  useLayoutEffect(() => {
    const el = scrollerOf(list.current);
    if (el && keep.current !== undefined) el.scrollTop = el.scrollHeight - keep.current;
    keep.current = undefined;
  }, [more]);
  // Near the top: the next window, once per scroll that gets there.
  useEffect(() => {
    const el = key === undefined ? null : scrollerOf(list.current);
    if (el === null) return;
    const onScroll = (): void => {
      if (hidden.current > 0 && keep.current === undefined && el.scrollTop < EARLIER_AT_PX) {
        showMore();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [key, showMore]);
  // Find in the page sees every row.
  useEffect(() => {
    if (key === undefined) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        grow(Number.MAX_SAFE_INTEGER / 2);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, grow]);
  return { more, showMore, list, hidden };
}

/** How near the top (px) a scroll loads the earlier rows. */
const EARLIER_AT_PX = 300;

export function MessageList<E extends ChatEntry>({
  entries,
  authorOf,
  byAttr = defaultBy,
  renderActions,
  renderExtra,
  onOpenRule,
  openQuestions,
  steps,
  narration,
  entryAttrs,
  marksOf,
  onMark,
  windowKey,
  testid = 'thread',
  label = 'Conversation',
}: MessageListProps<E>): JSX.Element {
  const all = chatRows(entries);
  const earlier = useThreadWindow(windowKey);
  const { rows, hidden } =
    windowKey === undefined
      ? { rows: all, hidden: 0 }
      : windowRows(all, THREAD_WINDOW + earlier.more);
  earlier.hidden.current = hidden;
  // T446: a system row links the node it made when the cockpit knows it.
  const streams = useOptionalFeed()?.cockpit?.streams;
  const known = (id: string): boolean => streams?.some((r) => r.id === id) === true;
  return (
    <ol className="cr-msgs" data-testid={testid} aria-label={label} ref={earlier.list}>
      {hidden > 0 && (
        <li className="cr-thread-earlier">
          <button
            type="button"
            className="cr-link"
            data-testid="thread-earlier"
            onClick={earlier.showMore}
          >
            <Icon name="arrow-up" size={12} />
            Show {Math.min(THREAD_WINDOW, hidden)} earlier{' '}
            {Math.min(THREAD_WINDOW, hidden) === 1 ? 'message' : 'messages'}
            <span className="cr-faint"> · {hidden} above</span>
          </button>
        </li>
      )}
      {rows.flatMap((row) => {
        const { entry, index, variant, continued, day, wake } = row;
        const key = `${entry.ts}:${index}`;
        const out: JSX.Element[] = [];
        if (day) {
          out.push(
            <li key={`day:${key}`} className="cr-day">
              <span>{day}</span>
            </li>,
          );
        }
        if (variant === 'rule_hit') {
          const rule = ruleHitOf(entry) as string;
          out.push(
            <li
              key={key}
              className="cr-msg"
              data-variant="system"
              data-testid="thread-rule-hit"
              data-kind={entry.kind}
              data-by="daemon"
              data-rule={rule}
            >
              <div className="cr-sys" data-tone="danger">
                <Icon name="shield-check" size={14} className="cr-sys-icon" />
                <div className="cr-sys-text">
                  <span className="cr-sys-lead">blocked by rule</span>
                  <Markdown text={ruleHitText(entry.body)} />
                </div>
                {onOpenRule && (
                  <button
                    type="button"
                    className="cr-link cr-sys-link"
                    data-testid="thread-rule-link"
                    onClick={() => onOpenRule(rule)}
                  >
                    Open the rule
                  </button>
                )}
                <Time ts={entry.ts} />
              </div>
            </li>,
          );
          return out;
        }
        if (variant === 'system') {
          const line =
            row.system ?? systemLine(entry.body, { by: entry.by, ref: entry.ref, known });
          out.push(
            <li
              key={key}
              className="cr-msg"
              data-variant="system"
              data-testid="thread-entry"
              data-kind={entry.kind}
              data-by={byAttr(entry.by)}
              data-actor={
                entry.by === 'coordinator' || entry.by === 'director' ? entry.by : undefined
              }
              {...entryAttrs?.(entry, index)}
            >
              <div
                className="cr-sys"
                data-tone={line.tone}
                title={line.text === entry.body ? undefined : entry.body}
              >
                <Icon name={line.icon} size={14} className="cr-sys-icon" />
                <div className="cr-sys-text">
                  <Markdown text={line.text} />
                </div>
                <Time ts={entry.ts} />
              </div>
              {renderExtra?.(entry, index)}
            </li>,
          );
          return out;
        }
        const author = authorOf(entry.by);
        const tag = KIND_TAG[entry.kind];
        const tools = (float: boolean) => (
          <div key="tools" className={`cr-msg-tools${float ? ' cr-msg-tools-float' : ''}`}>
            <Time ts={entry.ts} />
            <CopyButton text={entry.body} />
            {renderActions?.(entry, index)}
          </div>
        );
        const led = steps?.get(index) ?? [];
        const notes = narration?.get(index) ?? [];
        const fold =
          led.length > 0 || notes.length > 0 ? (
            <StepsFold key="steps" steps={led} notes={notes} />
          ) : undefined;
        if (variant === 'you') {
          if (fold) {
            out.push(
              <li key={`steps:${key}`} className="cr-msg" data-variant="steps">
                {fold}
              </li>,
            );
          }
          out.push(
            <li
              key={key}
              className="cr-msg"
              data-variant="you"
              data-testid="thread-entry"
              data-kind={entry.kind}
              data-by={byAttr(entry.by)}
              data-cont={continued ? 'true' : undefined}
              {...entryAttrs?.(entry, index)}
            >
              <div className="cr-you">
                {tools(false)}
                <div className="cr-bubble">
                  {entry.kind === 'answer' && (
                    <span className="cr-msg-tag" data-tone="amber">
                      <Icon name="corner-down-left" size={11} />
                      Answer
                    </span>
                  )}
                  <ThreadBody
                    body={entry.body}
                    id={entry.ts}
                    marks={marksOf?.(entry, index)}
                    onMark={onMark}
                  />
                </div>
              </div>
              {renderExtra?.(entry, index)}
            </li>,
          );
          return out;
        }
        const asked = entry.kind === 'question' ? questionIdOfRef(entry.ref) : undefined;
        const pending = asked !== undefined && openQuestions?.has(asked) === true;
        // T435 (#26): a worker's `propose_next` reads as the node it proposes, not the raw verb.
        const next = proposedNext(entry);
        out.push(
          <li
            key={key}
            className="cr-msg"
            data-variant="agent"
            data-testid="thread-entry"
            data-kind={entry.kind}
            data-by={byAttr(entry.by)}
            data-cont={continued ? 'true' : undefined}
            data-open-question={pending ? 'true' : undefined}
            // T499: Quote from it goes to its card's answer box.
            data-quote-target={pending ? asked : undefined}
            {...entryAttrs?.(entry, index)}
          >
            {!continued && (
              <div className="cr-msg-head">
                <Avatar author={author} />
                <span className="cr-msg-name">{author.name}</span>
                {author.role && <span className="cr-msg-role">{author.role}</span>}
                {wake && (
                  // T446 (audit r7 #17): the routine wake this reply answers, folded into it.
                  <span
                    className="cr-msg-wake"
                    data-testid="chat-wake"
                    title={new Date(wake.ts).toLocaleString()}
                  >
                    {wake.text} · {clockTime(wake.ts)}
                  </span>
                )}
              </div>
            )}
            {tools(true)}
            {fold}
            <div className="cr-msg-body">
              {tag && (
                <span className="cr-msg-tag" data-tone={tag.tone}>
                  {tag.label}
                  {pending ? (
                    <>
                      {' · answer below'}
                      <Icon name="arrow-down" size={11} />
                    </>
                  ) : null}
                </span>
              )}
              {next ? (
                <div className="cr-proposal-next" data-testid="proposal-next">
                  <div className="cr-proposal-next-title">
                    Next: <strong>{next.title}</strong>
                  </div>
                  <ThreadBody body={next.goal} />
                </div>
              ) : (
                <ThreadBody
                  body={agentWords(entry.body)}
                  id={entry.ts}
                  marks={marksOf?.(entry, index)}
                  onMark={onMark}
                />
              )}
            </div>
            {renderExtra?.(entry, index)}
          </li>,
        );
        return out;
      })}
    </ol>
  );
}

// ---------------------------------------------------------------- question threads

/**
 * T502 (D62, D63, design/chat-threads.md §5): a question is its thread. Under
 * the line that asked it: how many replies and where it stands ("Waiting on
 * Codex", "Settled: Integer cents"), then its lines, compact: your replies,
 * the agent's turns they caused, a re-ask, the answer. On a coordinator's
 * chat, `head` names the child and its question, and the lines are the
 * coordinator's own notes on it.
 */
export function QuestionThreadView({
  thread,
  lines,
  authorOf,
  head,
  testid = 'question-thread',
}: {
  thread: QuestionThread;
  lines: readonly ChatEntry[];
  authorOf: (by: string) => ChatAuthor;
  head?: ReactNode;
  testid?: string;
}): JSX.Element {
  const words = questionThreadWords(thread);
  return (
    <div
      className="cr-qthread"
      data-testid={testid}
      data-question={thread.question}
      data-state={thread.state}
      data-thread-on=""
    >
      {head}
      <div className="cr-qthread-meta">
        <Icon name="corner-down-right" size={12} />
        {thread.replies > 0 && (
          <span data-testid="question-thread-replies">{repliesText(thread.replies)}</span>
        )}
        <span className="cr-msg-tag" data-tone={words.tone} data-testid="question-thread-state">
          {words.text}
        </span>
      </div>
      {lines.length > 0 && (
        <ol className="cr-qthread-lines">
          {lines.map((entry) => {
            const tag =
              entry.kind === 'answer'
                ? 'Answer'
                : entry.kind === 'question'
                  ? 'Asked again'
                  : undefined;
            const body =
              entry.by === 'daemon'
                ? systemLine(entry.body, { by: entry.by, ref: entry.ref }).text
                : agentWords(entry.body);
            return (
              <li
                key={entry.ts}
                className="cr-qthread-line"
                data-testid="question-thread-entry"
                data-kind={entry.kind}
                data-by={defaultBy(entry.by)}
              >
                <div className="cr-qthread-who">
                  <span className="cr-msg-name">{authorOf(entry.by).name}</span>
                  {tag && (
                    <span className="cr-msg-tag" data-tone="amber">
                      {tag}
                    </span>
                  )}
                  <Time ts={entry.ts} />
                </div>
                <ThreadBody body={body} id={entry.ts} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- chat threads

/**
 * T503 (D60, D64, design/chat-threads.md §3a, §6): the marks under a turn,
 * one per thread on it, in passage order: what it is on ("banker's
 * rounding…", or the whole message), its replies, how long ago, where it
 * stands, and a dot with a count when it has replies you haven't read.
 */
export function ThreadMarks({
  threads,
  unreadOf,
  onOpen,
  open,
}: {
  threads: readonly ChatThread[];
  unreadOf: (thread: ChatThread) => number;
  onOpen: (thread: string) => void;
  /** The thread the panel shows. */
  open?: string;
}): JSX.Element {
  const several = threads.length > 1;
  return (
    // `data-thread-on` empty: a selection here starts no thread on the turn above.
    <div className="cr-tmarks" data-testid="thread-marks" data-thread-on="">
      {threads.map((thread) => {
        const unread = unreadOf(thread);
        const words = threadStateWords(thread);
        const label =
          thread.anchor.quote !== undefined || several ? anchorLabel(thread.anchor) : '';
        return (
          <button
            key={thread.id}
            type="button"
            className="cr-tmark"
            data-testid="thread-mark"
            data-thread={thread.id}
            data-state={thread.state}
            data-unread={unread > 0 ? 'true' : undefined}
            aria-pressed={open === thread.id}
            title="Open the thread"
            onClick={() => onOpen(thread.id)}
          >
            <Icon name="corner-down-right" size={12} />
            {label && <span className="cr-tmark-quote">{label}</span>}
            <span className="cr-tmark-count" data-testid="thread-mark-count">
              {threadRepliesText(thread.replies)}
            </span>
            <span className="cr-faint">· last {ago(thread.last_at) || 'now'}</span>
            {words && (
              <span className="cr-msg-tag" data-tone={words.tone} data-testid="thread-mark-state">
                {words.text}
              </span>
            )}
            {unread > 0 && (
              <span
                className="cr-tmark-unread"
                data-testid="thread-mark-unread"
                aria-label={`${unread} unread`}
              >
                {unread}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * T504 (D65, design/chat-threads.md §6a): the archived threads on a turn,
 * folded into "Archived threads (n)" at the end of its thread line: quiet
 * (no count, no tint), each one opens (read only) or is restored.
 */
export function ArchivedThreads({
  threads,
  onOpen,
  onRestore,
}: {
  threads: readonly ChatThread[];
  onOpen: (thread: string) => void;
  onRestore?: (thread: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="cr-tarchived" data-testid="archived-threads" data-thread-on="">
      <button
        type="button"
        className="cr-link cr-faint"
        data-testid="archived-threads-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="archive" size={12} />
        Archived threads ({threads.length})
      </button>
      {open && (
        <ul className="cr-tarchived-list">
          {threads.map((thread) => (
            <li key={thread.id} data-testid="archived-thread" data-thread={thread.id}>
              <button type="button" className="cr-link" onClick={() => onOpen(thread.id)}>
                {anchorLabel(thread.anchor, 40, 'the whole message')}
              </button>
              <span className="cr-faint">
                · {threadRepliesText(thread.replies)}
                {thread.archived?.forget ? ' · forgotten' : ''}
              </span>
              {onRestore && (
                <button
                  type="button"
                  className="cr-link"
                  data-testid="restore-thread"
                  title="Bring the thread back (the agent is told it is open again)"
                  onClick={() => onRestore(thread.id)}
                >
                  Restore
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** T503 (§4.1, §6): a link row under a main-flow line: the threads it replies to, or is asked in. */
export function ThreadLinks({
  lead,
  threads,
  onOpen,
  testid,
  whole,
}: {
  lead: string;
  threads: readonly ChatThread[];
  onOpen: (thread: string) => void;
  testid: string;
  /** How a thread on a whole message reads (it has no passage to quote). */
  whole: string;
}): JSX.Element {
  return (
    <div className="cr-tlinks" data-testid={testid} data-thread-on="">
      <Icon name="corner-down-right" size={12} />
      <span>{lead}</span>
      {threads.map((thread, i) => (
        <button
          key={thread.id}
          type="button"
          className="cr-link"
          data-testid="thread-link"
          data-thread={thread.id}
          onClick={() => onOpen(thread.id)}
        >
          {threads.length > 1 ? `${String.fromCharCode(9424 + i)} ` : ''}
          {anchorLabel(thread.anchor, 40, whole)}
        </button>
      ))}
    </div>
  );
}

/**
 * T503 (D60, D61, design/chat-threads.md §3a, §6): a thread in the side
 * panel (full screen on a phone): the turn it is on and the passage it
 * quotes, its lines, and a box to reply in it. A reply sent while the agent
 * works is queued until its turn ends, as a composer line is (D61). A new
 * thread (no `thread` yet) is the passage and the box: the first reply
 * starts it. A question asked in it shows here and in the main flow.
 */
export function ThreadPanel({
  thread,
  anchor,
  on,
  lines,
  authorOf,
  queued,
  sendBlocked,
  onSend,
  onClose,
  actions,
  lineExtra,
  notice,
}: {
  thread?: ChatThread;
  anchor: ThreadAnchor;
  /** The turn it is on, when the chat has it loaded. */
  on?: ChatEntry;
  lines: readonly ChatEntry[];
  authorOf: (by: string) => ChatAuthor;
  /** Your lines not delivered yet (queued until the agent's turn ends). */
  queued: ReadonlySet<string>;
  /** Why a reply can't be sent now; absent: it can. */
  sendBlocked?: string;
  onSend: (text: string) => Promise<void>;
  onClose: () => void;
  /** T504 (§6a, §7): the thread's ⋯ (Archive, Archive and forget, Compact now, Promote). */
  actions?: ReactNode;
  /** T504 (§6): under a line: moved here, by you; Move to main. */
  lineExtra?: (entry: ChatEntry) => ReactNode;
  /** T504: above the box: archived (Restore), or promoted to a tangent (its link). */
  notice?: ReactNode;
}): JSX.Element {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const box = useRef<HTMLTextAreaElement>(null);
  const words = thread ? threadStateWords(thread) : undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: focus once per thread (or new one) opened.
  useEffect(() => {
    box.current?.focus();
  }, [thread?.id, anchor.entry, anchor.quote]);
  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || sending || sendBlocked !== undefined) return;
    setSending(true);
    setError(undefined);
    try {
      await onSend(text);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };
  const author = on ? authorOf(on.by) : undefined;
  return (
    <aside
      className="cr-tpanel"
      data-testid="thread-panel"
      data-thread={thread?.id ?? ''}
      data-state={thread?.state ?? 'new'}
      data-archived={thread?.archived !== undefined ? 'true' : undefined}
      aria-label="Thread"
    >
      <div className="cr-tpanel-hd">
        <span className="cr-tpanel-title">
          {thread?.archived !== undefined ? 'Archived thread' : thread ? 'Thread' : 'New thread'}
        </span>
        {words && (
          <span className="cr-msg-tag" data-tone={words.tone} data-testid="thread-panel-state">
            {words.text}
          </span>
        )}
        {actions}
        <IconButton
          icon="x"
          label="Close the thread"
          size="sm"
          data-testid="thread-panel-close"
          onClick={onClose}
        />
      </div>
      <div className="cr-tpanel-body">
        <div className="cr-tpanel-on" data-testid="thread-panel-on">
          {author && (
            <div className="cr-qthread-who">
              <span className="cr-msg-name">{author.name}</span>
              {on && <Time ts={on.ts} />}
            </div>
          )}
          {anchor.quote !== undefined ? (
            <blockquote className="cr-tpanel-quote" data-testid="thread-panel-quote">
              {anchor.quote}
            </blockquote>
          ) : on ? (
            <p className="cr-tpanel-turn">
              {agentWords(on.body).replace(/\s+/g, ' ').slice(0, 280)}
            </p>
          ) : (
            <p className="cr-tpanel-turn cr-faint">The message is above the loaded lines.</p>
          )}
        </div>
        <ol className="cr-qthread-lines cr-tpanel-lines" data-testid="thread-panel-lines">
          {lines.map((entry) => (
            <li
              key={entry.ts}
              className="cr-qthread-line"
              data-testid="thread-panel-entry"
              data-kind={entry.kind}
              data-by={defaultBy(entry.by)}
            >
              <div className="cr-qthread-who">
                <span className="cr-msg-name">{authorOf(entry.by).name}</span>
                {entry.kind === 'question' && (
                  <span className="cr-msg-tag" data-tone="amber">
                    Question · also in the chat
                  </span>
                )}
                <Time ts={entry.ts} />
              </div>
              <ThreadBody
                body={entry.by === 'human' ? entry.body : agentWords(entry.body)}
                id={entry.ts}
              />
              {entry.by === 'human' && queued.has(entry.ts) && (
                <div className="cr-queued" data-testid="thread-queued">
                  <Icon name="clock" size={12} />
                  Not sent yet — queued until the agent’s current step ends
                </div>
              )}
              {lineExtra?.(entry)}
            </li>
          ))}
        </ol>
        {notice}
      </div>
      <form
        className="cr-tpanel-foot"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={box}
          data-testid="thread-reply-input"
          aria-label="Reply in the thread"
          placeholder={thread ? 'Reply in the thread…' : 'Start the thread…'}
          rows={2}
          value={draft}
          disabled={sending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {error && (
          <div className="cr-send-error" role="alert" data-testid="thread-reply-error">
            <Icon name="alert-circle" size={14} />
            <span>{error}</span>
          </div>
        )}
        <div className="cr-tpanel-actions">
          <span className="cr-faint">Enter to send · Shift+Enter for a new line</span>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            data-testid="thread-reply-send"
            busy={sending}
            disabled={draft.trim() === '' || sendBlocked !== undefined}
            title={sendBlocked}
          >
            Reply
          </Button>
        </div>
      </form>
    </aside>
  );
}

// ---------------------------------------------------------------- steps

function StepStatus({ state }: { state: StepState }): JSX.Element {
  return (
    <span
      className="cr-step-status"
      data-state={state}
      role="img"
      aria-label={STEP_STATE_LABEL[state]}
      title={STEP_STATE_LABEL[state]}
    >
      {state === 'running' ? (
        <Spinner size={11} />
      ) : (
        <Icon
          name={state === 'done' ? 'check' : state === 'failed' ? 'x' : 'circle-dashed'}
          size={13}
        />
      )}
    </span>
  );
}

/** One step: its kind's icon, its title (a command or a path in monospace), its status. */
export function StepRow({ step, live }: { step: AgentStep; live: boolean }): JSX.Element {
  const view = stepView(step);
  const state = stepState(step.status, live);
  return (
    <li
      className="cr-step"
      data-testid="step"
      data-kind={step.kind}
      data-status={state}
      title={view.full}
    >
      <Icon name={view.icon} size={13} className="cr-step-icon" />
      <span className="cr-step-title">
        {view.parts.map((part, i) =>
          part.code ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one title, in order.
            <code key={i}>{part.text}</code>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one title, in order.
            <span key={i}>{part.text}</span>
          ),
        )}
      </span>
      <StepStatus state={state} />
    </li>
  );
}

function StepList({
  steps,
  live,
  testid,
}: {
  steps: readonly AgentStep[];
  live: boolean;
  testid: string;
}): JSX.Element {
  return (
    <ol className="cr-step-list" data-testid={testid}>
      {steps.map((step) => (
        <StepRow key={stepKey(step)} step={step} live={live} />
      ))}
    </ol>
  );
}

/** A finished turn's steps, folded to one quiet row: "Worked through 12 steps · 1 failed". */
/**
 * T411: how full the agent's context window is, a small ring by its model
 * chip; amber from 75%, red from 90% (time to restart it fresh). The numbers
 * are its label and tooltip.
 */
export function ContextMeter({
  context,
}: {
  context: { used: number; size: number };
}): JSX.Element {
  const { percent, level, title } = contextMeter(context);
  const r = 5;
  const around = 2 * Math.PI * r;
  return (
    <span
      className="cr-context"
      data-testid="context-meter"
      data-level={level}
      data-percent={percent}
      title={title}
      role="img"
      aria-label={title}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle className="cr-context-track" cx="7" cy="7" r={r} />
        <circle
          className="cr-context-fill"
          cx="7"
          cy="7"
          r={r}
          strokeDasharray={`${(around * percent) / 100} ${around}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
      <span className="cr-context-text">{percent}%</span>
    </span>
  );
}

export function StepsFold({
  steps,
  notes = [],
}: {
  steps: readonly AgentStep[];
  /** T509: the agent's earlier messages of the turn, shown in order with the steps. */
  notes?: readonly { ts: string; body: string }[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const hold = useContext(ChatHold);
  const { label, failed } = stepsSummary(steps, notes.length);
  return (
    <div className="cr-steps" data-testid="steps-fold" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="cr-steps-toggle"
        data-testid="steps-toggle"
        aria-expanded={open}
        onClick={() => {
          hold();
          setOpen((v) => !v);
        }}
      >
        <Icon name="chevron-right" size={13} className="cr-steps-chev" />
        <span>{label}</span>
        {failed > 0 && (
          <>
            {' '}
            <span className="cr-steps-failed">· {failed} failed</span>
          </>
        )}
      </button>
      {open &&
        (notes.length === 0 ? (
          <StepList steps={steps} live={false} testid="steps-list" />
        ) : (
          <ol className="cr-step-list" data-testid="steps-list">
            {foldItems(steps, notes).map((item) =>
              'step' in item ? (
                <StepRow key={stepKey(item.step)} step={item.step} live={false} />
              ) : (
                <NarrationRow key={`note:${item.note.ts}`} body={item.note.body} />
              ),
            )}
          </ol>
        ))}
    </div>
  );
}

/** T509: one of the agent's earlier messages in its turn, inside the fold, in its words. */
function NarrationRow({ body }: { body: string }): JSX.Element {
  return (
    <li className="cr-step cr-step-note" data-testid="step-note">
      <Icon name="message-square" size={13} className="cr-step-icon" />
      <div className="cr-step-note-text">
        <Markdown text={agentWords(body)} />
      </div>
    </li>
  );
}

/**
 * "Claude is working…" while a turn is in flight, with its latest steps
 * (the newest five; "+N earlier steps" opens the rest) as they happen.
 */
/** T405: how long the turn has run, ticking once a second (only this re-renders). */
function Elapsed({ since }: { since: string }): JSX.Element | null {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  if (Number.isNaN(start)) return null;
  return (
    <span
      className="cr-thinking-time"
      data-testid="thinking-time"
      title={`Since ${clockTime(since)}`}
    >
      {elapsedText(now - start)}
    </span>
  );
}

export function Thinking({
  name,
  doing = 'working',
  steps = [],
  since,
}: {
  name: string;
  /** T400: "reviewing" while only a reviewer runs. */
  doing?: 'working' | 'reviewing';
  steps?: readonly AgentStep[];
  /** T405: when the turn began (`turnStartedAt`); the head says how long it has run. */
  since?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hold = useContext(ChatHold);
  const { shown, earlier } = liveWindow(steps, expanded);
  return (
    <div className="cr-thinking" data-testid="thinking" data-steps={steps.length}>
      <div className="cr-thinking-head">
        <span className="cr-avatar" aria-hidden="true">
          <Icon name="sparkles" size={13} />
        </span>
        <span className="cr-thinking-text" aria-live="polite">
          {name} is {doing}
        </span>
        <span className="cr-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {since !== undefined && <Elapsed since={since} />}
      </div>
      {steps.length > 0 && (
        <div className="cr-live-steps">
          {(earlier > 0 || (expanded && liveWindow(steps, false).earlier > 0)) && (
            <button
              type="button"
              className="cr-steps-earlier"
              data-testid="steps-earlier"
              aria-expanded={expanded}
              onClick={() => {
                hold();
                setExpanded((v) => !v);
              }}
            >
              <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
              {expanded ? 'Show fewer' : `+${earlier} earlier ${earlier === 1 ? 'step' : 'steps'}`}
            </button>
          )}
          <StepList steps={shown} live testid="live-steps" />
        </div>
      )}
    </div>
  );
}

/**
 * A node's steps, oldest first: the daemon's read, then every live
 * `tool_call` event for the node folded in. Read again when the socket
 * reconnects (events may have been missed while it was down).
 *
 * `read` fetches the first page (T399: the Director reads its own route). It
 * must be stable, such as a module-level function: a new one reads again.
 */
export function useSteps(
  node: string | undefined,
  read: (node: string) => Promise<StepPage> = getStreamSteps,
): {
  steps: AgentStep[];
  /** The daemon has more steps than it sent (the oldest turn's count may be short). */
  partial: boolean;
} {
  const { onEvent, connected } = useFeed();
  const [state, setState] = useState<{ node: string; steps: AgentStep[]; partial: boolean }>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `connected` is the trigger: a reconnect reads again.
  useEffect(() => {
    if (node === undefined) return;
    let alive = true;
    // Events that arrive while the read is in flight are folded in after it.
    let pending: StepUpdate[] | undefined = [];
    const off = onEvent((event) => {
      const update = stepUpdateOf(event, node);
      if (update === undefined) return;
      if (pending !== undefined) {
        pending.push(update);
        return;
      }
      setState((prev) => {
        if (prev?.node !== node) return { node, steps: applyStep([], update), partial: false };
        const steps = applyStep(prev.steps, update);
        return steps === prev.steps ? prev : { ...prev, steps };
      });
    });
    read(node)
      .then((page) => {
        if (!alive) return;
        const steps = stepsFromPage(page, pending);
        pending = undefined;
        setState({ node, steps, partial: page.total > page.steps.length });
      })
      .catch(() => {
        if (!alive) return;
        // No read (the daemon is restarting): keep what is shown, with what came live.
        const missed = pending ?? [];
        pending = undefined;
        setState((prev) => {
          const kept = prev?.node === node;
          let steps = kept ? prev.steps : [];
          for (const update of missed) steps = applyStep(steps, update);
          return { node, steps, partial: kept ? prev.partial : true };
        });
      });
    return () => {
      alive = false;
      off();
    };
  }, [node, read, onEvent, connected]);

  return state?.node === node && state !== undefined
    ? { steps: state.steps, partial: state.partial }
    : { steps: [], partial: false };
}

// ---------------------------------------------------------------- quote a selection

/** Where the Quote button sits: over the selection's middle, or under it near the window's top. */
interface QuoteSpot {
  x: number;
  y: number;
  below: boolean;
}

/** Room (px) above a selection the Quote button needs before it goes under the selection instead. */
const QUOTE_ROOM_PX = 44;

/**
 * T499: text selected inside `scope` (a chat message, a question card)
 * shows a small Quote button by the selection. Pressed, it hands the text
 * over with the question it was selected in — the nearest
 * `data-quote-target`, a question card or that question's own line — or
 * `undefined` outside one. With `outside` off it is offered only inside one.
 * A selection in a text box isn't a quote; nor is one still being dragged.
 */
export function QuoteSelection({
  scope,
  onQuote,
  onThread,
  outside = true,
}: {
  scope: RefObject<HTMLElement>;
  onQuote: (text: string, question: string | undefined) => void;
  /**
   * T503 (D64, §3a): Reply in thread, beside Quote, for a selection inside
   * one turn of the main flow (its row's `data-thread-on`, the turn's `ts`).
   */
  onThread?: (text: string, on: string) => void;
  outside?: boolean;
}): JSX.Element | null {
  const [spot, setSpot] = useState<QuoteSpot | undefined>(undefined);
  const picked = useRef<
    { text: string; question: string | undefined; on: string | undefined } | undefined
  >(undefined);

  useEffect(() => {
    let dragging = false;
    /** The selection worth a Quote button: its text, its question, and where it is. */
    const selected = ():
      | { text: string; question: string | undefined; on: string | undefined; range: Range }
      | undefined => {
      const root = scope.current;
      const selection = document.getSelection();
      if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const common = range.commonAncestorContainer;
      const within = common instanceof Element ? common : common.parentElement;
      if (!within || !root.contains(within) || within.closest('textarea, input, [contenteditable]'))
        return;
      const text = selection.toString();
      if (text.trim() === '') return;
      const question = within.closest('[data-quote-target]')?.getAttribute('data-quote-target');
      if (!question && !outside) return;
      // T503: the turn the selection is in (all of it in one turn), for Reply in thread.
      const on = within.closest('[data-thread-on]')?.getAttribute('data-thread-on');
      return { text, question: question || undefined, on: on || undefined, range };
    };
    const read = (): void => {
      const found = selected();
      picked.current = found && { text: found.text, question: found.question, on: found.on };
      if (!found) {
        setSpot(undefined);
        return;
      }
      const box = found.range.getBoundingClientRect();
      const below = box.top < QUOTE_ROOM_PX;
      setSpot({ x: box.left + box.width / 2, y: below ? box.bottom + 6 : box.top - 6, below });
    };
    const onChange = (): void => {
      if (!dragging) read();
    };
    const onDown = (event: PointerEvent): void => {
      if (event.target instanceof Element && event.target.closest('.cr-quote')) return;
      dragging = true;
    };
    const onUp = (): void => {
      if (!dragging) return;
      dragging = false;
      // Once the click that ends a drag has settled the selection.
      requestAnimationFrame(read);
    };
    document.addEventListener('selectionchange', onChange);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointerup', onUp);
    // The chat scrolls under a selection: the button follows it.
    window.addEventListener('scroll', onChange, true);
    window.addEventListener('resize', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointerup', onUp);
      window.removeEventListener('scroll', onChange, true);
      window.removeEventListener('resize', onChange);
    };
  }, [scope, outside]);

  if (spot === undefined) return null;
  const done = (): void => {
    document.getSelection()?.removeAllRanges();
    picked.current = undefined;
    setSpot(undefined);
  };
  const quoteButton = (inBar: boolean) => (
    <button
      type="button"
      className="cr-quote"
      data-testid="quote-selection"
      data-below={!inBar && spot.below ? 'true' : undefined}
      style={inBar ? undefined : { left: spot.x, top: spot.y }}
      title="Quote it in your answer (or, outside a question, in your message)"
      // Pressing it would clear the selection it quotes.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        const quote = picked.current;
        if (quote === undefined) return;
        onQuote(quote.text, quote.question);
        done();
      }}
    >
      <Icon name="quote" size={12} />
      Quote
    </button>
  );
  const on = picked.current?.on;
  if (onThread === undefined || on === undefined) {
    return createPortal(quoteButton(false), document.body);
  }
  // T503 (§3a): the bar's two actions: Quote, and Reply in thread on the passage.
  return createPortal(
    <div
      className="cr-quote-bar"
      data-testid="selection-bar"
      data-below={spot.below ? 'true' : undefined}
      style={{ left: spot.x, top: spot.y }}
    >
      {quoteButton(true)}
      <button
        type="button"
        className="cr-quote"
        data-testid="selection-thread"
        title="Start a thread on this passage: it is quoted, and highlighted in the message"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const picked_ = picked.current;
          if (picked_?.on === undefined) return;
          onThread(picked_.text, picked_.on);
          done();
        }}
      >
        <Icon name="message-square" size={12} />
        Reply in thread
      </button>
    </div>,
    document.body,
  );
}
