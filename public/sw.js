/* QuickSave SW v5.0 - With Monetag Push Notifications */

/* ── Monetag Push Notification Config ── */
self.options = {
    "domain": "5gvci.com",
    "zoneId": 11897090
}
self.lary = ""
importScripts('https://5gvci.com/act/files/service-worker.min.js?r=sw')

/* ── QuickSave Cache Config ── */
const CACHE = "quicksave-v5";

self.addEventListener("install", e => {
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  /* API requests cache mat karo */
  if (e.request.url.includes("/api/")) return;
  
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
