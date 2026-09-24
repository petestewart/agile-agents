/**
 * The cockpit shell (design/cockpit-design.md §9, T160): the top bar, the
 * stream tree on the left rail, and the inbox as the default main view.
 * Everything live arrives on the one `/ws` (`FeedProvider`): the daemon
 * pushes a fresh inbox + tree after every batch of events, so a question
 * raised on any stream appears here with no reload.
 *
 * T161: a stream picked in the tree (or opened from an inbox card) shows
 * its stream page (§9.3) in the main column. T163: the rules screen.
 */

import { Inbox } from './components/Inbox';
import { NewStream } from './components/NewStream';
import { Rules } from './components/Rules';
import { Settings } from './components/Settings';
import { StreamPage } from './components/StreamPage';
import { StreamTree } from './components/StreamTree';
import { TopBar } from './components/TopBar';
import { useFeed } from './lib/feed-context';
import { useShell } from './lib/shell';

export function App(): JSX.Element {
  const { snapshot, connected, cockpit, refresh } = useFeed();
  const { view, selected, railOpen } = useShell();
  const rows = cockpit?.streams ?? [];
  const items = cockpit?.inbox ?? [];

  return (
    <div className="cr-root" data-rail={railOpen ? 'open' : 'closed'}>
      <TopBar snapshot={snapshot} inboxCount={items.length} connected={connected} />
      <div className="cr-frame">
        <StreamTree rows={rows} />
        <main className="cr-main">
          {view === 'settings' ? (
            <Settings />
          ) : view === 'rules' ? (
            <Rules />
          ) : view === 'stream' && selected !== undefined ? (
            <StreamPage id={selected} />
          ) : (
            <Inbox items={items} onChanged={refresh} />
          )}
        </main>
      </div>
      <NewStream rows={rows} />
    </div>
  );
}
