const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const { Readable, Writable } = require("stream");
const { pipeline } = require("stream/promises");
const youtubedl = require("youtube-dl-exec");

const app = express();

const PORT = process.env.PORT || 10000;
const MAX_BYTES = 250 * 1024 * 1024;
const INSPECT_TIMEOUT = 90000;
const DOWNLOAD_TIMEOUT = 300000;
const MAX_REDIRECTS = 4;
const MAX_ACTIVE_PER_IP = 3;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 20;
const PUBLIC_DIR = path.join(__dirname, "public");

const rateMap         = new Map();
const activeMap       = new Map();
const extractionCache = new Map();

app.use(express.json({ limit: "100kb" }));

/* ════════════════════════════════════════
   IP HELPERS
════════════════════════════════════════ */
function cleanIp(ip) {
  if (!ip) return "unknown";
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) ip = ip.substring(7);
  return ip;
}

function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  const [a, b] = p;
  return (
    a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" ||
    v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80:");
}

async function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") ||
    host === "local" || host === "metadata.google.internal"
  ) return true;
  const type = net.isIP(host);
  if (type === 4) return isPrivateIPv4(host);
  if (type === 6) return isPrivateIPv6(host);
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const r of records) {
      if (r.family === 4 && isPrivateIPv4(r.address)) return true;
      if (r.family === 6 && isPrivateIPv6(r.address)) return true;
    }
    return false;
  } catch { return true; }
}

async function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") throw new Error("URL is required.");
  let url;
  try { url = new URL(rawUrl.trim()); }
  catch { throw new Error("Please enter a valid URL."); }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (await isBlockedHost(url.hostname))
    throw new Error("This URL cannot be accessed safely.");
  return url;
}

/* ════════════════════════════════════════
   RATE / CONCURRENCY
════════════════════════════════════════ */
function checkRateLimit(ip) {
  const now = Date.now();
  let r = rateMap.get(ip);
  if (!r || now - r.start > RATE_WINDOW) { r = { start: now, count: 0 }; rateMap.set(ip, r); }
  r.count++;
  return r.count <= RATE_LIMIT;
}
function acquireDownload(ip) {
  const c = activeMap.get(ip) || 0;
  if (c >= MAX_ACTIVE_PER_IP) return false;
  activeMap.set(ip, c + 1); return true;
}
function releaseDownload(ip) {
  const c = activeMap.get(ip) || 0;
  if (c <= 1) activeMap.delete(ip); else activeMap.set(ip, c - 1);
}

/* ════════════════════════════════════════
   FILENAME
════════════════════════════════════════ */
function filenameFromUrl(url, contentType = "", customTitle = null) {
  const ext = contentType.includes("video") ? ".mp4"
    : contentType.includes("audio") ? ".mp3"
    : contentType.includes("image") ? ".jpg"
    : ".mp4";
  if (customTitle) {
    let t = customTitle.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").slice(0, 40);
    if (t.endsWith("_")) t = t.slice(0, -1);
    return `QuickSave_${t || "Media"}${ext}`;
  }
  let n = "";
  try { n = decodeURIComponent(path.basename(new URL(url).pathname)); } catch {}
  n = n.replace(/[^a-zA-Z0-9._-]/g, "_");
  return (!n || n === "." || n.length < 2) ? `QuickSave_Media${ext}` : n.slice(0, 50);
}

function getRawContentType(r) {
  return (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

function isValidMediaType(ct) {
  if (!ct) return false;
  if (ct.includes("json") || ct.includes("html") || ct.includes("text/") || ct.includes("xml")) return false;
  return ct.includes("video/") || ct.includes("audio/") || ct.includes("image/") || ct === "application/octet-stream";
}

/* ════════════════════════════════════════
   PLATFORM DETECTION
════════════════════════════════════════ */
function getPlatform(urlStr) {
  try {
    const h = new URL(urlStr).hostname.replace(/^www\./, "");
    if (h.includes("youtube.com") || h.includes("youtu.be")) return "youtube";
    if (h.includes("instagram.com")) return "instagram";
    if (h.includes("facebook.com") || h.includes("fb.watch")) return "facebook";
    if (h.includes("tiktok.com")) return "tiktok";
    if (h.includes("twitter.com") || h.includes("x.com")) return "twitter";
    if (h.includes("reddit.com") || h.includes("v.redd.it")) return "reddit";
    if (h.includes("vimeo.com")) return "vimeo";
    if (h.includes("dailymotion.com")) return "dailymotion";
    return null;
  } catch { return null; }
}

function isSocialMediaUrl(urlStr) {
  try {
    const h = new URL(urlStr).hostname.replace(/^www\./, "");
    if (
      h.includes("cdninstagram.com") || h.includes("fbcdn.net") ||
      h.includes("googlevideo.com")  || h.includes("tiktokcdn.com") ||
      h.includes("twimg.com")
    ) return false;

    return [
      "instagram.com", "facebook.com", "fb.watch",
      "tiktok.com",    "youtube.com",  "youtu.be",
      "twitter.com",   "x.com",        "reddit.com",
      "vimeo.com",     "dailymotion.com"
    ].some(p => h.includes(p));
  } catch { return false; }
}

/* ════════════════════════════════════════
   CACHE
════════════════════════════════════════ */
function makeDownloadId() { return crypto.randomBytes(12).toString("hex"); }

function cacheExtraction(originalUrl, extractedData) {
  const downloadId = makeDownloadId();
  const payload = { ...extractedData, originalUrl, downloadId, createdAt: Date.now() };
  extractionCache.set(originalUrl,         payload);
  extractionCache.set(extractedData.url,   payload);
  extractionCache.set(downloadId,          payload);
  setTimeout(() => {
    extractionCache.delete(originalUrl);
    extractionCache.delete(extractedData.url);
    extractionCache.delete(downloadId);
  }, 10 * 60 * 1000);
  return payload;
}

/* ════════════════════════════════════════
   URL CLEANERS
════════════════════════════════════════ */
function cleanYouTubeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    
    // youtu.be/VIDEO_ID
    if (u.hostname.includes("youtu.be")) {
      const videoId = u.pathname.slice(1).split("/")[0].split("?")[0];
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    }
    
    // youtube.com/shorts/VIDEO_ID
    if (u.pathname.startsWith("/shorts/")) {
      const videoId = u.pathname.split("/shorts/")[1].split("/")[0].split("?")[0];
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    }
    
    // youtube.com/watch?v=VIDEO_ID
    if (u.hostname.includes("youtube.com")) {
      const v = u.searchParams.get("v");
      if (v) return `https://www.youtube.com/watch?v=${v}`;
    }
    
    // youtube.com/live/VIDEO_ID  
    if (u.pathname.startsWith("/live/")) {
      const videoId = u.pathname.split("/live/")[1].split("/")[0].split("?")[0];
      if (videoId) return `https://www.youtube.com/watch?v=${videoId}`;
    }
    
  } catch {}
  return rawUrl;
}

/* ════════════════════════════════════════
   YT-DLP EXTRACTOR - YOUTUBE SHORTS FIX
════════════════════════════════════════ */
async function extractDirectVideoUrl(pageUrl) {
  console.log("[extract] Starting for:", pageUrl.slice(0, 80));
  
  const platform = getPlatform(pageUrl);
  console.log("[extract] Platform:", platform);

  let cleanUrl = pageUrl;
  if (platform === "youtube") {
    cleanUrl = cleanYouTubeUrl(pageUrl);
    console.log("[extract] Cleaned URL:", cleanUrl);
  }

  const strategies = buildStrategies(platform, cleanUrl);
  let lastError = null;

  for (let i = 0; i < strategies.length; i++) {
    const s = strategies[i];
    console.log(`[extract] Strategy ${i+1}/${strategies.length}: ${s.name}`);
    try {
      const result = await runExtraction(cleanUrl, s.options);
      if (result && result.url) {
        console.log("[extract] ✓ Success:", s.name);
        return result;
      }
    } catch (e) {
      lastError = e;
      const msg = e.message || "";
      console.log(`[extract] ✗ ${s.name}: ${msg.slice(0, 120)}`);
      
      // Agar video exist hi nahi karta toh aage try mat karo
      if (
        msg.includes("Video unavailable") ||
        msg.includes("Private video") ||
        msg.includes("has been removed") ||
        msg.includes("age-restricted") ||
        msg.includes("not available")
      ) {
        throw new Error("Video private, removed, ya age-restricted hai. Download possible nahi.");
      }
    }
  }

  // Platform specific error
  if (platform === "youtube") {
    throw new Error("YouTube ne download block kar diya. yt-dlp update karo ya thodi der baad try karo.");
  }
  throw new Error(`Video extract nahi hua: ${lastError?.message?.slice(0, 100) || "Unknown error"}`);
}

function buildStrategies(platform, url) {
  if (platform === "youtube") {
    return [
      // Strategy 1: Android client - SABSE BEST for Shorts
      {
        name: "Android-Client",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
          extractorArgs:       "youtube:player_client=android,web",
        }
      },
      // Strategy 2: iOS client
      {
        name: "iOS-Client",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best[ext=mp4]/best",
          extractorArgs:       "youtube:player_client=ios",
        }
      },
      // Strategy 3: TV client (bot detection se bachne ke liye)
      {
        name: "TV-Client",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best",
          extractorArgs:       "youtube:player_client=tv_embedded",
        }
      },
      // Strategy 4: mweb client
      {
        name: "MWeb-Client",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best",
          extractorArgs:       "youtube:player_client=mweb",
          addHeader:           [
            "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
          ]
        }
      },
      // Strategy 5: Default web (last resort)
      {
        name: "Web-Default",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best[height<=720]/best",
        }
      }
    ];
  }

  if (platform === "instagram") {
    return [
      {
        name: "Instagram-Chrome",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best",
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept-Language: en-US,en;q=0.9",
            "Referer: https://www.instagram.com/"
          ]
        }
      },
      {
        name: "Instagram-Mobile",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          format:              "best",
          addHeader: [
            "User-Agent: Instagram 219.0.0.12.117 Android (30/11; 420dpi; 1080x2154; samsung; SM-G991B; o1s; exynos2100)",
          ]
        }
      }
    ];
  }

  if (platform === "tiktok") {
    return [
      {
        name: "TikTok-Main",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best",
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Referer: https://www.tiktok.com/"
          ]
        }
      }
    ];
  }

  if (platform === "facebook") {
    return [
      {
        name: "Facebook-Main",
        options: {
          dumpSingleJson:      true,
          noCheckCertificates: true,
          noWarnings:          true,
          noPlaylist:          true,
          format:              "best",
          addHeader: [
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
          ]
        }
      }
    ];
  }

  // Generic
  return [
    {
      name: "Generic-Best",
      options: {
        dumpSingleJson:      true,
        noCheckCertificates: true,
        noWarnings:          true,
        noPlaylist:          true,
        format:              "best[ext=mp4]/best",
      }
    }
  ];
}

async function runExtraction(url, options) {
  const output = await youtubedl(url, options);
  if (!output) throw new Error("Empty output from yt-dlp");

  let directUrl = null;
  let headers   = {};

  // 1. Direct URL
  if (output.url && typeof output.url === "string" && output.url.startsWith("http")) {
    directUrl = output.url;
    headers   = { ...(output.http_headers || {}) };
  }

  // 2. requested_formats (merged streams)
  if (!directUrl && output.requested_formats?.length) {
    // Video stream prefer karo
    const vf = output.requested_formats.find(f => f.url && f.vcodec && f.vcodec !== "none");
    if (vf) {
      directUrl = vf.url;
      headers   = { ...(vf.http_headers || {}) };
    }
  }

  // 3. formats array se best dhundo
  if (!directUrl && output.formats?.length) {
    const validFmts = output.formats
      .filter(f => f.url && typeof f.url === "string" && f.url.startsWith("http"))
      .reverse(); // best quality pehle

    // Combined video+audio prefer karo
    const combined = validFmts.find(
      f => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none"
    );
    const videoOnly = validFmts.find(f => f.vcodec && f.vcodec !== "none");
    const any       = validFmts[0];

    const chosen = combined || videoOnly || any;
    if (chosen) {
      directUrl = chosen.url;
      headers   = { ...(chosen.http_headers || {}) };
    }
  }

  if (!directUrl) throw new Error("No stream URL in yt-dlp output");

  // Host header remove (causes issues)
  delete headers["Host"];
  delete headers["host"];

  return {
    url:       directUrl,
    title:     output.title || output.id || "Video",
    thumbnail: output.thumbnail || null,
    headers
  };
}

/* ════════════════════════════════════════
   FETCH HELPERS
════════════════════════════════════════ */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchSafe(initialUrl, options = {}, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) throw new Error("Too many redirects.");
  const url = await validateUrl(initialUrl);
  const h = { "User-Agent": UA, "Accept": "*/*", ...(options.headers || {}) };
  delete h["Host"]; delete h["host"];
  const response = await fetch(url, { ...options, redirect: "manual", headers: h, signal: options.signal });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const loc = response.headers.get("location");
    if (!loc) throw new Error("Redirect location missing.");
    return fetchSafe(new URL(loc, url).toString(), options, redirectCount + 1);
  }
  return response;
}

async function fetchCDN(targetUrl, headers, signal) {
  const h = {
    "User-Agent":      UA,
    "Accept":          "*/*",
    "Accept-Encoding": "identity",
    ...headers
  };
  delete h["Host"];  delete h["host"];
  delete h["Range"]; delete h["range"];

  return fetch(targetUrl, {
    method:   "GET",
    headers:  h,
    redirect: "follow",
    signal
  });
}

/* ════════════════════════════════════════
   STREAM
════════════════════════════════════════ */
async function streamToResponse(response, res, controller, startTime) {
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength && contentLength > MAX_BYTES)
    throw Object.assign(new Error("File exceeds 250 MB limit."), { status: 413 });

  if (!response.body) throw new Error("Media stream unavailable.");
  if (contentLength) res.setHeader("Content-Length", String(contentLength));

  const nodeStream = Readable.fromWeb
    ? Readable.fromWeb(response.body)
    : response.body;

  let total         = 0;
  let limitExceeded = false;

  const guard = new Writable({
    highWaterMark: 512 * 1024,
    write(chunk, _enc, cb) {
      if (limitExceeded) return cb();
      total += chunk.length;
      if (total > MAX_BYTES) {
        limitExceeded = true;
        controller.abort();
        res.destroy();
        return cb(new Error("Size limit exceeded"));
      }
      if (!res.write(chunk)) res.once("drain", cb);
      else cb();
    },
    final(cb) {
      if (!limitExceeded) {
        res.end();
        const secs = ((Date.now() - startTime) / 1000).toFixed(1);
        const mbps = (total / 1024 / 1024 / parseFloat(secs)).toFixed(2);
        console.log(`[dl] done ${(total/1024/1024).toFixed(1)}MB in ${secs}s @ ${mbps}MB/s`);
      }
      cb();
    }
  });

  try {
    await pipeline(nodeStream, guard);
  } catch (e) {
    if (!limitExceeded && e.name !== "AbortError") throw e;
  }
}

/* ════════════════════════════════════════
   ROUTES
════════════════════════════════════════ */
app.get("/health", (_req, res) =>
  res.json({ ok: true, service: "QuickSave", version: "5.1" })
);

app.get("/share", (req, res) => {
  const shared = (req.query.url || req.query.text || req.query.title || "").trim();
  console.log("[share] received:", shared.slice(0, 120));
  return shared
    ? res.redirect(302, `/?url=${encodeURIComponent(shared)}`)
    : res.redirect(302, "/");
});

/* ── INSPECT ── */
app.post("/api/inspect", async (req, res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!checkRateLimit(ip))
    return res.status(429).json({ ok: false, message: "Too many requests. Please wait." });

  try {
    const rawUrl = req.body?.url;
    let urlObj      = await validateUrl(rawUrl);
    let targetUrl   = urlObj.toString();
    let extractedTitle = null, customHeaders = {}, useCDNFetch = false;
    let downloadId  = null, thumbnail = null;

    if (extractionCache.has(targetUrl)) {
      const c = extractionCache.get(targetUrl);
      targetUrl = c.url; extractedTitle = c.title; thumbnail = c.thumbnail;
      customHeaders = c.headers || {}; downloadId = c.downloadId; useCDNFetch = true;
      console.log("[inspect] cache hit");

    } else if (isSocialMediaUrl(targetUrl)) {
      console.log("[inspect] social url detected:", targetUrl.slice(0, 80));
      const data = await extractDirectVideoUrl(targetUrl);
      const c    = cacheExtraction(targetUrl, data);
      targetUrl = c.url; extractedTitle = c.title; thumbnail = c.thumbnail;
      customHeaders = c.headers || {}; downloadId = c.downloadId; useCDNFetch = true;

    } else {
      const c = cacheExtraction(targetUrl, { url: targetUrl, title: null, headers: {}, thumbnail: null });
      downloadId = c.downloadId;
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), INSPECT_TIMEOUT);

    try {
      let response = null;
      try {
        const h = { "User-Agent": UA, "Accept": "*/*", ...customHeaders };
        delete h["Host"]; delete h["host"]; delete h["Range"]; delete h["range"];
        response = await fetch(targetUrl, {
          method: "HEAD", headers: h, redirect: "follow", signal: controller.signal
        });
      } catch { response = null; }

      let contentType   = response ? getRawContentType(response) : "";
      let contentLength = response ? Number(response.headers.get("content-length") || 0) : 0;

      if (!response || !response.ok || !isValidMediaType(contentType)) {
        response = useCDNFetch
          ? await fetchCDN(targetUrl, customHeaders, controller.signal)
          : await fetchSafe(targetUrl, { method: "GET", signal: controller.signal });
        contentType   = getRawContentType(response);
        contentLength = Number(response.headers.get("content-length") || 0);
        try { await response.body?.cancel(); } catch {}
      }

      if (contentType === "application/octet-stream" && (extractedTitle || useCDNFetch)) {
        contentType = "video/mp4";
      }

      if (!response.ok)
        return res.status(400).json({ ok: false, type: "error",
          message: `Media server returned HTTP ${response.status}.` });

      if (!isValidMediaType(contentType))
        return res.status(400).json({ ok: false, type: "unsupported",
          message: "Valid media file nahi mila is URL par." });

      if (contentLength && contentLength > MAX_BYTES)
        return res.status(400).json({ ok: false, type: "too-large",
          message: "File 250 MB se badi hai." });

      const filename = filenameFromUrl(targetUrl, contentType, extractedTitle);
      console.log("[inspect] ok:", filename, contentType, contentLength);

      return res.json({
        ok:          true,
        type:        "media",
        id:          downloadId,
        downloadUrl: `/api/download?id=${downloadId}`,
        directUrl:   targetUrl,
        url:         targetUrl,
        originalUrl: urlObj.toString(),
        contentType: contentType || "video/mp4",
        size:        contentLength || null,
        filename,
        thumbnail
      });

    } finally { clearTimeout(timer); }

  } catch (e) {
    console.error("[inspect] error:", e.message);
    return res.status(400).json({ ok: false, type: "error",
      message: e.message || "URL process nahi ho pa raha." });
  }
});

/* ── DOWNLOAD ── */
app.get("/api/download", async (req, res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!checkRateLimit(ip))
    return res.status(429).json({ ok: false, message: "Too many requests." });
  if (!acquireDownload(ip))
    return res.status(429).json({ ok: false, message: "Too many active downloads." });

  const startTime = Date.now();

  try {
    let targetUrl = null, extractedTitle = null, customHeaders = {}, originalSocialUrl = null;
    const idParam = req.query.id ? String(req.query.id).trim() : null;

    if (idParam) {
      const cached = extractionCache.get(idParam);
      if (!cached)
        return res.status(410).json({ ok: false,
          message: "Link expired. Please 'Get media' again tap karo." });
      targetUrl         = cached.url;
      extractedTitle    = cached.title;
      customHeaders     = cached.headers || {};
      originalSocialUrl = cached.originalUrl;

    } else {
      let rawUrl = req.query.url;
      if (!rawUrl)
        return res.status(400).json({ ok: false, message: "id ya url required hai." });
      for (let i = 0; i < 2; i++) {
        try { const d = decodeURIComponent(rawUrl); if (d === rawUrl) break; rawUrl = d; } catch { break; }
      }
      if (extractionCache.has(rawUrl)) {
        const c = extractionCache.get(rawUrl);
        targetUrl = c.url; extractedTitle = c.title;
        customHeaders = c.headers || {}; originalSocialUrl = c.originalUrl;
      } else {
        const validated = await validateUrl(rawUrl);
        targetUrl = validated.toString();
        if (isSocialMediaUrl(targetUrl)) {
          originalSocialUrl = targetUrl;
          const data = await extractDirectVideoUrl(targetUrl);
          const c    = cacheExtraction(targetUrl, data);
          targetUrl = c.url; extractedTitle = c.title; customHeaders = c.headers || {};
        }
      }
    }

    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);
    req.on("close", () => { controller.abort(); clearTimeout(timer); });

    try {
      let response    = await fetchCDN(targetUrl, customHeaders, controller.signal);
      let contentType = getRawContentType(response);
      if (contentType === "application/octet-stream") contentType = "video/mp4";

      if (!response.ok || !isValidMediaType(contentType)) {
        if (originalSocialUrl && isSocialMediaUrl(originalSocialUrl)) {
          try {
            const fresh = await extractDirectVideoUrl(originalSocialUrl);
            const c     = cacheExtraction(originalSocialUrl, fresh);
            targetUrl = c.url; customHeaders = c.headers || {}; extractedTitle = fresh.title;
            response    = await fetchCDN(targetUrl, customHeaders, controller.signal);
            contentType = getRawContentType(response);
            if (contentType === "application/octet-stream") contentType = "video/mp4";
          } catch {
            return res.status(502).json({ ok: false,
              message: "Media expire ho gaya. Please 'Get media' again tap karo." });
          }
        }
        if (!response.ok || !isValidMediaType(contentType))
          return res.status(502).json({ ok: false,
            message: `Bad media response (${response.status}).` });
      }

      const filename        = filenameFromUrl(targetUrl, contentType, extractedTitle);
      const safeFilename    = filename.replace(/[\r\n"']/g, "");
      const encodedFilename = encodeURIComponent(safeFilename);
      const wantInline      = req.query.inline === "1";

      res.status(200);
      res.setHeader("Content-Type",          contentType);
      res.setHeader("Content-Disposition",
        wantInline
          ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
          : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
      );
      res.setHeader("Cache-Control",          "no-store");
      res.setHeader("Accept-Ranges",          "none");
      res.setHeader("X-Content-Type-Options", "nosniff");

      await streamToResponse(response, res, controller, startTime);

    } finally { clearTimeout(timer); }

  } catch (e) {
    console.error("[dl] error:", e.message);
    if (!res.headersSent)
      res.status(e.status || 400).json({ ok: false,
        message: e.name === "AbortError" ? "Download timeout." : e.message || "Download failed." });
    else res.destroy();
  } finally {
    releaseDownload(ip);
  }
});

/* ════════════════════════════════════════
   STATIC + FALLBACK
════════════════════════════════════════ */
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));
app.use((_req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.use((err, _req, res, next) => {
  console.error("Server error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: "Internal server error." });
});

/* ════════════════════════════════════════
   START
════════════════════════════════════════ */
const server = app.listen(PORT, "0.0.0.0", () =>
  console.log(`QuickSave v5.1 running on port ${PORT}`)
);

function shutdown(sig) {
  console.log(sig + " received");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("uncaughtException",  e => console.error("Uncaught:", e));
process.on("unhandledRejection", e => console.error("Unhandled:", e));
