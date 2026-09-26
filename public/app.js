/* QuickSave app.js v3.0 */
console.log("QuickSave app.js v3.0 loaded");

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

/* ── ONLY ID-based download URLs ── */
function buildDlUrl(d, inline = false) {
  if (!d || !d.id) {
    console.error("buildDlUrl: no id in response", d);
    return "#";
  }
  const base = `/api/download?id=${encodeURIComponent(d.id)}`;
  return inline ? base + "&inline=1" : base;
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
    const href = x.id
      ? escapeHtml(`/api/download?id=${x.id}`)
      : "#";
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

/* ── paste ── */
paste.onclick = async () => {
  try {
    url.value = (await navigator.clipboard.readText()).trim();
    paste.textContent = "Pasted ✓";
    setTimeout(() => (paste.textContent = "Paste"), 1200);
  } catch {
    msg("Clipboard unavailable. Paste manually.", "err");
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

  if (mime.startsWith("image/")) {
    const previewUrl = buildDlUrl(d, true);
    const img = new Image();
    img.src = previewUrl;
    img.alt = d.filename || "preview";
    img.onload = () => thumb.appendChild(img);
    img.onerror = () => (thumb.innerHTML = "<span>◈</span>");
  } else if (mime.startsWith("video/")) {
    // Video preview ke liye music note icon dikhao
    // (video tag CDN auth issues cause karta hai)
    thumb.innerHTML = "<span>▶</span>";
  } else {
    thumb.innerHTML = "<span>♪</span>";
  }
}

/* ── MAIN: Get media ── */
go.onclick = async () => {
  const value = url.value.trim();
  if (!value) return msg("Paste a media URL first.", "err");

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

    console.log("Inspect response:", JSON.stringify({
      ok: d.ok,
      id: d.id,
      downloadUrl: d.downloadUrl,
      contentType: d.contentType,
      filename: d.filename,
      size: d.size
    }));

    if (!r.ok || !d.ok) throw new Error(d.message || "This link could not be processed.");
    if (!d.id) throw new Error("Server error: no download ID. Please redeploy latest server.js");

    current = d;

    const dlUrl = buildDlUrl(d, false);
    console.log("Download URL will be:", dlUrl);

    name.textContent = d.filename || "media.mp4";
    meta.textContent = (d.contentType || "media") + (d.size ? " • " + size(d.size) : "");

    showPreview(d);

    /* ── Set anchor href ── */
    download.href = dlUrl;
    download.setAttribute("download", d.filename || "QuickSave_Media.mp4");

    result.classList.remove("hide");
    msg("Media is ready. Tap Download file.", "ok");

  } catch (e) {
    console.error("Inspect failed:", e);
    msg(e.message || "Something went wrong.", "err");
  } finally {
    go.disabled = false;
    const btnText2 = [...go.childNodes].find(n => n.nodeType === Node.TEXT_NODE);
    if (btnText2) btnText2.textContent = "Get media ";
  }
};

/* ── Download button click ── */
download.addEventListener("click", (e) => {
  if (!current || !current.id) {
    e.preventDefault();
    msg("Please tap 'Get media' first.", "err");
    return;
  }

  const dlUrl = buildDlUrl(current, false);
  console.log("Download clicked, URL:", dlUrl);

  // Re-confirm href (prevent any stale value)
  download.href = dlUrl;
  download.setAttribute("download", current.filename || "QuickSave_Media.mp4");

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

/* ── PWA ── */
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

/* ── SW ── */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {})
  );
}

renderHistory();
