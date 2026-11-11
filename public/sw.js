// App-shell cache so the PWA opens offline/instantly. Network-first so updates land promptly.
const C = 'pqtalk-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(C).then((k) => k.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
