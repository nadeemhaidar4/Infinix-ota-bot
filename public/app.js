/* QuickSave app.js v4.3 */
console.log("QuickSave app.js v4.3 loaded");

const $ = id => document.getElementById(id);
const url       = $("url"),
      paste     = $("paste"),
      go        = $("go"),
      drop      = $("drop"),
      status    = $("status"),
      result    = $("result"),
      name      = $("name"),
      meta      = $("meta"),
      download  = $("download"),
      thumb     = $("thumb"),
      progress  = $("progress"),
      bar       = $("bar"),
      progressText = $("progressText"),
      progressPct  = $("progressPct"),
      historyPanel = $("historyPanel"),
      history      = $("history"),
      install      = $("install"),
      autoToggle   = $("autoToggle"),
      autoLabel    = $("autoLabel");

let current      = null;
let installPrompt = null;
let autoProcessing = false;

/* ── Auto setting ── */
function isAutoEnabled() {
  return localStorage.getItem("qs_auto") !== "false";
}
function setAuto(val) {
  localStorage.setItem("qs_auto", val ? "true" : "false");
  autoToggle.checked = val;
  autoLabel.textContent = val ? "Auto ON" : "Auto OFF";
}

autoToggle.addEventListener("change", () => setAuto(autoToggle.checked));

/* ── helpers ── */
function msg(t, c = "") {
  status.textContent = t;
  status.className   = "status " + c;
  status.classList.toggle("hide", !t);
}

function size(n) {
  if (!n) return "Size unavailable";
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
  if (d && d.directUrl) return d.directUrl; 
  if (!d || !d.id) return "#";
  return `/api/download?id=${encodeURIComponent(d.id)}`;
}

function isSupportedUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, "");
    return [
      "instagram.com","facebook.com","fb.watch",
      "tiktok.com","youtube.com","youtu.be",
      "twitter.com","x.com"
    ].some(p => h.includes(p));
  } catch { return false; }
}

/* ── history ── */
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
      <a href="${href}">Download</a>
    </div>`;
  }).join("");
}

$("clearHistory").onclick = () => {
  localStorage.removeItem("qs_history");
  renderHistory();
};

/* ── Auto clipboard paste ── */
async function tryAutoPaste() {
  if (!isAutoEnabled()) return null;
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text && isSupportedUrl(text)) {
      return text;
    }
  } catch {}
  return null;
}

/* ── Main process function ── */
async function processUrl(value, autoDownload = false) {
  if (!value || autoProcessing) return;
  autoProcessing = true;

  url.value = value;
  go.disabled = true;
  result.classList.add("hide");
  progress.classList.add("hide");

  const btnText = [...go.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
  if (btnText) btnText.textContent = "Checking… ";
  msg("Checking the link…");

  try {
    const r = await fetch("/api/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: value })
    });
    const d = await r.json();

    if (!r.ok || !d.ok) throw new Error(d.message || "Could not process link.");
    if (!d.id) throw new Error("Server error: no download ID.");

    current = d;
    const dlUrl = buildDlUrl(d);

    name.textContent = d.filename || "media.mp4";
    meta.textContent = (d.contentType || "media") + (d.size ? " • " + size(d.size) : "");
    showPreview(d);

    download.href = dlUrl;
    download.setAttribute("download", d.filename || "QuickSave_Media.mp4");
    download.setAttribute("target", "_blank"); 

    result.classList.remove("hide");
    msg("Media is ready. Tap Download file.", "ok");

    if (autoDownload && isAutoEnabled()) {
      msg("Auto-downloading…", "ok");
      triggerDownload(d);
    }

  } catch (e) {
    console.error("Process failed:", e);
    msg(e.message || "Something went wrong.", "err");
  } finally {
    go.disabled = false;
    autoProcessing = false;
    if (btnText) btnText.textContent = "Get media ";
  }
}

function triggerDownload(d) {
  if (!d || !d.id) return;
  const dlUrl = buildDlUrl(d);
  download.href = dlUrl;
  download.setAttribute("download", d.filename || "QuickSave_Media.mp4");
  download.setAttribute("target", "_blank");

  saveHistory({
    id:   d.id,
    name: d.filename || "media.mp4",
    type: d.contentType || "media",
    time: Date.now()
  });

  progress.classList.remove("hide");
  progressText.textContent = "Starting download…";
  bar.style.width   = "10%";
  progressPct.textContent = "10%";

  download.click();

  setTimeout(() => {
    bar.style.width = "100%";
    progressPct.textContent = "Ready";
    progressText.textContent = "Download started — check your Downloads app.";
  }, 500);
}

/* ── Preview (Thumbnail Click to Play Logic) ── */
function showPreview(d) {
  thumb.innerHTML = "";
  thumb.style.overflow = "hidden";
  thumb.style.cursor = "pointer"; // Mouse cursor pointer ban jayega taaki lage ki click kar sakte hain

  // Agar user thumbnail box par click karega toh video play hone ke liye naye tab me khulegi
  thumb.onclick = () => {
    const playUrl = d.directUrl || `/api/download?id=${d.id}`;
    window.open(playUrl, '_blank');
  };
  
  if (d.thumbnail) {
    const img = new Image();
    img.src = d.thumbnail;
    
    // Size ko CSS wali thumb class (56x56) tak hi restrict rakhega
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.display = "block";
    
    img.onload  = () => thumb.appendChild(img);
    img.onerror = () => (thumb.innerHTML = "<span>▶</span>");
  } else {
    const mime = (d.contentType || "").toLowerCase();
    if (mime.startsWith("image/")) {
       thumb.innerHTML = "<span>◈</span>";
    } else if (mime.startsWith("video/")) {
      thumb.innerHTML = "<span>▶</span>";
    } else {
      thumb.innerHTML = "<span>♪</span>";
    }
  }
}

/* ── Paste button ── */
paste.onclick = async () => {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (text) {
      url.value = text;
      paste.textContent = "Pasted ✓";
      setTimeout(() => (paste.textContent = "Paste"), 1200);
      if (isAutoEnabled() && isSupportedUrl(text)) {
        processUrl(text, true);
      }
    }
  } catch {
    msg("Clipboard unavailable. Paste manually.", "err");
    url.focus();
  }
};

/* ── Get media button ── */
go.onclick = () => {
  const value = url.value.trim();
  if (!value) return msg("Paste a media URL first.", "err");
  processUrl(value, false);
};

url.onkeydown = e => {
  if (e.key === "Enter") {
    const value = url.value.trim();
    if (value) processUrl(value, isAutoEnabled() && isSupportedUrl(value));
  }
};

/* ── Download button ── */
download.addEventListener("click", () => {
  if (!current || !current.id) return;
  const dlUrl = buildDlUrl(current);
  download.href = dlUrl;
  download.setAttribute("download", current.filename || "QuickSave_Media.mp4");
  download.setAttribute("target", "_blank");

  saveHistory({
    id:   current.id,
    name: current.filename || "media.mp4",
    type: current.contentType || "media",
    time: Date.now()
  });

  progress.classList.remove("hide");
  progressText.textContent = "Starting download…";
  bar.style.width = "10%";
  progressPct.textContent = "10%";

  setTimeout(() => {
    bar.style.width = "100%";
    progressPct.textContent = "Ready";
    progressText.textContent = "Download started — check your Downloads app.";
  }, 500);
});

/* ── Drag drop ── */
["dragenter","dragover"].forEach(e =>
  drop.addEventListener(e, x => { x.preventDefault(); drop.classList.add("drag"); })
);
["dragleave","drop"].forEach(e =>
  drop.addEventListener(e, x => { x.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", e => {
  const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
  if (text) processUrl(text.trim(), isAutoEnabled() && isSupportedUrl(text.trim()));
});

/* ── PWA Install ── */
window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  installPrompt = e;
  install.classList.remove("hidden");
});
install.onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  install.classList.add("hidden");
};

/* ── Service Worker ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  );
}

/* ══════════════════════════════
   STARTUP LOGIC
══════════════════════════════ */
async function onStartup() {
  setAuto(isAutoEnabled());

  const params = new URLSearchParams(window.location.search);
  const sharedUrl = params.get("url") || params.get("text") || params.get("title");
  if (sharedUrl && isSupportedUrl(sharedUrl.trim())) {
    console.log("Shared URL detected:", sharedUrl);
    window.history.replaceState({}, "", "/");
    await processUrl(sharedUrl.trim(), true);
    return;
  }

  if (isAutoEnabled()) {
    const autoPasted = await tryAutoPaste();
    if (autoPasted) {
      console.log("Auto-pasted:", autoPasted);
      msg("URL detected! Processing…", "ok");
      await processUrl(autoPasted, true);
      return;
    }
  }

  renderHistory();
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (autoProcessing) return;
  if (!isAutoEnabled()) return;

  await new Promise(r => setTimeout(r, 300));

  const autoPasted = await tryAutoPaste();
  if (autoPasted && autoPasted !== url.value.trim()) {
    console.log("New URL on focus:", autoPasted);
    msg("New URL detected! Processing…", "ok");
    await processUrl(autoPasted, true);
  }
});

onStartup();
