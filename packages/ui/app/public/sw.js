/*
 * T165: the cockpit's service worker. It exists only so the browser will
 * install the cockpit as its own app window; it caches nothing. Every
 * request goes to the network (agiled on localhost), so the page can never
 * be served stale state — /api/* and /ws are live, and so is the shell.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request));
});
