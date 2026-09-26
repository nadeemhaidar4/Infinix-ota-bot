const $ = (id) => document.getElementById(id);
const url = $("url"),
  paste = $("paste"),
  go = $("go"),
  drop = $("drop"),
  status = $("status"),
  result = $("result"),
  name = $("name"),
  meta = $("meta"),
  download = $("download"),
  thumb = $("thumb"),
  progress = $("progress"),
  bar = $("bar"),
  progressText = $("progressText"),
  progressPct = $("progressPct"),
  historyPanel = $("historyPanel"),
  history = $("history"),
  install = $("install");

let current = null,
  installPrompt = null;

/* ── helpers ── */
function msg(t, c = "") {
  status.textContent = t;
  status.className = "status " + c;
  status.classList.toggle("hide", !t);
}

function size(n) {
  if (!n) return "Size unavailable";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[m])
  );
}

/* ── download URL builder ──
   Server returns: { id, downloadUrl, url, contentType, filename, size }
   We ALWAYS use id-based URL to avoid CDN URL encoding issues            */
function buildDlUrl(d, inline = false) {
  let base;
  if (d.id)          base = `/api/download?id=${encodeURIComponent(d.id)}`;
  else if (d.downloadUrl) base = d.downloadUrl;
  else               base = "#";          // fallback – should never happen
  return inline ? base + "&inline=1" : base;
}

/* ── history ── */
function saveHistory(item) {
  let h = JSON.parse(localStorage.getItem("qs_history") || "[]");
  h = [item, ...h.filter(x => x.id ? x.id !== item.id : x.url !== item.url)].slice(0, 8);
  localStorage.setItem("qs_history", JSON.stringify(h));
  renderHistory();
}

function renderHistory() {
  const h = JSON.parse(localStorage.getItem("qs_history") || "[]");
  if (!h.length) { historyPanel.classList.add("hide"); return; }
  historyPanel.classList.remove("hide");
  history.innerHTML = h.map(x => {
    const href = escapeHtml(
      x.id ? `/api/download?id=${x.id}` : (x.downloadUrl || "#")
    );
    return `<div class="historyrow">
      <div>
        <b>${escapeHtml(x.name)}</b>
        <small>${escapeHtml(x.type)} • ${new Date(x.time).toLocaleString()}</small>
      </div>
      <a href="${href}">Download</a>
    </div>`;
  }).join("");
}

$("clearHistory").onclick = () => {
  localStorage.removeItem("qs_history");
  renderHistory();
};

/* ── paste button ── */
paste.onclick = async () => {
  try {
    url.value = (await navigator.clipboard.readText()).trim();
    paste.textContent = "Pasted ✓";
    setTimeout(() => (paste.textContent = "Paste"), 1200);
  } catch {
    msg("Clipboard permission unavailable. Paste manually.", "err");
    url.focus();
  }
};

/* ── drag-drop ── */
["dragenter", "dragover"].forEach(e =>
  drop.addEventListener(e, x => { x.preventDefault(); drop.classList.add("drag"); })
);
["dragleave", "drop"].forEach(e =>
  drop.addEventListener(e, x => { x.preventDefault(); drop.classList.remove("drag"); })
);
drop.addEventListener("drop", e => {
  const text = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
  if (text) { url.value = text.trim(); go.click(); }
});
url.onkeydown = e => { if (e.key === "Enter") go.click(); };

/* ── preview ── */
function showPreview(d) {
  thumb.innerHTML = "";
  const mime = (d.contentType || "").toLowerCase();
  const previewUrl = buildDlUrl(d, true);   // inline=1 so browser streams it

  if (mime.startsWith("image/")) {
    const img = new Image();
    img.src = previewUrl;
    img.alt = d.filename || "preview";
    img.onload  = () => thumb.appendChild(img);
    img.onerror = () => (thumb.innerHTML = "<span>◈</span>");

  } else if (mime.startsWith("video/")) {
    const v = document.createElement("video");
    v.src        = previewUrl;
    v.muted      = true;
    v.playsInline = true;
    v.preload    = "metadata";
    v.addEventListener("loadedmetadata", () => {
      try { v.currentTime = 0.5; } catch {}
    });
    v.onerror = () => (thumb.innerHTML = "<span>▶</span>");
    thumb.appendChild(v);

  } else {
    thumb.innerHTML = "<span>♪</span>";
  }
}

/* ── main inspect flow ── */
go.onclick = async () => {
  const value = url.value.trim();
  if (!value) return msg("Paste a media URL first.", "err");

  go.disabled = true;
  result.classList.add("hide");
  progress.classList.add("hide");

  // safely update button text (first text node)
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

    if (!r.ok || !d.ok) throw new Error(d.message || "This link could not be processed.");

    // ── CRITICAL CHECK ──
    if (!d.id && !d.downloadUrl) {
      throw new Error("Server error: no download ID returned. Please redeploy latest server.js.");
    }

    current = d;

    /* build final download URL using short id */
    const dlUrl = buildDlUrl(d, false);

    name.textContent = d.filename || "media.mp4";
    meta.textContent = (d.contentType || "media") + (d.size ? " • " + size(d.size) : "");

    showPreview(d);

    /* set anchor — this is what Android Download Manager reads */
    download.href = dlUrl;
    download.setAttribute("download", d.filename || "QuickSave_Media.mp4");

    result.classList.remove("hide");
    msg("Media is ready. Tap Download file.", "ok");

  } catch (e) {
    msg(e.message || "Something went wrong.", "err");
  } finally {
    go.disabled = false;
    if (btnText) btnText.textContent = "Get media ";
  }
};

/* ── download button click ── */
download.addEventListener("click", () => {
  if (!current) return;

  const dlUrl = buildDlUrl(current, false);
  download.href = dlUrl;   // re-confirm before navigation

  saveHistory({
    id:          current.id,
    downloadUrl: dlUrl,
    url:         current.originalUrl || current.url || "",
    name:        current.filename    || "media.mp4",
    type:        current.contentType || "media",
    time:        Date.now()
  });

  /* progress bar UX */
  progress.classList.remove("hide");
  progressText.textContent = "Starting download…";
  bar.style.width   = "10%";
  progressPct.textContent = "10%";

  setTimeout(() => {
    bar.style.width         = "100%";
    progressPct.textContent = "Ready";
    progressText.textContent = "Download started — check your Downloads app.";
  }, 500);
});

/* ── PWA install ── */
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

/* ── service worker ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  );
}

renderHistory();
