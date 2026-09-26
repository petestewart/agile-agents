/**
 * The cockpit shell (design/cockpit-design.md §9, T160): the top bar, the
 * stream tree on the left rail, and the inbox as the default main view.
 * Everything live arrives on the one `/ws` (`FeedProvider`): the daemon
 * pushes a fresh inbox + tree after every batch of events, so a question
 * raised on any stream appears here with no reload.
 *
 * T161: a stream picked in the tree (or opened from an inbox card) shows
 * its stream page (§9.3) in the main column. T163: the rules screen.
 * T360: the top bar is gone; the sidebar (views, projects, Settings) is the
 * one navigation, a drawer below 900px (design/cockpit-ui.md §3).
 */

import { DirectorPage } from './components/Director';
import { Inbox } from './components/Inbox';
import { DependenciesLens, EventLog, RepoView, RunningLens } from './components/Lenses';
import { NewStream } from './components/NewStream';
import { Rules } from './components/Rules';
import { Settings } from './components/Settings';
import { MobileBar, Sidebar } from './components/Sidebar';
import { StreamPage } from './components/StreamPage';
import { useFeed } from './lib/feed-context';
import { useShell } from './lib/shell';

export function App(): JSX.Element {
  const { snapshot, connected, cockpit, refresh } = useFeed();
  const { view, selected, railOpen, toggleRail } = useShell();
  const rows = cockpit?.streams ?? [];
  const items = cockpit?.inbox ?? [];
  const projects = cockpit?.projects ?? [];
  const repos = cockpit?.repos ?? [];

  return (
    <div className="cr-root" data-rail={railOpen ? 'open' : 'closed'}>
      <Sidebar
        snapshot={snapshot}
        inboxCount={items.length}
        connected={connected}
        rows={rows}
        projects={projects}
      />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the drawer closes with its own toggle and Escape too. */}
      <div className="cr-scrim" onClick={toggleRail} />
      <main className="cr-main">
        <MobileBar connected={connected} name={snapshot?.project?.name ?? 'agile'} />
        {view === 'settings' ? (
          <Settings />
        ) : view === 'repos' ? (
          <RepoView rows={rows} repos={repos} overlaps={cockpit?.overlaps ?? []} />
        ) : view === 'running' ? (
          <RunningLens rows={rows} />
        ) : view === 'deps' ? (
          <DependenciesLens rows={rows} />
        ) : view === 'rules' ? (
          <Rules />
        ) : view === 'director' ? (
          <DirectorPage />
        ) : view === 'events' ? (
          <EventLog />
        ) : view === 'stream' && selected !== undefined ? (
          <StreamPage id={selected} />
        ) : (
          <Inbox items={items} onChanged={refresh} />
        )}
      </main>
      <NewStream rows={rows} projects={projects} />
    </div>
  );
}
