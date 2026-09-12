import type {
  AgentId,
  AgentRecord,
  Event,
  KbIndex,
  OracleIndex,
  Policy,
  Ticket,
} from '@agile-agents/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BoardPanel } from './components/BoardPanel';
import { ChatPanel } from './components/ChatPanel';
import { FeedPanel } from './components/FeedPanel';
import { NeedsYou } from './components/NeedsYou';
import { OraclePanel } from './components/OraclePanel';
import { Panel } from './components/Panel';
import { Settings } from './components/Settings';
import { SprintStrip } from './components/SprintStrip';
import { TeamPanel } from './components/TeamPanel';
import { ToolRow } from './components/ToolRow';
import { TopBar } from './components/TopBar';
import { PlanScreen } from './components/plan/PlanScreen';
import {
  getAgents,
  getKbIndex,
  getOracleIndex,
  getPolicy,
  getSnapshot,
  getTickets,
} from './lib/api';
import { useFeed } from './lib/feed-context';
import type { FeedSnapshot } from './lib/feed-types';
import { useShell } from './lib/shell';

type Tab = 'ops' | 'oracle';

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
 * (T042's, stubbed here), Sprint (the T025 panels, until T044 rewrites
 * them) and Settings (`Settings`, spend + "Who decides"). The single `/ws`
 * connection lives in `FeedProvider` (`lib/feed-context.tsx`) and the chrome
 * state in `ShellProvider` (`lib/shell.tsx`); this component owns only the
 * HTTP-sourced reads and the layout.
 */
export function App(): JSX.Element {
  const { snapshot: liveSnapshot, events, connected, onEvent } = useFeed();
  const { view, chatMode, middleOpen } = useShell();
  const [fetchedSnapshot, setFetchedSnapshot] = useState<FeedSnapshot | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('ops');
  const [agents, setAgents] = useState<Array<{ id: AgentId; record: AgentRecord }>>([]);
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
      const [a, t, o, k, p, snap] = await Promise.all([
        getAgents(),
        getTickets(),
        getOracleIndex(),
        getKbIndex(),
        getPolicy(),
        getSnapshot(),
      ]);
      setAgents(a);
      setTickets(t);
      setOracle(o);
      setKb(k);
      setPolicy(p);
      setFetchedSnapshot(snap);
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

  useEffect(
    () =>
      onEvent((event) => {
        if (REFRESH_TRIGGER_KINDS.has(event.kind) && !isHeartbeatOnlyEvent(event)) {
          scheduleRefresh();
        }
      }),
    [onEvent, scheduleRefresh],
  );

  // The `/ws` snapshot is the fresher of the two (it arrives on connect and
  // on reconnect); the fetched one fills the gap before the socket opens and
  // after this browser's own writes.
  const snapshot = liveSnapshot ?? fetchedSnapshot;

  const hil = snapshot?.hil ?? [];
  // T040: open questions are attention-queue items alongside the pending
  // HIL requests, so the Needs-you count covers both.
  const questions = snapshot?.questions ?? [];
  const halts = snapshot?.halts ?? [];
  const quota = snapshot?.quota ?? [];
  const sprint = snapshot?.sprint ?? { tickets: { done: 0, in_flight: 0, stale: 0, total: 0 } };

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
                <SprintStrip sprint={sprint} halts={halts} gates={policy?.gates} />
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="cr-icon-btn"
                    aria-pressed={tab === 'ops'}
                    onClick={() => setTab('ops')}
                  >
                    Ops
                  </button>
                  <button
                    type="button"
                    className="cr-icon-btn"
                    aria-pressed={tab === 'oracle'}
                    onClick={() => setTab('oracle')}
                  >
                    Oracle / KB
                  </button>
                </div>
                {tab === 'ops' ? (
                  <>
                    <Panel title="Needs you" count={hil.length + questions.length} defaultOpen>
                      <NeedsYou items={hil} questions={questions} onChanged={refreshAux} />
                    </Panel>
                    <Panel title="Team" count={agents.length}>
                      <TeamPanel agents={agents} halts={halts} />
                    </Panel>
                    <Panel title="Board" count={tickets.length} defaultOpen>
                      <BoardPanel tickets={tickets} halts={halts} />
                    </Panel>
                    <Panel title="Feed" count={events.length}>
                      <FeedPanel events={events} />
                    </Panel>
                  </>
                ) : (
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
