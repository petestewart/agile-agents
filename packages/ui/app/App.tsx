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
import { SprintStrip } from './components/SprintStrip';
import { TeamPanel } from './components/TeamPanel';
import { TopBar } from './components/TopBar';
import {
  getAgents,
  getKbIndex,
  getOracleIndex,
  getPolicy,
  getSnapshot,
  getTickets,
} from './lib/api';
import type { FeedSnapshot } from './lib/feed-types';
import { connectFeedSocket } from './lib/ws';

type Tab = 'ops' | 'oracle';

const MAX_EVENTS = 500;

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
]);

/** Coalesces a burst of triggering events (e.g. a ticket transition plus its stanza) into one refetch. */
const REFRESH_DEBOUNCE_MS = 150;

/**
 * Control room shell (T025 — design §17 "Control room"; session scope:
 * "collapsible Team / Board / Feed panels ... sprint strip with gate chips
 * ... Halt button ... EM chat panel"). Reads come from the daemon's
 * `/api/snapshot` + `/ws` (live tail, same feed T020's page uses) plus the
 * new T025 read endpoints (`/api/agents`, `/api/tickets`, `/api/oracle`,
 * `/api/kb`, `/api/policy`); every write goes through an existing daemon
 * verb (see `lib/api.ts`).
 */
export function App() {
  const [snapshot, setSnapshot] = useState<FeedSnapshot | undefined>(undefined);
  const [events, setEvents] = useState<Event[]>([]);
  const [tab, setTab] = useState<Tab>('ops');
  const [connected, setConnected] = useState(false);
  const [agents, setAgents] = useState<Array<{ id: AgentId; record: AgentRecord }>>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [oracle, setOracle] = useState<OracleIndex>({});
  const [kb, setKb] = useState<KbIndex>({});
  const [policy, setPolicy] = useState<Policy | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Re-pulls every HTTP-sourced read, `/api/snapshot` included. The `hil`/
  // `halts`/`quota` fields the panels read come from `snapshot` — this is
  // called both after every write this browser makes (so its own resolved
  // HIL request or raised halt disappears/appears immediately) and,
  // debounced, whenever `/ws` reports one of `REFRESH_TRIGGER_KINDS` (so an
  // *external* change — another agent flipping a ticket, say — shows up
  // without a manual reload too).
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
    const handle = connectFeedSocket({
      onSnapshot: (snap) => {
        setSnapshot(snap);
        setEvents(snap.events);
      },
      onEvent: (event) => {
        setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));
        if (REFRESH_TRIGGER_KINDS.has(event.kind)) scheduleRefresh();
      },
      onStatusChange: (status) => setConnected(status === 'open'),
    });
    return () => {
      handle.close();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [refreshAux, scheduleRefresh]);

  const hil = snapshot?.hil ?? [];
  const halts = snapshot?.halts ?? [];
  const quota = snapshot?.quota ?? [];
  const sprint = snapshot?.sprint ?? { tickets: { done: 0, in_flight: 0, stale: 0, total: 0 } };

  return (
    <div className="cr-root">
      <TopBar
        connected={connected}
        quota={quota}
        haltCount={halts.length}
        activeHaltIds={halts.map((h) => h.id)}
        onChanged={refreshAux}
      />
      <div style={{ display: 'flex', gap: 8, padding: '8px 16px 0' }}>
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
      {error && (
        <p style={{ color: 'var(--danger)', margin: '8px 16px 0' }} data-testid="app-error">
          {error}
        </p>
      )}
      <div className="cr-body">
        <div className="cr-main">
          <SprintStrip sprint={sprint} halts={halts} gates={policy?.gates} />

          {tab === 'ops' ? (
            <>
              <Panel title="Needs you" count={hil.length} defaultOpen>
                <NeedsYou items={hil} onChanged={refreshAux} />
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
        </div>
        <ChatPanel connected={connected} />
      </div>
    </div>
  );
}
