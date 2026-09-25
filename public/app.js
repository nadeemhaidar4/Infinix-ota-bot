const $=id=>document.getElementById(id);
const url=$("url"),paste=$("paste"),go=$("go"),drop=$("drop"),status=$("status"),result=$("result"),name=$("name"),meta=$("meta"),download=$("download"),thumb=$("thumb"),progress=$("progress"),bar=$("bar"),progressText=$("progressText"),progressPct=$("progressPct"),historyPanel=$("historyPanel"),history=$("history"),install=$("install");
let current=null,installPrompt=null;

function msg(t,c=""){status.textContent=t;status.className="status "+c}
function size(n){if(!n)return"Size unavailable";let u=["B","KB","MB","GB"],i=0;while(n>=1024&&i<3){n/=1024;i++}return`${n.toFixed(i?1:0)} ${u[i]}`}
function saveHistory(item){let h=JSON.parse(localStorage.getItem("qs_history")||"[]");h=[item,...h.filter(x=>x.url!==item.url)].slice(0,8);localStorage.setItem("qs_history",JSON.stringify(h));renderHistory()}
function renderHistory(){let h=JSON.parse(localStorage.getItem("qs_history")||"[]");if(!h.length){historyPanel.classList.add("hide");return}historyPanel.classList.remove("hide");history.innerHTML=h.map(x=>`<div class="historyrow"><div><b>${escapeHtml(x.name)}</b><small>${escapeHtml(x.type)} • ${new Date(x.time).toLocaleString()}</small></div><a href="/api/download?url=${encodeURIComponent(x.url)}">Download</a></div>`).join("")}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m]))}
$("clearHistory").onclick=()=>{localStorage.removeItem("qs_history");renderHistory()};

paste.onclick=async()=>{try{url.value=(await navigator.clipboard.readText()).trim();paste.textContent="Pasted ✓";setTimeout(()=>paste.textContent="Paste",1200)}catch{msg("Clipboard permission is unavailable. Paste manually.","err");url.focus()}};

["dragenter","dragover"].forEach(e=>drop.addEventListener(e,x=>{x.preventDefault();drop.classList.add("drag")}));
["dragleave","drop"].forEach(e=>drop.addEventListener(e,x=>{x.preventDefault();drop.classList.remove("drag")}));
drop.addEventListener("drop",e=>{const text=e.dataTransfer.getData("text/plain")||e.dataTransfer.getData("text/uri-list");if(text){url.value=text.trim();go.click()}});
url.onkeydown=e=>{if(e.key==="Enter")go.click()};

function showPreview(d){
 thumb.innerHTML="";
 if(d.type.startsWith("image/")){const img=new Image();img.src=d.mediaUrl;img.onload=()=>thumb.appendChild(img);img.onerror=()=>thumb.innerHTML="<span>◈</span>"}
 else if(d.type.startsWith("video/")){const v=document.createElement("video");v.src="/api/download?url="+encodeURIComponent(d.mediaUrl);v.muted=true;v.playsInline=true;v.preload="metadata";v.addEventListener("loadeddata",()=>{try{v.currentTime=0.1}catch{}});thumb.appendChild(v)}
 else thumb.innerHTML="<span>♪</span>";
}

go.onclick=async()=>{
 const value=url.value.trim();if(!value)return msg("Paste a media URL first.","err");
 go.disabled=true;result.classList.add("hide");go.firstChild.textContent="Checking…";msg("Checking the link…");
 try{
  const r=await fetch("/api/inspect",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:value})});
  const d=await r.json();if(!r.ok||!d.ok)throw Error(d.message||"This link could not be processed.");
  current=d;name.textContent=d.filename;meta.textContent=d.type+(d.size?" • "+size(d.size):"");showPreview(d);
  download.href="/api/download?url="+encodeURIComponent(d.mediaUrl);download.download=d.filename;
  result.classList.remove("hide");msg("Media is ready. Tap Download file.","ok");
 }catch(e){msg(e.message||"Something went wrong.","err")}
 finally{go.disabled=false;go.firstChild.textContent="Get media"}
};

download.addEventListener("click",()=>{if(!current)return;saveHistory({url:current.mediaUrl,name:current.filename,type:current.type,time:Date.now()});progress.classList.remove("hide");progressText.textContent="Starting download…";bar.style.width="10%";progressPct.textContent="10%";setTimeout(()=>{bar.style.width="100%";progressPct.textContent="Ready";progressText.textContent="Download started"} ,500)});

window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();installPrompt=e;install.classList.remove("hidden")});
install.onclick=async()=>{if(!installPrompt)return;installPrompt.prompt();await installPrompt.userChoice;installPrompt=null;install.classList.add("hidden")};

if("serviceWorker"in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
renderHistory();
