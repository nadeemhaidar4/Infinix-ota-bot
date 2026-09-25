const express=require("express");
const path=require("path");
const {URL}=require("url");
const app=express();
const PORT=Number(process.env.PORT||10000);

const MAX=250*1024*1024, TIMEOUT=15000, DL_TIMEOUT=60000, REDIRECTS=4;
const MAX_ACTIVE=3, WINDOW=60000, RATE=20;
const active=new Map(), buckets=new Map();

const TYPES=new Set([
 "video/mp4","video/webm","video/quicktime","video/x-matroska",
 "audio/mpeg","audio/mp4","audio/wav","audio/webm",
 "image/jpeg","image/png","image/webp","image/gif"
]);

app.disable("x-powered-by");
app.use(express.json({limit:"16kb"}));
app.use(express.static(path.join(__dirname,"public"),{extensions:["html"]}));

function key(req){return (req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown").toString().split(",")[0].trim()}
function limited(req,res,next){
 const k=key(req),now=Date.now(); let b=buckets.get(k);
 if(!b||now-b.start>=WINDOW){b={start:now,count:0};buckets.set(k,b)}
 if(++b.count>RATE)return res.status(429).json({ok:false,message:"Too many requests. Please wait a minute."});
 next();
}
setInterval(()=>{const n=Date.now();for(const[k,v]of buckets)if(n-v.start>=WINDOW)buckets.delete(k)},300000).unref();

function privateHost(h){
 h=h.toLowerCase().replace(/\.$/,"");
 if(["localhost","ip6-localhost","::1"].includes(h))return true;
 const m=h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);if(!m)return false;
 const a=+m[1],b=+m[2];
 return a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||a===0;
}
function valid(raw){
 if(typeof raw!=="string"||raw.length>4096)throw Error("Please enter a valid URL.");
 let u;try{u=new URL(raw.trim())}catch{throw Error("Please enter a valid URL.")}
 if(!["http:","https:"].includes(u.protocol))throw Error("Only HTTP and HTTPS links are supported.");
 if(privateHost(u.hostname))throw Error("This address is not allowed.");
 return u;
}
function ctl(ms){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);t.unref?.();return[c,()=>clearTimeout(t)]}
async function fetchSafe(raw,method,ms=TIMEOUT){
 let cur=valid(raw);
 for(let i=0;i<=REDIRECTS;i++){
  const[c,clear]=ctl(ms);
  try{
   const r=await fetch(cur,{method,redirect:"manual",signal:c.signal,headers:{User-Agent:"QuickSave/2.0",Accept:"*/*"}});
   if([301,302,303,307,308].includes(r.status)){
    const loc=r.headers.get("location");if(!loc)throw Error("Invalid redirect.");
    cur=valid(new URL(loc,cur).toString());continue;
   }
   return{response:r,url:cur};
  }finally{clear()}
 }
 throw Error("Too many redirects.");
}
function fname(s,f="quicksave-media"){
 const x=String(s||f).replace(/[<>:"/\\|?*\x00-\x1F]/g,"").replace(/\s+/g," ").trim().slice(0,120);
 return x||f;
}
function ext(t){return({"video/mp4":".mp4","video/webm":".webm","video/quicktime":".mov","video/x-matroska":".mkv","audio/mpeg":".mp3","audio/mp4":".m4a","audio/wav":".wav","audio/webm":".webm","image/jpeg":".jpg","image/png":".png","image/webp":".webp","image/gif":".gif"})[t]||""}
function acquire(k){const n=active.get(k)||0;if(n>=MAX_ACTIVE)return false;active.set(k,n+1);return true}
function release(k){const n=active.get(k)||0;if(n<=1)active.delete(k);else active.set(k,n-1)}

app.get("/health",(req,res)=>res.json({ok:true,service:"quicksave",uptime:Math.round(process.uptime()),active:[...active.values()].reduce((a,b)=>a+b,0)}));

app.post("/api/inspect",limited,async(req,res)=>{
 try{
  const input=String(req.body?.url||"").trim(),u=valid(input);
  let q=await fetchSafe(u.toString(),"HEAD"),r=q.response;
  if(!r.ok&&[400,403,405,406,501].includes(r.status)){q=await fetchSafe(u.toString(),"GET");r=q.response}
  if(!r.ok)return res.status(400).json({ok:false,message:`The server returned HTTP ${r.status}.`});
  const type=(r.headers.get("content-type")||"").split(";")[0].toLowerCase(),size=Number(r.headers.get("content-length")||0);
  if(!TYPES.has(type))return res.status(415).json({ok:false,message:"This is not a supported direct media file. Use a direct/public media URL."});
  if(size>MAX)return res.status(413).json({ok:false,message:"This file is larger than the 250 MB limit."});
  let n=fname(decodeURIComponent(q.url.pathname.split("/").pop()||"quicksave-media"));if(!n.includes("."))n+=ext(type);
  res.json({ok:true,mediaUrl:q.url.toString(),type,size:size||null,filename:n});
 }catch(e){res.status(400).json({ok:false,message:e.name==="AbortError"?"The media server took too long to respond.":e.message||"Unable to inspect this URL."})}
});

app.get("/api/download",limited,async(req,res)=>{
 const k=key(req);if(!acquire(k))return res.status(429).send("Too many simultaneous downloads. Please wait.");
 let done=false,cleanup=()=>{if(!done){done=true;release(k)}};req.on("close",cleanup);
 try{
  const q=await fetchSafe(String(req.query.url||""),"GET",DL_TIMEOUT),r=q.response;
  if(!r.ok)throw Error(`Unable to download: HTTP ${r.status}`);
  const type=(r.headers.get("content-type")||"").split(";")[0].toLowerCase();
  if(!TYPES.has(type))throw Error("Unsupported media type.");
  const declared=Number(r.headers.get("content-length")||0);if(declared>MAX)throw Error("File exceeds the 250 MB limit.");
  let n=fname(decodeURIComponent(q.url.pathname.split("/").pop()||"quicksave-media"));if(!n.includes("."))n+=ext(type);
  res.status(200).set({"Content-Type":type,"Content-Disposition":`attachment; filename="${n}"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
  const reader=r.body.getReader();let total=0;
  try{
   while(true){
    const{x,done:finished}=await reader.read().then(v=>({x:v.value,done:v.done}));
    if(finished)break;
    total+=x.byteLength;if(total>MAX){try{await reader.cancel()}catch{};if(!res.headersSent)res.status(413).send("File exceeds the 250 MB limit.");else res.destroy();return}
    if(!res.write(Buffer.from(x)))await new Promise((resolve,reject)=>{
      const d=()=>{c();resolve()},z=()=>{c();reject(Error("Client disconnected."))},c=()=>{res.off("drain",d);res.off("close",z)};
      res.once("drain",d);res.once("close",z);
    });
   }
   res.end();
  }finally{try{await reader.cancel()}catch{}}
 }catch(e){if(!res.headersSent)res.status(400).send(e.name==="AbortError"?"Download timed out.":e.message||"Download failed.");else if(!res.writableEnded)res.destroy()}
 finally{cleanup()}
});

app.get("*splat",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
const server=app.listen(PORT,()=>console.log(`QuickSave on ${PORT}`));
server.requestTimeout=75000;server.headersTimeout=80000;server.keepAliveTimeout=65000;
process.on("SIGTERM",()=>server.close(()=>process.exit(0)));
process.on("SIGINT",()=>server.close(()=>process.exit(0)));
process.on("uncaughtException",e=>console.error("UNCAUGHT",e));
process.on("unhandledRejection",e=>console.error("UNHANDLED",e));
