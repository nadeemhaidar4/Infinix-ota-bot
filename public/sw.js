/* QuickSave Service Worker v8.2 - Full Auto Background Download */
const CACHE_NAME     = "quicksave-v8.2.0";
const STATIC_TIMEOUT = 5000;
const BG_DOWNLOADS   = new Map();

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
  event.respondWith(networkFirstWithTimeout(event.request, STATIC_TIMEOUT));
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
   MESSAGE HANDLER
════════════════════════════════════════ */
self.addEventListener("message", async event => {
  const { type, data } = event.data || {};

  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (type === "GET_VERSION") {
    event.ports[0]?.postMessage({ version: CACHE_NAME });
    return;
  }
  if (type === "BG_DOWNLOAD") {
    handleBackgroundDownload(data, event.source);
    return;
  }
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
   BACKGROUND DOWNLOAD - FULL AUTO
   1. Inspect → get media URL + id
   2. Download file completely in SW
   3. Store in special cache
   4. Notification show karo
   5. User tap kare → app khule → auto trigger
════════════════════════════════════════ */
async function handleBackgroundDownload(data, sourceClient) {
  const { url: pageUrl, id } = data;
  const dlId = id || Date.now().toString();

  console.log(`[SW-BG] Starting: ${dlId} | ${pageUrl}`);

  // Sab clients ko batao - start hua
  await notifyClients({
    type:   "BG_STATUS",
    id:     dlId,
    status: "processing",
    msg:    "Processing your video…"
  });

  // Processing notification
  try {
    await self.registration.showNotification("QuickSave ⏳", {
      body:   "Processing your video in background…",
      icon:   "/icon-192.png",
      badge:  "/icon-192.png",
      tag:    `qs-${dlId}`,
      silent: true,
      data:   { dlId, pageUrl, step: "processing" }
    });
  } catch(e) {
    console.log("[SW-BG] Notification failed:", e.message);
  }

  const controller = new AbortController();
  BG_DOWNLOADS.set(dlId, { controller, pageUrl });

  try {
    /* ── Step 1: Inspect ── */
    console.log(`[SW-BG] Step 1: Inspecting…`);

    const inspectRes = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: pageUrl }),
      signal:  controller.signal
    });

    if (!inspectRes.ok) {
      const errData = await inspectRes.json().catch(() => ({}));
      throw new Error(errData.message || `Inspect failed (${inspectRes.status})`);
    }

    const inspectData = await inspectRes.json();
    if (!inspectData.ok || !inspectData.id) {
      throw new Error(inspectData.message || "Could not extract video");
    }

    const mediaId  = inspectData.id;
    const filename = inspectData.filename || "QuickSave_video.mp4";
    const thumb    = inspectData.thumbnail || null;

    console.log(`[SW-BG] Step 1 done: ${filename} | id: ${mediaId}`);

    /* ── Step 2: Download file completely ── */
    console.log(`[SW-BG] Step 2: Downloading file…`);

    await notifyClients({
      type:   "BG_STATUS",
      id:     dlId,
      status: "downloading",
      msg:    `Downloading ${filename}…`
    });

    const dlUrl = `/api/download?id=${mediaId}`;
    const dlRes = await fetch(dlUrl, { signal: controller.signal });

    if (!dlRes.ok) {
      throw new Error(`Download failed (${dlRes.status})`);
    }

    // File ko ArrayBuffer mein load karo (SW mein puri file)
    const fileBuffer = await dlRes.arrayBuffer();
    const contentType = dlRes.headers.get("content-type") || "video/mp4";
    const fileSize = fileBuffer.byteLength;

    console.log(`[SW-BG] Downloaded: ${(fileSize/1024/1024).toFixed(1)}MB`);

    // File ko special cache mein store karo
    const bgCacheName = "qs-bg-downloads";
    const bgCache = await caches.open(bgCacheName);

    const storedResponse = new Response(fileBuffer, {
      headers: {
        "Content-Type":        contentType,
        "Content-Length":      String(fileSize),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-QS-Filename":       filename,
        "X-QS-MediaId":        mediaId,
        "X-QS-DlId":           dlId,
        "X-QS-Timestamp":      String(Date.now())
      }
    });

    const cacheKey = `/bg-download/${dlId}`;
    await bgCache.put(cacheKey, storedResponse);

    console.log(`[SW-BG] Stored in cache: ${cacheKey}`);

    // 30 min baad cache se delete karo
    setTimeout(async () => {
      try {
        const c = await caches.open(bgCacheName);
        await c.delete(cacheKey);
        console.log(`[SW-BG] Cache cleaned: ${cacheKey}`);
      } catch {}
    }, 30 * 60 * 1000);

    /* ── Step 3: Success notification ── */
    await notifyClients({
      type:     "BG_STATUS",
      id:       dlId,
      status:   "done",
      msg:      `${filename} ready!`,
      cacheKey: cacheKey,
      filename: filename,
      mediaId:  mediaId,
      thumb:    thumb
    });

    // Done notification - tap karo auto download hoga
    try {
      await self.registration.showNotification("QuickSave ✅ Download Ready!", {
        body:    `${filename} — Tap to save to your device`,
        icon:    thumb || "/icon-192.png",
        badge:   "/icon-192.png",
        tag:     `qs-${dlId}`,
        silent:  false,
        vibrate: [100, 50, 100, 50, 200],
        data: {
          dlId:     dlId,
          cacheKey: cacheKey,
          filename: filename,
          mediaId:  mediaId,
          pageUrl:  pageUrl,
          step:     "done"
        },
        // Android mein actions dikhte hain
        actions: [
          { action: "save", title: "⬇ Save Now" }
        ]
      });
    } catch(e) {
      console.log("[SW-BG] Success notification failed:", e.message);
    }

    BG_DOWNLOADS.delete(dlId);
    console.log(`[SW-BG] Complete: ${dlId}`);

  } catch(err) {
    if (err.name === "AbortError") {
      console.log(`[SW-BG] Cancelled: ${dlId}`);
      BG_DOWNLOADS.delete(dlId);
      return;
    }

    console.error(`[SW-BG] Error: ${dlId}`, err.message);

    await notifyClients({
      type:   "BG_STATUS",
      id:     dlId,
      status: "error",
      msg:    err.message || "Download failed"
    });

    try {
      await self.registration.showNotification("QuickSave ❌ Failed", {
        body:   `${err.message.slice(0, 80)} — Tap to retry`,
        icon:   "/icon-192.png",
        badge:  "/icon-192.png",
        tag:    `qs-${dlId}`,
        silent: false,
        data:   { dlId, pageUrl, step: "error" }
      });
    } catch {}

    BG_DOWNLOADS.delete(dlId);
  }
}

/* ════════════════════════════════════════
   BG CACHE FETCH - App se request aaye
════════════════════════════════════════ */
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // Background cached file serve karo
  if (url.pathname.startsWith("/bg-download/")) {
    event.respondWith(
      caches.open("qs-bg-downloads")
        .then(cache => cache.match(url.pathname))
        .then(response => {
          if (response) return response;
          return new Response("File not found or expired", { status: 404 });
        })
    );
    return;
  }
});

/* ════════════════════════════════════════
   NOTIFICATION CLICK
════════════════════════════════════════ */
self.addEventListener("notificationclick", event => {
  const { action, notification } = event;
  const { dlId, cacheKey, filename, mediaId, pageUrl, step } = notification.data || {};

  notification.close();

  if (step === "error") {
    // Error - retry ke liye app open karo
    event.waitUntil(
      openOrFocusApp(`/?url=${encodeURIComponent(pageUrl || "")}`)
    );
    return;
  }

  if (step === "done" && cacheKey) {
    // Success - app open karo, auto download trigger hoga
    event.waitUntil(
      openOrFocusApp(
        `/?bg_dl=${encodeURIComponent(dlId)}&ck=${encodeURIComponent(cacheKey)}&fn=${encodeURIComponent(filename || "video.mp4")}`
      )
    );
    return;
  }

  // Default - app open karo
  event.waitUntil(openOrFocusApp("/"));
});

/* ── App open ya focus karo ── */
async function openOrFocusApp(path) {
  const clients = await self.clients.matchAll({
    type:            "window",
    includeUncontrolled: true
  });

  // Agar app already open hai
  for (const client of clients) {
    const clientUrl = new URL(client.url);
    if (clientUrl.origin === self.location.origin) {
      await client.focus();
      client.postMessage({
        type:    "OPEN_BG_DOWNLOAD",
        url:     path
      });
      return;
    }
  }

  // App band hai - open karo
  await self.clients.openWindow(path);
}

/* ── Notify all clients ── */
async function notifyClients(data) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => {
    try { c.postMessage(data); } catch {}
  });
}

/* ── Push (future) ── */
self.addEventListener("push", event => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    self.registration.showNotification(data.title || "QuickSave", {
      body:  data.body || "",
      icon:  "/icon-192.png",
      badge: "/icon-192.png"
    })
  );
});
