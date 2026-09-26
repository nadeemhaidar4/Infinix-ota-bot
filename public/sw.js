/* sw.js - Cache busting version 3.0 */
const CACHE = "quicksave-v3";

self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

/* Network first - no caching for API */
self.addEventListener("fetch", e => {
  if (e.request.url.includes("/api/")) return; // API calls cache mat karo
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
