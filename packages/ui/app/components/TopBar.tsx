/**
 * The one top bar (T043's, re-cut for the cockpit in T160): project name,
 * the view switch (Inbox carries the waiting count), the live dot, and —
 * at phone width only — the button that opens the stream-tree drawer.
 */

import type { FeedSnapshot } from '../lib/feed-types';
import { type ShellView, useShell } from '../lib/shell';

const NAV: ReadonlyArray<{ view: ShellView; label: string }> = [
  { view: 'inbox', label: 'Inbox' },
  { view: 'settings', label: 'Settings' },
];

export function TopBar({
  snapshot,
  inboxCount,
  connected,
}: {
  snapshot: FeedSnapshot | undefined;
  inboxCount: number;
  connected: boolean;
}): JSX.Element {
  const { view, setView, railOpen, toggleRail } = useShell();
  const project = snapshot?.project;

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
      <span className="cr-conn" data-testid="conn">
        <span className="cr-conn-dot" data-status={connected ? 'open' : 'closed'} />
        {connected ? 'live' : 'reconnecting…'}
      </span>
    </header>
  );
}
