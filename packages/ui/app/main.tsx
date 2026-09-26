import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './components/ui';
import { FeedProvider } from './lib/feed-context';
import { ShellProvider, parseShellUrl } from './lib/shell';
import { applyTheme, readTheme } from './lib/theme';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// `?view=settings` deep-links a view (T112 kept the query string across the
// `/control-room` redirect for exactly this), `?node=<id>` a node's page and
// `&project=<id>` the project filter (T348); anything else opens the inbox.
const initial = parseShellUrl(location.search);

// T360: the viewer's theme choice (system, light, dark) before the first paint.
applyTheme(readTheme());

// T394: the last resort. A view, a node's tab or an overlay that throws is
// caught nearer (`App`, `StreamPage`); anything else still shows a card in
// words with Reload, never a blank page.
createRoot(container).render(
  <StrictMode>
    <ErrorBoundary area="app">
      <FeedProvider>
        <ShellProvider initial={initial}>
          <ToastProvider>
            <App />
          </ToastProvider>
        </ShellProvider>
      </FeedProvider>
    </ErrorBoundary>
  </StrictMode>,
);
