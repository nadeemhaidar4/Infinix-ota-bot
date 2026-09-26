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

function getContentType(r) {
  return (r.headers.get("content-type")||"").split(";")[0].trim().toLowerCase();
}

/* ── CRITICAL: Content-Type valid hai ya nahi ── */
function isValidMediaContentType(ct) {
  if (!ct) return false;
  // JSON, HTML, text = invalid = CDN ne error diya
  if (ct.includes("application/json")) return false;
  if (ct.includes("text/html"))        return false;
  if (ct.includes("text/plain"))       return false;
  if (ct.includes("text/xml"))         return false;
  if (ct.includes("application/xml"))  return false;
  // Valid media types
  return (
    ct.includes("video/") ||
    ct.includes("audio/") ||
    ct.includes("image/") ||
    ct === "application/octet-stream"
  );
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
  // Instagram CDN URLs expire in ~6 hours, but cache only 10 min to be safe
  setTimeout(()=>{
    extractionCache.delete(originalUrl);
    extractionCache.delete(extractedData.url);
    extractionCache.delete(downloadId);
  }, 10*60*1000);
  return payload;
}

function invalidateCache(downloadId) {
  const c = extractionCache.get(downloadId);
  if (!c) return;
  extractionCache.delete(c.originalUrl);
  extractionCache.delete(c.url);
  extractionCache.delete(downloadId);
}

/* ── yt-dlp extractor ── */
async function extractDirectVideoUrl(url) {
  try {
    const output=await youtubedl(url,{
      dumpSingleJson:true,noCheckCertificates:true,noWarnings:true,format:"b"
    });
    if (!output) throw new Error("No output from extractor.");
    let directUrl=output.url;
    let headers={...(output.http_headers||{})};
    delete headers["Host"]; delete headers["host"];
    if (!directUrl&&output.requested_formats?.length) {
      directUrl=output.requested_formats[0].url;
      headers={...(output.requested_formats[0].http_headers||{})};
      delete headers["Host"]; delete headers["host"];
    }
    if (!directUrl) throw new Error("Could not extract media stream.");
    return {url:directUrl, title:output.title||"Video", headers};
  } catch (e) {
    console.error("Extractor error:", e.message);
    throw new Error("Unable to extract video. It might be private or unsupported.");
  }
}

/* ── fetch helpers ── */
const UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

async function fetchCDN(targetUrl, method, headers, signal) {
  const h={"User-Agent":UA,"Accept":"*/*",...headers};
  delete h["Host"]; delete h["host"];
  return fetch(targetUrl,{method,headers:h,redirect:"follow",signal});
}

/* ── health ── */
app.get("/health",(_req,res)=>res.json({ok:true,service:"QuickSave",version:"2.9"}));

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
      targetUrl=c.url; extractedTitle=c.title; customHeaders=c.headers||{};
      downloadId=c.downloadId; useCDNFetch=true;
    } else if (isSocialMediaUrl(targetUrl)) {
      const data=await extractDirectVideoUrl(targetUrl);
      const c=cacheExtraction(targetUrl,data);
      targetUrl=c.url; extractedTitle=c.title; customHeaders=c.headers||{};
      downloadId=c.downloadId; useCDNFetch=true;
    } else {
      const c=cacheExtraction(targetUrl,{url:targetUrl,title:null,headers:{}});
      downloadId=c.downloadId;
    }

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),INSPECT_TIMEOUT);

    try {
      let response=null;
      try {
        response=useCDNFetch
          ? await fetchCDN(targetUrl,"HEAD",customHeaders,controller.signal)
          : await fetchSafe(targetUrl,{method:"HEAD",signal:controller.signal});
      } catch { response=null; }

      let contentType=response?getContentType(response):"";
      let contentLength=response?Number(response.headers.get("content-length")||0):0;

      if (!response||!response.ok||!isValidMediaContentType(contentType)) {
        response=useCDNFetch
          ? await fetchCDN(targetUrl,"GET",{...customHeaders,Range:"bytes=0-0"},controller.signal)
          : await fetchSafe(targetUrl,{method:"GET",headers:{Range:"bytes=0-0"},signal:controller.signal});
        contentType=getContentType(response);
        const cr=response.headers.get("content-range");
        if (cr&&cr.includes("/")) {
          const t=Number(cr.split("/")[1]);
          if (!isNaN(t)&&t>0) contentLength=t;
        } else {
          contentLength=Number(response.headers.get("content-length")||0);
        }
        try { await response.body?.cancel(); } catch {}
      }

      if (!response.ok && response.status!==206)
        return res.status(400).json({ok:false,type:"error",message:`Media server returned HTTP ${response.status}.`});

      // CRITICAL: JSON/HTML response = CDN error, reject it
      if (!isValidMediaContentType(contentType))
        return res.status(400).json({ok:false,type:"unsupported",
          message:"This URL does not return a valid media file. Try again or use a different link."});

      if (contentLength&&contentLength>MAX_BYTES)
        return res.status(400).json({ok:false,type:"too-large",message:"File is larger than 250 MB."});

      return res.json({
        ok:true, type:"media",
        id: downloadId,
        downloadUrl:`/api/download?id=${downloadId}`,
        url: targetUrl,
        originalUrl: url.toString(),
        contentType: contentType||"video/mp4",
        size: contentLength||null,
        filename: filenameFromUrl(targetUrl, contentType, extractedTitle)
      });
    } finally { clearTimeout(timer); }

  } catch (e) {
    console.error("Inspect error:", e);
    return res.status(400).json({ok:false,type:"error",message:e.message||"Unable to process this URL."});
  }
});

/* ══════════════════════════════════════════
   DOWNLOAD  
══════════════════════════════════════════ */
app.get("/api/download", async (req,res) => {
  const ip=cleanIp(req.headers["x-forwarded-for"]||req.socket.remoteAddress);
  if (!checkRateLimit(ip))  return res.status(429).json({ok:false,message:"Too many requests."});
  if (!acquireDownload(ip)) return res.status(429).json({ok:false,message:"Too many active downloads."});

  try {
    let targetUrl=null, extractedTitle=null, customHeaders={}, useCDNFetch=false;
    let originalSocialUrl=null, downloadId=null;

    const idParam=req.query.id?String(req.query.id).trim():null;

    if (idParam) {
      const cached=extractionCache.get(idParam);
      if (!cached) {
        return res.status(410).json({ok:false,
          message:"Link expired. Please tap 'Get media' again."});
      }
      targetUrl=cached.url; extractedTitle=cached.title;
      customHeaders=cached.headers||{}; useCDNFetch=true;
      originalSocialUrl=cached.originalUrl; downloadId=idParam;
      console.log("[download] id=",idParam,"url=",targetUrl.slice(0,80));

    } else {
      // URL fallback
      let rawUrl=req.query.url;
      if (req.originalUrl.includes("url=")) {
        const idx=req.originalUrl.indexOf("url=");
        let full=req.originalUrl.substring(idx+4);
        const hi=full.indexOf("#"); if (hi!==-1) full=full.substring(0,hi);
        try { rawUrl=decodeURIComponent(full); } catch { rawUrl=full; }
      }
      if (!rawUrl) return res.status(400).json({ok:false,message:"URL or id is required."});
      for(let i=0;i<2;i++){try{const d=decodeURIComponent(rawUrl);if(d===rawUrl)break;rawUrl=d;}catch{break;}}

      console.log("[download] url=",String(rawUrl).slice(0,120));

      if (extractionCache.has(rawUrl)) {
        const c=extractionCache.get(rawUrl);
        targetUrl=c.url; extractedTitle=c.title; customHeaders=c.headers||{};
        useCDNFetch=true; originalSocialUrl=c.originalUrl; downloadId=c.downloadId;
      } else {
        const validated=await validateUrl(rawUrl);
        targetUrl=validated.toString();
        if (isSocialMediaUrl(targetUrl)) {
          const data=await extractDirectVideoUrl(targetUrl);
          const c=cacheExtraction(targetUrl,data);
          targetUrl=c.url; extractedTitle=c.title; customHeaders=c.headers||{};
          useCDNFetch=true; originalSocialUrl=targetUrl; downloadId=c.downloadId;
        }
      }
    }

    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),DOWNLOAD_TIMEOUT);
    req.on("close",()=>{controller.abort();clearTimeout(timer);});

    try {
      const fetchHeaders={...customHeaders};
      if (req.headers.range) fetchHeaders["Range"]=req.headers.range;

      let response=useCDNFetch
        ? await fetchCDN(targetUrl,"GET",fetchHeaders,controller.signal)
        : await fetchSafe(targetUrl,{method:"GET",headers:fetchHeaders,signal:controller.signal});

      // ── CRITICAL FIX: Agar CDN ne expired/error response diya ──
      // Detect: status 400/403/410 ya Content-Type JSON/HTML
      const responseCT = getContentType(response);
      const cdnExpired = !response.ok && response.status!==206;
      const wrongType  = !isValidMediaContentType(responseCT);

      if ((cdnExpired || wrongType) && originalSocialUrl && isSocialMediaUrl(originalSocialUrl)) {
        console.log("[download] CDN expired or wrong type:",response.status, responseCT,"— re-extracting...");

        // Cache invalidate karo
        if (downloadId) invalidateCache(downloadId);

        // Fresh extract
        let freshData;
        try {
          freshData=await extractDirectVideoUrl(originalSocialUrl);
        } catch(e) {
          return res.status(410).json({ok:false,
            message:"Media link expired and could not be refreshed. Please tap 'Get media' again."});
        }

        // Re-cache
        const newCached=cacheExtraction(originalSocialUrl, freshData);
        targetUrl=newCached.url; customHeaders=newCached.headers||{};
        extractedTitle=freshData.title;

        // Re-fetch with fresh URL
        const freshHeaders={...customHeaders};
        if (req.headers.range) freshHeaders["Range"]=req.headers.range;
        response=await fetchCDN(targetUrl,"GET",freshHeaders,controller.signal);

        const freshCT=getContentType(response);
        if (!response.ok&&response.status!==206)
          return res.status(502).json({ok:false,message:`Refreshed CDN returned HTTP ${response.status}.`});
        if (!isValidMediaContentType(freshCT))
          return res.status(502).json({ok:false,message:"Refreshed URL also returned invalid content. Please try again."});

      } else if (cdnExpired) {
        return res.status(400).json({ok:false,message:`Media server returned HTTP ${response.status}.`});
      } else if (wrongType) {
        // Non-social wrong type — direct reject
        return res.status(400).json({ok:false,
          message:`Server returned '${responseCT}' instead of media. Please try again.`});
      }

      const contentType=getContentType(response)||"video/mp4";
      const contentLength=Number(response.headers.get("content-length")||0);

      if (contentLength&&contentLength>MAX_BYTES)
        return res.status(413).json({ok:false,message:"File exceeds 250 MB limit."});

      const filename=filenameFromUrl(targetUrl, contentType, extractedTitle);
      const safeFilename=filename.replace(/[\r\n"']/g,"");
      const encodedFilename=encodeURIComponent(safeFilename);
      const wantInline=req.query.inline==="1";

      res.status(response.status);
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition",
        wantInline
          ? `inline; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
          : `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodedFilename}`
      );
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Accept-Ranges","bytes");
      if (response.headers.has("content-length")) res.setHeader("Content-Length",response.headers.get("content-length"));
      if (response.headers.has("content-range"))  res.setHeader("Content-Range",response.headers.get("content-range"));

      if (!response.body) throw new Error("Media stream unavailable.");
      let total=0;
      for await (const chunk of response.body) {
        total+=chunk.length;
        if (total>MAX_BYTES) {
          controller.abort();
          if (!res.headersSent) res.status(413).json({ok:false,message:"Download exceeded limit."});
          else res.destroy();
          return;
        }
        if (!res.write(chunk)) await new Promise(r=>res.once("drain",r));
      }
      res.end();

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

const server=app.listen(PORT,"0.0.0.0",()=>console.log(`QuickSave v2.9 running on port ${PORT}`));

function shutdown(sig){
  console.log(sig+" received");
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on("SIGTERM",()=>shutdown("SIGTERM"));
process.on("SIGINT", ()=>shutdown("SIGINT"));
process.on("uncaughtException", e=>console.error("Uncaught:",e));
process.on("unhandledRejection",e=>console.error("Unhandled:",e));
