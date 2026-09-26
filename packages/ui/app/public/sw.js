/*
 * T165: the cockpit's service worker. It exists so the browser will install
 * the cockpit as its own app window, and (T394) so notifications work where
 * only a worker may show one (Android Chrome, an installed iOS app).
 *
 * It caches nothing. Every request goes to the network (agiled on
 * localhost), so the page can never be served stale state: /api/* and /ws
 * are live, and so is the shell. That matters for the code-split build
 * (T394): the page (`/`, sent `no-cache`) always names the chunks that
 * exist now, and the chunks themselves are content-hashed files the
 * browser's own HTTP cache keeps (`immutable`). A tab opened before a
 * rebuild that asks for a deleted chunk gets a 404, and the cockpit says
 * "A new version of the cockpit is available — Reload".
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});

/*
 * T394: a click on a notification the cockpit showed through this worker
 * (`use-notify.ts`). Its `data` says what to open: `{ node }`, `{ view:
 * 'inbox' }` (Needs me), or nothing (the test from Settings). An open
 * cockpit tab is brought forward and told (the page opens it through the
 * shell); with none open, a new one opens straight on it.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openCockpit(event.notification.data));
});

async function openCockpit(data) {
  const target = {};
  if (data && typeof data.node === 'string' && data.node !== '') target.node = data.node;
  else if (data && data.view === 'inbox') target.view = 'inbox';
  // Most recently focused first; the cockpit is the page at `/`.
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const cockpit = windows.find((client) => new URL(client.url).pathname === '/');
  if (cockpit) {
    try {
      await cockpit.focus();
    } catch {
      // Not allowed to take focus: the page still opens what was clicked.
    }
    cockpit.postMessage({ type: 'agile-notify-click', ...target });
    return;
  }
  const url = target.node ? `/?node=${encodeURIComponent(target.node)}` : '/';
  await self.clients.openWindow(url);
}
