const CACHE="quicksave-v2";const ASSETS=["/","/index.html","/styles.css","/app.js","/manifest.webmanifest","/icon.svg"];
self.addEventListener("install",e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener("activate",e=>e.waitUntil(self.clients.claim()));
self.addEventListener("fetch",e=>{
 const u=new URL(e.request.url);
 if(u.pathname.startsWith("/api/"))return;
 e.respondWith(caches.match(e.request).then(c=>c||fetch(e.request).then(r=>{const copy=r.clone();caches.open(CACHE).then(x=>x.put(e.request,copy));return r}).catch(()=>caches.match("/"))));
});