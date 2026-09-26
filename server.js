const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const { Readable, Writable } = require("stream");
const { pipeline } = require("stream/promises");
const { execFile } = require("child_process");
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
const COOKIES_FILE = path.join(__dirname, "cookies.txt");

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
  return a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||a===0;
}
function isPrivateIPv6(ip) {
  const v = ip.toLowerCase();
  return v==="::1"||v==="::"||v.startsWith("fc")||v.startsWith("fd")||v.startsWith("fe80:");
}
async function isBlockedHost(hostname) {
  const host = hostname.toLowerCase();
  if (
    host==="localhost"||host.endsWith(".localhost")||
    host==="local"||host==="metadata.google.internal"
  ) return true;
  const type = net.isIP(host);
  if (type===4) return isPrivateIPv4(host);
  if (type===6) return isPrivateIPv6(host);
  try {
    const records = await dns.lookup(host,{all:true,verbatim:true});
    for (const r of records) {
      if (r.family===4&&isPrivateIPv4(r.address)) return true;
      if (r.family===6&&isPrivateIPv6(r.address)) return true;
    }
    return false;
  } catch { return true; }
}
async function validateUrl(rawUrl) {
  if (!rawUrl||typeof rawUrl!=="string") throw new Error("URL is required.");
  let url;
  try { url = new URL(rawUrl.trim()); }
  catch { throw new Error("Please enter a valid URL."); }
  if (!["http:","https:"].includes(url.protocol))
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
  if (!r||now-r.start>RATE_WINDOW) { r={start:now,count:0}; rateMap.set(ip,r); }
  r.count++;
  return r.count<=RATE_LIMIT;
}
function acquireDownload(ip) {
  const c = activeMap.get(ip)||0;
  if (c>=MAX_ACTIVE_PER_IP) return false;
  activeMap.set(ip,c+1); return true;
}
function releaseDownload(ip) {
  const c = activeMap.get(ip)||0;
  if (c<=1) activeMap.delete(ip); else activeMap.set(ip,c-1);
}

/* ════════════════════════════════════════
   HELPERS
════════════════════════════════════════ */
function filenameFromUrl(url, contentType="", customTitle=null) {
  const ext = contentType.includes("video") ? ".mp4"
    : contentType.includes("audio") ? ".mp3"
    : contentType.includes("image") ? ".jpg"
    : ".mp4";
  if (customTitle) {
    let t = customTitle.replace(/[^a-zA-Z0-9]/g,"_").replace(/_+/g,"_").slice(0,40);
    if (t.endsWith("_")) t = t.slice(0,-1);
    return `QuickSave_${t||"Media"}${ext}`;
  }
  let n = "";
  try { n = decodeURIComponent(path.basename(new URL(url).pathname)); } catch {}
  n = n.replace(/[^a-zA-Z0-9._-]/g,"_");
  return (!n||n==="."||n.length<2) ? `QuickSave_Media${ext}` : n.slice(0,50);
}
function getRawContentType(r) {
  return (r.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
}
function isValidMediaType(ct) {
  if (!ct) return false;
  if (ct.includes("json")||ct.includes("html")||ct.includes("text/")||ct.includes("xml")) return false;
  return ct.includes("video/")||ct.includes("audio/")||ct.includes("image/")||ct==="application/octet-stream";
}

/* ════════════════════════════════════════
   PLATFORM DETECTION
   Sirf Instagram, Facebook, Twitter
════════════════════════════════════════ */
function getPlatform(urlStr) {
  try {
    const h = new URL(urlStr).hostname.replace(/^www\./,"");
    if (h.includes("instagram.com"))                    return "instagram";
    if (h.includes("facebook.com")||h.includes("fb.watch")) return "facebook";
    if (h.includes("twitter.com")||h.includes("x.com")) return "twitter";
    return null;
  } catch { return null; }
}

function isSupportedUrl(urlStr) {
  try {
    const h = new URL(urlStr).hostname.replace(/^www\./,"");
    // CDN URLs supported nahi
    if (
      h.includes("cdninstagram.com")||h.includes("fbcdn.net")||
      h.includes("twimg.com")
    ) return false;
    return [
      "instagram.com",
      "facebook.com","fb.watch",
      "twitter.com","x.com"
    ].some(p=>h.includes(p));
  } catch { return false; }
}

/* ════════════════════════════════════════
   CACHE
════════════════════════════════════════ */
function makeDownloadId() { return crypto.randomBytes(12).toString("hex"); }

function cacheExtraction(originalUrl, extractedData) {
  const downloadId = makeDownloadId();
  const payload = {...extractedData, originalUrl, downloadId, createdAt:Date.now()};
  extractionCache.set(originalUrl,       payload);
  extractionCache.set(extractedData.url, payload);
  extractionCache.set(downloadId,        payload);
  setTimeout(()=>{
    extractionCache.delete(originalUrl);
    extractionCache.delete(extractedData.url);
    extractionCache.delete(downloadId);
  }, 10*60*1000);
  return payload;
}

/* ════════════════════════════════════════
   yt-dlp BINARY
════════════════════════════════════════ */
function getYtdlpBinary() {
  const locations = [
    "/usr/local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    process.env.YTDLP_PATH,
  ].filter(Boolean);

  for (const loc of locations) {
    try { if (fs.existsSync(loc)) return loc; } catch {}
  }
  try {
    const pkg = require("youtube-dl-exec");
    const binPath = pkg.path||pkg.binaryPath;
    if (binPath&&fs.existsSync(binPath)) return binPath;
  } catch {}
  return "yt-dlp";
}

const YTDLP_BINARY = getYtdlpBinary();

/* ════════════════════════════════════════
   yt-dlp RUNNER
════════════════════════════════════════ */
function runYtdlp(url, extraArgs, timeoutMs=60000) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      "--dump-single-json",
      "--no-check-certificates",
      "--no-warnings",
      "--no-playlist",
      "--socket-timeout","20",
      "--retries","2",
      "--no-cache-dir",
      ...extraArgs
    ];

    if (fs.existsSync(COOKIES_FILE)) {
      args.push("--cookies", COOKIES_FILE);
    }

    execFile(YTDLP_BINARY, args, {
      timeout: timeoutMs,
      maxBuffer: 50*1024*1024,
      env: {...process.env, PYTHONIOENCODING:"utf-8"}
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr||error.message||"").trim()));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error("Failed to parse yt-dlp output")); }
    });
  });
}

/* ════════════════════════════════════════
   OUTPUT PARSER
════════════════════════════════════════ */
function parseYtdlpOutput(output) {
  if (!output) return null;
  let directUrl=null, headers={};

  if (output.url&&output.url.startsWith("http")) {
    directUrl = output.url;
    headers   = {...(output.http_headers||{})};
  }
  if (!directUrl&&output.requested_formats?.length) {
    const vf = output.requested_formats.find(
      f=>f.url&&f.url.startsWith("http")&&f.vcodec&&f.vcodec!=="none"
    );
    if (vf) { directUrl=vf.url; headers={...(vf.http_headers||{})}; }
  }
  if (!directUrl&&output.formats?.length) {
    const valid = output.formats
      .filter(f=>f.url&&f.url.startsWith("http"))
      .reverse();
    const best =
      valid.find(f=>f.vcodec!=="none"&&f.acodec!=="none")||
      valid.find(f=>f.vcodec!=="none")||
      valid[0];
    if (best) { directUrl=best.url; headers={...(best.http_headers||{})}; }
  }

  if (!directUrl) return null;
  delete headers["Host"]; delete headers["host"];

  return {
    url:       directUrl,
    title:     output.title||output.id||"Video",
    thumbnail: output.thumbnail||null,
    headers
  };
}

/* ════════════════════════════════════════
   INSTAGRAM EXTRACTOR
════════════════════════════════════════ */
async function extractInstagram(url) {
  console.log("[instagram] Extracting:", url.slice(0,70));

  const strategies = [
    {
      name: "chrome-desktop",
      args: [
        "-f","best",
        "--add-header","User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "--add-header","Accept-Language:en-US,en;q=0.9",
        "--add-header","Referer:https://www.instagram.com/",
      ]
    },
    {
      name: "android-app",
      args: [
        "-f","best",
        "--add-header","User-Agent:Instagram 219.0.0.12.117 Android (30/11; 420dpi; 1080x2154; samsung; SM-G991B; o1s; exynos2100)",
        "--add-header","Accept-Language:en-US",
      ]
    },
    {
      name: "no-header",
      args: ["-f","best"]
    }
  ];

  for (const s of strategies) {
    try {
      console.log(`[instagram] Trying: ${s.name}`);
      const output = await runYtdlp(url, s.args, 50000);
      const result = parseYtdlpOutput(output);
      if (result&&result.url) {
        console.log(`[instagram] ✓ Success: ${s.name}`);
        return result;
      }
    } catch (e) {
      console.log(`[instagram] ✗ ${s.name}:`, e.message.slice(0,80));
    }
  }

  throw new Error("Instagram video could not be extracted. It may be private or deleted.");
}

/* ════════════════════════════════════════
   FACEBOOK EXTRACTOR
════════════════════════════════════════ */
async function extractFacebook(url) {
  console.log("[facebook] Extracting:", url.slice(0,70));

  const strategies = [
    {
      name: "chrome-desktop",
      args: [
        "-f","best",
        "--add-header","User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "--add-header","Accept-Language:en-US,en;q=0.9",
      ]
    },
    {
      name: "mobile",
      args: [
        "-f","best",
        "--add-header","User-Agent:Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
      ]
    },
    {
      name: "no-header",
      args: ["-f","best"]
    }
  ];

  for (const s of strategies) {
    try {
      console.log(`[facebook] Trying: ${s.name}`);
      const output = await runYtdlp(url, s.args, 50000);
      const result = parseYtdlpOutput(output);
      if (result&&result.url) {
        console.log(`[facebook] ✓ Success: ${s.name}`);
        return result;
      }
    } catch (e) {
      console.log(`[facebook] ✗ ${s.name}:`, e.message.slice(0,80));
    }
  }

  throw new Error("Facebook video could not be extracted. It may be private or restricted.");
}

/* ════════════════════════════════════════
   TWITTER / X EXTRACTOR
════════════════════════════════════════ */
async function extractTwitter(url) {
  console.log("[twitter] Extracting:", url.slice(0,70));

  const strategies = [
    {
      name: "chrome-desktop",
      args: [
        "-f","best[ext=mp4]/best",
        "--add-header","User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ]
    },
    {
      name: "no-header",
      args: ["-f","best[ext=mp4]/best"]
    }
  ];

  for (const s of strategies) {
    try {
      console.log(`[twitter] Trying: ${s.name}`);
      const output = await runYtdlp(url, s.args, 50000);
      const result = parseYtdlpOutput(output);
      if (result&&result.url) {
        console.log(`[twitter] ✓ Success: ${s.name}`);
        return result;
      }
    } catch (e) {
      console.log(`[twitter] ✗ ${s.name}:`, e.message.slice(0,80));
    }
  }

  throw new Error("Twitter/X video could not be extracted. It may be private or restricted.");
}

/* ════════════════════════════════════════
   MAIN EXTRACTOR
════════════════════════════════════════ */
async function extractDirectVideoUrl(pageUrl) {
  const platform = getPlatform(pageUrl);
  console.log("[extract] Platform:", platform, "| URL:", pageUrl.slice(0,70));

  if (!platform) {
    throw new Error("Only Instagram, Facebook, and Twitter/X links are supported.");
  }

  if (platform==="instagram") return extractInstagram(pageUrl);
  if (platform==="facebook")  return extractFacebook(pageUrl);
  if (platform==="twitter")   return extractTwitter(pageUrl);

  throw new Error("Unsupported platform.");
}

/* ════════════════════════════════════════
   FETCH HELPERS
════════════════════════════════════════ */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchSafe(initialUrl, options={}, redirectCount=0) {
  if (redirectCount>MAX_REDIRECTS) throw new Error("Too many redirects.");
  const url = await validateUrl(initialUrl);
  const h = {"User-Agent":UA,"Accept":"*/*",...(options.headers||{})};
  delete h["Host"]; delete h["host"];
  const response = await fetch(url,{
    ...options, redirect:"manual", headers:h, signal:options.signal
  });
  if ([301,302,303,307,308].includes(response.status)) {
    const loc = response.headers.get("location");
    if (!loc) throw new Error("Redirect location missing.");
    return fetchSafe(new URL(loc,url).toString(),options,redirectCount+1);
  }
  return response;
}

async function fetchCDN(targetUrl, headers, signal) {
  const h = {
    "User-Agent":UA, "Accept":"*/*", "Accept-Encoding":"identity",
    ...headers
  };
  delete h["Host"]; delete h["host"];
  delete h["Range"]; delete h["range"];
  return fetch(targetUrl,{method:"GET",headers:h,redirect:"follow",signal});
}

/* ════════════════════════════════════════
   STREAM
════════════════════════════════════════ */
async function streamToResponse(response, res, controller, startTime) {
  const contentLength = Number(response.headers.get("content-length")||0);
  if (contentLength&&contentLength>MAX_BYTES)
    throw Object.assign(new Error("File exceeds 250 MB limit."),{status:413});
  if (!response.body) throw new Error("Media stream unavailable.");
  if (contentLength) res.setHeader("Content-Length",String(contentLength));

  const nodeStream = Readable.fromWeb
    ? Readable.fromWeb(response.body)
    : response.body;

  let total=0, limitExceeded=false;

  const guard = new Writable({
    highWaterMark: 512*1024,
    write(chunk,_enc,cb) {
      if (limitExceeded) return cb();
      total+=chunk.length;
      if (total>MAX_BYTES) {
        limitExceeded=true; controller.abort(); res.destroy();
        return cb(new Error("Size limit exceeded"));
      }
      if (!res.write(chunk)) res.once("drain",cb); else cb();
    },
    final(cb) {
      if (!limitExceeded) {
        res.end();
        const secs=((Date.now()-startTime)/1000).toFixed(1);
        const mbps=(total/1024/1024/parseFloat(secs)).toFixed(2);
        console.log(`[dl] done ${(total/1024/1024).toFixed(1)}MB in ${secs}s @ ${mbps}MB/s`);
      }
      cb();
    }
  });

  try { await pipeline(nodeStream,guard); }
  catch(e) { if (!limitExceeded&&e.name!=="AbortError") throw e; }
}

/* ════════════════════════════════════════
   ROUTES
════════════════════════════════════════ */
app.get("/health", (_req,res) => res.json({
  ok:      true,
  service: "QuickSave",
  version: "6.0",
  platforms: ["instagram","facebook","twitter"],
  ytdlp:   YTDLP_BINARY,
  cookies: fs.existsSync(COOKIES_FILE)
}));

app.get("/share", (req,res) => {
  const shared = (req.query.url||req.query.text||req.query.title||"").trim();
  return shared
    ? res.redirect(302,`/?url=${encodeURIComponent(shared)}`)
    : res.redirect(302,"/");
});

/* ── INSPECT ── */
app.post("/api/inspect", async (req,res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"]||req.socket.remoteAddress);
  if (!checkRateLimit(ip))
    return res.status(429).json({ok:false,message:"Too many requests. Please wait."});

  try {
    const rawUrl = req.body?.url;
    let urlObj      = await validateUrl(rawUrl);
    let targetUrl   = urlObj.toString();
    let extractedTitle=null, customHeaders={}, useCDNFetch=false;
    let downloadId=null, thumbnail=null;

    // Platform check
    if (!isSupportedUrl(targetUrl)) {
      return res.status(400).json({
        ok:      false,
        type:    "unsupported",
        message: "Only Instagram, Facebook, and Twitter/X links are supported."
      });
    }

    if (extractionCache.has(targetUrl)) {
      const c = extractionCache.get(targetUrl);
      targetUrl=c.url; extractedTitle=c.title; thumbnail=c.thumbnail;
      customHeaders=c.headers||{}; downloadId=c.downloadId; useCDNFetch=true;
      console.log("[inspect] cache hit");

    } else {
      console.log("[inspect] Extracting:", targetUrl.slice(0,70));
      const data = await extractDirectVideoUrl(targetUrl);
      const c    = cacheExtraction(targetUrl, data);
      targetUrl=c.url; extractedTitle=c.title; thumbnail=c.thumbnail;
      customHeaders=c.headers||{}; downloadId=c.downloadId; useCDNFetch=true;
    }

    const controller = new AbortController();
    const timer      = setTimeout(()=>controller.abort(), INSPECT_TIMEOUT);

    try {
      let response=null;
      try {
        const h = {"User-Agent":UA,"Accept":"*/*",...customHeaders};
        delete h["Host"]; delete h["host"]; delete h["Range"]; delete h["range"];
        response = await fetch(targetUrl,{
          method:"HEAD", headers:h, redirect:"follow", signal:controller.signal
        });
      } catch { response=null; }

      let contentType   = response ? getRawContentType(response) : "";
      let contentLength = response ? Number(response.headers.get("content-length")||0) : 0;

      if (!response||!response.ok||!isValidMediaType(contentType)) {
        response = await fetchCDN(targetUrl, customHeaders, controller.signal);
        contentType   = getRawContentType(response);
        contentLength = Number(response.headers.get("content-length")||0);
        try { await response.body?.cancel(); } catch {}
      }

      if (contentType==="application/octet-stream") contentType="video/mp4";

      if (!response.ok)
        return res.status(400).json({
          ok:false, type:"error",
          message:`Server returned HTTP ${response.status}.`
        });

      if (!isValidMediaType(contentType))
        return res.status(400).json({
          ok:false, type:"unsupported",
          message:"This URL does not contain a valid media file."
        });

      if (contentLength&&contentLength>MAX_BYTES)
        return res.status(400).json({
          ok:false, type:"too-large",
          message:"File is larger than 250 MB."
        });

      const filename = filenameFromUrl(targetUrl, contentType, extractedTitle);
      console.log("[inspect] ok:", filename, contentType, contentLength);

      return res.json({
        ok:true, type:"media", id:downloadId,
        downloadUrl:`/api/download?id=${downloadId}`,
        directUrl:targetUrl, url:targetUrl,
        originalUrl:urlObj.toString(),
        contentType:contentType||"video/mp4",
        size:contentLength||null,
        filename, thumbnail
      });

    } finally { clearTimeout(timer); }

  } catch(e) {
    console.error("[inspect] error:", e.message);
    return res.status(400).json({
      ok:false, type:"error",
      message: e.message||"Unable to process this URL."
    });
  }
});

/* ── DOWNLOAD ── */
app.get("/api/download", async (req,res) => {
  const ip = cleanIp(req.headers["x-forwarded-for"]||req.socket.remoteAddress);
  if (!checkRateLimit(ip))
    return res.status(429).json({ok:false,message:"Too many requests."});
  if (!acquireDownload(ip))
    return res.status(429).json({ok:false,message:"Too many active downloads."});

  const startTime = Date.now();
  try {
    let targetUrl=null, extractedTitle=null, customHeaders={}, originalUrl=null;
    const idParam = req.query.id ? String(req.query.id).trim() : null;

    if (idParam) {
      const cached = extractionCache.get(idParam);
      if (!cached)
        return res.status(410).json({
          ok:false,
          message:"Link expired. Please click 'Get media' again."
        });
      targetUrl=cached.url; extractedTitle=cached.title;
      customHeaders=cached.headers||{}; originalUrl=cached.originalUrl;

    } else {
      let rawUrl = req.query.url;
      if (!rawUrl)
        return res.status(400).json({ok:false, message:"id or url required."});
      for(let i=0;i<2;i++){
        try{const d=decodeURIComponent(rawUrl);if(d===rawUrl)break;rawUrl=d;}catch{break;}
      }
      if (extractionCache.has(rawUrl)) {
        const c = extractionCache.get(rawUrl);
        targetUrl=c.url; extractedTitle=c.title;
        customHeaders=c.headers||{}; originalUrl=c.originalUrl;
      } else {
        const validated = await validateUrl(rawUrl);
        targetUrl = validated.toString();
        if (isSupportedUrl(targetUrl)) {
          originalUrl = targetUrl;
          const data = await extractDirectVideoUrl(targetUrl);
          const c    = cacheExtraction(targetUrl, data);
          targetUrl=c.url; extractedTitle=c.title; customHeaders=c.headers||{};
        }
      }
    }

    const controller = new AbortController();
    const timer      = setTimeout(()=>controller.abort(), DOWNLOAD_TIMEOUT);
    req.on("close",()=>{ controller.abort(); clearTimeout(timer); });

    try {
      let response    = await fetchCDN(targetUrl, customHeaders, controller.signal);
      let contentType = getRawContentType(response);
      if (contentType==="application/octet-stream") contentType="video/mp4";

      // Agar CDN response bad hai to re-extract karo
      if (!response.ok||!isValidMediaType(contentType)) {
        if (originalUrl&&isSupportedUrl(originalUrl)) {
          try {
            console.log("[dl] Re-extracting:", originalUrl.slice(0,70));
            const fresh = await extractDirectVideoUrl(originalUrl);
            const c     = cacheExtraction(originalUrl, fresh);
            targetUrl=c.url; customHeaders=c.headers||{}; extractedTitle=fresh.title;
            response    = await fetchCDN(targetUrl, customHeaders, controller.signal);
            contentType = getRawContentType(response);
            if (contentType==="application/octet-stream") contentType="video/mp4";
          } catch {
            return res.status(502).json({
              ok:false,
              message:"Media expired. Please click 'Get media' again."
            });
          }
        }
        if (!response.ok||!isValidMediaType(contentType))
          return res.status(502).json({
            ok:false,
            message:`Media fetch failed (${response.status}).`
          });
      }

      const filename        = filenameFromUrl(targetUrl, contentType, extractedTitle);
      const safeFilename    = filename.replace(/[\r\n"']/g,"");
      const encodedFilename = encodeURIComponent(safeFilename);
      const wantInline      = req.query.inline==="1";

      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition",
        wantInline
          ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
          : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
      );
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Accept-Ranges","none");
      res.setHeader("X-Content-Type-Options","nosniff");

      await streamToResponse(response, res, controller, startTime);

    } finally { clearTimeout(timer); }

  } catch(e) {
    console.error("[dl] error:", e.message);
    if (!res.headersSent)
      res.status(e.status||400).json({
        ok:false,
        message: e.name==="AbortError"
          ? "Download timed out."
          : e.message||"Download failed."
      });
    else res.destroy();
  } finally { releaseDownload(ip); }
});

/* ════════════════════════════════════════
   STATIC + FALLBACK
════════════════════════════════════════ */
app.use(express.static(PUBLIC_DIR,{extensions:["html"]}));
app.use((_req,res)=>res.sendFile(path.join(PUBLIC_DIR,"index.html")));
app.use((err,_req,res,next)=>{
  console.error("Server error:",err);
  if (res.headersSent) return next(err);
  res.status(500).json({ok:false,message:"Internal server error."});
});

/* ════════════════════════════════════════
   START
════════════════════════════════════════ */
const server = app.listen(PORT,"0.0.0.0",()=>
  console.log(`QuickSave v6.0 running on port ${PORT}`)
);
function shutdown(sig) {
  console.log(sig+" received");
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT", ()=>shutdown("SIGINT"));
process.on("uncaughtException", e=>console.error("Uncaught:",e));
process.on("unhandledRejection",e=>console.error("Unhandled:",e));
