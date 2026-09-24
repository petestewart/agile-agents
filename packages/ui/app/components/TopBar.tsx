/**
 * The one top bar (T043's, re-cut for the cockpit in T160): project name,
 * the view switch (Inbox carries the waiting count), the live dot, and —
 * at phone width only — the button that opens the stream-tree drawer.
 * T162: the quick-capture box (one line → a stream with no repo, its page
 * opened) and the "New stream" button. T163: the Rules view.
 */

import { type FormEvent, useState } from 'react';
import { createStream } from '../lib/api';
import type { CockpitProjectRow, CockpitStreamRow, FeedSnapshot } from '../lib/feed-types';
import { type ShellView, useShell } from '../lib/shell';
import { projectForNew } from '../lib/streams';

const NAV: ReadonlyArray<{ view: ShellView; label: string }> = [
  { view: 'inbox', label: 'Inbox' },
  { view: 'rules', label: 'Rules' },
  { view: 'settings', label: 'Settings' },
];

export function TopBar({
  snapshot,
  inboxCount,
  connected,
  rows,
  projects,
}: {
  snapshot: FeedSnapshot | undefined;
  inboxCount: number;
  connected: boolean;
  rows: readonly CockpitStreamRow[];
  projects: readonly CockpitProjectRow[];
}): JSX.Element {
  const {
    view,
    setView,
    railOpen,
    toggleRail,
    select,
    selected,
    setNewStreamOpen,
    project: current,
  } = useShell();
  const project = snapshot?.project;
  const [capture, setCapture] = useState('');
  const [captureError, setCaptureError] = useState<string | undefined>(undefined);

  const quickCapture = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const line = capture.trim();
    if (!line) return;
    try {
      // T208: it files into the current project (the daemon refuses none).
      const project = projectForNew(current, selected, rows, projects);
      if (project === undefined) throw new Error('Pick a project in the rail first');
      // T204: a jotted line is filed, not started; Start on its page runs the agent.
      const created = await createStream({ title: line, goal: line, project, start: false });
      setCapture('');
      setCaptureError(undefined);
      select(created.id);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <header className="cr-topbar" data-testid="topbar">
      <button
        type="button"
        className="cr-btn cr-rail-toggle"
        data-testid="rail-toggle"
        aria-expanded={railOpen}
        aria-controls="cr-rail"
        onClick={toggleRail}
      >
        Streams
      </button>
      <div className="repo" title={project?.path ?? 'agile'} data-testid="topbar-project">
        {project?.name ?? 'agile'}
      </div>
      <nav className="cr-nav" aria-label="Views">
        {NAV.map((item) => (
          <button
            key={item.view}
            type="button"
            data-view={item.view}
            aria-current={view === item.view ? 'page' : undefined}
            className={view === item.view ? 'on' : undefined}
            onClick={() => setView(item.view)}
          >
            {item.label}
            {item.view === 'inbox' && inboxCount > 0 && (
              <span className="badge" data-testid="inbox-badge">
                {inboxCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="grow" />
      <form className="cr-capture" onSubmit={quickCapture} aria-label="Quick capture">
        <input
          data-testid="quick-capture"
          placeholder="Capture a stream…"
          aria-label="Capture a stream"
          title={captureError ?? 'One line becomes a new stream'}
          aria-invalid={captureError ? 'true' : undefined}
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
        />
      </form>
      <button
        type="button"
        className="cr-btn"
        data-testid="new-stream-open"
        title="New stream (n)"
        onClick={() => setNewStreamOpen(true)}
      >
        New stream
      </button>
      <span className="cr-conn" data-testid="conn">
        <span className="cr-conn-dot" data-status={connected ? 'open' : 'closed'} />
        {connected ? 'live' : 'reconnecting…'}
      </span>
    </header>
  );
}
