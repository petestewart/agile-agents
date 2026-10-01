/**
 * T364: the decision card (design/cockpit-ui.md §7 "Decision cards"). One
 * anatomy for every Needs me item — a header (kind icon, what it is in
 * words, its age), the body (Markdown; long text folds with Show more), and
 * one row of actions, primary first — rendered in the Needs me list and,
 * with `full`, at the end of a node's chat.
 *
 *  - `question`     → its choices as buttons (one click answers; on a
 *                     focused card in the list, A/B… or 1/2… picks), and
 *                     its own answer box (T499), one "Reply…" line until
 *                     it is focused; in `full` the chat's own line carries
 *                     the question's text (T416); T502 (D62): typed to a
 *                     choice question it is a Reply in its thread (the
 *                     question stays open; its agent settles it or asks
 *                     again), else the answer
 *  - `gate`         → Allow/Deny (a `land` gate reads Merge/Hold), with an
 *                     optional note sent as the reason, or on its own; a
 *                     held read (T457) reads Allow once, Always for this
 *                     project, Deny
 *  - `rule_accept`  → Accept/Retire a proposed rule, standard, decision…
 *  - `rule_batch`   → opens Knowledge filtered to that import (T163)
 *  - `plan_approve` → Approve plan (T281)
 *  - `plan_waiting` → Wake coordinator, or Start parts anyway (T344)
 *  - `proposal`     → Apply/Dismiss a change held at Advise (T282)
 *  - `done`         → Merge (T347, D36 D7; T416: the first one asks), View
 *                     changes; a refusal says why under it, with its fix
 *  - `blocked`      → a reply unblocks it (T416: "Reply to unblock…")
 *  - `harness_update` → Update (runs the CLI's update, says the result in
 *                     words) and Dismiss (until a newer version) (T481)
 *
 * While the daemon is away (`offline`) every action is off, and says why.
 * The daemon's text is taken apart by `lib/inbox.ts` and `lib/errors.ts`
 * (pure, unit-tested); this file only renders and calls the API.
 */

import { type HarnessId, type InboxItem, MESSAGE_BODY_MAX_CHARS } from '@agile-agents/shared';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import {
  alwaysGate,
  answerQuestion,
  approvePlan,
  attachSession,
  closeStream,
  decideGate,
  decideProposal,
  decideRule,
  dismissFinished,
  dismissHarnessUpdate,
  dismissModelStuck,
  getStreamDiff,
  getStreamPage,
  landStream,
  markStreamLanded,
  noteGate,
  replyToQuestion,
  sayOnStream,
  startWaitingParts,
  stopSessions,
  updateHarness,
} from '../lib/api';
import { proposalCardWords } from '../lib/autonomy';
import { parseDiff, tidyIds } from '../lib/chat';
import { answerDrafts, draftOf, setDraftOf, updateDraft, useAnswerDraft } from '../lib/drafts';
import {
  type MergeFix,
  RECONNECTING,
  mergeConflict,
  mergeRefusal,
  writeFailure,
} from '../lib/errors';
import { useOptionalFeed } from '../lib/feed-context';
import {
  type CardTone,
  DONE_CARD_TITLE,
  MERGED_OUTSIDE_TEXT,
  branchName,
  cardOutcome,
  cardTitle,
  cardTone,
  choiceKey,
  diffStatParts,
  doneCardOf,
  doneLine,
  fold,
  fullText,
  gateView,
  isAgentFailure,
  knowledgeView,
  mergeQuestion,
  noChangesText,
  overlapText,
  overlapTitles,
  planView,
  proposalOf,
  questionView,
  scopeWords,
  statusText,
  waitingText,
} from '../lib/inbox';
import { distinctTitle } from '../lib/names';
import { withQuote } from '../lib/quote';
import {
  appendToDraft,
  clearComments,
  formatReview,
  reviews,
  roomAfter,
  unsentReviewQuestion,
} from '../lib/review';
import { useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { Icon, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { Button, Dialog, IconButton, Kbd, Spinner } from './ui';

function iconOf(item: InboxItem): IconName {
  switch (item.kind) {
    case 'question':
      return 'help-circle';
    case 'gate':
      return item.context.startsWith('land:') ? 'git-merge' : 'shield-check';
    case 'rule_accept':
    case 'rule_batch':
      return 'book-open';
    case 'plan_approve':
      return 'list';
    case 'plan_waiting':
      return 'clock';
    case 'proposal':
      return 'sparkles';
    case 'done':
      return 'git-merge';
    case 'blocked':
      return 'alert-triangle';
    case 'harness_update':
      return item.harness?.failed === true ? 'alert-circle' : 'download';
    case 'model_stuck':
      return 'alert-triangle';
  }
}

/** T416: a Needs me item's glyph, for the ⌘K palette's Needs me rows. */
export const inboxIcon = iconOf;

/** "Sat 26 Sep, 10:04" — the age's tooltip. */
function fullTime(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** A routed call longer than this (a long bash command) folds behind Show more in the list. */
const ACTION_CLIP = 160;

/** A finished agent's line longer than this (or on several lines) clips to one line in the list. */
const LINE_CLIP = 90;

/** How long a card stays disabled after its action succeeded, waiting for the next frame to drop it. */
const SETTLE_MS = 10_000;

/** What went wrong on a card: in words, with the fix it names (a refused merge) as a button. */
interface CardError {
  title?: string;
  text: string;
  fix?: MergeFix;
}

// ---------------------------------------------------------------- the first Merge asks

const MERGE_ASK_KEY = 'agile.merge.ask';

/** T416: whether Merge asks first in this browser ("Don't ask again" turns it off). */
export function mergeAsks(): boolean {
  try {
    return window.localStorage.getItem(MERGE_ASK_KEY) !== 'never';
  } catch {
    // Storage blocked: ask every time, the safe side.
    return true;
  }
}

function stopAskingMerge(): void {
  try {
    window.localStorage.setItem(MERGE_ASK_KEY, 'never');
  } catch {
    // Not remembered: it asks again next time.
  }
}

export interface MergeAsk {
  /** The node's title. */
  node: string;
  /** The node's id: to read its target when the caller doesn't know it, and its review comments. */
  id?: string;
  target?: string;
  files?: number;
  pr?: boolean;
  /**
   * T436: "Add to message" on the unsent-review question, where the caller
   * does it its own way (the node's page opens its chat on the composer).
   * Absent, the review joins the node's draft and its chat opens.
   */
  onAddReview?: () => void;
}

/**
 * T436 (audit r6 #11): a node's review comments not sent yet, put in its
 * composer as one message, as the review bar's Add to message does, read
 * against the diff as it is now. `too_long` when they don't fit beside the
 * draft already there (the Changes tab's bar says what to cut).
 */
export async function addReviewToDraft(node: string): Promise<'added' | 'too_long'> {
  const comments = reviews.get(node).comments;
  if (comments.length === 0) return 'added';
  const files = parseDiff((await getStreamDiff(node)).patch);
  const draft = draftOf(node);
  const message = formatReview(comments, files, roomAfter(draft));
  if (!message.fits) return 'too_long';
  setDraftOf(node, appendToDraft(draft, message.text));
  clearComments(node);
  return 'added';
}

/** A card knows its node, not the branch it merges into: the node's page read says. */
function useMergeTarget(info: MergeAsk): string | undefined {
  const [target, setTarget] = useState(info.target);
  useEffect(() => {
    if (info.target !== undefined || info.id === undefined) return;
    let live = true;
    getStreamPage(info.id)
      .then((page) => {
        if (live && page.land?.target) setTarget(page.land.target);
      })
      .catch(() => {
        // "its target branch" stands in.
      });
    return () => {
      live = false;
    };
  }, [info.id, info.target]);
  return target;
}

/**
 * T416 (finding 38): the first Merge — from a card or a node's header —
 * asks "Merge <node> into <target> (<n> files)?", with "Don't ask again"
 * remembered in this browser; after that Merge is one click. A merge can't
 * be undone from the cockpit, so it asks rather than offering Undo.
 *
 * T436 (audit r6 #11): while the node has review comments not sent, every
 * Merge asks "1 review comment on <node> isn't sent. Merge anyway?", with
 * Add to message as the other button; that one question stands in for the
 * first-Merge one.
 */
export function useMergeAsk(): {
  /** Runs `merge` at once, or after the question when this browser still asks. */
  ask: (info: MergeAsk, merge: () => void) => void;
  dialog: ReactNode;
} {
  const { select } = useShell();
  const [pending, setPending] = useState<
    { info: MergeAsk; merge: () => void; unsent: number } | undefined
  >();
  const addReview = (info: MergeAsk): void => {
    if (info.onAddReview) {
      info.onAddReview();
      return;
    }
    const id = info.id;
    if (id === undefined) return;
    addReviewToDraft(id)
      .then((result) => select(id, { tab: result === 'added' ? 'thread' : 'diff' }))
      .catch(() => select(id, { tab: 'diff' }));
  };
  return {
    ask: (info, merge) => {
      const unsent = info.id !== undefined ? reviews.get(info.id).comments.length : 0;
      if (unsent === 0 && !mergeAsks()) {
        merge();
        return;
      }
      setPending({ info, merge, unsent });
    },
    dialog: !pending ? null : pending.unsent > 0 ? (
      <UnsentReviewDialog
        info={pending.info}
        count={pending.unsent}
        onCancel={() => setPending(undefined)}
        onAdd={() => {
          setPending(undefined);
          addReview(pending.info);
        }}
        onMerge={() => {
          setPending(undefined);
          pending.merge();
        }}
      />
    ) : (
      <MergeDialog
        info={pending.info}
        onCancel={() => setPending(undefined)}
        onConfirm={(never) => {
          if (never) stopAskingMerge();
          setPending(undefined);
          pending.merge();
        }}
      />
    ),
  };
}

function UnsentReviewDialog({
  info,
  count,
  onCancel,
  onAdd,
  onMerge,
}: {
  info: MergeAsk;
  count: number;
  onCancel: () => void;
  onAdd: () => void;
  onMerge: () => void;
}): JSX.Element {
  const target = useMergeTarget(info);
  const words = unsentReviewQuestion({
    node: info.node,
    count,
    ...(target !== undefined ? { target } : {}),
    ...(info.pr ? { pr: true } : {}),
  });
  return (
    <Dialog
      open
      onClose={onCancel}
      title={words.title}
      size="sm"
      testid="merge-unsent"
      onSubmit={onMerge}
      footer={
        <>
          <Button
            icon="corner-down-left"
            data-testid="merge-unsent-add"
            data-autofocus
            onClick={onAdd}
          >
            Add to message
          </Button>
          <Button type="submit" variant="primary" icon="git-merge" data-testid="merge-unsent-merge">
            {words.confirm}
          </Button>
        </>
      }
    >
      <p className="cr-confirm-text">{words.body}</p>
    </Dialog>
  );
}

function MergeDialog({
  info,
  onCancel,
  onConfirm,
}: {
  info: MergeAsk;
  onCancel: () => void;
  onConfirm: (never: boolean) => void;
}): JSX.Element {
  const [never, setNever] = useState(false);
  const target = useMergeTarget(info);
  const checkId = useId();
  const words = mergeQuestion({
    node: info.node,
    ...(target !== undefined ? { target } : {}),
    ...(info.files !== undefined ? { files: info.files } : {}),
    ...(info.pr ? { pr: true } : {}),
  });
  return (
    <Dialog
      open
      onClose={onCancel}
      title={words.title}
      size="sm"
      testid="merge-confirm"
      onSubmit={() => onConfirm(never)}
      footer={
        <>
          <label className="cr-merge-never" htmlFor={checkId}>
            <input
              id={checkId}
              type="checkbox"
              data-testid="merge-confirm-never"
              checked={never}
              onChange={(e) => setNever(e.target.checked)}
            />
            Don’t ask again
          </label>
          <Button onClick={onCancel}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            icon="git-merge"
            data-testid="merge-confirm-confirm"
            data-autofocus
          >
            {words.confirm}
          </Button>
        </>
      }
    >
      <p className="cr-confirm-text">{words.body}</p>
    </Dialog>
  );
}

// ---------------------------------------------------------------- a question's answer box

/** T499: how tall an open answer box starts, and how far it grows before it scrolls. */
const ANSWER_MIN_LINES = 3;
const ANSWER_MAX_LINES = 10;

/**
 * T499: Quote into a question's answer box: the selection joins its kept
 * answer as a Markdown quote, and the box opens with the caret after it.
 */
export function quoteIntoAnswer(question: string, selection: string): void {
  updateDraft(answerDrafts, question, (before) => withQuote(before, selection));
  requestAnimationFrame(() => {
    const box = document.querySelector<HTMLTextAreaElement>(
      `[data-answer-for="${CSS.escape(question)}"] textarea`,
    );
    if (!box) return;
    box.focus({ preventScroll: true });
    box.setSelectionRange(box.value.length, box.value.length);
    box.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * T499: a question card's own answer box. One "Reply…" line until it is
 * focused or clicked, then a box that grows from three lines to ten. Enter
 * sends, Shift+Enter is a new line (never mid-IME composition), Esc folds it
 * again. What is typed is kept per question (`useAnswerDraft`), across a
 * re-render and a reload; an empty box folds when it loses focus.
 */
function AnswerBox({
  question,
  choices,
  open,
  onOpen,
  sending,
  frozen,
  locked,
  title,
  onSend,
  talksBack = false,
}: {
  question: string;
  /** The card has choice buttons above: the box is for an answer of your own. */
  choices: boolean;
  /**
   * T502 (D62): what you type is a reply in its thread, not the answer: the
   * question stays open and its agent settles it or asks again ("Reply").
   */
  talksBack?: boolean;
  open: boolean;
  onOpen: (open: boolean) => void;
  sending: boolean;
  /** An action on the card is in flight or done: nothing more is typed. */
  frozen: boolean;
  /** No sending now (that, or the daemon is away; `title` says why). */
  locked: boolean;
  title: string | undefined;
  onSend: (text: string) => void;
}): JSX.Element {
  const [draft, setDraft] = useAnswerDraft(question);
  const area = useRef<HTMLTextAreaElement>(null);
  const text = draft.trim();

  // Folded, one line; open, three lines growing to ten with the text, past that it scrolls.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `draft` is a trigger too.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = '';
    if (!open) {
      el.style.overflowY = 'hidden';
      return;
    }
    const style = getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || 20;
    const border =
      Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.borderBottomWidth);
    const pad = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const min = line * ANSWER_MIN_LINES + pad + border;
    const max = line * ANSWER_MAX_LINES + pad + border;
    el.style.height = 'auto';
    // `scrollHeight` holds the padding, not the border (the box is border-box).
    const needed = el.scrollHeight + border;
    el.style.height = `${Math.min(Math.max(needed, min), max)}px`;
    el.style.overflowY = needed > max ? 'auto' : 'hidden';
  }, [draft, open]);

  const send = (): void => {
    if (text !== '' && !locked) onSend(text);
  };

  return (
    <form
      className="cr-answer"
      data-open={open ? 'true' : undefined}
      data-answer-for={question}
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="cr-answer-box">
        <Icon name="corner-down-left" size={13} />
        <textarea
          ref={area}
          data-testid="answer-input"
          aria-label="Your answer"
          rows={1}
          maxLength={MESSAGE_BODY_MAX_CHARS}
          value={draft}
          disabled={frozen}
          placeholder={choices ? 'Or write your own answer, or ask about it…' : 'Reply…'}
          onFocus={() => onOpen(true)}
          onBlur={() => {
            if (draft.trim() === '') onOpen(false);
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // Folds the box (what you wrote stays), and nothing else hears it.
              e.preventDefault();
              e.stopPropagation();
              onOpen(false);
              area.current?.blur();
              return;
            }
            // Enter sends; Shift+Enter is a newline; never mid-IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
      {open && (
        <div className="cr-answer-bar">
          <span className="cr-answer-keys" aria-hidden="true">
            <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> new line · <Kbd>Esc</Kbd>{' '}
            close
          </span>
          <Button
            type="submit"
            size="sm"
            // T416: one Answer everywhere: secondary while empty, primary once there is text.
            variant={text.length > 0 ? 'primary' : 'secondary'}
            data-testid="answer-send"
            busy={sending}
            disabled={locked || text.length === 0}
            title={title}
            // Keep the box's focus: a click here mustn't fold an empty box before it lands.
            onMouseDown={(e) => e.preventDefault()}
          >
            {talksBack ? 'Reply' : 'Answer'}
          </Button>
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------- the card

/**
 * One decision card. `full` is the node page's rendering: the whole text up
 * front, and no link to the node (it is already open). T416:
 * `questionText` is how much of a question the card repeats — `none` when
 * the chat right above already reads it, `line` (one line, to tell several
 * apart), `whole` otherwise. T499: while its answer box is open, a `line`
 * reads whole, and so does a long question in the list.
 */
export function Card({
  item,
  onDone,
  full = false,
  questionText = 'whole',
  onActing,
  gone = false,
}: {
  item: InboxItem;
  onDone: () => void;
  full?: boolean;
  questionText?: 'whole' | 'line' | 'none';
  /**
   * T445 (audit r7 #5): an action on it started here. The list keeps it
   * mounted if the frame drops it before the answer is back, and a moment
   * after, as its outcome.
   */
  onActing?: (item: InboxItem) => void;
  /** T445: it has left the list and stays a moment, collapsed to what was decided. */
  gone?: boolean;
}): JSX.Element {
  const { select, openRules } = useShell();
  const feed = useOptionalFeed();
  const cockpit = feed?.cockpit;
  const offline = feed?.offline === true;
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  // T499: a question's answer box; one with a kept answer opens with it (after a reload).
  const [answerOpen, setAnswerOpen] = useState(
    () => item.kind === 'question' && answerDrafts.get(item.id) !== undefined,
  );
  /** Which action is in flight ("approve", "choice:1", …). */
  const [busy, setBusy] = useState<string | undefined>(undefined);
  /** An action succeeded: the card waits, disabled, for the frame that removes it. */
  const [settled, setSettled] = useState<string | undefined>(undefined);
  const [error, setError] = useState<CardError | undefined>(undefined);
  /** News that isn't a failure (a merge held by a ship check, a message sent). */
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noteRef = useRef<HTMLInputElement>(null);
  /** T445: what was decided here ("Merged into main"), shown while the card stays after it left. */
  const [outcome, setOutcome] = useState<string | undefined>(undefined);
  const cardRef = useRef<HTMLElement>(null);
  /** Its height as a whole card, last measured: the outcome keeps it. */
  const wholeHeight = useRef<number | undefined>(undefined);
  const merging = useMergeAsk();
  const text = draft.trim();
  const locked = busy !== undefined || settled !== undefined || offline;
  /** A write button's tooltip: why it is off while the daemon is away, else its own. */
  const why = (title?: string): string | undefined => (offline ? RECONNECTING : title);

  useEffect(() => {
    if (settled === undefined) return;
    const timer = setTimeout(() => setSettled(undefined), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  // T445 (audit r7 #13): the pressed button goes disabled while it works, which drops focus to
  // <body>; the card itself keeps it, so the list knows where you were when the card leaves.
  const keepFocus = (): void => {
    const card = cardRef.current;
    if (!full && card && card.contains(document.activeElement) && document.activeElement !== card) {
      card.focus({ preventScroll: true });
    }
  };
  // T445 (audit r7 #5): once it has left the list, it keeps its height (nothing under the pointer
  // moves) and reads only as its outcome; the height is the whole card's, measured each render.
  const showOutcome = gone && outcome !== undefined;
  useLayoutEffect(() => {
    if (!showOutcome && cardRef.current !== null)
      wholeHeight.current = cardRef.current.offsetHeight;
  });
  const acting = (): void => {
    keepFocus();
    onActing?.(item);
  };
  const decided = (words: string): void => setOutcome(words);

  async function act(key: string, fn: () => Promise<unknown>, sent?: string): Promise<void> {
    acting();
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
      setDraft('');
      setSettled(key);
      if (sent !== undefined) setNotice(sent);
      decided(cardOutcome(item, key));
      onDone();
    } catch (err) {
      setError({
        text: writeFailure(err, 'Couldn’t reach the daemon; nothing was sent. Try again.'),
      });
    } finally {
      setBusy(undefined);
    }
  }

  const row =
    item.stream !== undefined ? cockpit?.streams.find((r) => r.id === item.stream) : undefined;
  const nodeTitle = item.stream !== undefined ? (row?.title ?? item.stream_path.at(-1)) : undefined;

  /** Merge: a hold is news on the card; a refusal says why under it, with its fix. */
  async function merge(): Promise<void> {
    acting();
    setBusy('merge');
    setError(undefined);
    setNotice(undefined);
    try {
      const outcome = await landStream(item.id);
      if (outcome.status === 'refused' && outcome.held) setNotice(tidyIds(outcome.line));
      else if (outcome.status === 'refused') {
        setError({ title: 'Couldn’t merge.', ...mergeRefusal(outcome.reason) });
      } else if (outcome.status === 'blocked') {
        setError({
          title: 'Couldn’t merge.',
          ...mergeConflict(outcome.target, outcome.conflicts),
        });
      } else {
        setSettled('merge');
        decided(
          outcome.status === 'pr_open'
            ? `Pull request #${outcome.pr.number} opened`
            : outcome.status === 'gated'
              ? 'Waiting for your OK to merge'
              : cardOutcome(item, 'merge', outcome.target),
        );
      }
      onDone();
    } catch (err) {
      setError({
        title: 'Couldn’t merge.',
        ...mergeRefusal(writeFailure(err, 'Couldn’t reach the daemon; nothing was merged.')),
      });
    } finally {
      setBusy(undefined);
    }
  }

  /** T481: a vendor CLI's Update: the daemon runs it and says what happened, in words. */
  async function runHarnessUpdate(id: HarnessId): Promise<void> {
    acting();
    setBusy('update');
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await updateHarness(id);
      if (result.ok) {
        setSettled('update');
        setNotice(result.message);
        decided(result.message);
      } else {
        setError({ text: result.message });
      }
      onDone();
    } catch (err) {
      setError({ text: writeFailure(err, 'Couldn’t reach the daemon; nothing was updated.') });
    } finally {
      setBusy(undefined);
    }
  }

  /** The fix a refusal named: a prepared message to the node's agent, or stopping it. */
  async function applyFix(fix: MergeFix): Promise<void> {
    const id = item.stream;
    if (id === undefined) return;
    setBusy('fix');
    try {
      if (fix.kind === 'stop') {
        await stopSessions(id);
        setNotice('The agent is stopped. Merge again when you’re ready.');
      } else {
        await sayOnStream(id, fix.message, { start: true });
        setNotice('Sent to the agent. Merge again once it says the branch is ready.');
      }
      setError(undefined);
      onDone();
    } catch (err) {
      setError((before) => ({
        ...(before ?? { text: '' }),
        text: writeFailure(err, 'Couldn’t reach the daemon; nothing was sent.'),
      }));
    } finally {
      setBusy(undefined);
    }
  }

  // T380/T412: a finished node's card follows the merge check: Close when there is nothing
  // to merge, Mark as merged when its branch is already in, and no Merge while it waits.
  const done = item.kind === 'done' ? doneCardOf(row) : undefined;
  const noChanges = done === 'no_changes';
  const tone: CardTone =
    done === 'no_changes' || done === 'merged_outside'
      ? 'amber'
      : done === 'waiting'
        ? 'gray'
        : cardTone(item);
  // T403: on the chat, where the card sits at the end (a project root opens on its Overview otherwise).
  const open = item.stream !== undefined ? () => select(item.stream, { tab: 'thread' }) : undefined;
  // T416 (finding 29): what else it touches, by name.
  const overlap =
    item.kind === 'done' && row?.overlap === true && item.stream !== undefined
      ? overlapText(
          overlapTitles(item.stream, cockpit?.overlaps ?? [], (id) =>
            // T446 (audit r7 #18): the project or parent in front when two nodes share a title.
            distinctTitle(id, cockpit?.streams ?? []),
          ),
        )
      : undefined;

  /** The card's main text: whole on the node page or once expanded; clipped to a line in the list. */
  const shown = (whole: string): { text: string; foldable: boolean } => {
    const folded = fold(whole);
    if (full || folded.long === undefined) return { text: whole, foldable: false };
    return { text: expanded ? whole : folded.short, foldable: true };
  };

  let body: ReactNode = null;
  let actions: ReactNode = null;
  let foldable = false;

  switch (item.kind) {
    case 'question': {
      const q = questionView(item);
      // T499: with its box open the question reads whole, beside what you write.
      const main = answerOpen ? { text: q.text, foldable: false } : shown(q.text);
      const textShown = answerOpen && questionText === 'line' ? 'whole' : questionText;
      foldable = main.foldable && textShown === 'whole';
      // Keys pick a choice on a focused card in the list (`Inbox`'s keys); the keycap says which.
      const keyed = !full;
      /** Answers it with a choice's words; the kept answer goes. */
      const answer = (key: string, words: string): Promise<void> =>
        act(key, async () => {
          await answerQuestion(item.id, words);
          answerDrafts.set(item.id, undefined);
        });
      // T502 (D62): what you type goes as written. To a choice question it is a reply in its
      // thread: the question stays open, waiting on its agent (it settles it or asks again).
      // To one with no choices it is the answer, as before. The daemon decides which.
      const talksBack = item.options !== undefined && item.options.length > 0;
      const reply = (words: string): Promise<void> =>
        act(talksBack ? 'reply' : 'answer', async () => {
          await replyToQuestion(item.id, words);
          answerDrafts.set(item.id, undefined);
        });
      body = (
        <>
          {textShown === 'whole' ? (
            <Markdown className="context" text={main.text} testId="inbox-context" />
          ) : textShown === 'line' ? (
            <p className="cr-card-quote" data-testid="inbox-context" title={q.text}>
              {q.text.replace(/\s+/g, ' ').trim()}
            </p>
          ) : null}
          {q.choices.length > 0 && (
            <fieldset className="cr-choices" aria-label="Choices">
              {q.choices.map((choice, i) => {
                const key = `choice:${i}`;
                return (
                  <button
                    // biome-ignore lint/suspicious/noArrayIndexKey: choices are positional and may repeat words.
                    key={i}
                    type="button"
                    className="cr-choice"
                    data-testid="answer-choice"
                    data-state={busy === key ? 'sending' : settled === key ? 'sent' : undefined}
                    disabled={locked}
                    title={why()}
                    aria-keyshortcuts={keyed ? `${choiceKey(i)} ${i + 1}` : undefined}
                    onClick={() => void answer(key, choice)}
                  >
                    {keyed && (
                      <span className="cr-choice-key" aria-hidden="true">
                        {choiceKey(i)}
                      </span>
                    )}
                    <span className="cr-choice-text">{choice}</span>
                    {busy === key ? (
                      <span className="cr-choice-state">
                        <Spinner size={12} />
                        Sending…
                      </span>
                    ) : settled === key ? (
                      <span className="cr-choice-state">
                        <Icon name="check" size={14} />
                        Sent
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </fieldset>
          )}
        </>
      );
      // Its text in the chat above and no choices: the card is its answer box alone.
      if (textShown === 'none' && q.choices.length === 0) body = null;
      actions = (
        <AnswerBox
          question={item.id}
          choices={q.choices.length > 0}
          open={answerOpen}
          onOpen={setAnswerOpen}
          talksBack={talksBack}
          sending={busy === 'answer' || busy === 'reply'}
          frozen={busy !== undefined || settled !== undefined}
          locked={locked}
          title={why()}
          onSend={(words) => void reply(words)}
        />
      );
      break;
    }

    case 'gate': {
      const g = gateView(item);
      // T457: a read the Ask posture held: Allow once, Always for this project, or Deny.
      const readRoot = item.read_root;
      const reason = shown(g.reason);
      const longAction = g.action !== undefined && !full && g.action.length > ACTION_CLIP;
      foldable = reason.foldable || longAction;
      const action = longAction && !expanded ? `${g.action?.slice(0, ACTION_CLIP - 1)}…` : g.action;
      body = (
        <div className="context cr-card-gate" data-testid="inbox-context">
          <p className="cr-card-lead">
            {g.land ? (
              'This merge waits for your OK. Merge it now, or hold it.'
            ) : readRoot !== undefined ? (
              <span data-testid="gate-read-lead">
                {nodeTitle ?? 'An agent'} wants to read <code title={readRoot}>{readRoot}</code>,
                outside the repos it can read. Allow it once, always for this project, or deny it.
              </span>
            ) : g.rule !== undefined || g.ruleId !== undefined ? (
              <>
                The classifier wasn’t sure this action follows{' '}
                {g.rule !== undefined ? (
                  <strong title={g.ruleId}>{g.rule}</strong>
                ) : (
                  <span title={g.ruleId}>one of your rules</span>
                )}
                . Allow it once, or deny it.
              </>
            ) : (
              'The classifier wasn’t sure this action is allowed. Allow it once, or deny it.'
            )}
          </p>
          {action !== undefined && (
            <code className="cr-card-action" title={g.action}>
              {action}
            </code>
          )}
          {g.land && g.branch !== undefined ? (
            <p className="cr-card-why">
              Merge <code title={g.branch}>{branchName(g.branch)}</code> into{' '}
              <code>{g.target}</code>
            </p>
          ) : (
            <div
              className="cr-card-why"
              title={
                g.probability !== undefined
                  ? `The classifier put the chance this breaks the rule at ${g.probability}`
                  : undefined
              }
            >
              <span className="cr-card-why-label">
                {g.rule !== undefined || g.ruleId !== undefined ? 'Rule' : 'Why'}
              </span>
              <Markdown text={reason.text} />
            </div>
          )}
        </div>
      );
      actions = (
        <>
          <div className="cr-actions">
            <Button
              variant="primary"
              size="sm"
              icon={g.land ? 'git-merge' : 'check'}
              data-testid="gate-approve"
              busy={busy === 'approve'}
              disabled={locked}
              title={why()}
              onClick={() =>
                act('approve', () => decideGate(item.id, 'approve', text || undefined))
              }
            >
              {g.land ? 'Merge' : readRoot !== undefined ? 'Allow once' : 'Allow'}
            </Button>
            {readRoot !== undefined && (
              <Button
                size="sm"
                icon="folder-git"
                data-testid="gate-always"
                busy={busy === 'always'}
                disabled={locked}
                title={why(`Every node in this project may read ${readRoot} from now on`)}
                onClick={() => act('always', () => alwaysGate(item.id, text || undefined))}
              >
                Always for this project
              </Button>
            )}
            <Button
              size="sm"
              data-testid="gate-deny"
              busy={busy === 'deny'}
              disabled={locked}
              title={why()}
              onClick={() => act('deny', () => decideGate(item.id, 'deny', text || undefined))}
            >
              {g.land ? 'Hold' : 'Deny'}
            </Button>
            {!noteOpen && (
              <Button
                variant="ghost"
                size="sm"
                icon="pencil"
                className="cr-card-note-toggle"
                data-testid="gate-add-note"
                disabled={locked}
                title={why()}
                onClick={() => setNoteOpen(true)}
              >
                Add a note
              </Button>
            )}
          </div>
          {noteOpen && (
            <div className="cr-card-note">
              <div className="cr-reply">
                <input
                  ref={noteRef}
                  data-testid="gate-note"
                  aria-label="Note"
                  value={draft}
                  disabled={busy !== undefined || settled !== undefined}
                  placeholder={
                    g.land ? 'A reason for Merge or Hold…' : 'A reason for Allow or Deny…'
                  }
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && text === '') setNoteOpen(false);
                  }}
                />
                <Button
                  size="sm"
                  data-testid="gate-send-note"
                  busy={busy === 'note'}
                  disabled={locked || text.length === 0}
                  title={why()}
                  onClick={() => act('note', () => noteGate(item.id, text))}
                >
                  Send note
                </Button>
              </div>
              <p className="cr-card-hint">
                Sent with {g.land ? 'Merge or Hold' : 'Allow or Deny'} — or on its own with Send
                note, leaving the decision open.
              </p>
            </div>
          )}
        </>
      );
      break;
    }

    case 'rule_accept': {
      const k = knowledgeView(item);
      const main = shown(k.text);
      foldable = main.foldable;
      const where = scopeWords(k.scope, {
        node: (id) => cockpit?.streams.find((r) => r.id === id)?.title,
        project: (id) => cockpit?.projects.find((p) => p.id === id)?.name,
      });
      body = (
        <>
          <Markdown className="context" text={main.text} testId="inbox-context" />
          <p className="cr-card-meta">
            {k.name !== undefined && <span className="cr-card-name">{k.name}</span>}
            {where !== undefined && <span>Applies to {where}</span>}
            <button
              type="button"
              className="cr-link"
              data-testid="rule-open"
              onClick={() => openRules({ status: 'proposed', scope: 'all', rule: item.id })}
            >
              Open in Knowledge
            </button>
          </p>
        </>
      );
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            icon="check"
            data-testid="rule-accept"
            busy={busy === 'accept'}
            disabled={locked}
            title={why('Accept: it applies from now on')}
            onClick={() => act('accept', () => decideRule(item.id, 'accept'))}
          >
            Accept
          </Button>
          <Button
            size="sm"
            data-testid="rule-retire"
            busy={busy === 'retire'}
            disabled={locked}
            title={why('Retire: turn the proposal down; it never applies')}
            onClick={() => act('retire', () => decideRule(item.id, 'retire'))}
          >
            Retire
          </Button>
        </div>
      );
      break;
    }

    case 'rule_batch': {
      body = <Markdown className="context" text={item.context} testId="inbox-context" />;
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            data-testid="rule-batch-open"
            iconRight="arrow-right"
            onClick={() => openRules({ status: 'proposed', scope: 'all', source: item.id })}
          >
            Review {item.rules?.length ?? 0} items
          </Button>
        </div>
      );
      break;
    }

    case 'harness_update': {
      const harness = item.harness;
      const main = shown(fullText(item));
      foldable = main.foldable;
      body = <Markdown className="context" text={main.text} testId="inbox-context" />;
      actions =
        harness !== undefined ? (
          <div className="cr-actions">
            <Button
              variant="primary"
              size="sm"
              icon="download"
              data-testid="harness-update"
              busy={busy === 'update'}
              disabled={locked}
              title={why(
                `Install the new version of ${harness.label}. Running agents keep the one they started on.`,
              )}
              onClick={() => void runHarnessUpdate(harness.id)}
            >
              Update
            </Button>
            <Button
              size="sm"
              data-testid="harness-dismiss"
              busy={busy === 'dismiss'}
              disabled={locked}
              title={why('Hide it until a newer version is out')}
              onClick={() => act('dismiss', () => dismissHarnessUpdate(harness.id))}
            >
              Dismiss
            </Button>
          </div>
        ) : null;
      break;
    }

    case 'model_stuck': {
      // T484 (§6): no rung left to step up to. Pick a stronger model with the chip, widen the
      // preset models in Details → Model choice, or dismiss it.
      const main = shown(fullText(item));
      foldable = main.foldable;
      body = (
        <>
          <Markdown className="context" text={main.text} testId="inbox-context" />
          <p className="cr-set-muted" data-testid="model-stuck-hint">
            Pick a stronger model with the model chip, or add one to the preset models in the node’s
            Details → Model choice.
          </p>
        </>
      );
      const node = item.stream;
      actions =
        node !== undefined ? (
          <div className="cr-actions">
            {open !== undefined ? (
              <Button
                variant="primary"
                size="sm"
                icon="arrow-right"
                data-testid="model-stuck-open"
                disabled={locked}
                onClick={open}
              >
                Open node
              </Button>
            ) : null}
            <Button
              size="sm"
              data-testid="model-stuck-dismiss"
              busy={busy === 'dismiss'}
              disabled={locked}
              title={why('Hide it; the next time the work stalls here it comes back')}
              onClick={() => act('dismiss', () => dismissModelStuck(node))}
            >
              Dismiss
            </Button>
          </div>
        ) : null;
      break;
    }

    case 'plan_approve': {
      const plan = planView(item);
      if (plan) {
        const lines = [
          plan.revised ? 'A revised plan: what changed since the approved one is marked.' : '',
          '**Parts**',
          ...(plan.owners.length > 0
            ? plan.owners.map((o) => `- ${o}`)
            : ['- No parts own anything yet']),
          ...(plan.contracts.length > 0
            ? ['', '**Contracts**', ...plan.contracts.map((c) => `- ${c}`)]
            : []),
        ].filter((line, i) => i > 0 || line !== '');
        body = (
          <Markdown
            className="context cr-card-plan"
            text={lines.join('\n')}
            testId="inbox-context"
          />
        );
      } else {
        const main = shown(fullText(item));
        foldable = main.foldable;
        body = <Markdown className="context" text={main.text} testId="inbox-context" />;
      }
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            icon="check"
            data-testid="plan-approve"
            busy={busy === 'approve'}
            disabled={locked}
            title={why()}
            onClick={() => act('approve', () => approvePlan(item.id))}
          >
            Approve plan
          </Button>
        </div>
      );
      break;
    }

    case 'plan_waiting': {
      const main = shown(fullText(item));
      foldable = main.foldable;
      body = <Markdown className="context" text={main.text} testId="inbox-context" />;
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            icon="play"
            data-testid="plan-wake"
            busy={busy === 'wake'}
            disabled={locked}
            title={why()}
            onClick={() => act('wake', () => attachSession(item.id, 'worker'))}
          >
            Wake coordinator
          </Button>
          <Button
            size="sm"
            data-testid="plan-start-parts"
            busy={busy === 'start'}
            disabled={locked}
            title={why()}
            onClick={() => act('start', () => startWaitingParts(item.id))}
          >
            Start parts anyway
          </Button>
        </div>
      );
      break;
    }

    case 'proposal': {
      const p = proposalOf(item);
      const main = shown(p.summary);
      foldable = main.foldable;
      // T446 (audit r7 #6): the level it is held at (a link to where it is set) and what Apply does.
      const project = cockpit?.projects.find((pr) => pr.id === row?.project);
      const principal = p.principal ?? 'coordinator';
      // T452: a coordinator's own level, where the node sets one, is the level it is held at.
      const own = principal === 'coordinator' ? row?.autonomy : undefined;
      const words = proposalCardWords({
        principal,
        summary: p.summary,
        where: own !== undefined ? row?.title : project?.name,
        level:
          project === undefined || /^Create the project |in a new project, /.test(p.summary)
            ? undefined
            : (own ?? project.autonomy?.[principal] ?? 'advise'),
      });
      body = (
        <>
          <Markdown className="context" text={main.text} testId="inbox-context" />
          <p className="cr-card-meta" data-testid="proposal-level">
            <span>
              {words.level !== '' && project !== undefined ? (
                <>
                  {words.where}{' '}
                  <button
                    type="button"
                    className="cr-link"
                    data-testid="proposal-level-link"
                    title={`Change it on ${own !== undefined && row !== undefined ? row.title : project.name}`}
                    onClick={() =>
                      select(own !== undefined && row !== undefined ? row.id : project.root)
                    }
                  >
                    {words.level}
                  </button>
                  {words.why}{' '}
                </>
              ) : (
                `${words.why} `
              )}
              {words.apply}
            </span>
          </p>
        </>
      );
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            icon="check"
            data-testid="proposal-apply"
            busy={busy === 'apply'}
            disabled={locked}
            title={why()}
            onClick={() => act('apply', () => decideProposal(item.id, 'apply'))}
          >
            Apply
          </Button>
          <Button
            size="sm"
            data-testid="proposal-dismiss"
            busy={busy === 'dismiss'}
            disabled={locked}
            title={why()}
            onClick={() => act('dismiss', () => decideProposal(item.id, 'dismiss'))}
          >
            Dismiss
          </Button>
        </div>
      );
      break;
    }

    case 'done': {
      if (done === 'merged_outside') {
        const main = shown(MERGED_OUTSIDE_TEXT);
        foldable = main.foldable;
        body = <Markdown className="context" text={main.text} testId="inbox-context" />;
        actions = (
          <div className="cr-actions">
            <Button
              variant="primary"
              size="sm"
              icon="git-merge"
              data-testid="mark-merged"
              busy={busy === 'mark'}
              disabled={locked}
              title={why()}
              onClick={() => {
                const id = item.stream;
                if (id !== undefined) void act('mark', () => markStreamLanded(id));
              }}
            >
              Mark as merged
            </Button>
            {open && !full && (
              <Button size="sm" iconRight="arrow-right" data-testid="merged-open" onClick={open}>
                Open node
              </Button>
            )}
          </div>
        );
        break;
      }
      if (done === 'waiting') {
        const waited = (row?.waits_on ?? []).map((id) => ({
          id,
          title: cockpit?.streams.find((r) => r.id === id)?.title ?? 'another node',
        }));
        const main = shown(waitingText(waited.map((w) => w.title)));
        foldable = main.foldable;
        body = <Markdown className="context" text={main.text} testId="inbox-context" />;
        const first = waited[0];
        actions = (
          <div className="cr-actions">
            {first !== undefined && (
              <Button
                size="sm"
                iconRight="arrow-right"
                data-testid="waited-open"
                onClick={() => select(first.id, { tab: 'thread' })}
              >
                Open {first.title}
              </Button>
            )}
            {open && !full && item.stream !== undefined && (
              <Button
                size="sm"
                icon="file-diff"
                data-testid="view-changes"
                onClick={() => select(item.stream, { tab: 'diff' })}
              >
                View changes
              </Button>
            )}
            {row?.diff_stat !== undefined && <DiffStatLine stat={row.diff_stat} />}
          </div>
        );
        break;
      }
      if (noChanges) {
        const main = shown(noChangesText(item));
        foldable = main.foldable;
        body = <Markdown className="context" text={main.text} testId="inbox-context" />;
        actions = (
          <div className="cr-actions">
            <Button
              variant="primary"
              size="sm"
              icon="x-circle"
              data-testid="close-empty"
              busy={busy === 'close'}
              disabled={locked}
              title={why()}
              onClick={() => {
                const id = item.stream;
                if (id !== undefined) void act('close', () => closeStream(id));
              }}
            >
              Close node
            </Button>
            {open && !full && (
              <Button size="sm" iconRight="arrow-right" data-testid="empty-open" onClick={open}>
                Open node
              </Button>
            )}
          </div>
        );
        break;
      }
      // T416 (finding 29): the agent's own last line, one line in the list; the stock
      // sentence every such card shared is gone (the title and the buttons say it).
      const line = doneLine(item);
      const long = line !== undefined && (line.length > LINE_CLIP || line.includes('\n'));
      foldable = !full && long;
      body =
        line !== undefined || overlap !== undefined ? (
          <>
            {line !== undefined && (
              <Markdown className="context" text={line} testId="inbox-context" />
            )}
            {overlap !== undefined && (
              <p className="cr-card-meta cr-card-overlap" data-testid="card-overlap">
                <Icon name="copy" size={13} />
                <span>{overlap}</span>
              </p>
            )}
          </>
        ) : null;
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            icon="git-merge"
            data-testid="land"
            busy={busy === 'merge'}
            disabled={locked}
            title={why()}
            onClick={() =>
              merging.ask(
                {
                  node: nodeTitle ?? 'this node',
                  ...(item.stream !== undefined ? { id: item.stream } : {}),
                  ...(row?.diff_stat !== undefined ? { files: row.diff_stat.files } : {}),
                  pr: cockpit?.repos.find((r) => r.name === row?.repo)?.delivery === 'pr',
                },
                () => void merge(),
              )
            }
          >
            Merge
          </Button>
          {open && !full && item.stream !== undefined && (
            <Button
              size="sm"
              icon="file-diff"
              data-testid="view-changes"
              // T410: straight to the Changes tab, which is what it names.
              onClick={() => select(item.stream, { tab: 'diff' })}
            >
              View changes
            </Button>
          )}
          {row?.diff_stat !== undefined && <DiffStatLine stat={row.diff_stat} />}
        </div>
      );
      break;
    }

    case 'blocked': {
      const main = shown(statusText(item));
      foldable = main.foldable;
      body = <Markdown className="context" text={main.text} testId="inbox-context" />;
      // T416 (finding 13): it's filed with the questions because it wants your words; a reply
      // unblocks it (a message to the node, which wakes its agent, or starts one).
      const id = item.stream;
      if (id !== undefined) {
        actions = (
          <form
            className="cr-reply"
            onSubmit={(e) => {
              e.preventDefault();
              if (text && !locked) {
                void act(
                  'reply',
                  () => sayOnStream(id, text, { start: true }),
                  'Sent. The agent reads it on its next turn.',
                );
              }
            }}
          >
            <input
              data-testid="blocked-reply"
              aria-label="Your reply"
              value={draft}
              disabled={busy !== undefined || settled !== undefined}
              placeholder={
                isAgentFailure(item.context)
                  ? 'Fix its login or install, then reply to start it again…'
                  : 'Reply to unblock…'
              }
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant={text.length > 0 ? 'primary' : 'secondary'}
              data-testid="blocked-send"
              busy={busy === 'reply'}
              disabled={locked || text.length === 0}
              title={why()}
            >
              Reply
            </Button>
          </form>
        );
      }
      break;
    }
  }

  const clampLine =
    item.kind === 'done' && done === 'ready' && !full && !expanded ? 'true' : undefined;

  if (showOutcome) {
    // T445 (audit r7 #5): decided here and gone from the list: its outcome, in its place, briefly.
    return (
      <article
        ref={cardRef}
        className="cr-card cr-card-outcome"
        data-id={item.id}
        data-kind={item.kind}
        data-node-id={item.stream}
        data-gone="true"
        data-testid="card-outcome"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={wholeHeight.current !== undefined ? { minHeight: wholeHeight.current } : undefined}
      >
        <output className="cr-card-outcome-line" id={titleId}>
          <Icon name="check" size={14} strokeWidth={2.5} />
          <span>{outcome}</span>
          {nodeTitle !== undefined && <span className="cr-card-outcome-node">{nodeTitle}</span>}
        </output>
      </article>
    );
  }

  return (
    <article
      ref={cardRef}
      className="cr-card"
      data-id={item.id}
      data-kind={item.kind}
      data-tone={tone}
      data-node-id={item.stream}
      data-full={full ? 'true' : undefined}
      data-settled={settled !== undefined ? 'true' : undefined}
      data-clamp={clampLine}
      // T499: Quote from a question goes to its own answer box.
      data-quote-target={item.kind === 'question' ? item.id : undefined}
      aria-labelledby={titleId}
      // The list moves focus between cards with j/k (Needs me); a card is never a tab stop.
      tabIndex={full ? undefined : -1}
    >
      <header className="cr-card-hd">
        <span className="cr-card-icon" data-tone={tone}>
          <Icon
            name={
              done === 'no_changes' ? 'check-circle' : done === 'waiting' ? 'clock' : iconOf(item)
            }
            size={14}
          />
        </span>
        <span className="kind" id={titleId}>
          {done !== undefined ? DONE_CARD_TITLE[done] : cardTitle(item)}
        </span>
        <time className="cr-card-age" dateTime={item.ts} title={fullTime(item.ts)}>
          {ago(item.ts)}
        </time>
        {!full && open && (
          <button
            type="button"
            className="cr-card-open"
            data-testid="open-stream"
            title={nodeTitle !== undefined ? `Open ${nodeTitle}` : 'Open the node'}
            onClick={open}
          >
            Open
            <Icon name="arrow-right" size={13} />
          </button>
        )}
        {item.kind === 'done' && item.stream !== undefined && (
          // T477: a Finished card goes away until the node's agent finishes again.
          <IconButton
            icon="x"
            size="sm"
            label="Dismiss"
            title="Dismiss. It comes back if the agent finishes again."
            className="cr-card-dismiss"
            data-testid="card-dismiss"
            disabled={locked}
            onClick={() => {
              const stream = item.stream as string;
              void act('dismiss', () => dismissFinished(stream));
            }}
          />
        )}
      </header>
      {body !== null && (
        <div className="cr-card-body">
          {body}
          {foldable && (
            <button
              type="button"
              className="cr-link cr-card-more"
              data-testid="card-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      {actions ? <div className="cr-card-ft">{actions}</div> : null}
      {notice && (
        <output className="cr-card-notice" data-testid="card-notice">
          <Icon name="info" size={14} />
          {notice}
        </output>
      )}
      {error && (
        <div className="cr-card-error" role="alert" data-testid="card-error">
          <Icon name="alert-circle" size={14} />
          <p className="cr-card-error-text">
            {error.title !== undefined && <strong>{error.title} </strong>}
            {error.text}
          </p>
          {error.fix !== undefined && item.stream !== undefined && (
            <Button
              size="sm"
              icon={error.fix.kind === 'stop' ? 'square' : 'send'}
              data-testid="card-fix"
              data-fix={error.fix.kind}
              busy={busy === 'fix'}
              disabled={locked}
              title={why(error.fix.kind === 'stop' ? undefined : error.fix.message)}
              onClick={() => {
                const fix = error.fix;
                if (fix) void applyFix(fix);
              }}
            >
              {error.fix.label}
            </Button>
          )}
        </div>
      )}
      {merging.dialog}
    </article>
  );
}

/** T410: "3 files · +120 −14", what Merge would bring. */
function DiffStatLine({
  stat,
}: {
  stat: { files: number; added: number; removed: number };
}): JSX.Element {
  const parts = diffStatParts(stat);
  return (
    <span className="cr-card-diffstat" data-testid="card-diffstat" title={parts.label}>
      <span>{parts.files}</span>
      <span className="cr-diffstat-added">{parts.added}</span>
      <span className="cr-diffstat-removed">{parts.removed}</span>
    </span>
  );
}
