const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const youtubedl = require("youtube-dl-exec"); 

const app = express();

const PORT = process.env.PORT || 10000;
const MAX_BYTES = 250 * 1024 * 1024;
const INSPECT_TIMEOUT = 30000; 
const DOWNLOAD_TIMEOUT = 300000; // 5 mins
const MAX_REDIRECTS = 4;

const MAX_ACTIVE_PER_IP = 3;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 20;

const PUBLIC_DIR = path.join(__dirname, "public");

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

// FIX 2: Android File Manager ke liye completely strict filename banaya hai
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
        const hostname = new URL(urlStr).hostname.replace(/^www\./, "");
        const platforms = ["instagram.com", "facebook.com", "tiktok.com", "youtube.com", "youtu.be", "twitter.com", "x.com", "fb.watch"];
        return platforms.some(p => hostname.includes(p));
    } catch {
        return false;
    }
}

// FIX 1: Video ke URL ke sath uske bypass "headers" bhi fetch kiye gaye hain
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
        let headers = output.http_headers || {}; // Ye headers ab Instagram ki blocking bypass karenge

        if (!directUrl && output.requested_formats && output.requested_formats.length > 0) {
            directUrl = output.requested_formats[0].url;
            if (output.requested_formats[0].http_headers) {
                headers = output.requested_formats[0].http_headers;
            }
        }

        if (!directUrl) throw new Error("Could not extract media stream.");

        return {
            url: directUrl,
            title: output.title || "Video",
            headers: headers
        };
    } catch (error) {
        console.error("Extractor error:", error.message);
        throw new Error("Unable to extract video from this link. It might be private or unsupported.");
    }
}

async function fetchSafe(initialUrl, options = {}, redirectCount = 0) {
  if (redirectCount > MAX_REDIRECTS) throw new Error("Too many redirects.");
  const url = await validateUrl(initialUrl);
  
  const mergedHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "*/*",
      ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    headers: mergedHeaders,
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

app.get("/health", (req, res) => res.json({ ok: true, service: "QuickSave", version: "2.4" }));

app.post("/api/inspect", async (req, res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, message: "Too many requests. Please wait." });

  try {
    const rawUrl = req.body?.url;
    let url = await validateUrl(rawUrl);
    let targetUrl = url.toString();
    let extractedTitle = null;
    let customHeaders = {};
  
    if (isSocialMediaUrl(targetUrl)) {
        const cacheKey = targetUrl;
        if (extractionCache.has(cacheKey)) {
            const cached = extractionCache.get(cacheKey);
            targetUrl = cached.url;
            extractedTitle = cached.title;
            customHeaders = cached.headers;
        } else {
            const extractedData = await extractDirectVideoUrl(targetUrl);
            extractionCache.set(cacheKey, extractedData);
            setTimeout(() => extractionCache.delete(cacheKey), 10 * 60 * 1000);
            
            targetUrl = extractedData.url;
            extractedTitle = extractedData.title;
            customHeaders = extractedData.headers;
        }
    }
  
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, INSPECT_TIMEOUT);
  
    try {
      let response;
      try {
        response = await fetchSafe(targetUrl, { method: "HEAD", signal: controller.signal, headers: customHeaders });
      } catch {
        response = null;
      }
  
      let contentType = response ? getContentType(response) : "";
      let contentLength = response ? Number(response.headers.get("content-length") || 0) : 0;
  
      if (!response || !response.ok || !contentType) {
        response = await fetchSafe(targetUrl, {
          method: "GET",
          headers: { ...customHeaders, Range: "bytes=0-0" },
          signal: controller.signal
        });
        contentType = getContentType(response);
        contentLength = Number(response.headers.get("content-length") || 0);
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
        originalUrl: url.toString(),
        contentType: contentType || "video/mp4",
        size: contentLength || null,
        filename: filenameFromUrl(targetUrl, contentType, extractedTitle)
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Inspect error:", error);
    return res.status(400).json({ ok: false, type: "error", message: error.message || "Unable to process this URL." });
  }
});

app.get("/api/download", async (req, res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"] || req.socket.remoteAddress);
  if (!checkRateLimit(ip)) return res.status(429).json({ ok: false, message: "Too many requests. Please wait." });
  if (!acquireDownload(ip)) return res.status(429).json({ ok: false, message: "Too many downloads are running. Please wait." });

  try {
    const rawUrl = req.query.url; 
    let targetUrl = (await validateUrl(rawUrl)).toString();
    let extractedTitle = null;
    let customHeaders = {};

    if (isSocialMediaUrl(targetUrl)) {
        const cacheKey = targetUrl;
        if (extractionCache.has(cacheKey)) {
            const cached = extractionCache.get(cacheKey);
            targetUrl = cached.url;
            extractedTitle = cached.title;
            customHeaders = cached.headers;
        } else {
            const extractedData = await extractDirectVideoUrl(targetUrl);
            targetUrl = extractedData.url;
            extractedTitle = extractedData.title;
            customHeaders = extractedData.headers;
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, DOWNLOAD_TIMEOUT);

    // FIX 3: Agar mobile phone screen lock hone se connection drop kare, toh process ko safely kill karo.
    req.on("close", () => {
        controller.abort();
        clearTimeout(timer);
    });

    try {
      const response = await fetchSafe(targetUrl, { 
          method: "GET", 
          signal: controller.signal, 
          headers: customHeaders 
      });
      
      if (!response.ok) return res.status(400).json({ ok: false, message: `Media server returned HTTP ${response.status}.` });

      const contentType = getContentType(response) || "video/mp4";
      const contentLength = Number(response.headers.get("content-length") || 0);

      if (contentLength && contentLength > MAX_BYTES) {
        return res.status(413).json({ ok: false, message: "This file is larger than the 250 MB limit." });
      }

      const filename = filenameFromUrl(targetUrl, contentType, extractedTitle);

      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Cache-Control", "no-store");
      if (contentLength) res.setHeader("Content-Length", String(contentLength));

      let total = 0;
      if (!response.body) throw new Error("Media stream unavailable.");

      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > MAX_BYTES) {
          controller.abort();
          if (!res.headersSent) return res.status(413).json({ ok: false, message: "Download exceeded the limit." });
          res.destroy();
          return;
        }
        if (!res.write(chunk)) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
      res.end();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.error("Download error:", error);
    if (!res.headersSent) {
      return res.status(400).json({
        ok: false,
        message: error.name === "AbortError" ? "Download timed out." : error.message || "Unable to download this media."
      });
    }
    res.destroy();
  } finally {
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
