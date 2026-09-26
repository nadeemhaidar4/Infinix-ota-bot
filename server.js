const express = require("express");
const dns = require("dns").promises;
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const youtubedl = require("youtube-dl-exec");

const app = express();

const PORT = process.env.PORT || 10000;
const MAX_BYTES = 250 * 1024 * 1024;
const INSPECT_TIMEOUT = 30000;
const DOWNLOAD_TIMEOUT = 300000;
const MAX_REDIRECTS = 4;
const MAX_ACTIVE_PER_IP = 3;
const RATE_WINDOW = 60 * 1000;
const RATE_LIMIT = 20;
const PUBLIC_DIR = path.join(__dirname, "public");

const ALLOWED_MIME = new Set([
  "video/mp4","video/webm","video/quicktime","video/x-matroska",
  "audio/mpeg","audio/mp4","audio/wav","audio/webm",
  "image/jpeg","image/png","image/webp","image/gif",
  "application/octet-stream"
]);

const rateMap    = new Map();
const activeMap  = new Map();
const extractionCache = new Map();

app.use(express.json({ limit: "100kb" }));

/* ── IP helpers ── */
function cleanIp(ip) {
  if (!ip) return "unknown";
  if (ip.includes(",")) ip = ip.split(",")[0].trim();
  if (ip.startsWith("::ffff:")) ip = ip.substring(7);
  return ip;
}
function isPrivateIPv4(ip) {
  const p = ip.split(".").map(Number);
  if (p.length!==4||p.some(Number.isNaN)) return false;
  const [a,b]=p;
  return a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||a===0;
}
function isPrivateIPv6(ip) {
  const v=ip.toLowerCase();
  return v==="::1"||v==="::"||v.startsWith("fc")||v.startsWith("fd")||v.startsWith("fe80:");
}
async function isBlockedHost(hostname) {
  const host=hostname.toLowerCase();
  if (host==="localhost"||host.endsWith(".localhost")||host==="local"||host==="metadata.google.internal") return true;
  const type=net.isIP(host);
  if (type===4) return isPrivateIPv4(host);
  if (type===6) return isPrivateIPv6(host);
  try {
    const records=await dns.lookup(host,{all:true,verbatim:true});
    for (const r of records){
      if (r.family===4&&isPrivateIPv4(r.address)) return true;
      if (r.family===6&&isPrivateIPv6(r.address)) return true;
    }
    return false;
  } catch { return true; }
}
async function validateUrl(rawUrl) {
  if (!rawUrl||typeof rawUrl!=="string") throw new Error("URL is required.");
  let url;
  try { url=new URL(rawUrl.trim()); } catch { throw new Error("Please enter a valid URL."); }
  if (!["http:","https:"].includes(url.protocol)) throw new Error("Only HTTP and HTTPS URLs are supported.");
  if (await isBlockedHost(url.hostname)) throw new Error("This URL cannot be accessed safely.");
  return url;
}

/* ── rate / concurrency ── */
function checkRateLimit(ip) {
  const now=Date.now();
  let r=rateMap.get(ip);
  if (!r||now-r.start>RATE_WINDOW){r={start:now,count:0};rateMap.set(ip,r);}
  r.count++;
  return r.count<=RATE_LIMIT;
}
function acquireDownload(ip) {
  const c=activeMap.get(ip)||0;
  if (c>=MAX_ACTIVE_PER_IP) return false;
  activeMap.set(ip,c+1); return true;
}
function releaseDownload(ip) {
  const c=activeMap.get(ip)||0;
  if (c<=1) activeMap.delete(ip); else activeMap.set(ip,c-1);
}

/* ── filename ── */
function filenameFromUrl(url, contentType="", customTitle=null) {
  const ext = contentType.includes("video") ? ".mp4"
             : contentType.includes("audio") ? ".mp3"
             : contentType.includes("image") ? ".jpg"
             : ".mp4";
  if (customTitle) {
    let t=customTitle.replace(/[^a-zA-Z0-9]/g,"_").replace(/_+/g,"_").slice(0,40);
    if (t.endsWith("_")) t=t.slice(0,-1);
    return `QuickSave_${t||"Media"}${ext}`;
  }
  let n="";
  try { n=decodeURIComponent(path.basename(new URL(url).pathname)); } catch {}
  n=n.replace(/[^a-zA-Z0-9._-]/g,"_");
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

/* ── social media detect ── */
function isSocialMediaUrl(urlStr) {
  try {
    const h=new URL(urlStr).hostname.replace(/^www\./,"");
    if (h.includes("cdninstagram.com")||h.includes("fbcdn.net")||
        h.includes("googlevideo.com")||h.includes("tiktokcdn.com")||
        h.includes("twimg.com")) return false;
    return ["instagram.com","facebook.com","tiktok.com","youtube.com",
            "youtu.be","twitter.com","x.com","fb.watch"].some(p=>h.includes(p));
  } catch { return false; }
}

/* ── cache ── */
function makeDownloadId() { return crypto.randomBytes(12).toString("hex"); }

function cacheExtraction(originalUrl, extractedData) {
  const downloadId=makeDownloadId();
  const payload={...extractedData, originalUrl, downloadId, createdAt:Date.now()};
  extractionCache.set(originalUrl, payload);
  extractionCache.set(extractedData.url, payload);
  extractionCache.set(downloadId, payload);
  setTimeout(()=>{
    extractionCache.delete(originalUrl);
    extractionCache.delete(extractedData.url);
    extractionCache.delete(downloadId);
  }, 10*60*1000);
  return payload;
}

/* ── yt-dlp extractor ── */
async function extractDirectVideoUrl(url) {
  try {
    const output=await youtubedl(url,{
      dumpSingleJson:true,noCheckCertificates:true,noWarnings:true,format:"b"
    });
    if (!output) throw new Error("No output.");
    let directUrl=output.url;
    let headers={...(output.http_headers||{})};
    delete headers["Host"]; delete headers["host"];
    if (!directUrl&&output.requested_formats?.length) {
      directUrl=output.requested_formats[0].url;
      headers={...(output.requested_formats[0].http_headers||{})};
      delete headers["Host"]; delete headers["host"];
    }
    if (!directUrl) throw new Error("Could not extract stream URL.");
    return {url:directUrl, title:output.title||"Video", headers};
  } catch (e) {
    console.error("Extractor error:", e.message);
    throw new Error("Unable to extract video. It might be private or unsupported.");
  }
}

/* ── fetch helpers ── */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

async function fetchSafe(initialUrl, options={}, redirectCount=0) {
  if (redirectCount>MAX_REDIRECTS) throw new Error("Too many redirects.");
  const url=await validateUrl(initialUrl);
  const h={"User-Agent":UA,"Accept":"*/*",...(options.headers||{})};
  delete h["Host"]; delete h["host"];
  const response=await fetch(url,{...options,redirect:"manual",headers:h,signal:options.signal});
  if ([301,302,303,307,308].includes(response.status)) {
    const loc=response.headers.get("location");
    if (!loc) throw new Error("Redirect location missing.");
    return fetchSafe(new URL(loc,url).toString(),options,redirectCount+1);
  }
  return response;
}

/* CDN fetch - NO Range headers, fresh GET only */
async function fetchCDN(targetUrl, headers, signal) {
  const h={
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Encoding": "identity", // Compression disable - faster streaming
    ...headers
  };
  delete h["Host"]; delete h["host"];
  delete h["Range"]; delete h["range"]; // Range NEVER to CDN
  
  return fetch(targetUrl, {
    method: "GET",
    headers: h,
    redirect: "follow",
    signal,
    // Node.js fetch high watermark for faster streaming
    highWaterMark: 1024 * 1024 // 1MB chunks
  });
}

/* ── health ── */
app.get("/health",(_req,res)=>res.json({ok:true,service:"QuickSave",version:"3.1"}));

/* ══════════════════════════════════════════
   INSPECT
══════════════════════════════════════════ */
app.post("/api/inspect", async (req,res) => {
  const ip=cleanIp(req.headers["x-forwarded-for"]||req.socket.remoteAddress);
  if (!checkRateLimit(ip)) return res.status(429).json({ok:false,message:"Too many requests."});

  try {
    const rawUrl=req.body?.url;
    let url=await validateUrl(rawUrl);
    let targetUrl=url.toString();
    let extractedTitle=null, customHeaders={}, useCDNFetch=false, downloadId=null;

    if (extractionCache.has(targetUrl)) {
      const c=extractionCache.get(targetUrl);
      targetUrl=c.url; extractedTitle=c.title;
      customHeaders=c.headers||{}; downloadId=c.downloadId; useCDNFetch=true;
    } else if (isSocialMediaUrl(targetUrl)) {
      const data=await extractDirectVideoUrl(targetUrl);
      const c=cacheExtraction(targetUrl,data);
      targetUrl=c.url; extractedTitle=c.title;
      customHeaders=c.headers||{}; downloadId=c.downloadId; useCDNFetch=true;
    } else {
      const c=cacheExtraction(targetUrl,{url:targetUrl,title:null,headers:{}});
      downloadId=c.downloadId;
    }

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),INSPECT_TIMEOUT);

    try {
      let response=null;
      try {
        const h={"User-Agent":UA,"Accept":"*/*",...customHeaders};
        delete h["Host"]; delete h["host"];
        delete h["Range"]; delete h["range"];
        response=await fetch(targetUrl,{method:"HEAD",headers:h,redirect:"follow",signal:controller.signal});
      } catch { response=null; }

      let contentType=response?getRawContentType(response):"";
      let contentLength=response?Number(response.headers.get("content-length")||0):0;

      if (!response||!response.ok||!isValidMediaType(contentType)) {
        if (useCDNFetch) {
          response=await fetchCDN(targetUrl,customHeaders,controller.signal);
        } else {
          response=await fetchSafe(targetUrl,{method:"GET",signal:controller.signal});
        }
        contentType=getRawContentType(response);
        contentLength=Number(response.headers.get("content-length")||0);
        try { await response.body?.cancel(); } catch {}
      }

      if (!response.ok)
        return res.status(400).json({ok:false,type:"error",
          message:`Media server returned HTTP ${response.status}.`});

      if (!isValidMediaType(contentType))
        return res.status(400).json({ok:false,type:"unsupported",
          message:"This URL does not return a valid media file."});

      if (contentLength&&contentLength>MAX_BYTES)
        return res.status(400).json({ok:false,type:"too-large",
          message:"File is larger than 250 MB."});

      const filename=filenameFromUrl(targetUrl, contentType, extractedTitle);

      return res.json({
        ok:true, type:"media",
        id: downloadId,
        downloadUrl:`/api/download?id=${downloadId}`,
        url: targetUrl,
        originalUrl: url.toString(),
        contentType: contentType||"video/mp4",
        size: contentLength||null,
        filename
      });
    } finally { clearTimeout(timer); }

  } catch (e) {
    console.error("Inspect error:", e);
    return res.status(400).json({ok:false,type:"error",
      message:e.message||"Unable to process this URL."});
  }
});

/* ══════════════════════════════════════════
   DOWNLOAD — SPEED OPTIMIZED
══════════════════════════════════════════ */
app.get("/api/download", async (req,res) => {
  const ip=cleanIp(req.headers["x-forwarded-for"]||req.socket.remoteAddress);
  if (!checkRateLimit(ip))  return res.status(429).json({ok:false,message:"Too many requests."});
  if (!acquireDownload(ip)) return res.status(429).json({ok:false,message:"Too many active downloads."});

  const startTime = Date.now();

  try {
    let targetUrl=null, extractedTitle=null, customHeaders={};
    let originalSocialUrl=null;

    const idParam=req.query.id?String(req.query.id).trim():null;

    if (idParam) {
      const cached=extractionCache.get(idParam);
      if (!cached) {
        return res.status(410).json({ok:false,
          message:"Link expired. Please tap 'Get media' again."});
      }
      targetUrl=cached.url;
      extractedTitle=cached.title;
      customHeaders=cached.headers||{};
      originalSocialUrl=cached.originalUrl;
      console.log("[dl] id=",idParam,"url=",targetUrl.slice(0,80));

    } else {
      // URL fallback
      let rawUrl=req.query.url;
      if (!rawUrl) return res.status(400).json({ok:false,message:"id or url required."});

      for(let i=0;i<2;i++){
        try{const d=decodeURIComponent(rawUrl);if(d===rawUrl)break;rawUrl=d;}catch{break;}
      }

      console.log("[dl] url=",String(rawUrl).slice(0,120));

      if (extractionCache.has(rawUrl)) {
        const c=extractionCache.get(rawUrl);
        targetUrl=c.url; extractedTitle=c.title;
        customHeaders=c.headers||{}; originalSocialUrl=c.originalUrl;
      } else {
        const validated=await validateUrl(rawUrl);
        targetUrl=validated.toString();
        if (isSocialMediaUrl(targetUrl)) {
          originalSocialUrl=targetUrl;
          const data=await extractDirectVideoUrl(targetUrl);
          const c=cacheExtraction(targetUrl,data);
          targetUrl=c.url; extractedTitle=c.title; customHeaders=c.headers||{};
        }
      }
    }

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),DOWNLOAD_TIMEOUT);
    req.on("close",()=>{controller.abort();clearTimeout(timer);});

    try {
      // Fresh CDN fetch - no range headers
      let response=await fetchCDN(targetUrl,customHeaders,controller.signal);
      let contentType=getRawContentType(response);

      // Re-extract if CDN expired
      if (!response.ok||!isValidMediaType(contentType)) {
        console.log("[dl] CDN bad:",response.status,contentType,"re-extracting...");

        if (originalSocialUrl&&isSocialMediaUrl(originalSocialUrl)) {
          try {
            const fresh=await extractDirectVideoUrl(originalSocialUrl);
            const c=cacheExtraction(originalSocialUrl,fresh);
            targetUrl=c.url; customHeaders=c.headers||{}; extractedTitle=fresh.title;
            response=await fetchCDN(targetUrl,customHeaders,controller.signal);
            contentType=getRawContentType(response);
          } catch {
            return res.status(502).json({ok:false,
              message:"Media expired. Please tap 'Get media' again."});
          }
        }

        if (!response.ok||!isValidMediaType(contentType)) {
          return res.status(502).json({ok:false,
            message:`Bad media response (${response.status}). Please try again.`});
        }
      }

      const contentLength=Number(response.headers.get("content-length")||0);
      if (contentLength&&contentLength>MAX_BYTES)
        return res.status(413).json({ok:false,message:"File exceeds 250 MB limit."});

      const filename=filenameFromUrl(targetUrl,contentType,extractedTitle);
      const safeFilename=filename.replace(/[\r\n"']/g,"");
      const encodedFilename=encodeURIComponent(safeFilename);
      const wantInline=req.query.inline==="1";

      // ── Speed optimized headers ──
      res.status(200);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition",
        wantInline
          ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
          : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
      );
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Accept-Ranges", "none"); // Range disable = no .json issue
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Transfer-Encoding", "chunked"); // Chunked = faster start

      if (contentLength) {
        res.setHeader("Content-Length", String(contentLength));
      }

      if (!response.body) throw new Error("Media stream unavailable.");

      // ── FAST PIPE using Node.js stream pipeline ──
      // Yeh sabse fast method hai - direct pipe without manual chunk loop
      const { Writable } = require("stream");
      const { pipeline } = require("stream/promises");

      let total = 0;
      let limitExceeded = false;

      const sizeChecker = new Writable({
        // Large highWaterMark = faster throughput
        highWaterMark: 512 * 1024, // 512KB buffer
        write(chunk, _encoding, callback) {
          if (limitExceeded) return callback();
          total += chunk.length;
          if (total > MAX_BYTES) {
            limitExceeded = true;
            controller.abort();
            res.destroy();
            return callback(new Error("Size limit exceeded"));
          }
          if (!res.write(chunk)) {
            // Backpressure handle
            res.once("drain", callback);
          } else {
            callback();
          }
        },
        final(callback) {
          if (!limitExceeded) {
            res.end();
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            const mbps = (total / 1024 / 1024 / parseFloat(elapsed)).toFixed(2);
            console.log(`[dl] done: ${(total/1024/1024).toFixed(1)}MB in ${elapsed}s = ${mbps} MB/s`);
          }
          callback();
        }
      });

      // Web ReadableStream to Node.js stream
      const nodeStream = require("stream").Readable.fromWeb
        ? require("stream").Readable.fromWeb(response.body)
        : response.body;

      try {
        await pipeline(nodeStream, sizeChecker);
      } catch (e) {
        if (!limitExceeded && e.name !== "AbortError") {
          throw e;
        }
      }

    } finally { clearTimeout(timer); }

  } catch (e) {
    console.error("Download error:", e);
    if (!res.headersSent)
      res.status(400).json({ok:false,
        message:e.name==="AbortError"?"Download timed out.":e.message||"Unable to download."});
    else res.destroy();
  } finally {
    releaseDownload(ip);
  }
});

/* ── static + fallback ── */
app.use(express.static(PUBLIC_DIR,{extensions:["html"]}));
app.use((_req,res)=>res.sendFile(path.join(PUBLIC_DIR,"index.html")));
app.use((err,_req,res,next)=>{
  console.error("Server error:",err);
  if (res.headersSent) return next(err);
  res.status(500).json({ok:false,message:"Internal server error."});
});

const server=app.listen(PORT,"0.0.0.0",()=>
  console.log(`QuickSave v3.1 running on port ${PORT}`)
);

function shutdown(sig){
  console.log(sig+" received");
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT", ()=>shutdown("SIGINT"));
process.on("uncaughtException", e=>console.error("Uncaught:",e));
process.on("unhandledRejection",e=>console.error("Unhandled:",e));
