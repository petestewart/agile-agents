/**
 * T043: the control room's ONE `/ws` connection.
 *
 * T025 opened a socket in `App`, and T041 opened a second one inside
 * `ChatPanel` — so an in-page chat meant two sockets to the same daemon,
 * two `{type:'snapshot'}` payloads on every reconnect, and two independent
 * reconnect timers. This provider owns the single connection and fans its
 * frames out to subscribers; the chat panel and the shell both read from
 * here. `/control-room/chat` (the popped-out window) mounts the same
 * provider around nothing but the panel, so it still gets its own socket —
 * one per *window*, which is the point.
 */

import type { Event } from '@agile-agents/shared';
import {
  type PropsWithChildren,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { FeedSnapshot } from './feed-types';
import { type ChatFrame, connectFeedSocket } from './ws';

/** Cap on the in-memory event tail (the Feed panel renders it). */
const MAX_EVENTS = 500;

export interface FeedContextValue {
  snapshot: FeedSnapshot | undefined;
  events: Event[];
  connected: boolean;
  /** Subscribe to `/ws` events. Returns an unsubscribe. */
  onEvent(handler: (event: Event) => void): () => void;
  /** Subscribe to the EM chat side channel (`chat_delta` / `chat_turn_end`). Returns an unsubscribe. */
  onChat(handler: (frame: ChatFrame) => void): () => void;
}

const FeedContext = createContext<FeedContextValue | undefined>(undefined);

export function FeedProvider({ children }: PropsWithChildren): JSX.Element {
  const [snapshot, setSnapshot] = useState<FeedSnapshot | undefined>(undefined);
  const [events, setEvents] = useState<Event[]>([]);
  const [connected, setConnected] = useState(false);
  // Refs, not state: a new subscriber must never re-open the socket.
  const eventHandlers = useRef(new Set<(event: Event) => void>());
  const chatHandlers = useRef(new Set<(frame: ChatFrame) => void>());

  useEffect(() => {
    const handle = connectFeedSocket({
      onSnapshot: (snap) => {
        setSnapshot(snap);
        setEvents(snap.events);
      },
      onEvent: (event) => {
        setEvents((prev) => [...prev, event].slice(-MAX_EVENTS));
        for (const handler of eventHandlers.current) handler(event);
      },
      onStatusChange: (status) => setConnected(status === 'open'),
      onChat: (frame) => {
        for (const handler of chatHandlers.current) handler(frame);
      },
    });
    return () => handle.close();
  }, []);

  const onEvent = useCallback((handler: (event: Event) => void) => {
    eventHandlers.current.add(handler);
    return () => {
      eventHandlers.current.delete(handler);
    };
  }, []);

  const onChat = useCallback((handler: (frame: ChatFrame) => void) => {
    chatHandlers.current.add(handler);
    return () => {
      chatHandlers.current.delete(handler);
    };
  }, []);

  const value = useMemo<FeedContextValue>(
    () => ({ snapshot, events, connected, onEvent, onChat }),
    [snapshot, events, connected, onEvent, onChat],
  );

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeed(): FeedContextValue {
  const value = useContext(FeedContext);
  if (!value) throw new Error('useFeed must be used inside a <FeedProvider>');
  return value;
}
