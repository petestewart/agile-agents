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
  // Guards against a slow HTTP fallback clobbering state the WS already
  // delivered (same race the T020 feed page's e2e suite fixed — see
  // `feed.e2e.test.ts`'s second test).
  const liveDataApplied = useRef(false);

  // Re-pulls every HTTP-sourced read, `/api/snapshot` included. The `hil`/
  // `halts`/`quota` fields the panels read come from `snapshot` (kept
  // otherwise in sync by `/ws`'s live event tail, same as the T020 feed
  // page) — but a HIL resolve or a raised halt needs its *own* list entry
  // to disappear/appear immediately, not wait on the next unrelated event
  // to arrive over the socket, so every write in this app calls this after
  // it succeeds.
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

  useEffect(() => {
    void refreshAux();
    const handle = connectFeedSocket({
      onSnapshot: (snap) => {
        liveDataApplied.current = true;
        setSnapshot(snap);
        setEvents(snap.events);
      },
      onEvent: (event) => {
        liveDataApplied.current = true;
        setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));
      },
      onStatusChange: (status) => setConnected(status === 'open'),
    });
    return () => handle.close();
  }, [refreshAux]);

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
