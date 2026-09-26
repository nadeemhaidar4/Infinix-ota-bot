/* QuickSave app.js v6.2 */
console.log("QuickSave v6.2 loaded");

const $ = id => document.getElementById(id);

const url             = $("url"),
      paste           = $("paste"),
      go              = $("go"),
      drop            = $("drop"),
      status          = $("status"),
      result          = $("result"),
      name            = $("name"),
      meta            = $("meta"),
      download        = $("download"),
      thumb           = $("thumb"),
      progress        = $("progress"),
      bar             = $("bar"),
      progressText    = $("progressText"),
      progressPct     = $("progressPct"),
      historyPanel    = $("historyPanel"),
      history         = $("history"),
      install         = $("install"),
      iosInstall      = $("iosInstall"),
      iosDismiss      = $("iosDismiss"),
      autoToggle      = $("autoToggle"),
      autoLabel       = $("autoLabel"),
      retryBtn        = $("retryBtn"),
      adAfterDl       = $("adAfterDl"),
      interstitialAd  = $("interstitialAd"),
      closeBtn        = $("closeInterstitial"),
      adTimerEl       = $("adTimer");

let current        = null;
let installPrompt  = null;
let autoProcessing = false;
let lastUrl        = "";

/* ── PWA Detection ── */
function isPWA() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true ||
    document.referrer.includes("android-app://")
  );
}

/* ── Supported Platforms ── */
const SUPPORTED = [
  "instagram.com",
  "facebook.com", "fb.watch",
  "twitter.com",  "x.com"
];

function isSupportedUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return SUPPORTED.some(p => h.includes(p));
  } catch { return false; }
}

/* ── iOS Detection ── */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}
function isInStandaloneMode() {
  return window.matchMedia("(display-mode: standalone)").matches ||
         window.navigator.standalone === true;
}

/* ── Auto setting ── */
function isAutoEnabled() {
  return localStorage.getItem("qs_auto") !== "false";
}
function setAuto(val) {
  localStorage.setItem("qs_auto", val ? "true" : "false");
  autoToggle.checked    = val;
  autoLabel.textContent = val ? "Auto ON" : "Auto OFF";
}
autoToggle.addEventListener("change", () => setAuto(autoToggle.checked));

/* ── Helpers ── */
function msg(t, c = "") {
  status.textContent = t;
  status.className   = "status " + c;
  status.classList.toggle("hide", !t);
}
function size(n) {
  if (!n) return "";
  const u = ["B","KB","MB","GB"];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])
  );
}
function buildDlUrl(d) {
  if (!d?.id) return "#";
  return `/api/download?id=${encodeURIComponent(d.id)}`;
}

/* ══════════════════════════════
   INTERSTITIAL AD - PWA ke liye
══════════════════════════════ */
function showInterstitialAd(callback) {
  if (!interstitialAd) {
    callback?.();
    return;
  }

  interstitialAd.classList.remove("hide");
  document.body.style.overflow = "hidden";

  let secs = 5;
  if (adTimerEl) adTimerEl.textContent = secs;

  const timer = setInterval(() => {
    secs--;
    if (adTimerEl) adTimerEl.textContent = secs;
    if (secs <= 0) {
      clearInterval(timer);
      closeAd();
      callback?.();
    }
  }, 1000);

  function closeAd() {
    clearInterval(timer);
    interstitialAd.classList.add("hide");
    document.body.style.overflow = "";
  }

  if (closeBtn) {
    closeBtn.onclick = () => {
      closeAd();
      callback?.();
    };
  }

  interstitialAd.onclick = e => {
    if (e.target === interstitialAd) {
      closeAd();
      callback?.();
    }
  };
}

/* ── History ── */
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
  history.innerHTML = h.map(x => {
    const href = x.id ? escapeHtml(`/api/download?id=${x.id}`) : "#";
    return `<div class="historyrow">
      <div>
        <b>${escapeHtml(x.name || "media")}</b>
        <small>${escapeHtml(x.type || "media")} • ${new Date(x.time).toLocaleString()}</small>
      </div>
      <a href="${href}" download="${escapeHtml(x.name || "media")}">↓ Save</a>
    </div>`;
  }).join("");
}
$("clearHistory").onclick = () => {
  localStorage.removeItem("qs_history");
  renderHistory();
};

/* ── Clipboard ── */
async function tryAutoPaste() {
  if (!isAutoEnabled()) return null;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text && isSupportedUrl(text)) return text;
  } catch {}
  return null;
}

/* ── Main Process ── */
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
  msg("⏳ Fetching media info…");

  try {
    const r = await fetch("/api/inspect", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: value })
    });
    const d = await r.json();

    if (!r.ok || !d.ok) throw new Error(d.message || "Could not process link.");
    if (!d.id)          throw new Error("Server error: no download ID.");

    current = d;
    name.textContent = d.filename || "media.mp4";
    meta.textContent =
      (d.contentType || "media").replace("video/","").toUpperCase() +
      (d.size ? " • " + size(d.size) : "");
    showPreview(d);
    download.href = buildDlUrl(d);
    download.setAttribute("download", d.filename || "QuickSave_Media.mp4");
    result.classList.remove("hide");
    msg("✅ Ready! Tap the button below to download.", "ok");

    if (autoDownload && isAutoEnabled()) {
      setTimeout(() => triggerDownload(d), 800);
    }

  } catch (e) {
    console.error("Process failed:", e);
    msg("❌ " + (e.message || "Something went wrong."), "err");
  } finally {
    go.disabled    = false;
    autoProcessing = false;
    if (btnText) btnText.textContent = "Get media ";
  }
}

/* ── Start Actual Download ── */
function startDownload(d) {
  const dlUrl = buildDlUrl(d);

  saveHistory({
    id:   d.id,
    name: d.filename    || "media.mp4",
    type: d.contentType || "media",
    time: Date.now()
  });

  progress.classList.remove("hide");
  if (adAfterDl) adAfterDl.classList.remove("hide");
  progressText.textContent = "Starting download…";
  bar.style.width          = "10%";
  progressPct.textContent  = "10%";

  if (isIOS()) {
    window.location.href = dlUrl;
  } else {
    const a         = document.createElement("a");
    a.href          = dlUrl;
    a.download      = d.filename || "QuickSave_Media.mp4";
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

/* ── Trigger Download - Ad Pehle ── */
function triggerDownload(d) {
  if (!d?.id) return;
  if (isPWA()) {
    showInterstitialAd(() => startDownload(d));
  } else {
    startDownload(d);
  }
}

/* ── Preview ── */
function showPreview(d) {
  thumb.innerHTML    = "";
  thumb.style.cursor = "pointer";
  thumb.onclick      = () => {
    window.open(`/api/download?id=${d.id}&inline=1`, "_blank");
  };
  if (d.thumbnail) {
    const img         = new Image();
    img.src           = d.thumbnail;
    img.style.cssText = "width:100%;height:100%;object-fit:cover;display:block;border-radius:12px;";
    img.onload        = () => thumb.appendChild(img);
    img.onerror       = () => (thumb.innerHTML = "<span>▶</span>");
  } else {
    const mime      = (d.contentType || "").toLowerCase();
    thumb.innerHTML = mime.startsWith("image/") ? "<span>◈</span>"
      : mime.startsWith("video/")               ? "<span>▶</span>"
      :                                            "<span>♪</span>";
  }
}

/* ── Paste ── */
paste.onclick = async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      url.value         = text;
      paste.textContent = "✓ Pasted";
      setTimeout(() => (paste.textContent = "Paste"), 1500);
      if (isAutoEnabled() && isSupportedUrl(text)) processUrl(text, true);
    } else {
      msg("Clipboard is empty. Copy a link first.", "err");
    }
  } catch {
    msg("Clipboard unavailable. Please paste manually.", "err");
    url.focus();
  }
};

/* ── Get Media ── */
go.onclick = () => {
  const value = url.value.trim();
  if (!value) return msg("Please paste a media URL first.", "err");
  processUrl(value, false);
};
url.onkeydown = e => {
  if (e.key === "Enter") {
    const value = url.value.trim();
    if (value) processUrl(value, isAutoEnabled() && isSupportedUrl(value));
  }
};

/* ── Download Button ── */
download.addEventListener("click", e => {
  if (!current?.id) return;
  e.preventDefault();
  if (isPWA()) {
    showInterstitialAd(() => startDownload(current));
  } else {
    startDownload(current);
  }
});

/* ── Retry ── */
if (retryBtn) {
  retryBtn.onclick = e => {
    e.preventDefault();
    if (lastUrl) processUrl(lastUrl, false);
  };
}

/* ── Drag & Drop ── */
["dragenter","dragover"].forEach(ev =>
  drop.addEventListener(ev, x => {
    x.preventDefault();
    drop.classList.add("drag");
  })
);
["dragleave","drop"].forEach(ev =>
  drop.addEventListener(ev, x => {
    x.preventDefault();
    drop.classList.remove("drag");
  })
);
drop.addEventListener("drop", e => {
  const text = e.dataTransfer.getData("text/plain") ||
               e.dataTransfer.getData("text/uri-list");
  if (text) processUrl(text.trim(), isAutoEnabled() && isSupportedUrl(text.trim()));
});

/* ── PWA Install ── */
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

/* ── Service Worker ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then(r => console.log("SW ok:", r.scope))
      .catch(e => console.log("SW fail:", e));
  });
}

/* ── Startup ── */
async function onStartup() {
  setAuto(isAutoEnabled());

  if (isIOS() && !isInStandaloneMode() &&
      !localStorage.getItem("qs_ios_dismissed")) {
    setTimeout(() => iosInstall?.classList.remove("hidden"), 3000);
  }

  const params    = new URLSearchParams(window.location.search);
  const sharedUrl = (
    params.get("url") || params.get("text") || params.get("title") || ""
  ).trim();

  if (sharedUrl && isSupportedUrl(sharedUrl)) {
    window.history.replaceState({}, "", "/");
    await processUrl(sharedUrl, true);
    return;
  }

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

/* ── Visibility Change ── */
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (autoProcessing) return;
  if (!isAutoEnabled()) return;
  await new Promise(r => setTimeout(r, 400));
  const autoPasted = await tryAutoPaste();
  if (autoPasted && autoPasted !== url.value.trim()) {
    msg("🔗 New URL detected! Processing…", "ok");
    await processUrl(autoPasted, true);
  }
});

onStartup();
