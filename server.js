const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const { Readable, Transform } = require("stream");
const { pipeline } = require("stream/promises");
const youtubedl = require("youtube-dl-exec");

const app = express();

const PORT = process.env.PORT || 10000;
const MAX_BYTES = 250 * 1024 * 1024;
const INSPECT_TIMEOUT = 30000;
const IDLE_TIMEOUT = 60000; // 60 sec tak koi data na aaye tabhi abort
const MAX_REDIRECTS = 4;

const MAX_ACTIVE_PER_IP = 3;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 20;

const PUBLIC_DIR = path.join(__dirname, "public");

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "*/*",
  "Accept-Encoding": "identity"
};

const ALLOWED_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/octet-stream"
]);

const rateMap = new Map();
const activeMap = new Map();
const extractionCache = new Map();

app.use(express.json({ limit: "100kb" }));

function cleanIp(ip) {
  if (!ip) return "unknown";
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) ip = ip.substring(7);
  return ip;
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
  const [a, b] = parts;
  return (a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0);
}

function isPrivateIPv6(ip) {
  const value = ip.toLowerCase();
  return (value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe80:"));
}

async function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "local" || host === "metadata.google.internal") return true;
  const type = net.isIP(host);
  if (type === 4) return isPrivateIPv4(host);
  if (type === 6) return isPrivateIPv6(host);
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    for (const record of records) {
      if (record.family === 4 && isPrivateIPv4(record.address)) return true;
      if (record.family === 6 && isPrivateIPv6(record.address)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function validateUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== "string") throw new Error("URL is required.");
  let url;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Please enter a valid URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (await isBlockedHost(url.hostname)) throw new Error("This URL cannot be accessed safely.");
  return url;
}

function checkRateLimit(ip) {
  const now = Date.now();
  let record = rateMap.get(ip);
  if (!record || now - record.start > RATE_WINDOW) {
    record = { start: now, count: 0 };
    rateMap.set(ip, record);
  }
  record.count++;
  return record.count <= RATE_LIMIT;
}

function acquireDownload(ip) {
  const count = activeMap.get(ip) || 0;
  if (count >= MAX_ACTIVE_PER_IP) return false;
  activeMap.set(ip, count + 1);
  return true;
}

function releaseDownload(ip) {
  const count = activeMap.get(ip) || 0;
  if (count <= 1) activeMap.delete(ip);
  else activeMap.set(ip, count - 1);
}

function filenameFromUrl(url, contentType = "", customTitle = null) {
  let ext = contentType.includes("video") ? ".mp4" : contentType.includes("audio") ? ".mp3" : ".mp4";

  if (customTitle) {
    let safeTitle = customTitle.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").slice(0, 40);
    if (safeTitle.endsWith("_")) safeTitle = safeTitle.slice(0, -1);
    if (!safeTitle) safeTitle = "Media";
    return `QuickSave_${safeTitle}${ext}`;
  }

  let name = "";
  try {
    name = decodeURIComponent(path.basename(new URL(url).pathname));
  } catch {}
  name = name.replace(/[^a-zA-Z0-9._-]/g, "_");

  if (!name || name === "." || name.length < 2) {
    return `QuickSave_Media${ext}`;
  }
  return name.slice(0, 50);
}

function getContentType(response) {
  return (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
}

function isSocialMediaUrl(urlStr) {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.replace(/^www\./, "");

    if (hostname.includes("cdninstagram.com") || hostname.includes("fbcdn.net") || hostname.includes("googlevideo.com")) {
      return false;
    }

    const platforms = ["instagram.com", "facebook.com", "tiktok.com", "youtube.com", "youtu.be", "twitter.com", "x.com", "fb.watch"];
    return platforms.some(p => hostname.includes(p));
  } catch {
    return false;
  }
}

async function extractDirectVideoUrl(url) {
  try {
    const output = await youtubedl(url, {
      dumpSingleJson: true,
      noCheckCertificates: true,
      noWarnings: true,
      format: "b"
    });

    if (!output) throw new Error("Video file not found in post.");

    let directUrl = output.url;
    let headers = { ...(output.http_headers || {}) };

    if (!directUrl && output.requested_formats && output.requested_formats.length > 0) {
      directUrl = output.requested_formats[0].url;
      if (output.requested_formats[0].http_headers) {
        headers = { ...output.requested_formats[0].http_headers };
      }
    }

    delete headers["Host"];
    delete headers["host"];

    if (!directUrl) throw new Error("Could not extract media stream.");

    return {
      url: directUrl,
      title: output.title || "Video",
      headers
    };
  } catch (error) {
    console.error("Extractor error:", error.message);
    throw new Error("Unable to extract video from this link. It might be private or unsupported.");
  }
}

function buildHeaders(extra = {}) {
  const merged = { ...DEFAULT_HEADERS, ...extra };
  delete merged["Host"];
  delete merged["host"];
  // Compression band rakho taaki Content-Length sahi rahe
  delete merged["accept-encoding"];
  merged["Accept-Encoding"] = "identity";
  return merged;
}

async function fetchSafe(initialUrl, options = {}, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) throw new Error("Too many redirects.");
  const url = await validateUrl(initialUrl);

  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    headers: buildHeaders(options.headers || {}),
    signal: options.signal
  });

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect location missing.");
    const nextUrl = new URL(location, url).toString();
    return fetchSafe(nextUrl, options, redirectCount + 1);
  }
  return response;
}

async function fetchCDN(targetUrl, method, headers, signal) {
  return fetch(targetUrl, {
    method,
    headers: buildHeaders(headers),
    redirect: "follow",
    signal
  });
}

async function resolveTarget(rawUrl, saveToCache) {
  const url = await validateUrl(rawUrl);
  const originalUrl = url.toString();

  if (extractionCache.has(originalUrl)) {
    const cached = extractionCache.get(originalUrl);
    return { originalUrl, targetUrl: cached.url, title: cached.title, headers: cached.headers, useCDN: true };
  }

  if (isSocialMediaUrl(originalUrl)) {
    const data = await extractDirectVideoUrl(originalUrl);
    if (saveToCache) {
      extractionCache.set(originalUrl, data);
      extractionCache.set(data.url, data);
      setTimeout(() => {
        extractionCache.delete(originalUrl);
        extractionCache.delete(data.url);
      }, 15 * 60 * 1000).unref();
    }
    return { originalUrl, targetUrl: data.url, title: data.title, headers: data.headers, useCDN: true };
  }

  return { originalUrl, targetUrl: originalUrl, title: null, headers: {}, useCDN: false };
}

app.get("/health", (req, res) => res.json({ ok: true, service: "QuickSave", version: "2.7" }));

app.post("/api/inspect", async (req, res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, message: "Too many requests. Please wait." });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSPECT_TIMEOUT);

  try {
    const { originalUrl, targetUrl, title, headers, useCDN } = await resolveTarget(req.body?.url, true);

    let response = null;
    try {
      response = useCDN
        ? await fetchCDN(targetUrl, "HEAD", headers, controller.signal)
        : await fetchSafe(targetUrl, { method: "HEAD", signal: controller.signal });
    } catch {
      response = null;
    }

    let contentType = response ? getContentType(response) : "";
    let contentLength = response ? Number(response.headers.get("content-length") || 0) : 0;

    if (!response || !response.ok || !contentType) {
      response = useCDN
        ? await fetchCDN(targetUrl, "GET", { ...headers, Range: "bytes=0-0" }, controller.signal)
        : await fetchSafe(targetUrl, { method: "GET", headers: { Range: "bytes=0-0" }, signal: controller.signal });

      contentType = getContentType(response);
      const range = response.headers.get("content-range"); // e.g. bytes 0-0/24850000
      const totalFromRange = range && range.includes("/") ? Number(range.split("/")[1]) : 0;
      contentLength = totalFromRange || Number(response.headers.get("content-length") || 0);
      try { await response.body?.cancel(); } catch {}
    }

    if (!response.ok) {
      return res.status(400).json({ ok: false, type: "error", message: `The media server returned HTTP ${response.status}.` });
    }

    if (!ALLOWED_MIME.has(contentType) && !contentType.includes("video")) {
      return res.status(400).json({
        ok: false,
        type: "unsupported",
        contentType,
        message: "This URL does not point to a supported public media file."
      });
    }

    if (contentLength && contentLength > MAX_BYTES) {
      return res.status(400).json({ ok: false, type: "too-large", message: "This media file is larger than the 250 MB limit." });
    }

    return res.json({
      ok: true,
      type: "media",
      url: targetUrl,
      originalUrl,
      contentType: contentType || "video/mp4",
      size: contentLength || null,
      filename: filenameFromUrl(targetUrl, contentType, title)
    });
  } catch (error) {
    console.error("Inspect error:", error);
    return res.status(400).json({ ok: false, type: "error", message: error.message || "Unable to process this URL." });
  } finally {
    clearTimeout(timer);
  }
});

app.get("/api/download", async (req, res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, message: "Too many requests. Please wait." });
  if (!acquireDownload(ip)) return res.status(429).json({ ok: false, message: "Too many downloads are running. Please wait." });

  const controller = new AbortController();
  let idleTimer = null;
  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), IDLE_TIMEOUT);
  };

  // MAIN FIX: req ki jagah res ka "close" event.
  // Abort sirf tab hoga jab user ne sach mein connection tod diya ho.
  res.on("close", () => {
    clearTimeout(idleTimer);
    if (!res.writableFinished) controller.abort();
  });

  try {
    const { targetUrl, title, headers, useCDN } = await resolveTarget(req.query.url, false);

    const fetchHeaders = { ...headers };
    if (req.headers.range) fetchHeaders["Range"] = req.headers.range;

    resetIdle();
    const response = useCDN
      ? await fetchCDN(targetUrl, "GET", fetchHeaders, controller.signal)
      : await fetchSafe(targetUrl, { method: "GET", headers: fetchHeaders, signal: controller.signal });

    // response.ok me 200 aur 206 dono aate hain
    if (!response.ok) {
      return res.status(400).json({ ok: false, message: `Media server returned HTTP ${response.status}.` });
    }
    if (!response.body) throw new Error("Media stream unavailable.");

    const contentType = getContentType(response) || "video/mp4";
    const contentLength = Number(response.headers.get("content-length") || 0);

    if (contentLength && contentLength > MAX_BYTES) {
      try { await response.body.cancel(); } catch {}
      return res.status(413).json({ ok: false, message: "This file is larger than the 250 MB limit." });
    }

    const filename = filenameFromUrl(targetUrl, contentType, title);
    const encodedName = encodeURIComponent(filename);

    res.status(response.status);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodedName}`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Accept-Ranges", "bytes");
    if (response.headers.has("content-length")) res.setHeader("Content-Length", response.headers.get("content-length"));
    if (response.headers.has("content-range")) res.setHeader("Content-Range", response.headers.get("content-range"));

    let total = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length;
        resetIdle();
        if (total > MAX_BYTES) return cb(new Error("Download exceeded the limit."));
        cb(null, chunk);
      }
    });

    // pipeline backpressure aur errors khud handle karta hai
    await pipeline(Readable.fromWeb(response.body), limiter, res);
  } catch (error) {
    const clientLeft = error.code === "ERR_STREAM_PREMATURE_CLOSE" || (error.name === "AbortError" && res.destroyed);
    if (!clientLeft) console.error("Download error:", error);

    if (!res.headersSent) {
      return res.status(400).json({
        ok: false,
        message: error.name === "AbortError" ? "Download timed out." : error.message || "Unable to download this media."
      });
    }
    res.destroy();
  } finally {
    clearTimeout(idleTimer);
    releaseDownload(ip);
  }
});

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use((err, req, res, next) => {
  console.error("Server error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: "Internal server error." });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`QuickSave running on port ${PORT}`);
});

function shutdown(signal) {
  console.log(`${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (error) => console.error("Uncaught exception:", error));
process.on("unhandledRejection", (error) => console.error("Unhandled rejection:", error));
