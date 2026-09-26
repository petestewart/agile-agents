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
 * T394: through the service worker when one is active
 * (`registration.showNotification`), which is the only way Android Chrome
 * and an installed iOS app show one; a click there is handled by `sw.js`,
 * which brings the cockpit's tab forward and posts it what to open. The
 * page's own `new Notification` is the fallback without a worker.
 *
 * The words and the "which items are new" logic are in `notify.ts`.
 */

import type { InboxItem } from '@agile-agents/shared';
import { useEffect, useRef } from 'react';
import { useFeed } from './feed-context';
import {
  NOTIFY_TEST_TAG,
  type NotificationContent,
  type NotifyTarget,
  clickTarget,
  diffInbox,
  notificationFor,
  stillWaiting,
  targetOf,
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

/** A notification on screen, closed when what it says is stale. */
interface Shown {
  close(): void;
}

/** The service worker's registration, when one is active (none: an old browser, or before it installs). */
async function activeWorker(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    return registration?.active ? registration : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Shows a notification; `undefined` when the browser refuses. Through the
 * service worker when one is active: its click lands in `sw.js`, which
 * brings the cockpit forward and posts `target` back (see the hook). Else
 * the page's own, whose click is `onClick` here.
 */
async function raise(
  content: NotificationContent,
  target: NotifyTarget,
  onClick: () => void,
): Promise<Shown | undefined> {
  const options: NotificationOptions & { renotify?: boolean } = {
    body: content.body,
    tag: content.tag,
    // A replacement alerts again: it carries something new.
    renotify: true,
    icon: '/icons/icon-192.png',
  };
  const worker = await activeWorker();
  if (worker) {
    try {
      await worker.showNotification(content.title, { ...options, data: target });
      return {
        close: () => {
          worker
            .getNotifications({ tag: content.tag })
            .then((notes) => {
              for (const note of notes) note.close();
            })
            .catch(() => {});
        },
      };
    } catch {
      // The worker refused (a browser that allows only the page's own): try that.
    }
  }
  try {
    // Android Chrome throws here: it shows notifications only through a worker.
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

/** Settings' "Send a test", the same way a real one goes. False when the browser would not show it. */
export async function sendTestNotification(): Promise<boolean> {
  if (notifyAccess() !== 'granted') return false;
  const shown = await raise(
    {
      title: 'Notifications are on',
      body: 'This is how the cockpit tells you something new needs you. Click one to go straight to it.',
      tag: NOTIFY_TEST_TAG,
    },
    {},
    () => {},
  );
  return shown !== undefined;
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
  const shown = useRef<Shown>();
  /** Bumped when what is shown goes stale (you're back, or it was answered), so one still on its way is closed. */
  const stale = useRef(0);
  const go = useRef({ select, setView });
  go.current = { select, setView };

  // A click on one of ours: what waited is on screen now; open what it names.
  const open = useRef((target: NotifyTarget): void => {
    // The test from Settings names nothing: the click only brought the cockpit forward.
    if (target.node === undefined && target.view === undefined) return;
    pending.current = [];
    shown.current = undefined;
    if (target.node !== undefined) go.current.select(target.node);
    else if (target.view === 'inbox') go.current.setView('inbox');
  });

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
      stale.current++;
      shown.current?.close();
      shown.current = undefined;
      return;
    }
    if (diff.fresh.length === 0 || !readNotifyOn() || notifyAccess() !== 'granted') return;
    const rows = new Map(cockpit.streams.map((row) => [row.id, row]));
    const content = notificationFor(pending.current, (id) => rows.get(id));
    if (content === undefined) return;
    const target = targetOf(content);
    const since = stale.current;
    void raise(content, target, () => open.current(target)).then((note) => {
      // Back already, or answered elsewhere, while it was on its way: close it.
      // (A newer one under the same tag simply replaces it.)
      if (since !== stale.current) note?.close();
      else shown.current = note;
    });
  }, [cockpit]);

  // Back in the tab: what was waiting is on screen now.
  useEffect(() => {
    const back = (): void => {
      if (isAway()) return;
      stale.current++;
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

  // A click on a worker's notification: `sw.js` brought this tab forward and says what to open.
  useEffect(() => {
    const worker = navigator.serviceWorker;
    if (!worker) return;
    const onMessage = (event: MessageEvent): void => {
      const target = clickTarget(event.data);
      if (target !== undefined) open.current(target);
    };
    worker.addEventListener('message', onMessage);
    // Deliver what was queued before this listener existed (a tab the click just opened).
    if (typeof worker.startMessages === 'function') worker.startMessages();
    return () => worker.removeEventListener('message', onMessage);
  }, []);
}
