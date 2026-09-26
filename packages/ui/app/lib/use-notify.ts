/**
 * T388: opt-in browser notifications. The cockpit is a tab you keep open
 * all day; when something new needs you (a question, a gate, a plan, a
 * merge) while you are in another tab or app, one notification says what
 * and where, and a click brings you to it.
 *
 *  - The setting is per browser (localStorage, like the theme), off by
 *    default; Settings → General turns it on and asks the browser.
 *  - Nothing while the tab is visible and focused: the page already shows it.
 *  - One notification at a time (one tag): what arrived while you were away,
 *    replaced as more arrives, closed when you come back.
 *  - The seen items live in memory for the session, never in storage.
 *
 * The words and the "which items are new" logic are in `notify.ts`.
 */

import type { InboxItem } from '@agile-agents/shared';
import { useEffect, useRef } from 'react';
import { useFeed } from './feed-context';
import {
  NOTIFY_TEST_TAG,
  type NotificationContent,
  diffInbox,
  notificationFor,
  stillWaiting,
} from './notify';
import { useShell } from './shell';

// ---------------------------------------------------------------- the setting

const KEY = 'agile.notify';

/** The choice when storage is blocked: it lasts until the page reloads. */
let remembered = false;

export function readNotifyOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'on';
  } catch {
    return remembered;
  }
}

export function saveNotifyOn(on: boolean): void {
  remembered = on;
  try {
    if (on) window.localStorage.setItem(KEY, 'on');
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the choice lasts until the page reloads.
  }
}

// ---------------------------------------------------------------- the browser

/**
 * What the browser allows: its permission, or why there is none — no
 * Notification API at all (an old or embedded browser), or an address that
 * is not secure (browsers only notify from https or localhost).
 */
export type NotifyAccess = 'unsupported' | 'insecure' | NotificationPermission;

export function notifyAccess(): NotifyAccess {
  if (typeof window === 'undefined' || typeof window.Notification !== 'function') {
    return 'unsupported';
  }
  if (window.isSecureContext === false) return 'insecure';
  return window.Notification.permission;
}

/** Asks the browser (it shows its prompt only while the permission is undecided). */
export async function askNotifyAccess(): Promise<NotifyAccess> {
  const access = notifyAccess();
  if (access !== 'default') return access;
  try {
    // Older Safari answers through a callback and returns nothing.
    return await new Promise<NotificationPermission>((resolve) => {
      const asked = window.Notification.requestPermission(resolve);
      asked?.then(resolve, () => resolve(window.Notification.permission));
    });
  } catch {
    return notifyAccess();
  }
}

/** A notification; `undefined` when the browser refuses to make one (Android wants a service worker). */
function raise(content: NotificationContent, onClick: () => void): Notification | undefined {
  try {
    const options: NotificationOptions & { renotify?: boolean } = {
      body: content.body,
      tag: content.tag,
      // A replacement alerts again: it carries something new.
      renotify: true,
      icon: '/icons/icon-192.png',
    };
    const note = new window.Notification(content.title, options);
    note.onclick = () => {
      window.focus();
      note.close();
      onClick();
    };
    return note;
  } catch {
    return undefined;
  }
}

/** Settings' "Send a test". False when the browser would not show it. */
export function sendTestNotification(): boolean {
  if (notifyAccess() !== 'granted') return false;
  return (
    raise(
      {
        title: 'Notifications are on',
        body: 'This is how the cockpit tells you something new needs you. Click one to go straight to it.',
        tag: NOTIFY_TEST_TAG,
      },
      () => {},
    ) !== undefined
  );
}

/** In another tab, another app, or another window. */
function isAway(): boolean {
  return document.visibilityState === 'hidden' || !document.hasFocus();
}

// ---------------------------------------------------------------- the hook

/** Mounted once, in `App`: watches Needs me and notifies while you are away. */
export function useNeedsMeNotifications(): void {
  const { cockpit } = useFeed();
  const { select, setView } = useShell();
  /** Every item seen this session; `undefined` until the first frame. */
  const seen = useRef<Set<string>>();
  /** New items that arrived while you were away and still wait. */
  const pending = useRef<InboxItem[]>([]);
  const shown = useRef<Notification>();
  const go = useRef({ select, setView });
  go.current = { select, setView };

  useEffect(() => {
    if (cockpit === undefined) return;
    const diff = diffInbox(seen.current, cockpit.inbox);
    seen.current = diff.seen;
    if (!isAway()) {
      pending.current = [];
      return;
    }
    pending.current = stillWaiting(pending.current, diff.fresh, cockpit.inbox);
    if (pending.current.length === 0) {
      // All of it was answered somewhere else: the notification is stale.
      shown.current?.close();
      shown.current = undefined;
      return;
    }
    if (diff.fresh.length === 0 || !readNotifyOn() || notifyAccess() !== 'granted') return;
    const rows = new Map(cockpit.streams.map((row) => [row.id, row]));
    const content = notificationFor(pending.current, (id) => rows.get(id));
    if (content === undefined) return;
    shown.current = raise(content, () => {
      pending.current = [];
      shown.current = undefined;
      if (content.node !== undefined) go.current.select(content.node);
      else go.current.setView('inbox');
    });
  }, [cockpit]);

  // Back in the tab: what was waiting is on screen now.
  useEffect(() => {
    const back = (): void => {
      if (isAway()) return;
      pending.current = [];
      shown.current?.close();
      shown.current = undefined;
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, []);
}
