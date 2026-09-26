/**
 * The inbox (cockpit design §3, §9.1) — T044's "Needs you" cards, renamed
 * and re-keyed to the daemon's derived `InboxItem`s. Grouped by stream,
 * oldest first, every card answered in place.
 *
 * T161: a context clipped at §3.2's 200 chars carries its full text as
 * `detail`; "Show all" expands it in place, and "Open stream" is the one
 * deliberate navigation (the stream page shows the card with its full
 * text, beside the thread it came from).
 *
 *  - `question`    → free text, delivered verbatim to the asking session
 *  - `gate`        → allow/deny (a `land` gate reads merge/hold), with the
 *                    typed reason as the note; the text alone is a note
 *  - `rule_accept` → accept / retire
 *  - `rule_batch`  → opens the rules screen filtered to that seed import (T163)
 *  - `plan_approve` → approve a coordinator's draft plan (T281)
 *  - `plan_waiting` → parts wait for a plan no coordinator is writing:
 *                     wake the coordinator, or start the parts anyway (T344)
 *  - `proposal`    → apply / dismiss a coordinator's change held at Advise (T282)
 *  - `done`        → merge (T347, D36 D7: the Delivery panel's word)
 *  - `blocked`     → shown, decided on the stream page
 */

import type { InboxItem } from '@agile-agents/shared';
import { useState } from 'react';
import {
  answerQuestion,
  approvePlan,
  attachSession,
  decideGate,
  decideProposal,
  decideRule,
  landStream,
  noteGate,
  startWaitingParts,
} from '../lib/api';
import { useShell } from '../lib/shell';
import { groupInbox } from '../lib/streams';
import { Markdown } from './Markdown';

const KIND_LABEL: Record<InboxItem['kind'], string> = {
  question: 'question',
  gate: 'decision',
  rule_accept: 'knowledge proposed',
  rule_batch: 'knowledge proposed',
  plan_approve: 'plan to approve',
  plan_waiting: 'waiting for the plan',
  proposal: 'coordinator proposal',
  blocked: 'blocked',
  done: 'ready to merge',
};

function waitingFor(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  return minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`;
}

/** A gate item's context leads with its gate name (`inbox/service.ts`), which is how a `land` gate is told from a `classifier_review` one. */
function isLandGate(item: InboxItem): boolean {
  return item.kind === 'gate' && item.context.startsWith('land:');
}

/**
 * One inbox card. `full` is the stream page's rendering: the whole text
 * up front and no "Open stream" (it is already open).
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
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const text = draft.trim();

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setDraft('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const land = isLandGate(item);

  return (
    <article className="cr-card" data-id={item.id} data-kind={item.kind}>
      <div className="kind">
        {item.knowledge_kind !== undefined
          ? `${item.knowledge_kind} proposed`
          : KIND_LABEL[item.kind]}{' '}
        · {waitingFor(item.ts)}
      </div>
      <Markdown
        className="context"
        text={(full || expanded) && item.detail !== undefined ? item.detail : item.context}
        testId="inbox-context"
      />
      {!full && (item.detail !== undefined || item.stream !== undefined) ? (
        <div className="cr-card-links">
          {item.detail !== undefined && (
            <button
              type="button"
              className="cr-link"
              data-testid="card-expand"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
          {item.stream !== undefined && (
            <button
              type="button"
              className="cr-link"
              data-testid="open-stream"
              onClick={() => select(item.stream)}
            >
              Open stream
            </button>
          )}
        </div>
      ) : null}

      {item.kind === 'question' && (
        <form
          className="cr-reply"
          onSubmit={(e) => {
            e.preventDefault();
            if (text) void act(() => answerQuestion(item.id, text));
          }}
        >
          <input
            data-testid="answer-input"
            aria-label="Your answer"
            value={draft}
            disabled={busy}
            placeholder="Answer in your own words…"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="cr-btn signal"
            data-testid="answer-send"
            disabled={busy || text.length === 0}
          >
            Answer
          </button>
        </form>
      )}

      {item.kind === 'gate' && (
        <>
          <div className="cr-actions">
            <button
              type="button"
              className="cr-btn signal"
              data-testid="gate-approve"
              disabled={busy}
              onClick={() => act(() => decideGate(item.id, 'approve', text || undefined))}
            >
              {land ? 'Merge' : 'Allow'}
            </button>
            <button
              type="button"
              className="cr-btn"
              data-testid="gate-deny"
              disabled={busy}
              onClick={() => act(() => decideGate(item.id, 'deny', text || undefined))}
            >
              {land ? 'Hold' : 'Deny'}
            </button>
          </div>
          <div className="cr-reply">
            <input
              data-testid="gate-note"
              aria-label="Reason or note"
              value={draft}
              disabled={busy}
              placeholder="Reason (sent with Allow/Deny), or a note on its own…"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button
              type="button"
              className="cr-btn"
              data-testid="gate-send-note"
              disabled={busy || text.length === 0}
              onClick={() => act(() => noteGate(item.id, text))}
            >
              Note
            </button>
          </div>
        </>
      )}

      {item.kind === 'rule_accept' && (
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn signal"
            data-testid="rule-accept"
            disabled={busy}
            onClick={() => act(() => decideRule(item.id, 'accept'))}
          >
            Accept
          </button>
          <button
            type="button"
            className="cr-btn"
            data-testid="rule-retire"
            disabled={busy}
            onClick={() => act(() => decideRule(item.id, 'retire'))}
          >
            Retire
          </button>
        </div>
      )}

      {item.kind === 'rule_batch' && (
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn signal"
            data-testid="rule-batch-open"
            onClick={() => openRules({ status: 'proposed', scope: 'all', source: item.id })}
          >
            Review {item.rules?.length ?? 0} items
          </button>
        </div>
      )}

      {item.kind === 'plan_approve' && (
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn signal"
            data-testid="plan-approve"
            disabled={busy}
            onClick={() => act(() => approvePlan(item.id))}
          >
            Approve plan
          </button>
        </div>
      )}

      {item.kind === 'plan_waiting' && (
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn signal"
            data-testid="plan-wake"
            disabled={busy}
            onClick={() => act(() => attachSession(item.id, 'worker'))}
          >
            Wake coordinator
          </button>
          <button
            type="button"
            className="cr-btn"
            data-testid="plan-start-parts"
            disabled={busy}
            onClick={() => act(() => startWaitingParts(item.id))}
          >
            Start parts anyway
          </button>
        </div>
      )}

      {item.kind === 'proposal' && (
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn signal"
            data-testid="proposal-apply"
            disabled={busy}
            onClick={() => act(() => decideProposal(item.id, 'apply'))}
          >
            Apply
          </button>
          <button
            type="button"
            className="cr-btn"
            data-testid="proposal-dismiss"
            disabled={busy}
            onClick={() => act(() => decideProposal(item.id, 'dismiss'))}
          >
            Dismiss
          </button>
        </div>
      )}

      {item.kind === 'done' && (
        <div className="cr-actions">
          <button
            type="button"
            className="cr-btn signal"
            data-testid="land"
            disabled={busy}
            onClick={() => act(() => landStream(item.id))}
          >
            Merge
          </button>
        </div>
      )}

      {error && (
        <p className="cr-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function Inbox({
  items,
  onChanged,
}: {
  items: readonly InboxItem[];
  onChanged: () => void;
}): JSX.Element {
  const groups = groupInbox(items);
  return (
    <section className="cr-inbox" data-testid="inbox">
      <div className="cr-inbox-hd">
        {/* T341: the view is "Needs me" in the top bar and the walkthrough; its heading agrees. */}
        <h1>Needs me</h1>
        <span className="cr-count" data-testid="inbox-count">
          {items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="cr-calm" data-testid="inbox-empty">
          Nothing needs you.
        </p>
      ) : (
        groups.map((group) => (
          <div className="cr-group" key={group.key} data-stream={group.key}>
            <h2 data-testid="inbox-group">{group.label}</h2>
            {group.items.map((item) => (
              <Card key={item.id} item={item} onDone={onChanged} />
            ))}
          </div>
        ))
      )}
    </section>
  );
}
