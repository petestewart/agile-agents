/**
 * The control room shell.
 *
 * T122 deleted the Plan, Sprint, Review and Settings screens with the
 * ceremony layer behind them, so what is left is the smallest honest page:
 * the project the daemon is driving, what is waiting on the human, and the
 * live event tail. The cockpit proper is rebuilt in Phase 6 (T160) against
 * streams, so nothing here is a placeholder for a screen that still exists —
 * these three reads are the ones the daemon still serves.
 */

import { Panel } from './components/Panel';
import { useFeed } from './lib/feed-context';

export function App(): JSX.Element {
  const { snapshot, events, connected } = useFeed();
  const project = snapshot?.project;
  const gates = snapshot?.hil ?? [];
  const questions = snapshot?.questions ?? [];

  return (
    <div className="cr-root">
      <header className="cr-topbar">
        <span className="cr-project" title={project?.path}>
          {project?.name ?? 'agile'}
        </span>
        <span className="cr-needs-you">Needs you: {snapshot?.status.needs_you ?? 0}</span>
        <span className="cr-conn">{connected ? 'live' : 'reconnecting…'}</span>
      </header>

      <Panel title="Needs you" count={gates.length + questions.length} defaultOpen>
        {gates.length + questions.length === 0 ? (
          <p className="cr-empty">Nothing is waiting on you.</p>
        ) : (
          <ul className="cr-list">
            {gates.map((gate) => (
              <li key={gate.id}>
                <code>{gate.id}</code> {gate.hil_kind} — {gate.summary}
              </li>
            ))}
            {questions.map((question) => (
              <li key={question.id}>
                <code>{question.id}</code> {question.raised_by} — {question.text}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Feed" count={events.length} defaultOpen>
        <ul className="cr-list">
          {events
            .slice(-100)
            .reverse()
            .map((event, index) => (
              <li key={`${event.ts}-${index}`}>
                <code>{event.ts}</code> {event.kind}
              </li>
            ))}
        </ul>
      </Panel>
    </div>
  );
}
