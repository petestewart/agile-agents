import type { Event, KbIndex, OracleIndex, Policy, Ticket } from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatPanel } from './components/ChatPanel';
import { OraclePanel } from './components/OraclePanel';
import { Panel } from './components/Panel';
import { Settings } from './components/Settings';
import { ToolRow } from './components/ToolRow';
import { TopBar } from './components/TopBar';
import { PlanScreen } from './components/plan/PlanScreen';
import { ReviewView } from './components/review/ReviewView';
import { SprintView } from './components/sprint/SprintView';
import { getKbIndex, getOracleIndex, getPolicy, getSnapshot, getTickets } from './lib/api';
import { useFeed } from './lib/feed-context';
import type { FeedSnapshot } from './lib/feed-types';
import { useShell } from './lib/shell';

/**
 * T044: the Sprint slot carries three bodies — the sprint itself, the
 * sprint-review narrative (which the shell switches to on its own once a
 * `sprint_review` gate is pending), and T025's Oracle/KB reader.
 */
type Tab = 'ops' | 'review' | 'oracle';

/**
 * QA round 1 (REJECT): an external change (e.g. a ticket status flipped
 * through the store by an agent) never reached the Board/Team/Oracle/KB
 * panels without a full manual reload — `hil`/`halts`/`quota` come from the
 * live `/ws` snapshot, but `agents`/`tickets`/`oracle`/`kb`/`policy` were
 * only ever (re)pulled on mount or after *this browser's own* write.
 * These are the event kinds `store.ts` mints for exactly those entities
 * (`event.ts`'s enumeration) — any of them arriving over `/ws` means one of
 * those five reads is now stale.
 */
const REFRESH_TRIGGER_KINDS = new Set<Event['kind']>([
  'ticket_put',
  'state_transition',
  'stanza_appended',
  'oracle_put',
  'kb_put',
  'agent_put',
  'agent_deleted',
  'policy_put',
  // T040: a question raised or answered elsewhere changes the Needs-you
  // queue, which rides on `/api/snapshot`.
  'question_raised',
  'question_answered',
  // T043: the top bar renders the current sprint and the halt count from
  // `/api/snapshot`, so an externally started sprint (`agile run`, the EM
  // loop) or a halt raised from the CLI has to reach the bar without a
  // reload — the `/ws` snapshot frame only arrives on (re)connect.
  'sprint_put',
  'halt_created',
  'halt_updated',
  'halt_released',
]);

/** Coalesces a burst of triggering events (e.g. a ticket transition plus its stanza) into one refetch. */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * T032: `store.ts`'s `heartbeat()` mints an `agent_put` with `data:
 * {heartbeat: true}` on every coalesced ~30s liveness beat (see its own doc
 * comment — it's the ONLY caller that sets this field; every other
 * `agent_put` writer, e.g. `putAgent`/spawn/exit, sends `data: {}` or a
 * `warning`). A live session heartbeats roughly once every 30s per agent,
 * which — before this — fired the full six-endpoint `refreshAux` every
 * time, for no observable UI change (agents/tickets/oracle/kb/policy don't
 * change on a heartbeat, only `last_seen` inside `snapshot.agents`, which
 * heartbeat-only updates don't even need to reflect immediately). Treat
 * this one event shape as a no-refetch signal so a room full of idle agents
 * doesn't spam the daemon every 30s, while any other `agent_put` (a role
 * change, a new registration, a real status flip) still refetches as before.
 */
function isHeartbeatOnlyEvent(event: Event): boolean {
  return event.kind === 'agent_put' && event.data?.heartbeat === true;
}

/**
 * Control room shell.
 *
 * T025 built it as one screen (sprint strip + collapsible panels + chat).
 * T043 puts the §17 v2 chrome around it: one top bar on every view
 * (`TopBar`), a thin tool row under it (`ToolRow`), and three views — Plan
 * (T042's), Sprint and Settings (`Settings`, spend + "Who decides"). T044
 * replaced the Sprint slot's T025 panels with the §17 v2 bodies: the sprint
 * itself (`components/sprint/SprintView`), the sprint-review narrative
 * (`components/review/ReviewView`) and T025's Oracle/KB reader. The single `/ws`
 * connection lives in `FeedProvider` (`lib/feed-context.tsx`) and the chrome
 * state in `ShellProvider` (`lib/shell.tsx`); this component owns only the
 * HTTP-sourced reads and the layout.
 */
export function App(): JSX.Element {
  const { snapshot: liveSnapshot, connected, onEvent } = useFeed();
  const { view, chatMode, middleOpen } = useShell();
  const [snapshot, setSnapshot] = useState<FeedSnapshot | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('ops');
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [oracle, setOracle] = useState<OracleIndex>({});
  const [kb, setKb] = useState<KbIndex>({});
  const [policy, setPolicy] = useState<Policy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-pulls every HTTP-sourced read, `/api/snapshot` included. Called both
  // after every write this browser makes (so its own resolved HIL request,
  // raised halt or policy edit shows immediately) and, debounced, whenever
  // `/ws` reports one of `REFRESH_TRIGGER_KINDS`.
  const refreshAux = useCallback(async () => {
    try {
      const [t, o, k, p, snap] = await Promise.all([
        getTickets(),
        getOracleIndex(),
        getKbIndex(),
        getPolicy(),
        getSnapshot(),
      ]);
      setTickets(t);
      setOracle(o);
      setKb(k);
      setPolicy(p);
      setSnapshot(snap);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = undefined;
      void refreshAux();
    }, REFRESH_DEBOUNCE_MS);
  }, [refreshAux]);

  useEffect(() => {
    void refreshAux();
    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refreshAux]);

  /**
   * The `/ws` snapshot and `refreshAux`'s `GET /api/snapshot` feed ONE piece
   * of state, newest write wins. Preferring the socket's copy would pin the
   * page to the snapshot it got on connect, so this browser's own write (an
   * approved HIL request, a raised halt) would never leave the screen —
   * exactly the T025/T039 behaviour the e2e tests assert.
   */
  useEffect(() => {
    if (liveSnapshot) setSnapshot(liveSnapshot);
  }, [liveSnapshot]);

  const reviewPending = snapshot?.status.sprint_review_pending ?? false;
  const reviewAnnounced = useRef(false);
  useEffect(() => {
    if (reviewPending && !reviewAnnounced.current) {
      reviewAnnounced.current = true;
      setTab('review');
    }
    if (!reviewPending) reviewAnnounced.current = false;
  }, [reviewPending]);

  useEffect(
    () =>
      onEvent((event) => {
        if (REFRESH_TRIGGER_KINDS.has(event.kind) && !isHeartbeatOnlyEvent(event)) {
          scheduleRefresh();
        }
      }),
    [onEvent, scheduleRefresh],
  );

  const hil = snapshot?.hil ?? [];
  // T040: open questions are attention-queue items alongside the pending
  // HIL requests, so the Needs-you count covers both.
  const questions = snapshot?.questions ?? [];
  const halts = snapshot?.halts ?? [];
  const quota = snapshot?.quota ?? [];
  /**
   * T044: the open `sprint_review` gate, when there is one. Its presence
   * both enables the Review view's decision buttons and auto-selects that
   * view once — §17 v2: the review IS the sprint's last screen, so an
   * operator who left the room on the Sprint tab should come back to the
   * thing that is waiting on them, without losing the ability to click back.
   */
  const reviewGate = hil.find((item) => item.gate === 'sprint_review');

  const chatVisible = chatMode !== 'hidden';
  const mainVisible = chatMode !== 'max' && middleOpen;

  return (
    <div className="cr-root">
      <TopBar
        snapshot={snapshot}
        haltCount={halts.length}
        activeHaltIds={halts.map((h) => h.id)}
        onChanged={refreshAux}
      />
      <ToolRow connected={connected} />
      {error && (
        <p style={{ color: 'var(--danger)', margin: '8px 16px 0' }} data-testid="app-error">
          {error}
        </p>
      )}
      <div
        className="cr-frame"
        data-chat={chatMode}
        data-main={mainVisible ? 'open' : 'closed'}
        data-view={view}
      >
        {mainVisible && (
          <div className="cr-main">
            {view === 'plan' && <PlanScreen />}
            {view === 'settings' && (
              <Settings policy={policy} quota={quota} onChanged={refreshAux} />
            )}
            {view === 'sprint' && (
              <>
                <div className="cr-view-tabs">
                  <button
                    type="button"
                    className="cr-btn"
                    data-testid="sprint-tab-sprint"
                    aria-pressed={tab === 'ops'}
                    onClick={() => setTab('ops')}
                  >
                    Sprint
                  </button>
                  <button
                    type="button"
                    className="cr-btn"
                    data-testid="sprint-tab-review"
                    aria-pressed={tab === 'review'}
                    title={
                      reviewGate
                        ? 'The sprint is waiting on your review'
                        : 'The sprint report so far'
                    }
                    onClick={() => setTab('review')}
                  >
                    Review{reviewGate ? ' ·' : ''}
                  </button>
                  <button
                    type="button"
                    className="cr-btn"
                    aria-pressed={tab === 'oracle'}
                    onClick={() => setTab('oracle')}
                  >
                    Oracle / KB
                  </button>
                </div>
                {tab === 'ops' && (
                  <SprintView
                    snapshot={snapshot}
                    hil={hil}
                    questions={questions}
                    halts={halts}
                    tickets={tickets}
                    {...(policy ? { policy } : {})}
                    onChanged={refreshAux}
                  />
                )}
                {tab === 'review' && (
                  <ReviewView
                    {...(reviewGate ? { gate: reviewGate } : {})}
                    onChanged={refreshAux}
                  />
                )}
                {tab === 'oracle' && (
                  <Panel title="Oracle / KB" defaultOpen>
                    <OraclePanel oracle={oracle} kb={kb} />
                  </Panel>
                )}
              </>
            )}
          </div>
        )}
        {chatVisible && <ChatPanel />}
      </div>
    </div>
  );
}
