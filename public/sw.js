/* QuickSave Service Worker v8.1 - Background Download Support */
const CACHE_NAME    = "quicksave-v8.1.0";
const CACHE_TIMEOUT = 5000;
const BG_DOWNLOADS  = new Map(); // Background download tracking

const STATIC_FILES = [
  "/",
  "/index.html",
  "/styles.css",
  "/app.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png"
];

/* ── Install ── */
self.addEventListener("install", event => {
  console.log("[SW] Installing:", CACHE_NAME);
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
      .catch(err => console.error("[SW] Cache failed:", err))
  );
});

/* ── Activate ── */
self.addEventListener("activate", event => {
  console.log("[SW] Activating:", CACHE_NAME);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch ── */
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(networkFirstWithTimeout(event.request, CACHE_TIMEOUT));
});

async function networkFirstWithTimeout(request, timeout) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const networkResponse = await fetch(request, { signal: controller.signal });
    clearTimeout(timer);
    if (networkResponse.ok) cache.put(request, networkResponse.clone());
    return networkResponse;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const index = await cache.match("/index.html");
      if (index) return index;
    }
    return new Response("Offline", { status: 503 });
  }
}

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD - Main Logic
════════════════════════════════════════ */
self.addEventListener("message", async event => {
  const { type, data } = event.data || {};

  /* SW Update */
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  /* Version info */
  if (type === "GET_VERSION") {
    event.ports[0]?.postMessage({ version: CACHE_NAME });
    return;
  }

  /* Background download request */
  if (type === "BG_DOWNLOAD") {
    handleBackgroundDownload(data, event.source);
    return;
  }

  /* Cancel download */
  if (type === "CANCEL_DOWNLOAD") {
    const dl = BG_DOWNLOADS.get(data?.id);
    if (dl) {
      dl.controller.abort();
      BG_DOWNLOADS.delete(data.id);
    }
    return;
  }
});

/* ════════════════════════════════════════
   Background Download Handler
════════════════════════════════════════ */
async function handleBackgroundDownload(data, client) {
  const { url: pageUrl, id } = data;
  const dlId = id || Date.now().toString();

  console.log(`[SW-BG] Starting background download: ${dlId}`);

  // Client ko notify karo - start hua
  notifyClients({
    type:   "BG_DOWNLOAD_START",
    id:     dlId,
    url:    pageUrl,
    status: "processing"
  });

  // Show notification
  if (self.registration.showNotification) {
    await self.registration.showNotification("QuickSave", {
      body:    "⏳ Processing your video...",
      icon:    "/icon-192.png",
      badge:   "/icon-192.png",
      tag:     `qs-dl-${dlId}`,
      silent:  true,
      data:    { dlId, pageUrl }
    });
  }

  const controller = new AbortController();
  BG_DOWNLOADS.set(dlId, { controller, url: pageUrl });

  try {
    // Step 1: Inspect karo
    const inspectRes = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: pageUrl }),
      signal:  controller.signal
    });

    if (!inspectRes.ok) {
      const err = await inspectRes.json();
      throw new Error(err.message || "Could not process link");
    }

    const inspectData = await inspectRes.json();
    if (!inspectData.ok || !inspectData.id) {
      throw new Error(inspectData.message || "Extraction failed");
    }

    // Client ko update karo
    notifyClients({
      type:     "BG_DOWNLOAD_READY",
      id:       dlId,
      dlId:     inspectData.id,
      filename: inspectData.filename,
      thumb:    inspectData.thumbnail,
      status:   "ready"
    });

    // Step 2: Notification update - ready
    if (self.registration.showNotification) {
      await self.registration.showNotification("QuickSave ✅", {
        body:    `Tap to save: ${inspectData.filename || "video.mp4"}`,
        icon:    "/icon-192.png",
        badge:   "/icon-192.png",
        tag:     `qs-dl-${dlId}`,
        silent:  false,
        vibrate: [200, 100, 200],
        data:    {
          dlId:     dlId,
          mediaId:  inspectData.id,
          filename: inspectData.filename,
          pageUrl:  pageUrl
        },
        actions: [
          { action: "download", title: "⬇ Download Now" },
          { action: "dismiss",  title: "✕ Dismiss" }
        ]
      });
    }

    BG_DOWNLOADS.delete(dlId);

  } catch(err) {
    if (err.name === "AbortError") {
      console.log(`[SW-BG] Cancelled: ${dlId}`);
      return;
    }

    console.error(`[SW-BG] Failed: ${dlId}`, err.message);

    notifyClients({
      type:    "BG_DOWNLOAD_ERROR",
      id:      dlId,
      error:   err.message,
      status:  "error"
    });

    if (self.registration.showNotification) {
      await self.registration.showNotification("QuickSave ❌", {
        body:   `Failed: ${err.message.slice(0, 60)}`,
        icon:   "/icon-192.png",
        badge:  "/icon-192.png",
        tag:    `qs-dl-${dlId}`,
        silent: false,
        data:   { dlId, pageUrl }
      });
    }

    BG_DOWNLOADS.delete(dlId);
  }
}

/* ── Notification Click Handler ── */
self.addEventListener("notificationclick", event => {
  const { action, notification } = event;
  const { mediaId, filename, dlId, pageUrl } = notification.data || {};

  notification.close();

  if (action === "dismiss") return;

  // Download action ya notification click
  if (mediaId) {
    event.waitUntil(
      // App open karo aur download trigger karo
      self.clients.matchAll({ type: "window" }).then(clients => {
        const dlUrl = `/api/download?id=${mediaId}`;

        // Agar app already open hai
        for (const c of clients) {
          if (c.url.includes(self.location.origin)) {
            c.focus();
            c.postMessage({
              type:     "TRIGGER_DOWNLOAD",
              mediaId:  mediaId,
              filename: filename,
              dlId:     dlId
            });
            return;
          }
        }

        // App band hai - open karo download ke saath
        return self.clients.openWindow(`/?download=${mediaId}&filename=${encodeURIComponent(filename || "video.mp4")}`);
      })
    );
  } else if (pageUrl) {
    // Retry - app open karo URL ke saath
    event.waitUntil(
      self.clients.openWindow(`/?url=${encodeURIComponent(pageUrl)}`)
    );
  }
});

/* ── Notify all clients ── */
async function notifyClients(data) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => c.postMessage(data));
}
