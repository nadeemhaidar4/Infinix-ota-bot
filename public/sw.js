/* QuickSave Service Worker v8.4 */
const CACHE_NAME = "quicksave-v8.4.0";
const BG_DOWNLOADS = new Map();

const STATIC_FILES = [
  "/", "/index.html", "/styles.css", "/app.js",
  "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME && k !== "qs-bg-files")
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── Fetch handler ── */
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
    event.waitUntil(handleBgDownload(data));
    return;
  }
  if (type === "CANCEL") {
    BG_DOWNLOADS.get(data?.id)?.abort();
    BG_DOWNLOADS.delete(data?.id);
    return;
  }
});

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD
   
   SW mein file download karo memory mein
   Fir client ko base64/arrayBuffer bhejo
   Client blob banayega - NO a.click()
════════════════════════════════════════ */
async function handleBgDownload(data) {
  const { url: pageUrl, id: dlId } = data;
  console.log("[SW-BG] Start:", dlId);

  const ctrl = new AbortController();
  BG_DOWNLOADS.set(dlId, ctrl);

  await broadcast({ type: "BG_STATUS", id: dlId, status: "processing" });

  /* Processing notification - silent */
  try {
    await self.registration.showNotification("QuickSave", {
      body:   "Downloading your video...",
      icon:   "/icon-192.png",
      badge:  "/icon-192.png",
      tag:    `qs-prog-${dlId}`,
      silent: true,
      data:   { dlId, step: "progress" }
    });
  } catch(e) {}

  try {
    /* Step 1: Inspect */
    const inspRes = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: pageUrl }),
      signal:  ctrl.signal
    });

    if (!inspRes.ok) {
      const e = await inspRes.json().catch(() => ({}));
      throw new Error(e.message || "Could not extract video");
    }

    const insp = await inspRes.json();
    if (!insp.ok || !insp.id) throw new Error(insp.message || "Extraction failed");

    const mediaId  = insp.id;
    const filename = cleanFilename(insp.filename || "QuickSave_video.mp4");

    console.log("[SW-BG] Got:", filename, mediaId);

    await broadcast({
      type: "BG_STATUS", id: dlId,
      status: "downloading", filename
    });

    /* Step 2: Download video bytes */
    const dlRes = await fetch(
      `/api/download?id=${encodeURIComponent(mediaId)}`,
      { signal: ctrl.signal }
    );

    if (!dlRes.ok) throw new Error(`Download failed (${dlRes.status})`);

    const contentType = parseContentType(dlRes.headers.get("content-type"));
    const fileBytes   = await dlRes.arrayBuffer();
    const sizeMB      = (fileBytes.byteLength / 1024 / 1024).toFixed(1);

    console.log("[SW-BG] Downloaded:", sizeMB, "MB | type:", contentType);

    if (fileBytes.byteLength < 5000) {
      throw new Error("File too small, likely an error response");
    }

    /* Step 3: Close progress notification */
    try {
      const notifs = await self.registration.getNotifications({ tag: `qs-prog-${dlId}` });
      notifs.forEach(n => n.close());
    } catch(e) {}

    /* Step 4: Client ko file data bhejo seedha */
    const clients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    let sentToClient = false;

    for (const client of clients) {
      if (new URL(client.url).origin === self.location.origin) {
        /* ArrayBuffer transfer karo - zero copy */
        client.postMessage({
          type:        "SAVE_FILE",
          id:          dlId,
          filename:    filename,
          contentType: contentType,
          sizeMB:      sizeMB,
          buffer:      fileBytes
        }, [fileBytes]); /* Transferable - memory efficient */

        sentToClient = true;
        console.log("[SW-BG] File sent to client");
        break;
      }
    }

    /* Step 5: Success notification */
    await self.registration.showNotification("✅ QuickSave — Video Ready!", {
      body:    sentToClient
        ? `${filename} (${sizeMB}MB) — Saving to your device...`
        : `${filename} (${sizeMB}MB) — Tap to save`,
      icon:    "/icon-192.png",
      badge:   "/icon-192.png",
      tag:     `qs-done-${dlId}`,
      silent:  false,
      vibrate: [100, 50, 200],
      data: {
        dlId,
        mediaId,
        filename,
        sizeMB,
        step: "done",
        /* File data ab available hai client mein */
        clientHasFile: sentToClient
      }
    });

    BG_DOWNLOADS.delete(dlId);
    console.log("[SW-BG] Complete:", dlId);

  } catch(err) {
    if (err.name === "AbortError") {
      BG_DOWNLOADS.delete(dlId);
      return;
    }

    console.error("[SW-BG] Error:", err.message);

    await broadcast({
      type: "BG_STATUS", id: dlId,
      status: "error", msg: err.message
    });

    /* Close progress notification */
    try {
      const notifs = await self.registration.getNotifications({ tag: `qs-prog-${dlId}` });
      notifs.forEach(n => n.close());
    } catch(e) {}

    try {
      await self.registration.showNotification("❌ QuickSave — Download Failed", {
        body:   err.message.slice(0, 100),
        icon:   "/icon-192.png",
        badge:  "/icon-192.png",
        tag:    `qs-err-${dlId}`,
        silent: false,
        data:   { dlId, step: "error" }
      });
    } catch(e) {}

    BG_DOWNLOADS.delete(dlId);
  }
}

/* ════════════════════════════════════════
   NOTIFICATION CLICK
════════════════════════════════════════ */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const d = event.notification.data || {};

  if (d.step === "progress") return; /* Progress notification - ignore */

  if (d.step === "done") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true })
        .then(async clients => {
          for (const client of clients) {
            if (new URL(client.url).origin === self.location.origin) {
              await client.focus();
              /* Client ko trigger karo */
              client.postMessage({
                type:     "NOTIF_CLICKED",
                mediaId:  d.mediaId,
                filename: d.filename,
                dlId:     d.dlId
              });
              return;
            }
          }
          /* App band thi - open karo */
          await self.clients.openWindow(
            `/?qs_media=${encodeURIComponent(d.mediaId)}&qs_fn=${encodeURIComponent(d.filename)}`
          );
        })
    );
    return;
  }

  /* Default: app open */
  event.waitUntil(
    self.clients.openWindow("/")
  );
});

/* ── Helpers ── */
async function broadcast(data) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach(c => { try { c.postMessage(data); } catch {} });
}

function cleanFilename(name) {
  const ext  = name.match(/\.[a-z0-9]{2,4}$/i)?.[0] || ".mp4";
  const base = name.replace(/\.[a-z0-9]{2,4}$/i, "")
    .replace(/[^\w\s\-_.]/g, "")
    .trim().replace(/\s+/g, "_").slice(0, 50);
  return (base || "QuickSave_video") + ext;
}

function parseContentType(ct) {
  if (!ct) return "video/mp4";
  const type = ct.split(";")[0].trim().toLowerCase();
  if (type.startsWith("video/")) return type;
  if (type.startsWith("audio/")) return type;
  return "video/mp4";
}
