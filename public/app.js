/* QuickSave app.js v8.2 - Full Auto Background Download */
console.log("QuickSave v8.2 loaded");

const APP_VERSION    = "8.2.0";
const AD_DISABLE_CODE = "666666";

const $ = id => document.getElementById(id);

const url            = $("url"),
      paste          = $("paste"),
      go             = $("go"),
      drop           = $("drop"),
      status         = $("status"),
      result         = $("result"),
      name           = $("name"),
      meta           = $("meta"),
      download       = $("download"),
      thumb          = $("thumb"),
      progress       = $("progress"),
      bar            = $("bar"),
      progressText   = $("progressText"),
      progressPct    = $("progressPct"),
      historyPanel   = $("historyPanel"),
      historyEl      = $("history"),
      install        = $("install"),
      iosInstall     = $("iosInstall"),
      iosDismiss     = $("iosDismiss"),
      autoToggle     = $("autoToggle"),
      autoLabel      = $("autoLabel"),
      retryBtn       = $("retryBtn"),
      adAfterDl      = $("adAfterDl"),
      interstitialAd = $("interstitialAd"),
      closeBtn       = $("closeInterstitial"),
      adTimerEl      = $("adTimer"),
      queueStatus    = $("queueStatus"),
      queueText      = $("queueText"),
      updateBanner   = $("updateBanner"),
      adCodeInput    = $("adCodeInput"),
      adCodeBtn      = $("adCodeBtn"),
      adCodeMsg      = $("adCodeMsg"),
      bgStatus       = $("bgStatus"),
      bgStatusText   = $("bgStatusText"),
      bgStatusIcon   = $("bgStatusIcon");

let current        = null;
let installPrompt  = null;
let autoProcessing = false;
let lastUrl        = "";
let swRegistration = null;
let newSW          = null;

/* ════════════════════════════════════════
   PWA DETECTION
════════════════════════════════════════ */
function isPWA() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true ||
    document.referrer.includes("android-app://")
  );
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isInStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         window.navigator.standalone === true;
}

/* ════════════════════════════════════════
   SUPPORTED PLATFORMS
════════════════════════════════════════ */
const SUPPORTED = ["instagram.com","facebook.com","fb.watch","twitter.com","x.com"];
function isSupportedUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return SUPPORTED.some(p => h.includes(p));
  } catch { return false; }
}

/* ════════════════════════════════════════
   AD MANAGEMENT
════════════════════════════════════════ */
function isAdsDisabled() {
  return localStorage.getItem("qs_ads_disabled") === "true";
}
function setAdsDisabled(val) {
  localStorage.setItem("qs_ads_disabled", val ? "true" : "false");
  applyAdVisibility();
}
function applyAdVisibility() {
  const disabled = isAdsDisabled();
  document.querySelectorAll(".ad-wrap,.interstitial-overlay,[data-ad]").forEach(el => {
    el.classList.toggle("ads-hidden", disabled);
  });
  if (adCodeMsg) {
    adCodeMsg.textContent = disabled ? "✅ Ads are disabled" : "";
    adCodeMsg.className   = disabled ? "code-msg ok" : "code-msg";
  }
}

if (adCodeBtn) {
  adCodeBtn.addEventListener("click", () => {
    const code = (adCodeInput?.value || "").trim();
    if (code === AD_DISABLE_CODE) {
      setAdsDisabled(true);
      if (adCodeMsg) { adCodeMsg.textContent = "✅ Ads disabled!"; adCodeMsg.className = "code-msg ok"; }
    } else if (code === "000000") {
      setAdsDisabled(false);
      if (adCodeMsg) { adCodeMsg.textContent = "Ads re-enabled."; adCodeMsg.className = "code-msg"; }
    } else {
      if (adCodeMsg) { adCodeMsg.textContent = "❌ Invalid code."; adCodeMsg.className = "code-msg err"; }
    }
    if (adCodeInput) adCodeInput.value = "";
  });
}
if (adCodeInput) {
  adCodeInput.addEventListener("keydown", e => { if (e.key === "Enter") adCodeBtn?.click(); });
}

/* ════════════════════════════════════════
   AUTO SETTING
════════════════════════════════════════ */
function isAutoEnabled() { return localStorage.getItem("qs_auto") !== "false"; }
function setAuto(val) {
  localStorage.setItem("qs_auto", val ? "true" : "false");
  autoToggle.checked    = val;
  autoLabel.textContent = val ? "Auto ON" : "Auto OFF";
}
autoToggle.addEventListener("change", () => setAuto(autoToggle.checked));

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
function msg(t, c = "") {
  status.textContent = t;
  status.className   = "status " + c;
  status.classList.toggle("hide", !t);
}
function sizeStr(n) {
  if (!n) return "";
  const u = ["B","KB","MB","GB"];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function escHtml(s) {
  return String(s).replace(/[&<>"']/g,
    m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])
  );
}
function buildDlUrl(d) {
  if (!d?.id) return "#";
  return `/api/download?id=${encodeURIComponent(d.id)}`;
}

/* ════════════════════════════════════════
   BG STATUS UI
════════════════════════════════════════ */
function showBgStatus(text, type = "processing", icon = "⬇") {
  if (!bgStatus) return;
  if (bgStatusText) bgStatusText.textContent = text;
  if (bgStatusIcon) bgStatusIcon.textContent = icon;
  bgStatus.className = `bg-status ${type}`;
  bgStatus.classList.remove("hide");
}
function hideBgStatus() {
  bgStatus?.classList.add("hide");
}

/* ════════════════════════════════════════
   QUEUE STATUS
════════════════════════════════════════ */
async function updateQueueStatus() {
  try {
    const r = await fetch("/api/queue");
    const d = await r.json();
    if (!queueStatus || !queueText) return;
    if (d.processing > 0 || d.waiting > 0) {
      queueStatus.classList.remove("hide");
      queueText.textContent = !d.available
        ? `🔄 ${d.processing} processing, ${d.waiting} waiting`
        : `✅ Server ready`;
    } else {
      queueStatus.classList.add("hide");
    }
  } catch {}
}

/* ════════════════════════════════════════
   NOTIFICATION PERMISSION
════════════════════════════════════════ */
async function requestNotifPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied")  return false;
  const r = await Notification.requestPermission();
  return r === "granted";
}

/* ════════════════════════════════════════
   AUTO DOWNLOAD FROM BG CACHE
   SW ne cache mein store ki file ko
   automatically download karo
════════════════════════════════════════ */
async function autoDownloadFromCache(cacheKey, filename) {
  console.log("[auto-dl] Fetching from cache:", cacheKey);

  showBgStatus("⬇ Saving to your device…", "downloading", "⬇");

  try {
    // SW cache se file fetch karo
    const response = await fetch(cacheKey);

    if (!response.ok) {
      throw new Error(`Cache fetch failed: ${response.status}`);
    }

    const blob = await response.blob();
    const safeFilename = filename || "QuickSave_video.mp4";

    // Blob URL banao aur auto click karo
    const blobUrl = URL.createObjectURL(blob);
    const a       = document.createElement("a");
    a.href        = blobUrl;
    a.download    = safeFilename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      document.body.removeChild(a);
    }, 2000);

    showBgStatus(`✅ Saved! Check your Downloads folder.`, "ok", "✅");
    msg("✅ Video saved to Downloads!", "ok");

    // History mein add karo
    saveHistory({
      id:   cacheKey,
      name: safeFilename,
      type: "video/mp4",
      time: Date.now()
    });

    setTimeout(() => hideBgStatus(), 6000);

    console.log("[auto-dl] ✓ Downloaded:", safeFilename);

  } catch(e) {
    console.error("[auto-dl] Failed:", e.message);
    showBgStatus(`❌ Save failed: ${e.message}`, "err", "❌");
    setTimeout(() => hideBgStatus(), 5000);
  }
}

/* ════════════════════════════════════════
   SW MESSAGE LISTENER
════════════════════════════════════════ */
function setupSWMessages() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", async event => {
    const data = event.data || {};
    console.log("[SW msg]", data.type, data.status || "");

    /* Background download status updates */
    if (data.type === "BG_STATUS") {
      switch(data.status) {
        case "processing":
          showBgStatus("⏳ Processing video… You can go back!", "processing", "⏳");
          break;
        case "downloading":
          showBgStatus("⬇ Downloading in background…", "downloading", "⬇");
          break;
        case "done":
          // Auto download karo cache se
          if (data.cacheKey) {
            await autoDownloadFromCache(data.cacheKey, data.filename);
          }
          break;
        case "error":
          showBgStatus(`❌ ${data.msg || "Download failed"}`, "err", "❌");
          setTimeout(() => hideBgStatus(), 6000);
          break;
      }
      return;
    }

    /* Notification click se aaya - app already open thi */
    if (data.type === "OPEN_BG_DOWNLOAD") {
      const urlParams = new URLSearchParams(new URL(data.url, window.location.origin).search);
      const ck = urlParams.get("ck");
      const fn = urlParams.get("fn");
      if (ck) {
        await autoDownloadFromCache(decodeURIComponent(ck), decodeURIComponent(fn || "video.mp4"));
      }
      return;
    }

    /* Direct trigger (fallback) */
    if (data.type === "TRIGGER_DOWNLOAD") {
      if (data.cacheKey) {
        await autoDownloadFromCache(data.cacheKey, data.filename);
      } else if (data.mediaId) {
        startDownload({ id: data.mediaId, filename: data.filename });
      }
      return;
    }
  });
}

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD TRIGGER
════════════════════════════════════════ */
async function startBackgroundDownload(pageUrl) {
  if (!swRegistration?.active) {
    console.log("[BG] No SW active");
    return false;
  }

  // Notification permission
  const hasNotif = await requestNotifPermission();
  if (!hasNotif) {
    console.log("[BG] No notification permission, using normal flow");
    return false;
  }

  const dlId = Date.now().toString();

  // SW ko message bhejo
  swRegistration.active.postMessage({
    type: "BG_DOWNLOAD",
    data: { url: pageUrl, id: dlId }
  });

  showBgStatus("⏳ Processing in background… Aap wapas ja sakte hain!", "processing", "⏳");
  msg("⏳ Background mein ho raha hai! Notification aayegi.", "ok");

  return true;
}

/* ════════════════════════════════════════
   SHARE TARGET HANDLER
════════════════════════════════════════ */
async function handleShareTarget(sharedUrl) {
  console.log("[share] URL:", sharedUrl);

  if (!isSupportedUrl(sharedUrl)) {
    msg("Only Instagram, Facebook, Twitter/X links supported.", "err");
    return;
  }

  url.value = sharedUrl;

  // PWA mein hai? Background download try karo
  if (isPWA() && swRegistration?.active) {
    const started = await startBackgroundDownload(sharedUrl);
    if (started) {
      // Background download start hua - normal flow skip karo
      // User wapas ja sakta hai
      return;
    }
  }

  // Fallback: Normal download
  await processUrl(sharedUrl, true);
}

/* ════════════════════════════════════════
   INTERSTITIAL AD
════════════════════════════════════════ */
function showInterstitialAd(callback) {
  if (isAdsDisabled() || !interstitialAd) { callback?.(); return; }
  interstitialAd.classList.remove("hide");
  document.body.style.overflow = "hidden";
  let secs = 5;
  if (adTimerEl) adTimerEl.textContent = secs;
  const timer = setInterval(() => {
    secs--;
    if (adTimerEl) adTimerEl.textContent = secs;
    if (secs <= 0) { clearInterval(timer); closeAd(); callback?.(); }
  }, 1000);
  function closeAd() {
    clearInterval(timer);
    interstitialAd.classList.add("hide");
    document.body.style.overflow = "";
  }
  if (closeBtn) closeBtn.onclick = () => { closeAd(); callback?.(); };
  interstitialAd.onclick = e => { if (e.target === interstitialAd) { closeAd(); callback?.(); } };
}

/* ════════════════════════════════════════
   UPDATE BANNER
════════════════════════════════════════ */
function showUpdateBanner() {
  if (!updateBanner) return;
  updateBanner.classList.remove("hide");
  const btn = $("updateNowBtn");
  if (btn) {
    btn.onclick = () => {
      newSW?.postMessage({ type: "SKIP_WAITING" });
      updateBanner.classList.add("hide");
    };
  }
}

async function checkServerVersion() {
  try {
    const r = await fetch("/api/version?t=" + Date.now());
    const d = await r.json();
    const sv = d.version;
    const stored = localStorage.getItem("qs_server_version");
    if (stored && stored !== sv) {
      localStorage.setItem("qs_server_version", sv);
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      window.location.reload(true);
    } else {
      localStorage.setItem("qs_server_version", sv);
    }
  } catch {}
}

/* ════════════════════════════════════════
   HISTORY
════════════════════════════════════════ */
function saveHistory(item) {
  let h = JSON.parse(localStorage.getItem("qs_history") || "[]");
  h = [item, ...h.filter(x => x.id !== item.id)].slice(0, 8);
  localStorage.setItem("qs_history", JSON.stringify(h));
  renderHistory();
}
function renderHistory() {
  const h = JSON.parse(localStorage.getItem("qs_history") || "[]");
  if (!h.length) { historyPanel.classList.add("hide"); return; }
  historyPanel.classList.remove("hide");
  historyEl.innerHTML = h.map(x => {
    const isCacheKey = x.id && x.id.startsWith("/bg-download/");
    const href = isCacheKey
      ? escHtml(x.id)
      : (x.id ? escHtml(`/api/download?id=${x.id}`) : "#");
    return `<div class="historyrow">
      <div>
        <b>${escHtml(x.name || "media")}</b>
        <small>${escHtml(x.type || "media")} • ${new Date(x.time).toLocaleString()}</small>
      </div>
      <a href="${href}" download="${escHtml(x.name || "media")}">↓ Save</a>
    </div>`;
  }).join("");
}
$("clearHistory").onclick = () => {
  localStorage.removeItem("qs_history");
  renderHistory();
};

/* ════════════════════════════════════════
   CLIPBOARD
════════════════════════════════════════ */
async function tryAutoPaste() {
  if (!isAutoEnabled()) return null;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text && isSupportedUrl(text)) return text;
  } catch {}
  return null;
}

/* ════════════════════════════════════════
   MAIN PROCESS (Normal flow)
════════════════════════════════════════ */
async function processUrl(value, autoDownload = false) {
  if (!value || autoProcessing) return;
  if (!isSupportedUrl(value)) {
    msg("Only Instagram, Facebook, and Twitter/X links are supported.", "err");
    return;
  }

  autoProcessing = true;
  lastUrl        = value;
  url.value      = value;
  go.disabled    = true;
  result.classList.add("hide");
  progress.classList.add("hide");
  if (adAfterDl) adAfterDl.classList.add("hide");

  const btnText = [...go.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
  if (btnText) btnText.textContent = "Checking… ";
  updateQueueStatus();

  try {
    const qr = await fetch("/api/queue");
    const qd = await qr.json();
    msg(!qd.available && qd.waiting > 2
      ? `⏳ Queue mein hai (position ${qd.waiting + 1})…`
      : "⏳ Fetching media info…"
    );

    const r = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: value })
    });
    const d = await r.json();
    updateQueueStatus();

    if (r.status === 503 && d.type === "queue-full")
      throw new Error(`🔴 Server busy. ${d.queueSize} waiting. Try in 30s.`);
    if (r.status === 408)
      throw new Error("⏱️ Timeout. Please try again.");
    if (!r.ok || !d.ok) throw new Error(d.message || "Could not process link.");
    if (!d.id)          throw new Error("Server error.");

    current = d;
    name.textContent = d.filename || "media.mp4";
    meta.textContent =
      (d.contentType || "media").replace("video/","").toUpperCase() +
      (d.size ? " • " + sizeStr(d.size) : "");
    showPreview(d);
    download.href = buildDlUrl(d);
    download.setAttribute("download", d.filename || "QuickSave_Media.mp4");
    result.classList.remove("hide");
    msg("✅ Ready! Tap the button below to download.", "ok");

    if (autoDownload && isAutoEnabled()) {
      setTimeout(() => triggerDownload(d), 600);
    }

  } catch(e) {
    console.error("Process failed:", e);
    msg("❌ " + (e.message || "Something went wrong."), "err");
  } finally {
    go.disabled    = false;
    autoProcessing = false;
    if (btnText) btnText.textContent = "Get media ";
    updateQueueStatus();
  }
}

/* ════════════════════════════════════════
   START DOWNLOAD (Normal)
════════════════════════════════════════ */
function startDownload(d) {
  const dlUrl = buildDlUrl(d);

  saveHistory({
    id:   d.id,
    name: d.filename    || "media.mp4",
    type: d.contentType || "media",
    time: Date.now()
  });

  progress.classList.remove("hide");
  if (adAfterDl && !isAdsDisabled()) adAfterDl.classList.remove("hide");

  progressText.textContent = "Starting download…";
  bar.style.width          = "10%";
  progressPct.textContent  = "10%";

  if (isIOS()) {
    window.location.href = dlUrl;
  } else {
    const a = document.createElement("a");
    a.href  = dlUrl;
    a.download = d.filename || "QuickSave_Media.mp4";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 1000);
  }

  setTimeout(() => {
    bar.style.width          = "100%";
    progressPct.textContent  = "100%";
    progressText.textContent = isIOS()
      ? "✅ Tap & hold video to save to Photos."
      : "✅ Check your Downloads folder.";
  }, 800);
}

/* ════════════════════════════════════════
   TRIGGER DOWNLOAD
════════════════════════════════════════ */
function triggerDownload(d) {
  if (!d?.id) return;
  if (isPWA() && !isAdsDisabled()) {
    showInterstitialAd(() => startDownload(d));
  } else {
    startDownload(d);
  }
}

/* ════════════════════════════════════════
   PREVIEW
════════════════════════════════════════ */
function showPreview(d) {
  thumb.innerHTML    = "";
  thumb.style.cursor = "pointer";
  thumb.onclick      = () => window.open(`/api/download?id=${d.id}&inline=1`, "_blank");
  if (d.thumbnail) {
    const img = new Image();
    img.src   = d.thumbnail;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;border-radius:12px;";
    img.onload  = () => thumb.appendChild(img);
    img.onerror = () => (thumb.innerHTML = "<span>▶</span>");
  } else {
    const mime = (d.contentType || "").toLowerCase();
    thumb.innerHTML = mime.startsWith("image/") ? "<span>◈</span>"
      : mime.startsWith("video/")               ? "<span>▶</span>"
      :                                            "<span>♪</span>";
  }
}

/* ════════════════════════════════════════
   BUTTONS
════════════════════════════════════════ */
paste.onclick = async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      url.value         = text;
      paste.textContent = "✓ Pasted";
      setTimeout(() => (paste.textContent = "Paste"), 1500);
      if (isAutoEnabled() && isSupportedUrl(text)) processUrl(text, true);
    } else {
      msg("Clipboard is empty.", "err");
    }
  } catch {
    msg("Clipboard unavailable. Paste manually.", "err");
    url.focus();
  }
};

go.onclick = () => {
  const v = url.value.trim();
  if (!v) return msg("Please paste a media URL first.", "err");
  processUrl(v, false);
};

url.onkeydown = e => {
  if (e.key === "Enter") {
    const v = url.value.trim();
    if (v) processUrl(v, isAutoEnabled() && isSupportedUrl(v));
  }
};

download.addEventListener("click", e => {
  if (!current?.id) return;
  e.preventDefault();
  if (isPWA() && !isAdsDisabled()) {
    showInterstitialAd(() => startDownload(current));
  } else {
    startDownload(current);
  }
});

if (retryBtn) {
  retryBtn.onclick = e => { e.preventDefault(); if (lastUrl) processUrl(lastUrl, false); };
}

/* ════════════════════════════════════════
   DRAG & DROP
════════════════════════════════════════ */
["dragenter","dragover"].forEach(ev =>
  drop.addEventListener(ev, x => { x.preventDefault(); drop.classList.add("drag"); })
);
["dragleave","drop"].forEach(ev =>
  drop.addEventListener(ev, x => { x.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", e => {
  const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
  if (text) processUrl(text.trim(), isAutoEnabled() && isSupportedUrl(text.trim()));
});

/* ════════════════════════════════════════
   PWA INSTALL
════════════════════════════════════════ */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPrompt = e;
  if (!isIOS()) install.classList.remove("hidden");
});
install.onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  install.classList.add("hidden");
};

/* ── iOS Banner ── */
if (iosDismiss) {
  iosDismiss.onclick = () => {
    iosInstall?.classList.add("hidden");
    localStorage.setItem("qs_ios_dismissed", "true");
  };
}

/* ════════════════════════════════════════
   SERVICE WORKER
════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      swRegistration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      console.log("[SW] Registered");

      swRegistration.addEventListener("updatefound", () => {
        newSW = swRegistration.installing;
        newSW.addEventListener("statechange", () => {
          if (newSW.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner();
          }
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => {
        window.location.reload();
      });

      // SW messages setup
      setupSWMessages();

      // Auto update check
      setInterval(() => swRegistration.update(), 5 * 60 * 1000);

    } catch(e) {
      console.log("[SW] Failed:", e);
    }
  });
}

/* ════════════════════════════════════════
   STARTUP
════════════════════════════════════════ */
async function onStartup() {
  setAuto(isAutoEnabled());
  applyAdVisibility();
  checkServerVersion();
  updateQueueStatus();
  setInterval(updateQueueStatus, 30000);

  if (isIOS() && !isInStandaloneMode() && !localStorage.getItem("qs_ios_dismissed")) {
    setTimeout(() => iosInstall?.classList.remove("hidden"), 3000);
  }

  const params = new URLSearchParams(window.location.search);

  /* ── Background download complete - notification tap se aaya ── */
  const bgDlId = params.get("bg_dl");
  const ck     = params.get("ck");
  const fn     = params.get("fn");

  if (bgDlId && ck) {
    window.history.replaceState({}, "", "/");
    // Thoda wait karo SW ready hone ke liye
    setTimeout(async () => {
      await autoDownloadFromCache(
        decodeURIComponent(ck),
        decodeURIComponent(fn || "video.mp4")
      );
    }, 800);
    return;
  }

  /* ── Share target ── */
  const sharedUrl = (
    params.get("url") || params.get("text") || params.get("title") || ""
  ).trim();

  if (sharedUrl && isSupportedUrl(sharedUrl)) {
    window.history.replaceState({}, "", "/");
    // SW ready hone ka wait karo
    await new Promise(r => setTimeout(r, 500));
    await handleShareTarget(sharedUrl);
    return;
  }

  /* ── Action ── */
  const action = params.get("action");
  if (action === "paste") {
    window.history.replaceState({}, "", "/");
    setTimeout(() => paste.onclick?.(), 300);
    return;
  }

  /* ── Auto paste ── */
  if (isAutoEnabled()) {
    const autoPasted = await tryAutoPaste();
    if (autoPasted) {
      msg("🔗 URL detected! Processing…", "ok");
      await processUrl(autoPasted, true);
      return;
    }
  }

  renderHistory();
}

/* ════════════════════════════════════════
   VISIBILITY CHANGE
════════════════════════════════════════ */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (autoProcessing) return;

  swRegistration?.update();
  checkServerVersion();
  updateQueueStatus();

  if (!isAutoEnabled()) return;
  await new Promise(r => setTimeout(r, 400));
  const autoPasted = await tryAutoPaste();
  if (autoPasted && autoPasted !== url.value.trim()) {
    msg("🔗 New URL detected! Processing…", "ok");
    await processUrl(autoPasted, true);
  }
});

onStartup();
