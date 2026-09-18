import type { Event, TicketId } from '@agile-agents/shared';
import { useCallback, useEffect, useState } from 'react';
import { useFeed } from '../../lib/feed-context';
import { useShell } from '../../lib/shell';
import { BriefPane } from './BriefPane';
import { DecisionsPane } from './DecisionsPane';
import { KnowledgePane } from './KnowledgePane';
import { PolicyPane } from './PolicyPane';
import { QuestionsPane } from './QuestionsPane';
import { RulesPane } from './RulesPane';
import { SprintsPane } from './SprintsPane';
import { TicketsPane } from './TicketsPane';
import { type PlanOverview, getPlanOverview } from './plan-api';

/**
 * The Plan screen (T042 — design §17 "Control room v2": "Plan screen = the
 * documents + the EM chat. Left rail, one entry per artifact family, each
 * opening a pane that renders the files and edits them ... Any pane can be
 * closed (X) and the chat widens; the rail collapses to icons.").
 *
 * Everything it renders comes from `GET /api/plan` (one round trip, the
 * panes are small and always shown together) and every edit goes back
 * through a daemon verb — the panes never write a file. A live `/ws` event
 * that changes any of it refetches, debounced.
 *
 * The chrome is T043's and this component only consumes it: the single `/ws`
 * connection through `useFeed()` (never its own socket), the rail-collapse
 * and pane-open state through `useShell()` (the tool row's left button
 * toggles the rail; closing a pane widens the chat), the view switch for
 * "Open Settings", and the one action — **Start Sprint N** — in the top bar,
 * not here.
 */

export type PaneId =
  | 'brief'
  | 'rules'
  | 'questions'
  | 'decisions'
  | 'tickets'
  | 'sprints'
  | 'knowledge'
  | 'policy';

const RAIL: Array<{ id: PaneId; label: string }> = [
  { id: 'brief', label: 'Brief' },
  { id: 'rules', label: 'Rules' },
  { id: 'questions', label: 'Questions' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'sprints', label: 'Sprints' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'policy', label: 'Who decides' },
];

/** Event kinds that change something a pane renders (`store.ts` mints all of them). */
const PLAN_REFRESH_KINDS = new Set<Event['kind']>([
  'ticket_put',
  'ticket_reexamined',
  'state_transition',
  'oracle_put',
  'kb_put',
  'entity_put',
  'sprint_put',
  'policy_put',
  'question_raised',
  'question_answered',
]);

const REFRESH_DEBOUNCE_MS = 150;

export function PlanScreen(): JSX.Element {
  const { onEvent } = useFeed();
  const { railCollapsed, middleOpen, setMiddleOpen, setView } = useShell();
  const [overview, setOverview] = useState<PlanOverview | undefined>(undefined);
  const [pane, setPane] = useState<PaneId>('tickets');
  const [selected, setSelected] = useState<TicketId | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      setOverview(await getPlanOverview());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The shell's one socket, not a second connection of this screen's own.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onEvent((event) => {
      if (!PLAN_REFRESH_KINDS.has(event.kind)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [onEvent, refresh]);

  /** Selecting a rail entry re-opens the middle pane (the shell pulls the chat back out of `max`). */
  function openPane(id: PaneId): void {
    setPane(id);
    setMiddleOpen(true);
  }

  const counts: Record<PaneId, string> = {
    brief: overview?.brief.stub ? '—' : '1',
    rules: String(overview?.rules.length ?? 0),
    questions: String(overview?.questions.filter((q) => q.status === 'open').length ?? 0),
    decisions: String(overview?.decisions.length ?? 0),
    tickets: String(overview?.tickets.length ?? 0),
    sprints: String(overview?.sprints.rows.length ?? 0),
    knowledge: String(overview?.knowledge.length ?? 0),
    policy: 'policy',
  };

  // The detail panel's blocked-by/blocks come from the sprint projection,
  // which carries them per row ticket. A ticket in no projected row (a done
  // one, or one already claimed by the running sprint) is rebuilt from the
  // ticket list so clicking it still opens a detail panel.
  const detail = (() => {
    if (selected === undefined || !overview) return undefined;
    const fromRows = overview.sprints.rows.flatMap((r) => r.tickets).find((t) => t.id === selected);
    if (fromRows) return fromRows;
    const ticket = overview.tickets.find((t) => t.id === selected);
    if (!ticket) return undefined;
    const done = new Set(overview.tickets.filter((t) => t.status === 'done').map((t) => t.id));
    return {
      id: ticket.id,
      title: ticket.title,
      status: ticket.status,
      blocked_by: ticket.depends.filter((dep) => !done.has(dep)),
      blocks: overview.tickets
        .filter((t) => t.status !== 'done' && t.depends.includes(ticket.id))
        .map((t) => t.id),
      stub: ticket.stub,
    };
  })();
  return (
    <section
      className={`cr-plan${railCollapsed ? ' mini' : ''}`}
      data-testid="plan-screen"
      data-rail={railCollapsed ? 'collapsed' : 'expanded'}
    >
      {error && (
        <p style={{ color: 'var(--danger)' }} data-testid="plan-error">
          {error}
        </p>
      )}

      <div className={`plan${railCollapsed ? ' mini' : ''}${middleOpen ? '' : ' nopane'}`}>
        <nav className="rail" aria-label="Plan documents">
          {RAIL.map((entry) => (
            <button
              key={entry.id}
              type="button"
              title={entry.label}
              className={pane === entry.id ? 'on' : undefined}
              aria-pressed={pane === entry.id}
              data-testid={`rail-${entry.id}`}
              onClick={() => openPane(entry.id)}
            >
              <span className="lbl">{entry.label}</span>
              <span className="n">{counts[entry.id]}</span>
            </button>
          ))}
          <div className="path">
            Everything here is a file under .agile/ on the agile-state branch. Edit in the UI,
            through the EM, or in your editor; all three write the same file.
          </div>
        </nav>

        {middleOpen && overview && (
          <div>
            <div className="cr-plan-paneclose">
              <button
                type="button"
                className="cr-icon-btn"
                data-testid="pane-close"
                title="Close this pane and widen the chat"
                onClick={() => setMiddleOpen(false)}
              >
                ✕
              </button>
            </div>
            {pane === 'brief' && <BriefPane brief={overview.brief} onChanged={refresh} />}
            {pane === 'rules' && <RulesPane rules={overview.rules} onChanged={refresh} />}
            {pane === 'questions' && (
              <QuestionsPane questions={overview.questions} onChanged={refresh} />
            )}
            {pane === 'decisions' && (
              <DecisionsPane decisions={overview.decisions} onChanged={refresh} />
            )}
            {pane === 'tickets' && (
              <TicketsPane
                tickets={overview.tickets}
                onChanged={refresh}
                onSelect={(id) => setSelected(id)}
              />
            )}
            {pane === 'sprints' && (
              <SprintsPane
                board={overview.sprints}
                onChanged={refresh}
                onSelect={(id) => setSelected(id)}
              />
            )}
            {pane === 'knowledge' && (
              <KnowledgePane facts={overview.knowledge} onChanged={refresh} />
            )}
            {pane === 'policy' && (
              <PolicyPane
                {...(overview.policy ? { policy: overview.policy } : {})}
                onOpenSettings={() => setView('settings')}
              />
            )}

            {detail && (
              <div className="rule" data-testid={`ticket-detail-${detail.id}`}>
                <span className="id">Ticket detail · {detail.id}</span> <b>{detail.title}</b>
                <dl className="kv">
                  <dt>Blocked by</dt>
                  <dd className="mono" data-testid="detail-blocked-by">
                    {detail.blocked_by.length > 0 ? detail.blocked_by.join(', ') : 'nothing'}
                  </dd>
                  <dt>Blocks</dt>
                  <dd className="mono" data-testid="detail-blocks">
                    {detail.blocks.length > 0 ? detail.blocks.join(', ') : 'nothing'}
                  </dd>
                  <dt>Contract</dt>
                  <dd>{detail.stub ? 'stub, expanded when blockers land' : 'refined'}</dd>
                </dl>
                <button type="button" className="cr-link" onClick={() => setSelected(undefined)}>
                  close
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
