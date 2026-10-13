/**
 * T043: the control room's ONE `/ws` connection.
 *
 * T025 opened a socket in `App`, and T041 opened a second one inside
 * `ChatPanel` — so an in-page chat meant two sockets to the same daemon,
 * two `{type:'snapshot'}` payloads on every reconnect, and two independent
 * reconnect timers. This provider owns the single connection and fans its
 * frames out to subscribers.
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
import type { CockpitFrame, FeedSnapshot } from './feed-types';
import { NO_NAMES, type Names, namesOf, stableNames } from './names';
import { withParts } from './status';
import { connectFeedSocket } from './ws';

export interface FeedContextValue {
  snapshot: FeedSnapshot | undefined;
  connected: boolean;
  /**
   * T416: the socket has been down for a moment (not a blip, and not the
   * first connect's few hundred ms): the banner shows, and write buttons are
   * off with "Reconnecting to the daemon…" until it is back.
   */
  offline: boolean;
  /** T160: the latest inbox + stream tree push; `undefined` until the first frame. */
  cockpit: CockpitFrame | undefined;
  /**
   * T544: the frame's ids as names (`namesOf`), one map for every
   * `<Markdown>`, kept while no title changes so their renders are memo hits.
   */
  names: Names;
  /**
   * Re-reads `GET /api/cockpit` now — used right after the operator's own
   * write so the card they acted on goes at once, rather than on the next
   * pushed frame (which follows within one tailer tick anyway).
   */
  refresh(): void;
  /** Subscribe to `/ws` events. Returns an unsubscribe. */
  onEvent(handler: (event: Event) => void): () => void;
}

const FeedContext = createContext<FeedContextValue | undefined>(undefined);

/**
 * T447 (audit r7 #2): the frame as the cockpit reads it — each coordinating
 * node's and project root's parts rolled up once here, so the rail, the
 * header, the Overview and Children agree on its status.
 */
export function readFrame(frame: CockpitFrame): CockpitFrame {
  return { ...frame, streams: withParts(frame.streams) };
}

/**
 * T520 (audit U8): where the cockpit was when a `refresh()` read was sent,
 * and where it is when the read comes back: how many reads had been sent,
 * and how many pushed frames had arrived.
 */
export interface RefreshMark {
  refreshes: number;
  frames: number;
}

/**
 * T520 (audit U8): whether a `refresh()` read, sent at `sent`, may replace
 * the cockpit `now`. Only the latest read lands, as `StreamPage.load`'s
 * `loadSeq` does: reads overlap and resolve in any order. And none lands
 * once a frame has arrived since it was sent: frames carry no sequence, so
 * that frame may be newer than the read, and with the system then quiet
 * nothing would put the older state right. A dropped read loses nothing:
 * the next frame carries the same state.
 */
export function refreshLands(sent: RefreshMark, now: RefreshMark): boolean {
  return sent.refreshes === now.refreshes && sent.frames === now.frames;
}

/** The timers a `Reloader` runs on (fakes in tests). */
export interface ReloadClock {
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_CLOCK: ReloadClock = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface Reloader {
  /** Something changed: reload now, or once the gap since the last load has passed. */
  schedule(): void;
  /** The view is gone: nothing more loads. */
  cancel(): void;
}

/**
 * T548 (perf P5): reloads a view on pushed frames without one read per
 * frame. A frame loads at once when the last load started `gapMs` ago;
 * frames inside the gap, or while a load is in flight, make one trailing
 * load when both are over. So never two loads at a time, and at most two
 * in any `gapMs`.
 */
export function createReloader(
  load: () => Promise<unknown>,
  gapMs: number,
  clock: ReloadClock = REAL_CLOCK,
): Reloader {
  let dirty = false;
  let inFlight = false;
  let cancelled = false;
  let timer: unknown;
  let last = Number.NEGATIVE_INFINITY;
  const pump = (): void => {
    if (cancelled || !dirty || inFlight || timer !== undefined) return;
    const wait = last + gapMs - clock.now();
    if (wait > 0) {
      timer = clock.set(() => {
        timer = undefined;
        pump();
      }, wait);
      return;
    }
    dirty = false;
    inFlight = true;
    last = clock.now();
    void Promise.resolve()
      .then(load)
      .catch(() => {
        // The view says its own load failure.
      })
      .finally(() => {
        inFlight = false;
        pump();
      });
  };
  return {
    schedule() {
      dirty = true;
      pump();
    },
    cancel() {
      cancelled = true;
      if (timer !== undefined) clock.clear(timer);
      timer = undefined;
    },
  };
}

/** How long the socket may be down before the cockpit says so (a reconnect blip says nothing). */
export const OFFLINE_AFTER_MS = 2000;

/** True once `connected` has been false for `OFFLINE_AFTER_MS`; false again the moment it is back. */
function useOffline(connected: boolean): boolean {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    if (connected) {
      setOffline(false);
      return;
    }
    const timer = setTimeout(() => setOffline(true), OFFLINE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);
  return offline;
}

export function FeedProvider({ children }: PropsWithChildren): JSX.Element {
  const [snapshot, setSnapshot] = useState<FeedSnapshot | undefined>(undefined);
  const [connected, setConnected] = useState(false);
  const [cockpit, setCockpit] = useState<CockpitFrame | undefined>(undefined);
  // Refs, not state: a new subscriber must never re-open the socket.
  const eventHandlers = useRef(new Set<(event: Event) => void>());
  // T520: the reads `refresh()` sent and the frames pushed so far (`refreshLands`).
  const mark = useRef<RefreshMark>({ refreshes: 0, frames: 0 });
  const offline = useOffline(connected);

  useEffect(() => {
    const handle = connectFeedSocket({
      onSnapshot: (snap) => setSnapshot(snap),
      // T544: events go to their subscribers only; no state, so an event re-renders nothing.
      onEvent: (event) => {
        for (const handler of eventHandlers.current) handler(event);
      },
      onCockpit: (frame) => {
        mark.current = { ...mark.current, frames: mark.current.frames + 1 };
        setCockpit(readFrame(frame));
      },
      onStatusChange: (status) => setConnected(status === 'open'),
    });
    return () => handle.close();
  }, []);

  const onEvent = useCallback((handler: (event: Event) => void) => {
    eventHandlers.current.add(handler);
    return () => {
      eventHandlers.current.delete(handler);
    };
  }, []);

  const refresh = useCallback(() => {
    const sent = { ...mark.current, refreshes: mark.current.refreshes + 1 };
    mark.current = sent;
    fetch('/api/cockpit')
      .then((res) => (res.ok ? (res.json() as Promise<CockpitFrame>) : undefined))
      .then((frame) => {
        // T520 (audit U8): an older read, or one a pushed frame overtook, never puts back older state.
        if (frame && refreshLands(sent, mark.current)) setCockpit(readFrame(frame));
      })
      .catch(() => {
        // The next pushed frame carries the same state.
      });
  }, []);

  const lastNames = useRef<Names>(NO_NAMES);
  const names = useMemo(() => {
    lastNames.current = stableNames(lastNames.current, namesOf(cockpit));
    return lastNames.current;
  }, [cockpit]);

  const value = useMemo<FeedContextValue>(
    () => ({ snapshot, connected, offline, cockpit, names, refresh, onEvent }),
    [snapshot, connected, offline, cockpit, names, refresh, onEvent],
  );

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

export function useFeed(): FeedContextValue {
  const value = useContext(FeedContext);
  if (!value) throw new Error('useFeed must be used inside a <FeedProvider>');
  return value;
}

/** T338: the feed, or `undefined` outside a provider (text rendered on its own). */
export function useOptionalFeed(): FeedContextValue | undefined {
  return useContext(FeedContext);
}
