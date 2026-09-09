/**
 * `/ws` client (same socket the T020 feed page uses — `http.ts`'s
 * `startHttpServer`): hello frame, one full `FeedSnapshot` on connect, then
 * `{type:'event', event}` per new line appended to `log/events.jsonl`.
 * Status must never cost tokens; it is read straight from daemon state
 * (§17) — this module owns the live half of that read path.
 */
import type { Event, FeedSnapshot } from '@agile-agents/shared';

export type FeedFrame =
  | { type: 'hello'; version: string; stateRoot: string }
  | (FeedSnapshot & { type: 'snapshot' })
  | { type: 'event'; event: Event };

export interface FeedSocketHandlers {
  onSnapshot: (snapshot: FeedSnapshot) => void;
  onEvent: (event: Event) => void;
  onStatusChange?: (status: 'connecting' | 'open' | 'closed') => void;
}

export interface FeedSocketHandle {
  close(): void;
}

/** Reconnects with a fixed backoff — a control room left open for hours must not need a manual refresh after a daemon restart. */
const RECONNECT_DELAY_MS = 2000;

export function connectFeedSocket(handlers: FeedSocketHandlers): FeedSocketHandle {
  let closed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  function connect(): void {
    if (closed) return;
    handlers.onStatusChange?.('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws`);

    socket.onopen = () => handlers.onStatusChange?.('open');
    socket.onmessage = (ev) => {
      let frame: FeedFrame;
      try {
        frame = JSON.parse(ev.data as string) as FeedFrame;
      } catch {
        return;
      }
      if (frame.type === 'snapshot') handlers.onSnapshot(frame);
      else if (frame.type === 'event') handlers.onEvent(frame.event);
    };
    socket.onclose = () => {
      handlers.onStatusChange?.('closed');
      if (!closed) retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    };
    socket.onerror = () => socket?.close();
  }

  connect();

  return {
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    },
  };
}
