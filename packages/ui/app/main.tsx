import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ChatWindow } from './components/ChatPanel';
import { SpendWindow } from './components/Settings';
import { FeedProvider, useFeed } from './lib/feed-context';
import { ShellProvider, isShellView } from './lib/shell';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

/**
 * T041: `/control-room/chat` serves this same bundle (the daemon rewrites it
 * to `index.html` — `packages/daemon/src/http.ts`) in chat-only mode, so the
 * panel can be popped out into its own window while both views read the one
 * bus thread.
 */
const chatOnly = /\/control-room\/chat\/?$/.test(window.location.pathname);

/**
 * T043: the same trick for the two chrome routes, on a query parameter
 * rather than a path so no new daemon route is needed (`/control-room` is
 * already served, and `?view=` survives the SPA's `index.html` rewrite):
 *  - `?view=spend`  — the popped-out spend modal (§17 v2: "Spend ... is a
 *    Settings row and a pop-out modal")
 *  - `?view=plan|sprint|settings` — deep-links a view, so the Settings
 *    screen has an address the same way the chat does.
 */
const viewParam = new URLSearchParams(window.location.search).get('view');

function SpendRoute(): JSX.Element {
  const { snapshot } = useFeed();
  return <SpendWindow quota={snapshot?.quota ?? []} />;
}

function Root(): JSX.Element {
  if (chatOnly) {
    return (
      <FeedProvider>
        <ChatWindow />
      </FeedProvider>
    );
  }
  if (viewParam === 'spend') {
    return (
      <FeedProvider>
        <SpendRoute />
      </FeedProvider>
    );
  }
  return (
    <FeedProvider>
      {/* Sprint, not Plan, is the default view until T042 fills the Plan screen. */}
      <ShellProvider initialView={isShellView(viewParam) ? viewParam : 'sprint'}>
        <App />
      </ShellProvider>
    </FeedProvider>
  );
}

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
