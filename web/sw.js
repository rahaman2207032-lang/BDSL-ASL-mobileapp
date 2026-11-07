// Offline cache. Pose files (.bsl) are cached forever once seen; the app files are always re-checked online first,
// so a new version of the app shows up as soon as you are online.
const CACHE = "bdsl-v2";
self.addEventListener("install", e => { self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const store = res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; };
  if (url.pathname.endsWith(".bsl")) {                                  // cache first
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(store)));
  } else {                                                              // network first, cache as backup
    e.respondWith(fetch(e.request).then(store).catch(() => caches.match(e.request)));
  }
});
