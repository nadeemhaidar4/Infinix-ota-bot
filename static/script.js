let ws = null;
let roomCode = "";
let myName = "";
let state = "lobby";
let players = [];
let tokenData = [];
let currentPlayer = null;
let currentRoll = null;
let legalMoves = [];
let myNumber = 0;
let myColor = "";
let myTokens = [-1,-1,-1,-1];
let deadline = 0;
let timerInterval = null;
let reconnecting = false;

const $ = id => document.getElementById(id);

function esc(v){
  return String(v ?? "").replace(/[&<>"']/g,c=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function show(id){$(id)?.classList.remove("hidden")}
function hide(id){$(id)?.classList.add("hidden")}

function toast(text){
  const el=$("toast");
  el.textContent=text;
  el.classList.remove("hidden");
  clearTimeout(window.__toast);
  window.__toast=setTimeout(()=>el.classList.add("hidden"),2200);
}

function setStatus(text){
  $("status").textContent=text;
}

async function createRoom(){
  if(ws && ws.readyState===WebSocket.OPEN)return;

  myName=$("name").value.trim();

  if(!myName){
    toast("Pehle apna naam likho.");
    $("name").focus();
    return;
  }

  const maxPlayers=Number($("max-players").value||4);

  $("create-btn").disabled=true;
  $("join-btn").disabled=true;
  setStatus("Room ban raha hai…");

  try{
    const r=await fetch(`/api/create-room?max_players=${maxPlayers}`);
    const data=await r.json();

    if(!data.ok)throw new Error(data.message||"Room create nahi hua.");

    connect(data.room);
  }catch(e){
    $("create-btn").disabled=false;
    $("join-btn").disabled=false;
    setStatus("Ready");
    toast(e.message||"Room create nahi hua.");
  }
}

async function joinRoom(){
  if(ws && ws.readyState===WebSocket.OPEN)return;

  myName=$("name").value.trim();
  roomCode=$("room").value.replace(/\D/g,"").slice(0,4);

  if(!myName){
    toast("Pehle apna naam likho.");
    $("name").focus();
    return;
  }

  if(roomCode.length!==4){
    toast("4 digit room code dalo.");
    $("room").focus();
    return;
  }

  $("create-btn").disabled=true;
  $("join-btn").disabled=true;
  setStatus("Room check ho raha hai…");

  try{
    const r=await fetch(`/api/check-room/${roomCode}`);
    const data=await r.json();

    if(!data.ok)throw new Error(data.message||"Room nahi mila.");
    if(data.state==="game_over")throw new Error("Ye game khatam ho chuka hai.");

    connect(roomCode);
  }catch(e){
    $("create-btn").disabled=false;
    $("join-btn").disabled=false;
    setStatus("Ready");
    toast(e.message||"Join nahi ho paya.");
  }
}

function connect(code){
  roomCode=code;

  const protocol=location.protocol==="https:"?"wss":"ws";

  setStatus("Room se connect ho raha hai…");

  ws=new WebSocket(
    `${protocol}://${location.host}/ws/${encodeURIComponent(roomCode)}?name=${encodeURIComponent(myName)}`
  );

  ws.onopen=()=>{
    hide("home");
    show("app");
    $("room-code").textContent=roomCode;
    $("share-code").textContent=roomCode;
    $("me").textContent=myName;
    setStatus("Connected");
  };

  ws.onmessage=event=>{
    try{handle(JSON.parse(event.data))}
    catch(e){console.error(e)}
  };

  ws.onerror=()=>{
    toast("Connection problem.");
  };

  ws.onclose=()=>{
    if(!reconnecting){
      toast("Connection lost. Refresh karke dubara join karo.");
    }
  };
}

function send(data){
  if(ws?.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify(data));
  }
}

function handle(d){
  if(d.type==="error"){
    toast(d.message||"Something went wrong.");
    $("create-btn").disabled=false;
    $("join-btn").disabled=false;
    return;
  }

  if(d.type==="chat"){
    addChat(d.sender, d.text);
    return;
  }

  if(d.type==="state"){
    state=d.state;
    players=d.players||[];
    tokenData=d.tokens||[];
    currentPlayer=d.current_player;
    currentRoll=d.current_roll;
    legalMoves=d.legal_moves||[];
    myNumber=d.my_number||0;
    myColor=d.my_color||"";
    myTokens=d.my_tokens||[-1,-1,-1,-1];
    deadline=Number(d.deadline||0);

    isHost=d.host===myName;

    $("room-code").textContent=d.room;
    $("share-code").textContent=d.room;
    $("me").textContent=myName;

    renderState(d);
    return;
  }
}

function renderState(d){
  stopTimer();

  $("phase-text").textContent=
    state==="lobby"?"Lobby":
    state==="game_over"?"Game Over":
    state==="rolling"?"Kavdi Roll":
    "Goti Chuno";

  if(state==="lobby"){
    show("lobby-screen");
    hide("board-screen");
    hide("gameover-screen");

    $("host-note").textContent=
      d.host
      ? (d.host===myName ? "Aap host ho. Friends ke join hone ke baad game start karo." : `Host: ${d.host}`)
      : "Waiting for host…";

    $("start-btn").classList.toggle(
      "hidden",
      !(isHost && players.filter(p=>p.connected).length>=2)
    );

    renderPlayers();
    return;
  }

  if(state==="rolling" || state==="moving"){
    hide("lobby-screen");
    hide("gameover-screen");
    show("board-screen");

    $("turn-name").textContent=currentPlayer||"—";
    $("game-message").textContent=d.message||"";
    $("roll-result").textContent=
      currentRoll
      ? `Kavdi = ${currentRoll}`
      : "—";

    renderShells(d.shells||[]);
    renderBoard();
    renderStrip();

    const canRoll=
      state==="rolling" &&
      currentPlayer===myName;

    $("roll-btn").classList.toggle("hidden",!canRoll);

    $("move-hint").classList.toggle(
      "hidden",
      !(state==="moving"&&currentPlayer===myName)
    );

    if(deadline){
      startTimer(deadline);
    }

    return;
  }

  if(state==="game_over"){
    hide("lobby-screen");
    hide("board-screen");
    show("gameover-screen");

    const winner=d.winner||"";
    $("winner-title").textContent=`🏆 ${winner} Wins!`;
    $("winner-text").textContent=d.message||"Game complete.";

    renderPlayers();
    $("final-players").innerHTML=$("players").innerHTML;

    $("restart-btn").classList.toggle(
      "hidden",
      !isHost
    );
  }
}

function renderPlayers(){
  const box=$("players");
  box.innerHTML="";

  [...players]
    .sort((a,b)=>(a.number||99)-(b.number||99))
    .forEach(p=>{
      const row=document.createElement("div");
      row.className="player-row";

      row.innerHTML=`
        <div class="avatar ${esc(p.color)}">
          ${esc((p.name||"?")[0].toUpperCase())}
        </div>

        <div class="player-main">
          <div class="player-name">
            No.${p.number} ${esc(p.name)}
            ${p.name===myName?'<span class="host-tag">YOU</span>':''}
            ${p.is_host?'<span class="host-tag">HOST</span>':''}
          </div>

          <div class="player-meta">
            ${p.connected?"Online":"Offline"}
            ${p.has_kill?" • Inner path unlocked":""}
          </div>
        </div>

        <div class="player-finish">
          ${p.finished}/4
        </div>
      `;

      box.appendChild(row);
    });
}

function renderStrip(){
  const box=$("player-strip");
  box.innerHTML="";

  [...players]
    .sort((a,b)=>(a.number||99)-(b.number||99))
    .forEach(p=>{
      const el=document.createElement("div");
      el.className=
        "strip-player "+
        (p.name===currentPlayer?"current":"");

      const initial=(p.name||"?")[0].toUpperCase();

      el.innerHTML=`
        <span class="dot ${esc(p.color)}">${esc(initial)}</span>
        <div>${esc(p.name)}</div>
        <b>${p.finished||0}/4</b>
      `;

      box.appendChild(el);
    });
}

function getCell(row,col){
  return document.querySelector(
    `.cell[data-r="${row}"][data-c="${col}"]`
  );
}

function createCell(row,col){
  const div=document.createElement("div");
  div.className="cell";
  div.dataset.r=row;
  div.dataset.c=col;

  if(
    (row===0&&col===2)||
    (row===2&&col===0)||
    (row===2&&col===4)||
    (row===4&&col===2)
  ){
    div.classList.add("safe");
  }

  if(row===2&&col===2){
    div.classList.add("center");
  }

  return div;
}

function renderBoard(){
  const board=$("board");
  board.innerHTML="";

  for(let r=0;r<5;r++){
    for(let c=0;c<5;c++){
      board.appendChild(createCell(r,c));
    }
  }

  // Put active pawns on board.
  tokenData.forEach(p=>{
    const playerIndex=(p.number||1)-1;

    p.tokens.forEach((progress,tokenIndex)=>{
      if(progress<0||progress>17)return;

      let pos;

      if(progress===17){
        pos={r:2,c:2};
      }else{
        // Client path duplicates server path construction.
        pos=pathFor(playerIndex)[progress];
      }

      const cell=getCell(pos.r,pos.c);
      if(!cell)return;

      let stack=cell.querySelector(".pawn-stack");
      if(!stack){
        stack=document.createElement("div");
        stack.className="pawn-stack";
        cell.appendChild(stack);
      }

      const pawn=document.createElement("button");
      pawn.className=`pawn ${p.color}`;

      const canMove =
        currentPlayer===myName &&
        state==="moving" &&
        legalMoves.includes(tokenIndex) &&
        p.name===myName;

      if(canMove){
        pawn.classList.add("movable");
        pawn.onclick=(e)=>{
          e.stopPropagation();
          moveToken(tokenIndex);
        };
        pawn.title="Move this pawn";
      }else{
        pawn.disabled=true;
      }

      pawn.textContent=String(tokenIndex+1);

      stack.appendChild(pawn);
    });
  });

  // Show home pawns as small waiting pieces under the board.
  const homeCell=getCell(2,2);
  if(homeCell){
    // Center already contains finished pawns, no home tokens here.
  }

  if(currentPlayer===myName && state==="moving"){
    legalMoves.forEach(idx=>{
      // already highlighted by pawn
    });
  }
}

function pathFor(index){
  const base=[
    {r:0,c:2},{r:0,c:1},{r:0,c:0},
    {r:1,c:0},{r:2,c:0},{r:3,c:0},{r:4,c:0},
    {r:4,c:1},{r:4,c:2},{r:4,c:3},{r:4,c:4},
    {r:3,c:4},{r:2,c:4},{r:1,c:4},{r:0,c:4},{r:0,c:3}
  ];

  const rotate=(cell,times)=>{
    let r=cell.r,c=cell.c;
    for(let i=0;i<times;i++){
      [r,c]=[c,4-r];
    }
    return {r,c};
  };

  const outer=base.map(x=>rotate(x,index));

  const start=outer[0];
  const dr=2-start.r;
  const dc=2-start.c;

  const sr=dr===0?0:dr>0?1:-1;
  const sc=dc===0?0:dc>0?1:-1;

  outer.push({
    r:start.r+sr,
    c:start.c+sc
  });

  outer.push({r:2,c:2});

  return outer;
}

function renderShells(shells){
  const box=$("shells");
  box.innerHTML="";

  if(!shells.length){
    for(let i=0;i<4;i++){
      const s=document.createElement("span");
      s.textContent="🐚";
      box.appendChild(s);
    }
    return;
  }

  shells.forEach(value=>{
    const s=document.createElement("span");
    s.textContent=value===1?"◡":"◠";
    box.appendChild(s);
  });
}

function startGame(){
  if(!isHost)return;
  send({action:"start_game"});
}

function rollKavdi(){
  if(currentPlayer!==myName||state!=="rolling")return;
  send({action:"roll"});
}

function moveToken(index){
  if(state!=="moving"||currentPlayer!==myName)return;
  if(!legalMoves.includes(index))return;

  send({
    action:"move",
    token:index
  });
}

function startTimer(endMs){
  stopTimer();
  deadline=endMs;

  const tick=()=>{
    const left=Math.max(0,endMs-Date.now());
    $("timer").textContent=Math.ceil(left/1000);

    if(left<=0){
      stopTimer();
    }
  };

  tick();
  timerInterval=setInterval(tick,100);
}

function stopTimer(){
  clearInterval(timerInterval);
  timerInterval=null;
  if(state==="lobby"||state==="game_over")$("timer").textContent="—";
}

function copyRoom(){
  if(navigator.clipboard){
    navigator.clipboard.writeText(roomCode);
    toast("Room code copied!");
  }else{
    toast(`Room code: ${roomCode}`);
  }
}

function toggleRules(){
  $("rules-modal").classList.toggle("hidden");
}

function restartGame(){
  if(isHost){
    send({action:"restart"});
  }
}

function leaveGame(){
  try{ws?.close()}catch{}
  location.reload();
}

function sendChat(){
  const input=$("chat-input");
  const value=input.value.trim();

  if(!value)return;

  send({
    action:"chat",
    text:value
  });

  input.value="";
}

function addChat(sender,text){
  const box=$("chat");
  const row=document.createElement("div");
  row.className="chat-line";
  row.innerHTML=`<b>${esc(sender)}</b> ${esc(text)}`;
  box.appendChild(row);
  box.scrollTop=box.scrollHeight;
}

$("chat-input").addEventListener("keydown",e=>{
  if(e.key==="Enter")sendChat();
});

$("name").addEventListener("keydown",e=>{
  if(e.key==="Enter")createRoom();
});

$("room").addEventListener("keydown",e=>{
  if(e.key==="Enter")joinRoom();
});

$("room").addEventListener("input",e=>{
  e.target.value=e.target.value.replace(/\D/g,"").slice(0,4);
});

window.addEventListener("load",()=>{
  const urlRoom=
    new URLSearchParams(location.search)
      .get("room");

  if(urlRoom){
    $("room").value=
      urlRoom.replace(/\D/g,"").slice(0,4);
  }
});
