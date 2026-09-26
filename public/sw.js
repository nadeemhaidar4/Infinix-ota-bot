/* QuickSave Service Worker v8.3 - Fixed Background Download */
const CACHE_NAME = "quicksave-v8.3.0";
const BG_DOWNLOADS = new Map();

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
  );
});

/* ── Activate ── */
self.addEventListener("activate", event => {
  console.log("[SW] Activating:", CACHE_NAME);
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== "qs-bg-files")
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch: Static files ── */
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  /* API calls - no cache */
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(event.request));
    return;
  }

  /* Background stored video file serve karo */
  if (url.pathname.startsWith("/qs-file/")) {
    event.respondWith(serveBgFile(url.pathname));
    return;
  }

  /* External - no cache */
  if (url.origin !== self.location.origin) {
    event.respondWith(fetch(event.request));
    return;
  }

  /* Static files - network first */
  event.respondWith(networkFirst(event.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(request, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const idx = await cache.match("/index.html");
      if (idx) return idx;
    }
    return new Response("Offline", { status: 503 });
  }
}

/* ── Serve background downloaded file ── */
async function serveBgFile(pathname) {
  const cache = await caches.open("qs-bg-files");
  const stored = await cache.match(pathname);
  if (stored) return stored;
  return new Response("File not found or expired", { status: 404 });
}

/* ════════════════════════════════════════
   MESSAGE HANDLER
════════════════════════════════════════ */
self.addEventListener("message", event => {
  const { type, data } = event.data || {};

  if (type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }

  if (type === "BG_DOWNLOAD") {
    /* waitUntil zaruri hai - SW band na ho beech mein */
    event.waitUntil(
      handleBackgroundDownload(data)
    );
    return;
  }

  if (type === "CANCEL") {
    const dl = BG_DOWNLOADS.get(data?.id);
    if (dl) { dl.abort(); BG_DOWNLOADS.delete(data.id); }
    return;
  }
});

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD HANDLER
   
   Flow:
   1. /api/inspect → mediaId, filename
   2. /api/download → puri video file bytes
   3. Cache mein store karo (/qs-file/ID)
   4. Client ko message bhejo → auto blob download
   5. Agar client visible nahi → notification
════════════════════════════════════════ */
async function handleBackgroundDownload(data) {
  const { url: pageUrl, id: dlId } = data;

  console.log(`[SW-BG] Starting: ${dlId}`);

  const controller = new AbortController();
  BG_DOWNLOADS.set(dlId, controller);

  /* Clients ko status bhejo */
  await broadcast({ type: "BG_STATUS", id: dlId, status: "processing" });

  try {
    /* ── STEP 1: Inspect ── */
    const inspRes = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: pageUrl }),
      signal:  controller.signal
    });

    if (!inspRes.ok) {
      const e = await inspRes.json().catch(() => ({}));
      throw new Error(e.message || `Inspect failed (${inspRes.status})`);
    }

    const insp = await inspRes.json();
    if (!insp.ok || !insp.id) throw new Error(insp.message || "Extraction failed");

    const mediaId  = insp.id;
    const filename = sanitizeFilename(insp.filename || "QuickSave_video.mp4");

    console.log(`[SW-BG] Got mediaId: ${mediaId} | file: ${filename}`);

    await broadcast({
      type: "BG_STATUS", id: dlId,
      status: "downloading", filename
    });

    /* ── STEP 2: Download actual video bytes ── */
    const dlRes = await fetch(`/api/download?id=${encodeURIComponent(mediaId)}`, {
      signal: controller.signal
    });

    if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);

    /* Content-Type check - video hona chahiye */
    const ct = (dlRes.headers.get("content-type") || "video/mp4")
      .split(";")[0].trim();

    if (!ct.startsWith("video/") && !ct.startsWith("audio/") &&
        ct !== "application/octet-stream") {
      throw new Error(`Invalid file type: ${ct}`);
    }

    /* Puri file bytes padho */
    const fileBytes  = await dlRes.arrayBuffer();
    const fileSizeMB = (fileBytes.byteLength / 1024 / 1024).toFixed(1);

    console.log(`[SW-BG] Downloaded: ${fileSizeMB}MB | type: ${ct}`);

    /* ── STEP 3: Cache mein store karo ── */
    const cacheKey  = `/qs-file/${dlId}`;
    const bgCache   = await caches.open("qs-bg-files");

    /* Sahi Content-Type ke saath store karo - HTML nahi! */
    const storeResp = new Response(fileBytes, {
      status:  200,
      headers: {
        "Content-Type":        ct.startsWith("video/") ? ct : "video/mp4",
        "Content-Length":      String(fileBytes.byteLength),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "X-QS-Filename":       filename,
        "X-QS-Size":           String(fileBytes.byteLength)
      }
    });

    await bgCache.put(cacheKey, storeResp);

    /* 30 min baad cache clean karo */
    setTimeout(async () => {
      try {
        const c = await caches.open("qs-bg-files");
        await c.delete(cacheKey);
      } catch {}
    }, 30 * 60 * 1000);

    /* ── STEP 4: Client ko bhejo ── */
    const clients = await self.clients.matchAll({ type: "window" });

    /* Koi visible client hai? */
    const visibleClient = clients.find(c => c.visibilityState === "visible");

    if (visibleClient) {
      /* App open hai - seedha download trigger karo */
      visibleClient.postMessage({
        type:     "AUTO_DOWNLOAD",
        cacheKey: cacheKey,
        filename: filename,
        size:     fileBytes.byteLength,
        id:       dlId
      });
      console.log(`[SW-BG] Sent to visible client`);
    } else if (clients.length > 0) {
      /* App open hai but background mein */
      clients[0].postMessage({
        type:     "AUTO_DOWNLOAD",
        cacheKey: cacheKey,
        filename: filename,
        size:     fileBytes.byteLength,
        id:       dlId
      });
    }

    /* ── STEP 5: Notification ── */
    await self.registration.showNotification("✅ QuickSave — Download Ready", {
      body:    `${filename} (${fileSizeMB}MB) saved!`,
      icon:    "/icon-192.png",
      badge:   "/icon-192.png",
      tag:     `qs-done-${dlId}`,
      silent:  false,
      vibrate: [100, 50, 200],
      data: {
        cacheKey: cacheKey,
        filename: filename,
        dlId:     dlId,
        done:     true
      }
    });

    BG_DOWNLOADS.delete(dlId);
    console.log(`[SW-BG] Complete: ${dlId}`);

  } catch (err) {
    if (err.name === "AbortError") {
      console.log(`[SW-BG] Cancelled: ${dlId}`);
      BG_DOWNLOADS.delete(dlId);
      return;
    }

    console.error(`[SW-BG] Failed:`, err.message);

    await broadcast({
      type:   "BG_STATUS",
      id:     dlId,
      status: "error",
      msg:    err.message
    });

    try {
      await self.registration.showNotification("❌ QuickSave — Failed", {
        body:   `${err.message.slice(0, 100)}`,
        icon:   "/icon-192.png",
        badge:  "/icon-192.png",
        tag:    `qs-err-${dlId}`,
        silent: false,
        data:   { error: true, dlId }
      });
    } catch {}

    BG_DOWNLOADS.delete(dlId);
  }
}

/* ════════════════════════════════════════
   NOTIFICATION CLICK
════════════════════════════════════════ */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const { cacheKey, filename, done, dlId } = event.notification.data || {};

  if (!done || !cacheKey) return;

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(async clients => {

        /* Agar koi client open hai */
        for (const client of clients) {
          if (new URL(client.url).origin === self.location.origin) {
            await client.focus();
            /* Auto download trigger karo */
            client.postMessage({
              type:     "AUTO_DOWNLOAD",
              cacheKey: cacheKey,
              filename: filename,
              id:       dlId
            });
            return;
          }
        }

        /* App band hai - open karo */
        const newClient = await self.clients.openWindow(
          `/?qs_dl=${encodeURIComponent(dlId)}&qs_ck=${encodeURIComponent(cacheKey)}&qs_fn=${encodeURIComponent(filename)}`
        );
      })
  );
});

/* ── Broadcast to all clients ── */
async function broadcast(data) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => { try { c.postMessage(data); } catch {} });
}

/* ── Filename sanitize ── */
function sanitizeFilename(name) {
  /* Extension preserve karo */
  const ext  = name.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4";
  const base = name.replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 50);
  return (base || "QuickSave_video") + ext;
}
