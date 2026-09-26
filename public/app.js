/* QuickSave app.js v8.3 */
console.log("QuickSave v8.3 loaded");

const AD_DISABLE_CODE = "666666";
const $ = id => document.getElementById(id);

/* ── DOM Elements ── */
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

let current       = null;
let installPrompt = null;
let autoProc      = false;
let lastUrl       = "";
let swReg         = null;
let newSW         = null;

/* ── Download guard: ek baar hi trigger ho ── */
let dlInProgress = false;

/* ════════════════════════════════════════
   UTILS
════════════════════════════════════════ */
function isPWA() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         navigator.standalone === true ||
         document.referrer.includes("android-app://");
}
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         navigator.standalone === true;
}
const SUPPORTED = ["instagram.com","facebook.com","fb.watch","twitter.com","x.com"];
function isSupportedUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./,"");
    return SUPPORTED.some(p => h.includes(p));
  } catch { return false; }
}
function escH(s) {
  return String(s).replace(/[&<>"']/g,
    m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]));
}
function sizeStr(n) {
  if (!n) return "";
  const u = ["B","KB","MB","GB"]; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i?1:0)} ${u[i]}`;
}
function buildDlUrl(d) {
  return d?.id ? `/api/download?id=${encodeURIComponent(d.id)}` : "#";
}
function msg(t, c="") {
  status.textContent = t;
  status.className   = "status " + c;
  status.classList.toggle("hide", !t);
}

/* ════════════════════════════════════════
   AD MANAGEMENT
════════════════════════════════════════ */
function isAdsOff() { return localStorage.getItem("qs_ads_disabled") === "true"; }
function setAdsOff(v) {
  localStorage.setItem("qs_ads_disabled", v ? "true" : "false");
  applyAds();
}
function applyAds() {
  const off = isAdsOff();
  document.querySelectorAll(".ad-wrap,.interstitial-overlay,[data-ad]")
    .forEach(el => el.classList.toggle("ads-hidden", off));
  if (adCodeMsg) {
    adCodeMsg.textContent = off ? "✅ Ads disabled" : "";
    adCodeMsg.className   = off ? "code-msg ok" : "code-msg";
  }
}
adCodeBtn?.addEventListener("click", () => {
  const c = (adCodeInput?.value || "").trim();
  if (c === AD_DISABLE_CODE) {
    setAdsOff(true);
    if (adCodeMsg) { adCodeMsg.textContent="✅ Ads disabled!"; adCodeMsg.className="code-msg ok"; }
  } else if (c === "000000") {
    setAdsOff(false);
    if (adCodeMsg) { adCodeMsg.textContent="Ads enabled."; adCodeMsg.className="code-msg"; }
  } else {
    if (adCodeMsg) { adCodeMsg.textContent="❌ Invalid code."; adCodeMsg.className="code-msg err"; }
  }
  if (adCodeInput) adCodeInput.value = "";
});
adCodeInput?.addEventListener("keydown", e => { if (e.key==="Enter") adCodeBtn?.click(); });

/* ════════════════════════════════════════
   AUTO TOGGLE
════════════════════════════════════════ */
function isAutoOn() { return localStorage.getItem("qs_auto") !== "false"; }
function setAuto(v) {
  localStorage.setItem("qs_auto", v ? "true" : "false");
  autoToggle.checked    = v;
  autoLabel.textContent = v ? "Auto ON" : "Auto OFF";
}
autoToggle.addEventListener("change", () => setAuto(autoToggle.checked));

/* ════════════════════════════════════════
   BG STATUS UI
════════════════════════════════════════ */
function showBg(text, type="processing", icon="⏳") {
  if (!bgStatus) return;
  if (bgStatusText) bgStatusText.textContent = text;
  if (bgStatusIcon) bgStatusIcon.textContent = icon;
  bgStatus.className = `bg-status ${type}`;
  bgStatus.classList.remove("hide");
}
function hideBg(delay=0) {
  if (delay) setTimeout(() => bgStatus?.classList.add("hide"), delay);
  else bgStatus?.classList.add("hide");
}

/* ════════════════════════════════════════
   QUEUE STATUS
════════════════════════════════════════ */
async function updateQ() {
  try {
    const d = await fetch("/api/queue").then(r=>r.json());
    if (!queueStatus||!queueText) return;
    if (d.processing>0||d.waiting>0) {
      queueStatus.classList.remove("hide");
      queueText.textContent = d.available
        ? `✅ Server ready`
        : `🔄 ${d.processing} processing, ${d.waiting} waiting`;
    } else {
      queueStatus.classList.add("hide");
    }
  } catch {}
}

/* ════════════════════════════════════════
   NOTIFICATION PERMISSION
════════════════════════════════════════ */
async function askNotifPerm() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied")  return false;
  return (await Notification.requestPermission()) === "granted";
}

/* ════════════════════════════════════════
   CORE: AUTO DOWNLOAD FROM CACHE
   
   SW ne video store ki → yahan blob banao
   → a.click() → browser native download
   
   KEY FIX: Content-Type "video/mp4" set karo
   taki browser HTML nahi, video download kare
════════════════════════════════════════ */
let autoDownloadDone = new Set(); // Double trigger prevent

async function autoDownloadFromCache(cacheKey, filename, calledFromSW=false) {
  /* Double download prevent karo */
  const key = cacheKey + filename;
  if (autoDownloadDone.has(key)) {
    console.log("[auto-dl] Already done, skipping:", filename);
    return;
  }
  autoDownloadDone.add(key);

  /* 30 sec baad reset karo */
  setTimeout(() => autoDownloadDone.delete(key), 30000);

  console.log("[auto-dl] Starting:", filename, "| cache:", cacheKey);
  showBg(`⬇ Saving ${filename}…`, "downloading", "⬇");

  try {
    /* SW cache se video fetch karo */
    const response = await fetch(cacheKey);

    if (!response.ok) {
      throw new Error(`Cache expired or not found (${response.status})`);
    }

    /* Content-Type check */
    const ct = response.headers.get("content-type") || "video/mp4";
    console.log("[auto-dl] Content-Type:", ct, "| Size:", response.headers.get("content-length"));

    /* ArrayBuffer se Blob banao - sahi MIME type ke saath */
    const bytes    = await response.arrayBuffer();
    const mimeType = ct.startsWith("video/") ? ct : "video/mp4";
    const blob     = new Blob([bytes], { type: mimeType });

    console.log("[auto-dl] Blob size:", (blob.size/1024/1024).toFixed(2), "MB | type:", blob.type);

    if (blob.size < 1000) {
      throw new Error("Downloaded file is too small — may be corrupted");
    }

    /* Blob URL → a.click() */
    const blobUrl  = URL.createObjectURL(blob);
    const a        = document.createElement("a");
    a.href         = blobUrl;
    a.download     = filename;
    a.style.display = "none";

    document.body.appendChild(a);
    a.click();

    /* Cleanup */
    setTimeout(() => {
      URL.revokeObjectURL(blobUrl);
      try { document.body.removeChild(a); } catch {}
    }, 5000);

    showBg(`✅ Saved! Check Downloads folder.`, "ok", "✅");
    msg("✅ Video saved to Downloads!", "ok");

    /* History */
    saveHistory({
      id:   "local_" + Date.now(),
      name: filename,
      type: mimeType,
      time: Date.now()
    });

    hideBg(8000);
    console.log("[auto-dl] ✓ Done:", filename);

  } catch(e) {
    console.error("[auto-dl] Failed:", e.message);
    autoDownloadDone.delete(key); // Reset on error
    showBg(`❌ Save failed: ${e.message}`, "err", "❌");
    hideBg(6000);
  }
}

/* ════════════════════════════════════════
   SW MESSAGE LISTENER
════════════════════════════════════════ */
function setupSWMessages() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("message", async event => {
    const d = event.data || {};
    console.log("[SW→App]", d.type, d.status||"");

    /* Background status updates */
    if (d.type === "BG_STATUS") {
      switch(d.status) {
        case "processing":
          showBg("⏳ Processing video… Aap wapas ja sakte hain!", "processing", "⏳");
          break;
        case "downloading":
          showBg(`⬇ Downloading ${d.filename||"video"}…`, "downloading", "⬇");
          break;
        case "error":
          showBg(`❌ ${d.msg||"Failed"}`, "err", "❌");
          hideBg(6000);
          break;
      }
      return;
    }

    /* Auto download trigger - SW ne file store kar li */
    if (d.type === "AUTO_DOWNLOAD") {
      if (d.cacheKey && d.filename) {
        await autoDownloadFromCache(d.cacheKey, d.filename, true);
      }
      return;
    }

    /* Notification click se navigate */
    if (d.type === "OPEN_DL") {
      if (d.cacheKey && d.filename) {
        await autoDownloadFromCache(d.cacheKey, d.filename, true);
      }
      return;
    }
  });
}

/* ════════════════════════════════════════
   BACKGROUND DOWNLOAD START
   Share → QuickSave → SW ko message
════════════════════════════════════════ */
async function startBgDownload(pageUrl) {
  if (!swReg?.active) {
    console.log("[BG] No SW active");
    return false;
  }

  const hasNotif = await askNotifPerm();
  if (!hasNotif) {
    console.log("[BG] No notification permission");
    return false;
  }

  const dlId = `dl_${Date.now()}`;

  swReg.active.postMessage({
    type: "BG_DOWNLOAD",
    data: { url: pageUrl, id: dlId }
  });

  showBg("⏳ Processing… Aap wapas ja sakte hain!", "processing", "⏳");
  msg("⏳ Background mein ho raha hai!", "ok");

  return true;
}

/* ════════════════════════════════════════
   SHARE TARGET HANDLER
════════════════════════════════════════ */
async function handleShare(sharedUrl) {
  if (!isSupportedUrl(sharedUrl)) {
    msg("Only Instagram, Facebook, Twitter/X links supported.", "err");
    return;
  }

  url.value = sharedUrl;

  /* PWA + SW available = background download */
  if (isPWA() && swReg?.active) {
    const ok = await startBgDownload(sharedUrl);
    if (ok) return; /* Background mein gaya, user wapas ja sakta hai */
  }

  /* Fallback: normal flow */
  await processUrl(sharedUrl, true);
}

/* ════════════════════════════════════════
   INTERSTITIAL AD
════════════════════════════════════════ */
function showAd(callback) {
  if (isAdsOff() || !interstitialAd) { callback?.(); return; }
  interstitialAd.classList.remove("hide");
  document.body.style.overflow = "hidden";
  let s = 5;
  if (adTimerEl) adTimerEl.textContent = s;
  const t = setInterval(() => {
    s--;
    if (adTimerEl) adTimerEl.textContent = s;
    if (s <= 0) { clearInterval(t); close(); callback?.(); }
  }, 1000);
  function close() {
    clearInterval(t);
    interstitialAd.classList.add("hide");
    document.body.style.overflow = "";
  }
  if (closeBtn) closeBtn.onclick = () => { close(); callback?.(); };
  interstitialAd.onclick = e => { if (e.target===interstitialAd) { close(); callback?.(); } };
}

/* ════════════════════════════════════════
   UPDATE
════════════════════════════════════════ */
function showUpdateBanner() {
  if (!updateBanner) return;
  updateBanner.classList.remove("hide");
  $("updateNowBtn")?.addEventListener("click", () => {
    newSW?.postMessage({ type: "SKIP_WAITING" });
    updateBanner.classList.add("hide");
  }, { once: true });
}
async function checkVersion() {
  try {
    const d = await fetch("/api/version?t=" + Date.now()).then(r=>r.json());
    const stored = localStorage.getItem("qs_sv");
    if (stored && stored !== d.version) {
      localStorage.setItem("qs_sv", d.version);
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
      location.reload(true);
    } else {
      localStorage.setItem("qs_sv", d.version);
    }
  } catch {}
}

/* ════════════════════════════════════════
   HISTORY
════════════════════════════════════════ */
function saveHistory(item) {
  let h = JSON.parse(localStorage.getItem("qs_history")||"[]");
  h = [item, ...h.filter(x=>x.id!==item.id)].slice(0,8);
  localStorage.setItem("qs_history", JSON.stringify(h));
  renderHistory();
}
function renderHistory() {
  const h = JSON.parse(localStorage.getItem("qs_history")||"[]");
  if (!h.length) { historyPanel.classList.add("hide"); return; }
  historyPanel.classList.remove("hide");
  historyEl.innerHTML = h.map(x => {
    const href = x.id?.startsWith("local_") ? "#"
      : (x.id ? escH(`/api/download?id=${x.id}`) : "#");
    const dlAttr = x.id?.startsWith("local_") ? "" : `download="${escH(x.name||"media")}"`;
    return `<div class="historyrow">
      <div>
        <b>${escH(x.name||"media")}</b>
        <small>${escH(x.type||"media")} • ${new Date(x.time).toLocaleString()}</small>
      </div>
      <a href="${href}" ${dlAttr}>↓ Save</a>
    </div>`;
  }).join("");
}
$("clearHistory").onclick = () => {
  localStorage.removeItem("qs_history");
  renderHistory();
};

/* ════════════════════════════════════════
   AUTO PASTE
════════════════════════════════════════ */
async function tryAutoPaste() {
  if (!isAutoOn()) return null;
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t && isSupportedUrl(t)) return t;
  } catch {}
  return null;
}

/* ════════════════════════════════════════
   MAIN PROCESS (Normal - not background)
════════════════════════════════════════ */
async function processUrl(value, autoDownload=false) {
  if (!value || autoProc) return;
  if (!isSupportedUrl(value)) {
    msg("Only Instagram, Facebook, Twitter/X links supported.", "err");
    return;
  }

  autoProc     = true;
  lastUrl      = value;
  url.value    = value;
  go.disabled  = true;
  result.classList.add("hide");
  progress.classList.add("hide");
  adAfterDl?.classList.add("hide");

  const btnTxt = [...go.childNodes].find(n=>n.nodeType===Node.TEXT_NODE);
  if (btnTxt) btnTxt.textContent = "Checking… ";
  updateQ();

  try {
    msg("⏳ Fetching media info…");

    const r = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: value })
    });
    const d = await r.json();
    updateQ();

    if (r.status===503 && d.type==="queue-full")
      throw new Error(`🔴 Server busy (${d.queueSize} waiting). Try in 30s.`);
    if (r.status===408)
      throw new Error("⏱️ Timeout. Try again.");
    if (!r.ok||!d.ok) throw new Error(d.message||"Could not process link.");
    if (!d.id)        throw new Error("Server error.");

    current = d;
    name.textContent = d.filename||"media.mp4";
    meta.textContent = (d.contentType||"media").replace("video/","").toUpperCase() +
      (d.size ? " • "+sizeStr(d.size) : "");
    showPreview(d);
    download.href = buildDlUrl(d);
    download.setAttribute("download", d.filename||"QuickSave_Media.mp4");
    result.classList.remove("hide");
    msg("✅ Ready! Tap download.", "ok");

    if (autoDownload && isAutoOn()) {
      setTimeout(() => triggerDownload(d), 600);
    }

  } catch(e) {
    console.error(e);
    msg("❌ "+(e.message||"Something went wrong."), "err");
  } finally {
    go.disabled = false;
    autoProc    = false;
    if (btnTxt) btnTxt.textContent = "Get media ";
    updateQ();
  }
}

/* ════════════════════════════════════════
   DOWNLOAD (Normal flow)
════════════════════════════════════════ */
function startDownload(d) {
  const dlUrl = buildDlUrl(d);
  saveHistory({ id:d.id, name:d.filename||"media.mp4", type:d.contentType||"media", time:Date.now() });
  progress.classList.remove("hide");
  if (adAfterDl && !isAdsOff()) adAfterDl.classList.remove("hide");
  progressText.textContent = "Starting download…";
  bar.style.width          = "10%";
  progressPct.textContent  = "10%";

  if (isIOS()) {
    window.location.href = dlUrl;
  } else {
    const a = document.createElement("a");
    a.href = dlUrl; a.download = d.filename||"QuickSave_Media.mp4";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 2000);
  }

  setTimeout(() => {
    bar.style.width          = "100%";
    progressPct.textContent  = "100%";
    progressText.textContent = isIOS()
      ? "✅ Tap & hold to save to Photos."
      : "✅ Check your Downloads folder.";
  }, 800);
}

function triggerDownload(d) {
  if (!d?.id) return;
  if (isPWA() && !isAdsOff()) {
    showAd(() => startDownload(d));
  } else {
    startDownload(d);
  }
}

/* ════════════════════════════════════════
   PREVIEW
════════════════════════════════════════ */
function showPreview(d) {
  thumb.innerHTML = "";
  thumb.onclick   = () => window.open(`/api/download?id=${d.id}&inline=1`, "_blank");
  if (d.thumbnail) {
    const img = new Image();
    img.src = d.thumbnail;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;border-radius:12px;";
    img.onload  = () => thumb.appendChild(img);
    img.onerror = () => (thumb.innerHTML = "<span>▶</span>");
  } else {
    thumb.innerHTML = "<span>▶</span>";
  }
}

/* ════════════════════════════════════════
   BUTTONS
════════════════════════════════════════ */
paste.onclick = async () => {
  try {
    const t = (await navigator.clipboard.readText()).trim();
    if (t) {
      url.value = t;
      paste.textContent = "✓ Pasted";
      setTimeout(() => (paste.textContent="Paste"), 1500);
      if (isAutoOn() && isSupportedUrl(t)) processUrl(t, true);
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
  if (e.key==="Enter") {
    const v = url.value.trim();
    if (v) processUrl(v, isAutoOn() && isSupportedUrl(v));
  }
};

download.addEventListener("click", e => {
  if (!current?.id) return;
  e.preventDefault();
  if (isPWA() && !isAdsOff()) showAd(() => startDownload(current));
  else startDownload(current);
});

if (retryBtn) retryBtn.onclick = e => {
  e.preventDefault();
  if (lastUrl) processUrl(lastUrl, false);
};

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
  const t = e.dataTransfer.getData("text/plain")||e.dataTransfer.getData("text/uri-list");
  if (t) processUrl(t.trim(), isAutoOn() && isSupportedUrl(t.trim()));
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
if (iosDismiss) {
  iosDismiss.onclick = () => {
    iosInstall?.classList.add("hidden");
    localStorage.setItem("qs_ios_dismissed","true");
  };
}

/* ════════════════════════════════════════
   SERVICE WORKER REGISTER
════════════════════════════════════════ */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      swReg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      console.log("[SW] Registered");

      swReg.addEventListener("updatefound", () => {
        newSW = swReg.installing;
        newSW.addEventListener("statechange", () => {
          if (newSW.state==="installed" && navigator.serviceWorker.controller)
            showUpdateBanner();
        });
      });

      navigator.serviceWorker.addEventListener("controllerchange", () => location.reload());

      setupSWMessages();
      setInterval(() => swReg.update(), 5*60*1000);

    } catch(e) { console.log("[SW] Failed:", e); }
  });
}

/* ════════════════════════════════════════
   STARTUP
════════════════════════════════════════ */
async function onStartup() {
  setAuto(isAutoOn());
  applyAds();
  checkVersion();
  updateQ();
  setInterval(updateQ, 30000);

  /* iOS banner */
  if (isIOS() && !isStandalone() && !localStorage.getItem("qs_ios_dismissed"))
    setTimeout(() => iosInstall?.classList.remove("hidden"), 3000);

  const params = new URLSearchParams(location.search);

  /* ── Case 1: Notification click se aaya (app band thi) ── */
  const qs_ck = params.get("qs_ck");
  const qs_fn = params.get("qs_fn");
  const qs_dl = params.get("qs_dl");

  if (qs_ck && qs_fn) {
    history.replaceState({}, "", "/");
    /* SW ready hone ka wait karo */
    setTimeout(async () => {
      await autoDownloadFromCache(
        decodeURIComponent(qs_ck),
        decodeURIComponent(qs_fn)
      );
    }, 1000);
    return;
  }

  /* ── Case 2: Share target ── */
  const shared = (
    params.get("url") || params.get("text") || params.get("title") || ""
  ).trim();

  if (shared && isSupportedUrl(shared)) {
    history.replaceState({}, "", "/");
    await new Promise(r => setTimeout(r, 600)); /* SW ready wait */
    await handleShare(shared);
    return;
  }

  /* ── Case 3: Action param ── */
  if (params.get("action") === "paste") {
    history.replaceState({}, "", "/");
    setTimeout(() => paste.onclick?.(), 300);
    return;
  }

  /* ── Case 4: Auto paste from clipboard ── */
  if (isAutoOn()) {
    const auto = await tryAutoPaste();
    if (auto) {
      msg("🔗 URL detected!", "ok");
      await processUrl(auto, true);
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
  if (autoProc) return;

  swReg?.update();
  checkVersion();
  updateQ();

  if (!isAutoOn()) return;
  await new Promise(r => setTimeout(r, 400));
  const auto = await tryAutoPaste();
  if (auto && auto !== url.value.trim()) {
    msg("🔗 New URL detected!", "ok");
    await processUrl(auto, true);
  }
});

onStartup();
