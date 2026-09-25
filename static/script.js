let ws = null;
let roomCode = "";
let myName = "";
let isHost = false;
let state = "lobby";
let players = [];
let answered = false;
let selectedChoice = null;
let timerInterval = null;
let deadline = 0;
let reconnecting = false;

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function show(id) { $(id)?.classList.remove("hidden"); }
function hide(id) { $(id)?.classList.add("hidden"); }

function setStatus(text, cls="") {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + cls;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

async function createRoom() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const maxPlayers = Number($("max-players").value || 8);
  myName = $("name").value.trim();

  if (!myName) {
    toast("Enter your name first.");
    $("name").focus();
    return;
  }

  $("create-btn").disabled = true;
  $("join-btn").disabled = true;
  setStatus("Creating room...");

  try {
    const r = await fetch(`/api/create-room?max_players=${encodeURIComponent(maxPlayers)}`);
    if (!r.ok) throw new Error("Server error while creating room.");
    const data = await r.json();
    if (!data.ok) throw new Error(data.message || "Could not create room.");
    connect(data.room);
  } catch (e) {
    $("create-btn").disabled = false;
    $("join-btn").disabled = false;
    setStatus("Ready");
    toast(e.message || "Could not create room.");
  }
}

async function joinRoom() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  myName = $("name").value.trim();
  roomCode = $("room").value.trim().replace(/\D/g, "").slice(0, 4);

  if (!myName) {
    toast("Enter your name first.");
    $("name").focus();
    return;
  }
  if (roomCode.length !== 4) {
    toast("Enter the 4-digit room code.");
    $("room").focus();
    return;
  }

  $("create-btn").disabled = true;
  $("join-btn").disabled = true;
  setStatus("Checking room...");

  try {
    const r = await fetch(`/api/check-room/${roomCode}`);
    const data = await r.json();
    if (!data.ok) throw new Error(data.message || "Room not found.");
    if (data.state === "game_over") throw new Error("That game has ended. Create a new room.");

    connect(roomCode);
  } catch (e) {
    $("create-btn").disabled = false;
    $("join-btn").disabled = false;
    setStatus("Ready");
    toast(e.message || "Could not join room.");
  }
}

function connect(code) {
  roomCode = code;
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  setStatus("Connecting to room...");
  ws = new WebSocket(`${protocol}://${location.host}/ws/${encodeURIComponent(roomCode)}?name=${encodeURIComponent(myName)}`);

  ws.onopen = () => {
    reconnecting = false;
    show("app");
    hide("home");
    $("room-code").textContent = roomCode;
    $("me").textContent = myName;
    setStatus("Connected");
  };

  ws.onmessage = (ev) => {
    try { handle(JSON.parse(ev.data)); }
    catch (err) { console.error(err); }
  };

  ws.onerror = () => {
    setStatus("Connection problem", "error");
  };

  ws.onclose = () => {
    if (!reconnecting) {
      setStatus("Disconnected. Refresh to reconnect.", "error");
    }
  };
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handle(d) {
  switch (d.type) {
    case "error":
      toast(d.message || "Something went wrong.");
      $("create-btn").disabled = false;
      $("join-btn").disabled = false;
      setStatus("Ready");
      break;

    case "joined":
      myName = d.name;
      roomCode = d.room;
      isHost = d.host === myName;
      state = d.state;
      players = d.players || [];
      show("app");
      hide("home");
      renderAll();
      break;

    case "state":
      state = d.state;
      isHost = d.host === myName;
      players = d.players || [];
      renderAll();
      break;

    case "game_started":
      showQuestionShell();
      toast("Game started!");
      break;

    case "question":
      state = "question";
      answered = false;
      selectedChoice = null;
      deadline = Number(d.deadline);
      $("question-number").textContent = `Question ${d.number}/${d.total}`;
      $("question-text").textContent = d.question;
      renderChoices(d.answers || []);
      $("answer-status").textContent = "Choose one answer";
      showQuestionShell();
      startTimer(deadline);
      renderPlayers();
      break;

    case "answer_locked":
      answered = true;
      selectedChoice = d.choice;
      lockChoices();
      $("answer-status").textContent = "Answer locked. Waiting for others...";
      toast("Answer locked");
      break;

    case "answer_progress":
      $("progress").textContent = `${d.answered}/${d.total} answered`;
      break;

    case "reveal":
      stopTimer();
      state = "reveal";
      showReveal(d);
      renderPlayers();
      break;

    case "game_over":
      stopTimer();
      state = "game_over";
      showGameOver(d);
      renderPlayers(d.leaderboard || []);
      break;

    case "chat":
      addChat(d.sender, d.text);
      break;

    case "returned_to_lobby":
      state = "lobby";
      hide("question-screen");
      hide("reveal-screen");
      hide("gameover-screen");
      show("lobby-screen");
      toast(d.message || "Back to lobby.");
      break;
  }
}

function renderAll() {
  $("room-code").textContent = roomCode;
  $("me").textContent = myName;
  if (state === "lobby") {
    show("lobby-screen");
    hide("question-screen");
    hide("reveal-screen");
    hide("gameover-screen");
  } else if (state === "question") {
    showQuestionShell();
  }
  updateHostControls();
  renderPlayers();
}

function updateHostControls() {
  const start = $("start-btn");
  const count = players.filter(p => p.connected).length;
  start.classList.toggle("hidden", !(state === "lobby" && isHost));
  start.disabled = count < 2;
  $("lobby-count").textContent = `${count} player${count === 1 ? "" : "s"} in room`;
  $("host-label").textContent = isHost ? "You are the host" : `Host: ${getHostName() || "—"}`;
}

function getHostName() {
  return players.find(p => p.is_host)?.name || "";
}

function renderPlayers(listOverride=null) {
  const list = listOverride || players;
  const box = $("players");
  box.innerHTML = "";

  [...list]
    .sort((a,b) => (a.number||99) - (b.number||99))
    .forEach(p => {
      const row = document.createElement("div");
      const mine = p.name === myName;
      row.className = "player-row";
      row.innerHTML = `
        <div class="player-avatar">${esc((p.name||"?")[0].toUpperCase())}</div>
        <div class="player-main">
          <div class="player-name">${esc(p.name)} ${mine ? '<span class="you">YOU</span>' : ""}</div>
          <div class="player-meta">
            No.${p.number}
            ${p.is_host ? " • 👑 Host" : ""}
            ${p.connected ? "" : " • offline"}
          </div>
        </div>
        <div class="player-score">${Number(p.score||0)}</div>
      `;
      box.appendChild(row);
    });
}

function startGame() {
  if (!isHost) return;
  send({action:"start_game"});
}

function showQuestionShell() {
  hide("lobby-screen");
  hide("reveal-screen");
  hide("gameover-screen");
  show("question-screen");
}

function renderChoices(answers) {
  const box = $("choices");
  box.innerHTML = "";
  answers.forEach((text, i) => {
    const btn = document.createElement("button");
    btn.className = "choice";
    btn.innerHTML = `<span class="choice-letter">${String.fromCharCode(65+i)}</span><span>${esc(text)}</span>`;
    btn.onclick = () => chooseAnswer(i);
    box.appendChild(btn);
  });
}

function chooseAnswer(i) {
  if (answered || state !== "question") return;
  answered = true;
  selectedChoice = i;
  send({action:"answer", choice:i});
  lockChoices();
  $("answer-status").textContent = "Answer locked. Waiting for others...";
}

function lockChoices() {
  document.querySelectorAll(".choice").forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === selectedChoice) btn.classList.add("selected");
  });
}

function startTimer(endMs) {
  stopTimer();
  const tick = () => {
    const left = Math.max(0, endMs - Date.now());
    const sec = Math.ceil(left / 1000);
    $("timer").textContent = sec;
    $("timer-bar").style.width = `${Math.min(100, (left / (15*1000))*100)}%`;
    if (left <= 0) stopTimer();
  };
  tick();
  timerInterval = setInterval(tick, 100);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function showReveal(d) {
  hide("question-screen");
  hide("gameover-screen");
  show("reveal-screen");

  $("reveal-correct").textContent = `Correct answer: ${String.fromCharCode(65 + d.correct)} — ${$("choices")?.children[d.correct]?.innerText?.replace(/^[A-D]\s*/,"") || "Correct choice"}`;

  const myResult = (d.results || []).find(x => x.name === myName);
  if (myResult?.correct) {
    $("reveal-me").textContent = `✅ Correct! +${myResult.gained}`;
  } else if (myResult) {
    $("reveal-me").textContent = "❌ Wrong answer";
  } else {
    $("reveal-me").textContent = "You did not answer.";
  }

  const lb = $("reveal-list");
  lb.innerHTML = "";
  (d.leaderboard || []).slice(0, 8).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = "leader-row";
    row.innerHTML = `<span>${i+1}. ${esc(p.name)}</span><b>${p.score}</b>`;
    lb.appendChild(row);
  });
}

function showGameOver(d) {
  hide("lobby-screen");
  hide("question-screen");
  hide("reveal-screen");
  show("gameover-screen");

  const lb = $("final-list");
  lb.innerHTML = "";
  (d.leaderboard || []).forEach((p, i) => {
    const row = document.createElement("div");
    row.className = `leader-row ${i === 0 ? "winner" : ""}`;
    row.innerHTML = `<span>${i+1}. ${esc(p.name)}</span><b>${p.score}</b>`;
    lb.appendChild(row);
  });

  if (isHost) $("restart-btn").classList.remove("hidden");
  else $("restart-btn").classList.add("hidden");
}

function restartGame() {
  send({action:"restart"});
}

function addChat(sender, text) {
  const box = $("chat");
  const row = document.createElement("div");
  row.className = "chat-line";
  row.innerHTML = `<b>${esc(sender)}</b><span>${esc(text)}</span>`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 100) box.firstChild.remove();
}

function sendChat() {
  const input = $("chat-input");
  const value = input.value.trim();
  if (!value) return;
  send({action:"chat", text:value});
  input.value = "";
}

function leaveRoom() {
  stopTimer();
  try { ws?.close(); } catch {}
  location.reload();
}

window.addEventListener("load", () => {
  const params = new URLSearchParams(location.search);
  const roomParam = (params.get("room") || "").replace(/\D/g, "").slice(0,4);
  if (roomParam) $("room").value = roomParam;

  $("room").addEventListener("input", e => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0,4);
  });

  $("name").addEventListener("keydown", e => {
    if (e.key === "Enter") createRoom();
  });
  $("room").addEventListener("keydown", e => {
    if (e.key === "Enter") joinRoom();
  });
  $("chat-input").addEventListener("keydown", e => {
    if (e.key === "Enter") sendChat();
  });
});
