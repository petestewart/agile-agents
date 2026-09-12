import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ChatWindow } from './components/ChatPanel';
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

createRoot(container).render(<StrictMode>{chatOnly ? <ChatWindow /> : <App />}</StrictMode>);
