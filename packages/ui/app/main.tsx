import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FeedProvider } from './lib/feed-context';
import { ShellProvider, isShellView } from './lib/shell';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// `?view=settings` deep-links a view (T112 kept the query string across the
// `/control-room` redirect for exactly this); anything else opens the inbox.
const requested = new URLSearchParams(location.search).get('view');

createRoot(container).render(
  <StrictMode>
    <FeedProvider>
      <ShellProvider initialView={isShellView(requested) ? requested : 'inbox'}>
        <App />
      </ShellProvider>
    </FeedProvider>
  </StrictMode>,
);
