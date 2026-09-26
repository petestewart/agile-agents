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
 *    opens to the list (T392); `useSteps` reads a node's steps and follows
 *    the live `tool_call` events. The rules are in `lib/steps.ts`.
 *
 * Every entry keeps `data-testid="thread-entry"` with `data-kind`/`data-by`
 * (a rule hit: `thread-rule-hit`), and every row's text stays in the DOM.
 */

import type { ThreadEntry } from '@agile-agents/shared';
import {
  type PropsWithChildren,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { getStreamSteps } from '../lib/api';
import {
  type ChatAuthor,
  chatRows,
  clockTime,
  isNearBottom,
  questionIdOfRef,
  ruleHitText,
  systemLine,
} from '../lib/chat';
import { useFeed } from '../lib/feed-context';
import {
  type AgentStep,
  STEP_STATE_LABEL,
  type StepPage,
  type StepState,
  type StepUpdate,
  applyStep,
  liveWindow,
  stepKey,
  stepState,
  stepUpdateOf,
  stepView,
  stepsFromPage,
  stepsSummary,
} from '../lib/steps';
import { ruleHitOf } from '../lib/streams';
import { Icon, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { IconButton, Spinner, useCopy } from './ui';

/** T330: past ~12 lines a thread entry renders collapsed, with a Show more / Show less toggle. */
export const THREAD_COLLAPSE_LINES = 12;

/** Long enough to collapse: more than 12 source lines, or ~12 wrapped lines of prose. */
export function isLongThreadBody(body: string): boolean {
  return (
    body.split('\n').length > THREAD_COLLAPSE_LINES || body.length > THREAD_COLLAPSE_LINES * 100
  );
}

export function ThreadBody({ body }: { body: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  if (!isLongThreadBody(body)) return <Markdown text={body} />;
  return (
    <>
      <Markdown
        text={body}
        className={expanded ? undefined : 'cr-collapsed'}
        testId="thread-body"
      />
      <button
        type="button"
        className="cr-fold"
        data-testid="thread-expand"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        {expanded ? 'Show less' : 'Show more'}
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={13} />
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

export function MessageList<E extends ChatEntry>({
  entries,
  authorOf,
  byAttr = defaultBy,
  renderActions,
  renderExtra,
  onOpenRule,
  openQuestions,
  steps,
  testid = 'thread',
  label = 'Conversation',
}: MessageListProps<E>): JSX.Element {
  const rows = chatRows(entries);
  return (
    <ol className="cr-msgs" data-testid={testid} aria-label={label}>
      {rows.flatMap((row) => {
        const { entry, index, variant, continued, day } = row;
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
          const line = systemLine(entry.body);
          out.push(
            <li
              key={key}
              className="cr-msg"
              data-variant="system"
              data-testid="thread-entry"
              data-kind={entry.kind}
              data-by={byAttr(entry.by)}
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
        const led = steps?.get(index);
        const fold = led && led.length > 0 ? <StepsFold key="steps" steps={led} /> : undefined;
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
                  <ThreadBody body={entry.body} />
                </div>
              </div>
              {renderExtra?.(entry, index)}
            </li>,
          );
          return out;
        }
        const asked = entry.kind === 'question' ? questionIdOfRef(entry.ref) : undefined;
        const pending = asked !== undefined && openQuestions?.has(asked) === true;
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
          >
            {!continued && (
              <div className="cr-msg-head">
                <Avatar author={author} />
                <span className="cr-msg-name">{author.name}</span>
                {author.role && <span className="cr-msg-role">{author.role}</span>}
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
              <ThreadBody body={entry.body} />
            </div>
            {renderExtra?.(entry, index)}
          </li>,
        );
        return out;
      })}
    </ol>
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
export function StepsFold({ steps }: { steps: readonly AgentStep[] }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hold = useContext(ChatHold);
  const { label, failed } = stepsSummary(steps);
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
      {open && <StepList steps={steps} live={false} testid="steps-list" />}
    </div>
  );
}

/**
 * "Claude is working…" while a turn is in flight, with its latest steps
 * (the newest five; "+N earlier steps" opens the rest) as they happen.
 */
export function Thinking({
  name,
  steps = [],
}: {
  name: string;
  steps?: readonly AgentStep[];
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const hold = useContext(ChatHold);
  const { shown, earlier } = liveWindow(steps, expanded);
  return (
    <div className="cr-thinking" data-testid="thinking" data-steps={steps.length}>
      <div className="cr-thinking-head" aria-live="polite">
        <span className="cr-avatar" aria-hidden="true">
          <Icon name="sparkles" size={13} />
        </span>
        <span className="cr-thinking-text">{name} is working</span>
        <span className="cr-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
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
