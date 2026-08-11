/**
 * Iron Ledger service worker.
 *
 * Strategy is split deliberately:
 *   - The HTML document is NETWORK-FIRST, so a re-upload takes effect on the next
 *     online launch. Falls back to cache when there's no signal.
 *   - Icons and the manifest are CACHE-FIRST, since they rarely change.
 *
 * The previous version was cache-first for everything, which meant app updates
 * could never reach the phone. Bump CACHE below if you ever need a hard reset.
 */
const CACHE = 'iron-ledger-v2';
const SHELL = ['./', './index.html', './manifest.json',
               './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Sync traffic must always hit the network.
  if (url.hostname.includes('script.google.com')) return;
  if (url.origin !== location.origin) return;

  const isDoc = e.request.mode === 'navigate' || url.pathname.endsWith('.html')
             || url.pathname === '/' || url.pathname.endsWith('/');

  if (isDoc) {
    // Network first: newest app when online, cached app when not.
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }).catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Everything else: cache first, refill on miss.
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }))
  );
});
