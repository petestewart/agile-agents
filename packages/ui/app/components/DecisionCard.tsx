/**
 * T364: the decision card (design/cockpit-ui.md §7 "Decision cards"). One
 * anatomy for every Needs me item — a header (kind icon, what it is in
 * words, its age), the body (Markdown; long text folds with Show more), and
 * one row of actions, primary first — rendered in the Needs me list and,
 * with `full`, at the end of a node's chat.
 *
 *  - `question`     → its choices as buttons (one click answers; on a
 *                     focused card in the list, A/B… or 1/2… picks); in the
 *                     list a compact typed answer too, in `full` the node
 *                     page's composer answers, and the chat's own line
 *                     carries the question's text (T416)
 *  - `gate`         → Allow/Deny (a `land` gate reads Merge/Hold), with an
 *                     optional note sent as the reason, or on its own
 *  - `rule_accept`  → Accept/Retire a proposed rule, standard, decision…
 *  - `rule_batch`   → opens Knowledge filtered to that import (T163)
 *  - `plan_approve` → Approve plan (T281)
 *  - `plan_waiting` → Wake coordinator, or Start parts anyway (T344)
 *  - `proposal`     → Apply/Dismiss a change held at Advise (T282)
 *  - `done`         → Merge (T347, D36 D7; T416: the first one asks), View
 *                     changes; a refusal says why under it, with its fix
 *  - `blocked`      → a reply unblocks it (T416: "Reply to unblock…")
 *
 * While the daemon is away (`offline`) every action is off, and says why.
 * The daemon's text is taken apart by `lib/inbox.ts` and `lib/errors.ts`
 * (pure, unit-tested); this file only renders and calls the API.
 */

import type { InboxItem } from '@agile-agents/shared';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import {
  answerQuestion,
  approvePlan,
  attachSession,
  closeStream,
  decideGate,
  decideProposal,
  decideRule,
  getStreamPage,
  landStream,
  markStreamLanded,
  noteGate,
  sayOnStream,
  startWaitingParts,
  stopSessions,
} from '../lib/api';
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
  cardTitle,
  cardTone,
  choiceKey,
  diffStatParts,
  doneCardOf,
  doneLine,
  fold,
  fullText,
  gateView,
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
import { useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { Icon, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { Button, Dialog, Spinner } from './ui';

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
  /** The node's id, to read its target when the caller doesn't know it. */
  id?: string;
  target?: string;
  files?: number;
  pr?: boolean;
}

/**
 * T416 (finding 38): the first Merge — from a card or a node's header —
 * asks "Merge <node> into <target> (<n> files)?", with "Don't ask again"
 * remembered in this browser; after that Merge is one click. A merge can't
 * be undone from the cockpit, so it asks rather than offering Undo.
 */
export function useMergeAsk(): {
  /** Runs `merge` at once, or after the question when this browser still asks. */
  ask: (info: MergeAsk, merge: () => void) => void;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<{ info: MergeAsk; merge: () => void } | undefined>();
  return {
    ask: (info, merge) => {
      if (!mergeAsks()) {
        merge();
        return;
      }
      setPending({ info, merge });
    },
    dialog: pending ? (
      <MergeDialog
        info={pending.info}
        onCancel={() => setPending(undefined)}
        onConfirm={(never) => {
          if (never) stopAskingMerge();
          setPending(undefined);
          pending.merge();
        }}
      />
    ) : null,
  };
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
  const [target, setTarget] = useState(info.target);
  const checkId = useId();
  // A card knows its node, not the branch it merges into: the node's page read says.
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

// ---------------------------------------------------------------- the card

/**
 * One decision card. `full` is the node page's rendering: the whole text up
 * front, no link to the node (it is already open), and a question answered
 * from the page's composer rather than an input of its own. T416:
 * `questionText` is how much of a question the card repeats — `none` when
 * the chat right above already reads it, `line` (one line, to tell several
 * apart), `whole` otherwise.
 */
export function Card({
  item,
  onDone,
  full = false,
  questionText = 'whole',
}: {
  item: InboxItem;
  onDone: () => void;
  full?: boolean;
  questionText?: 'whole' | 'line' | 'none';
}): JSX.Element {
  const { select, openRules } = useShell();
  const feed = useOptionalFeed();
  const cockpit = feed?.cockpit;
  const offline = feed?.offline === true;
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  /** Which action is in flight ("approve", "choice:1", …). */
  const [busy, setBusy] = useState<string | undefined>(undefined);
  /** An action succeeded: the card waits, disabled, for the frame that removes it. */
  const [settled, setSettled] = useState<string | undefined>(undefined);
  const [error, setError] = useState<CardError | undefined>(undefined);
  /** News that isn't a failure (a merge held by a ship check, a message sent). */
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noteRef = useRef<HTMLInputElement>(null);
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

  async function act(key: string, fn: () => Promise<unknown>, sent?: string): Promise<void> {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
      setDraft('');
      setSettled(key);
      if (sent !== undefined) setNotice(sent);
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
    setBusy('merge');
    setError(undefined);
    setNotice(undefined);
    try {
      const outcome = await landStream(item.id);
      if (outcome.status === 'refused' && outcome.held) setNotice(outcome.line);
      else if (outcome.status === 'refused') {
        setError({ title: 'Couldn’t merge.', ...mergeRefusal(outcome.reason) });
      } else if (outcome.status === 'blocked') {
        setError({
          title: 'Couldn’t merge.',
          ...mergeConflict(outcome.target, outcome.conflicts),
        });
      } else setSettled('merge');
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
          overlapTitles(
            item.stream,
            cockpit?.overlaps ?? [],
            (id) => cockpit?.streams.find((r) => r.id === id)?.title,
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
      const main = shown(q.text);
      foldable = main.foldable && questionText === 'whole';
      // Keys pick a choice on a focused card in the list (`Inbox`'s keys); the keycap says which.
      const keyed = !full;
      body = (
        <>
          {questionText === 'whole' ? (
            <Markdown className="context" text={main.text} testId="inbox-context" />
          ) : questionText === 'line' ? (
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
                    onClick={() => act(key, () => answerQuestion(item.id, choice))}
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
          {full ? (
            <p className="cr-card-hint" data-testid="answer-hint">
              <Icon name="corner-down-left" size={13} />
              {q.choices.length > 0 ? '…or type your answer below' : 'Type your answer below'}
            </p>
          ) : null}
        </>
      );
      if (!full) {
        actions = (
          <form
            className="cr-reply"
            onSubmit={(e) => {
              e.preventDefault();
              if (text && !locked) void act('answer', () => answerQuestion(item.id, text));
            }}
          >
            <input
              data-testid="answer-input"
              aria-label="Your answer"
              value={draft}
              disabled={busy !== undefined || settled !== undefined}
              placeholder={
                q.choices.length > 0 ? 'Or answer in your own words…' : 'Answer in your own words…'
              }
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              // T416: one Answer everywhere: secondary while empty, primary once there is text.
              variant={text.length > 0 ? 'primary' : 'secondary'}
              data-testid="answer-send"
              busy={busy === 'answer'}
              disabled={locked || text.length === 0}
              title={why()}
            >
              Answer
            </Button>
          </form>
        );
      }
      break;
    }

    case 'gate': {
      const g = gateView(item);
      const reason = shown(g.reason);
      const longAction = g.action !== undefined && !full && g.action.length > ACTION_CLIP;
      foldable = reason.foldable || longAction;
      const action = longAction && !expanded ? `${g.action?.slice(0, ACTION_CLIP - 1)}…` : g.action;
      body = (
        <div className="context cr-card-gate" data-testid="inbox-context">
          <p className="cr-card-lead">
            {g.land ? (
              'This merge waits for your OK. Merge it now, or hold it.'
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
              {g.land ? 'Merge' : 'Allow'}
            </Button>
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
      body = (
        <>
          <Markdown className="context" text={main.text} testId="inbox-context" />
          <p className="cr-card-meta">
            <span>
              {p.principal === 'director' ? 'The Director' : 'Its coordinator'} asks first at this
              autonomy level.
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
              placeholder="Reply to unblock…"
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

  return (
    <article
      className="cr-card"
      data-id={item.id}
      data-kind={item.kind}
      data-tone={tone}
      data-node-id={item.stream}
      data-full={full ? 'true' : undefined}
      data-settled={settled !== undefined ? 'true' : undefined}
      data-clamp={clampLine}
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
