/**
 * The Sprint view (T044 — §17 "Control room v2", mockup `#s3`).
 *
 * Replaces T025's collapsible Board/Team/Feed panels with the three things
 * the mockup says an operator actually needs: the strip (where the sprint
 * is), Needs-you (what is waiting on them), and one story per ticket (what
 * happened, with timestamps) over the Team table (who is on it, finished
 * agents included).
 *
 * It renders from the snapshot the daemon already assembles — `stories` and
 * `team` are derived there (`packages/daemon/src/feed/stories.ts`,
 * `feed/snapshot.ts`), never here, so the page and `runs/*.md` cannot tell
 * different stories.
 */

import type { Halt, HilRequest, Policy, Question, Ticket } from '@agile-agents/shared';
import { useState } from 'react';
import type { FeedSnapshot } from '../../lib/feed-types';
import { NeedsYou } from '../NeedsYou';
import { Stories } from './Stories';
import { TeamTable } from './TeamTable';
import { TicketDetail } from './TicketDetail';

function money(quota: FeedSnapshot['quota']): string {
  const spend = quota.reduce((sum, q) => sum + (q.spend_usd ?? 0), 0);
  return spend > 0 ? `$${spend.toFixed(2)}` : '—';
}

function asksYou(gates?: Policy['gates']): string {
  if (!gates) return '—';
  const entries = Object.entries(gates);
  const human = entries.filter(([, owner]) => String(owner).startsWith('human'));
  if (entries.length === 0) return '—';
  if (human.length === 0) return 'Nothing';
  if (human.length === entries.length) return 'Everything';
  return `${human.length} of ${entries.length} gates`;
}

export function SprintView({
  snapshot,
  hil,
  questions,
  halts,
  tickets,
  policy,
  onChanged,
}: {
  snapshot?: FeedSnapshot;
  hil: HilRequest[];
  questions: Question[];
  halts: Halt[];
  tickets: Ticket[];
  policy?: Policy;
  onChanged: () => void;
}): JSX.Element {
  const [open, setOpen] = useState<string | undefined>(undefined);
  const sprint = snapshot?.sprint;
  const summary = sprint?.tickets ?? { done: 0, in_flight: 0, stale: 0, total: 0 };
  const stories = snapshot?.stories ?? [];
  const inQa = stories.filter((story) => story.status === 'in_qa').length;

  return (
    <div className="cr-sprint-view" data-testid="sprint-view">
      <div className="cr-strip" data-testid="sprint-strip">
        <div>
          <div className="k">Goal</div>
          <div className="v" style={{ fontSize: 14 }}>
            {sprint?.sprint?.goal ?? 'No sprint yet'}
          </div>
        </div>
        <div>
          <div className="k">Done</div>
          <div className="v">
            {summary.done} <small>of {summary.total}</small>
          </div>
        </div>
        <div>
          <div className="k">In QA</div>
          <div className="v">{inQa}</div>
        </div>
        <div>
          <div className="k">Blocked</div>
          <div className="v" data-testid="halt-count">
            {halts.length}
          </div>
        </div>
        <div>
          <div className="k">Spend</div>
          <div className="v">{money(snapshot?.quota ?? [])}</div>
        </div>
        <div>
          <div className="k">Asks you</div>
          <div className="v" style={{ fontSize: 14 }}>
            {asksYou(policy?.gates)}
          </div>
        </div>
      </div>

      <NeedsYou items={hil} questions={questions} onChanged={onChanged} />

      <Stories stories={stories} onOpen={setOpen} />

      <TeamTable team={snapshot?.team ?? []} />

      {open && (
        <TicketDetail ticketId={open} tickets={tickets} onClose={() => setOpen(undefined)} />
      )}
    </div>
  );
}
