/**
 * T364: the decision card (design/cockpit-ui.md §7 "Decision cards"). One
 * anatomy for every Needs me item — a header (kind icon, what it is in
 * words, its age), the body (Markdown; long text folds with Show more), and
 * one row of actions, primary first — rendered in the Needs me list and,
 * with `full`, at the end of a node's chat.
 *
 *  - `question`     → its choices as buttons (one click answers); in the
 *                     list a compact typed answer too, in `full` the node
 *                     page's composer answers (manager decision, T363/T364)
 *  - `gate`         → Allow/Deny (a `land` gate reads Merge/Hold), with an
 *                     optional note sent as the reason, or on its own
 *  - `rule_accept`  → Accept/Retire a proposed rule, standard, decision…
 *  - `rule_batch`   → opens Knowledge filtered to that import (T163)
 *  - `plan_approve` → Approve plan (T281)
 *  - `plan_waiting` → Wake coordinator, or Start parts anyway (T344)
 *  - `proposal`     → Apply/Dismiss a change held at Advise (T282)
 *  - `done`         → Merge (T347, D36 D7), View changes
 *  - `blocked`      → shown; decided on the node's page
 *
 * The daemon's text is taken apart by `lib/inbox.ts` (pure, unit-tested);
 * this file only renders and calls the API.
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
  landStream,
  noteGate,
  startWaitingParts,
} from '../lib/api';
import { useOptionalFeed } from '../lib/feed-context';
import {
  type CardTone,
  branchName,
  cardTitle,
  cardTone,
  diffStatParts,
  fold,
  fullText,
  gateView,
  knowledgeView,
  noChangesText,
  planView,
  proposalOf,
  questionView,
  scopeWords,
  statusText,
} from '../lib/inbox';
import { useShell } from '../lib/shell';
import { ago } from '../lib/status';
import { Icon, type IconName } from './Icon';
import { Markdown } from './Markdown';
import { Button, Spinner } from './ui';

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

/** How long a card stays disabled after its action succeeded, waiting for the next frame to drop it. */
const SETTLE_MS = 10_000;

/**
 * One decision card. `full` is the node page's rendering: the whole text up
 * front, no link to the node (it is already open), and a question answered
 * from the page's composer rather than an input of its own.
 */
export function Card({
  item,
  onDone,
  full = false,
}: {
  item: InboxItem;
  onDone: () => void;
  full?: boolean;
}): JSX.Element {
  const { select, openRules } = useShell();
  const cockpit = useOptionalFeed()?.cockpit;
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  /** Which action is in flight ("approve", "choice:1", …). */
  const [busy, setBusy] = useState<string | undefined>(undefined);
  /** An action succeeded: the card waits, disabled, for the frame that removes it. */
  const [settled, setSettled] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  /** News that isn't a failure (a merge held by a ship check). */
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const noteRef = useRef<HTMLInputElement>(null);
  const text = draft.trim();
  const locked = busy !== undefined || settled !== undefined;

  useEffect(() => {
    if (settled === undefined) return;
    const timer = setTimeout(() => setSettled(undefined), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  useEffect(() => {
    if (noteOpen) noteRef.current?.focus();
  }, [noteOpen]);

  async function act(key: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(key);
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
      setDraft('');
      setSettled(key);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  /** Merge: a hold or a refusal is said on the card; anything else is done. */
  async function merge(): Promise<void> {
    setBusy('merge');
    setError(undefined);
    setNotice(undefined);
    try {
      const outcome = await landStream(item.id);
      if (outcome.status === 'refused' && outcome.held) setNotice(outcome.line);
      else if (outcome.status === 'refused') setError(outcome.reason);
      else if (outcome.status === 'blocked') {
        setError(
          `The merge into ${outcome.target} conflicts in ${outcome.conflicts.length} ${
            outcome.conflicts.length === 1 ? 'file' : 'files'
          }. Open the node to resolve it.`,
        );
      } else setSettled('merge');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  const row =
    item.stream !== undefined ? cockpit?.streams.find((r) => r.id === item.stream) : undefined;
  // T380: finished with no commits beyond its target: the move is Close, not Merge.
  const noChanges = item.kind === 'done' && row?.nothing_to_merge === true;
  const tone: CardTone = noChanges ? 'amber' : cardTone(item);
  const nodeTitle = item.stream !== undefined ? (row?.title ?? item.stream_path.at(-1)) : undefined;
  // T403: on the chat, where the card sits at the end (a project root opens on its Overview otherwise).
  const open = item.stream !== undefined ? () => select(item.stream, { tab: 'thread' }) : undefined;

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
      foldable = main.foldable;
      body = (
        <>
          <Markdown className="context" text={main.text} testId="inbox-context" />
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
                    onClick={() => act(key, () => answerQuestion(item.id, choice))}
                  >
                    <span className="cr-choice-key" aria-hidden="true">
                      {String.fromCharCode(65 + i)}
                    </span>
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
              if (text) void act('answer', () => answerQuestion(item.id, text));
            }}
          >
            <input
              data-testid="answer-input"
              aria-label="Your answer"
              value={draft}
              disabled={locked}
              placeholder={
                q.choices.length > 0 ? 'Or answer in your own words…' : 'Answer in your own words…'
              }
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              type="submit"
              size="sm"
              variant={q.choices.length > 0 ? 'secondary' : 'primary'}
              data-testid="answer-send"
              busy={busy === 'answer'}
              disabled={locked || text.length === 0}
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
                  disabled={locked}
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
            title="Accept: it applies from now on"
            onClick={() => act('accept', () => decideRule(item.id, 'accept'))}
          >
            Accept
          </Button>
          <Button
            size="sm"
            data-testid="rule-retire"
            busy={busy === 'retire'}
            disabled={locked}
            title="Retire: turn the proposal down; it never applies"
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
            onClick={() => act('wake', () => attachSession(item.id, 'worker'))}
          >
            Wake coordinator
          </Button>
          <Button
            size="sm"
            data-testid="plan-start-parts"
            busy={busy === 'start'}
            disabled={locked}
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
            onClick={() => act('apply', () => decideProposal(item.id, 'apply'))}
          >
            Apply
          </Button>
          <Button
            size="sm"
            data-testid="proposal-dismiss"
            busy={busy === 'dismiss'}
            disabled={locked}
            onClick={() => act('dismiss', () => decideProposal(item.id, 'dismiss'))}
          >
            Dismiss
          </Button>
        </div>
      );
      break;
    }

    case 'done': {
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
      const main = shown(statusText(item));
      foldable = main.foldable;
      body = <Markdown className="context" text={main.text} testId="inbox-context" />;
      actions = (
        <div className="cr-actions">
          <Button
            variant="primary"
            size="sm"
            icon="git-merge"
            data-testid="land"
            busy={busy === 'merge'}
            disabled={locked}
            onClick={() => void merge()}
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
      body = (
        <>
          <Markdown className="context" text={main.text} testId="inbox-context" />
          {full && <p className="cr-card-hint">Write below to help it on.</p>}
        </>
      );
      if (open && !full) {
        actions = (
          <div className="cr-actions">
            <Button size="sm" iconRight="arrow-right" data-testid="blocked-open" onClick={open}>
              Open node
            </Button>
          </div>
        );
      }
      break;
    }
  }

  return (
    <article
      className="cr-card"
      data-id={item.id}
      data-kind={item.kind}
      data-tone={tone}
      data-node-id={item.stream}
      data-full={full ? 'true' : undefined}
      data-settled={settled !== undefined ? 'true' : undefined}
      aria-labelledby={titleId}
      // The list moves focus between cards with j/k (Needs me); a card is never a tab stop.
      tabIndex={full ? undefined : -1}
    >
      <header className="cr-card-hd">
        <span className="cr-card-icon" data-tone={tone}>
          <Icon name={noChanges ? 'check-circle' : iconOf(item)} size={14} />
        </span>
        <span className="kind" id={titleId}>
          {noChanges ? 'Finished, no changes' : cardTitle(item)}
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
      {actions ? <div className="cr-card-ft">{actions}</div> : null}
      {notice && (
        <output className="cr-card-notice">
          <Icon name="info" size={14} />
          {notice}
        </output>
      )}
      {error && (
        <p className="cr-error" role="alert">
          <Icon name="alert-circle" size={14} />
          {error}
        </p>
      )}
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
