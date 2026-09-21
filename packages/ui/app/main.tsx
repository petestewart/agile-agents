import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FeedProvider } from './lib/feed-context';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <FeedProvider>
      <App />
    </FeedProvider>
  </StrictMode>,
);
