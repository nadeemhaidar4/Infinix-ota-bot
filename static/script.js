// =============================================================
// WHO IS THE SPY — COMPLETE CLIENT
// Agora voice + WebSocket game state + mobile UI
// =============================================================

let ws = null;
let username = "";
let room = "";
let userCapacity = 6;
let selectedMode = "spy";

let players = [];
let categories = [];
let selectedCategory = null;
let isAlive = true;
let isReady = false;
let currentSpeaker = null;
let secretWord = "—";
let currentCategory = "Waiting";
let currentRound = 1;
let voted = false;
let soundEnabled = true;
let toastTimer = null;

let timerInterval = null;
let timerEndAt = 0;

const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4";
// Leave empty when the Agora project uses App-ID authentication.
// If the Agora project is configured for token authentication,
// set a valid channel token here or provide a backend token endpoint.
const AGORA_TOKEN = null;

let agoraClient = null;
let agoraJoined = false;
let localAudioTrack = null;
let localAudioTrackPublished = false;
let micBusy = false;
let remoteAudioTracks = new Map();
let audioUnlocked = false;
let agoraUid = null;

const clientId =
    "spy_" +
    Math.random().toString(36).slice(2) +
    Date.now().toString(36);

function $(id) {
    return document.getElementById(id);
}

function show(id) {
    const el = $(id);
    if (el) el.classList.remove("hidden");
}

function hide(id) {
    const el = $(id);
    if (el) el.classList.add("hidden");
}

function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = value ?? "";
}

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function sendWS(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(payload));
        return true;
    } catch (error) {
        console.error("WebSocket send error", error);
        return false;
    }
}

function showToast(message, ms = 2200) {
    const el = $("toast");
    if (!el) return;
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

// =============================================================
// HOME / ROOM CREATE / ROOM JOIN
// =============================================================

let homeBusy = false;
let activePollingStarted = false;
let activePollingTimer = null;

function selectMode(mode) {
    // Current game is the Spy mode. Keep the second button visually disabled
    // instead of silently switching to another unsupported mode.
    selectedMode = "spy";
    $("mode-spy")?.classList.add("selected");
    $("mode-wordless")?.classList.remove("selected");
}

function setHomeBusy(busy, text = "") {
    homeBusy = busy;
    document.querySelectorAll(".join-btn, .secondary-btn").forEach(button => {
        if (button.id === "mode-spy" || button.id === "mode-wordless") return;
        button.disabled = busy;
        button.style.pointerEvents = busy ? "none" : "";
        button.style.opacity = busy ? ".65" : "";
    });
    setText("loading-text", text);
}

async function readJson(response) {
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
        const body = await response.text();
        throw new Error(
            `Server returned an unexpected response (${response.status}). ${body.slice(0, 120)}`
        );
    }
    const data = await response.json();
    if (!response.ok || data?.error) {
        throw new Error(data?.error || `Request failed (${response.status}).`);
    }
    return data;
}

async function createRoomAndJoin() {
    const capacityInput = $("capacity");
    const capacity = Number(capacityInput?.value || 6);

    setHomeBusy(true, "Creating your room...");

    try {
        const response = await fetch(
            `/create_new_room?capacity=${encodeURIComponent(capacity)}&mode=${encodeURIComponent(selectedMode)}`,
            {
                method: "GET",
                cache: "no-store",
                headers: { "Accept": "application/json" }
            }
        );

        const data = await readJson(response);

        room = String(data.room_id || "").padStart(4, "0");
        userCapacity = Number(data.capacity || capacity);
        selectedMode = String(data.mode || "spy");

        if (!/^\d{4}$/.test(room)) {
            throw new Error("The server returned an invalid Room ID.");
        }

        $("room-code").value = room;

        await enterGameScreen(true);

    } catch (error) {
        console.error("Create room failed:", error);
        setHomeBusy(false, "");
        alert(error?.message || "Could not create room. Please try again.");
    }
}

async function findRandomRoomAndJoin() {
    const capacity = Number($("capacity")?.value || 6);

    setHomeBusy(true, "Finding a room...");

    try {
        const response = await fetch(
            `/get_random_room/${encodeURIComponent(capacity)}?mode=${encodeURIComponent(selectedMode)}`,
            {
                method: "GET",
                cache: "no-store",
                headers: { "Accept": "application/json" }
            }
        );

        const data = await readJson(response);

        room = String(data.room_id || "").padStart(4, "0");
        userCapacity = Number(data.capacity || capacity);
        selectedMode = String(data.mode || "spy");
        $("room-code").value = room;

        await enterGameScreen(false);

    } catch (error) {
        console.error("Random room failed:", error);
        setHomeBusy(false, "");
        alert(error?.message || "Could not find a room. Please try again.");
    }
}

async function joinRoomById() {
    const roomInput = $("room-code");
    const code = String(roomInput?.value || "")
        .replace(/\D/g, "")
        .slice(0, 4);

    roomInput.value = code;

    if (code.length !== 4) {
        alert("Enter the 4-digit Room ID.");
        roomInput?.focus();
        return;
    }

    setHomeBusy(true, "Checking Room ID...");

    try {
        // IMPORTANT: capacity is read from the server.
        // The joining player does NOT need to choose the host's player count.
        const response = await fetch(
            `/room_info/${encodeURIComponent(code)}`,
            {
                method: "GET",
                cache: "no-store",
                headers: { "Accept": "application/json" }
            }
        );

        const data = await readJson(response);

        if (!data.joinable) {
            if (data.state === "game_over") {
                throw new Error("This game has already ended.");
            }
            if (data.state !== "waiting") {
                throw new Error("This game has already started. You cannot join now.");
            }
            throw new Error("This room is full.");
        }

        room = code;
        userCapacity = Number(data.capacity);
        selectedMode = String(data.mode || "spy");
        $("capacity").value = String(userCapacity);

        await enterGameScreen(false);

    } catch (error) {
        console.error("Join room failed:", error);
        setHomeBusy(false, "");
        alert(error?.message || "Could not join that room.");
    }
}

async function joinRoom(mode) {
    if (homeBusy) return;

    const nameInput = $("username");
    username = String(nameInput?.value || "").trim();

    if (!username) {
        alert("Please enter your player name.");
        nameInput?.focus();
        return;
    }

    if (username.length > 20) {
        alert("Player name must be 20 characters or less.");
        return;
    }

    if (mode === "create") {
        await createRoomAndJoin();
    } else if (mode === "random") {
        await findRandomRoomAndJoin();
    } else if (mode === "join") {
        await joinRoomById();
    }
}

async function enterGameScreen(fromCreate = false) {
    hide("lobby-screen");
    show("game-screen");

    setText("room-name", room);
    setText("room-status", "Connecting to room...");
    setText("category-line", "Category: Waiting");
    setText("round-line", "Lobby");

    isReady = false;
    isAlive = true;
    players = [];
    currentSpeaker = null;
    currentRound = 1;
    voted = false;
    selectedCategory = null;
    secretWord = "—";
    currentCategory = "Waiting";
    updateWordAndCategory();
    renderPlayers();

    try {
        await connectWebSocket();
    } catch (error) {
        console.error("WebSocket connection failed:", error);
        try { ws?.close(); } catch (_) {}
        ws = null;
        hide("game-screen");
        show("lobby-screen");
        setHomeBusy(false, "");
        alert(error?.message || "Could not connect to the room.");
        return;
    }

    // Agora join is intentionally AFTER the game socket connects.
    // This prevents a failed voice service from making room creation appear broken.
    try {
        await initAgora(room);
    } catch (error) {
        console.warn("Agora init failed:", error);
        showToast("Voice service is unavailable. Room/chat will still work.", 3500);
    }

    setHomeBusy(false, "");
    hide("lobby-screen");
    show("game-screen");

    if (fromCreate) {
        showToast(`Room ${room} created. Share this 4-digit ID with your friends.`, 4500);
    }
}

function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const url =
            `${protocol}//${location.host}` +
            `/ws/${encodeURIComponent(room)}/${encodeURIComponent(userCapacity)}/${encodeURIComponent(selectedMode)}` +
            `?username=${encodeURIComponent(username)}`;

        let settled = false;

        const fail = message => {
            if (settled) return;
            settled = true;
            reject(new Error(message));
        };

        try {
            ws = new WebSocket(url);
        } catch (error) {
            console.error(error);
            fail("Could not open a connection to the game server.");
            return;
        }

        ws.onopen = () => {
            if (!settled) {
                settled = true;
                resolve();
            }
            setText("room-status", "Connected • waiting for players...");
            addSystemMessage("Connected to the room.");
            startActiveUserPolling();
        };

        ws.onmessage = event => {
            try {
                const data = JSON.parse(event.data);
                handleServerMessage(data);

                if (
                    data?.type === "error" &&
                    !settled
                ) {
                    fail(data.message || "Could not join this room.");
                }

            } catch (error) {
                console.error("Invalid server message:", error);
            }
        };

        ws.onerror = error => {
            console.warn("WebSocket error:", error);
            fail("Could not connect to the room. Please check the Room ID and try again.");
        };

        ws.onclose = event => {
            if (!settled) {
                fail(
                    event?.code === 1008
                        ? "The server rejected this room connection."
                        : "The room connection closed before joining."
                );
                return;
            }

            if (!$('game-screen')?.classList.contains("hidden")) {
                addSystemMessage("Disconnected from server.");
                setText("room-status", "Disconnected");
            }
        };
    });
}

function startActiveUserPolling() {
    if (activePollingStarted) return;
    activePollingStarted = true;

    const tick = async () => {
        try {
            const response = await fetch(
                `/get_active_users?client_id=${encodeURIComponent(clientId)}`,
                { cache: "no-store", headers: { "Accept": "application/json" } }
            );
            if (!response.ok) return;
            const data = await response.json();
            setText("active-users-count", data.active_users ?? 0);
        } catch (_) {}
    };

    tick();
    activePollingTimer = setInterval(tick, 5000);
}

// =============================================================
// SERVER MESSAGE ROUTER
// =============================================================

function handleServerMessage(data) {
    if (!data || typeof data !== "object") return;

    switch (data.type) {
        case "connected":
            players = Array.isArray(data.players) ? data.players : [];
            room = String(data.room || room);
            userCapacity = Number(data.capacity || userCapacity);
            selectedMode = String(data.mode || selectedMode);
            setText("room-name", room);
            renderPlayers();
            break;

        case "lobby_update":
            handleLobby(data);
            break;

        case "category_select":
            openCategorySelection(data);
            break;

        case "category_vote_update":
            updateCategoryCounts(data.counts || {});
            break;

        case "category_result":
            showCategoryResult(data);
            break;

        case "game_start":
            secretWord = data.word || "—";
            currentCategory = data.category || "Life";
            currentRound = Number(data.round || 1);
            isAlive = true;
            updateWordAndCategory();
            setText("round-line", `Round ${currentRound}`);
            renderPlayers();
            addSystemMessage(`Game started. Your word is ${secretWord}.`);
            break;

        case "round_start":
        case "new_round":
            currentRound = Number(data.round || currentRound + 1);
            currentCategory = data.category || currentCategory;
            players = Array.isArray(data.players) ? data.players : players;
            syncSelfAlive();
            currentSpeaker = null;
            voted = false;
            stopTimer();
            setMicState(false);
            updateWordAndCategory();
            setText("round-line", `Round ${currentRound}`);
            renderPlayers();
            addSystemMessage(`Round ${currentRound} description starts.`);
            break;

        case "turn_update":
            handleTurn(data);
            break;

        case "turn_timeout":
            showToast(`${data.current_player || "Player"}'s time is up.`);
            break;

        case "turn_ended":
            showToast(`${data.player || "Player"} passed.`);
            break;

        case "start_voting":
            openVoting(Array.isArray(data.players) ? data.players : []);
            break;

        case "vote_update":
            setText("vote-status", `Votes: ${data.count || 0}/${data.total || 0}`);
            break;

        case "vote_error":
            setText("vote-status", data.message || "Vote error.");
            break;

        case "vote_reset":
            voted = false;
            showToast(data.message || "Vote again.");
            break;

        case "vote_timeout":
            voted = false;
            showToast(data.message || "Time is up. Vote again.");
            openVoting(data.players || getAliveNames());
            break;

        case "vote_tie":
            voted = false;
            showToast(data.message || "Vote tie! Vote again.");
            openVoting(data.players || getAliveNames());
            break;

        case "vote_result":
            hide("vote-overlay");
            stopTimer();
            markPlayerDead(data.eliminated, data.role === "civilian");
            addSystemMessage(`No.${data.number} ${data.eliminated} was selected.`);
            if (data.role === "spy") {
                showEvent("Spy caught!", `No.${data.number} is out. He/She is the spy!`);
            }
            renderPlayers();
            break;

        case "reaction_phase":
            handleReactionPhase(data);
            break;

        case "chat":
            addChatMessage(data.sender, data.text);
            break;

        case "reaction":
            addReactionMessage(data.sender, data.emoji);
            break;

        case "game_over":
            handleGameOver(data);
            break;

        case "error":
            alert(data.message || "Something went wrong.");
            break;
    }
}

// =============================================================
// LOBBY / READY
// =============================================================

function handleLobby(data) {
    players = Array.isArray(data.players) ? data.players : [];
    currentSpeaker = data.current_speaker || null;
    renderPlayers();

    if (data.state === "waiting") {
        show("ready-overlay");
        const readyCount = players.filter(p => p.ready).length;
        setText("ready-status", `Players ${players.length}/${data.capacity} • Ready ${readyCount}/${data.capacity}`);
        updateReadyButton();
        renderReadyPlayers();
        setText("room-status", `Waiting • ${players.length}/${data.capacity}`);
    } else {
        hide("ready-overlay");
    }
}

function renderReadyPlayers() {
    const box = $("ready-players");
    if (!box) return;
    box.innerHTML = "";
    players.forEach(player => {
        const chip = document.createElement("div");
        chip.className = `ready-chip ${player.ready ? "ready" : ""}`;
        chip.innerHTML = `${escapeHTML(player.username)} <span>${player.ready ? "✓" : "…"}</span>`;
        box.appendChild(chip);
    });
}

async function toggleReady() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        alert("Not connected to the room.");
        return;
    }

    isReady = !isReady;
    sendWS({ action: "set_ready", ready: isReady });
    updateReadyButton();

    // This is a real user gesture. Use it to get microphone permission early.
    if (isReady) {
        try {
            await prepareMicrophone();
        } catch (error) {
            console.warn("Microphone preparation failed", error);
        }
    }
}

function updateReadyButton() {
    const button = $("ready-button");
    if (!button) return;
    button.textContent = isReady ? "✓ Ready • Cancel" : "Get Ready";
}

// =============================================================
// CATEGORY
// =============================================================

function openCategorySelection(data) {
    categories = Array.isArray(data.categories) ? data.categories : [];
    selectedCategory = null;
    hide("ready-overlay");
    show("category-overlay");
    buildCategoryButtons();
    startCountdown("category-timer", Number(data.seconds || 9), () => {
        hide("category-overlay");
    });
}

function buildCategoryButtons() {
    const grid = $("category-grid");
    if (!grid) return;
    grid.innerHTML = "";

    categories.forEach(category => {
        const button = document.createElement("button");
        button.className = "category-btn";
        button.dataset.category = category;
        button.innerHTML = `${escapeHTML(category)}<span class="count" data-count="${escapeHTML(category)}"></span>`;
        button.onclick = () => selectCategory(category);
        grid.appendChild(button);
    });
    $("category-confirm")?.classList.add("disabled");
}

function selectCategory(category) {
    selectedCategory = category;
    document.querySelectorAll(".category-btn").forEach(button => {
        button.classList.toggle("selected", button.dataset.category === category);
    });
    $("category-confirm")?.classList.remove("disabled");
    sendWS({ action: "category_vote", category });
}

function confirmCategory() {
    if (selectedCategory) {
        sendWS({ action: "category_vote", category: selectedCategory });
        showToast("Choice confirmed.");
    }
}

function updateCategoryCounts(counts) {
    document.querySelectorAll(".category-btn").forEach(button => {
        const category = button.dataset.category;
        const span = button.querySelector(".count");
        const count = Number(counts[category] || 0);
        if (span) span.textContent = count ? `${count} vote${count === 1 ? "" : "s"}` : "";
    });
}

function showCategoryResult(data) {
    hide("category-overlay");
    currentCategory = data.category || currentCategory;
    setText("chosen-category", currentCategory);
    show("category-result-overlay");
    startCountdown("category-result-timer", Number(data.seconds || 3), () => hide("category-result-overlay"));
}

// =============================================================
// GAME / WORD / PLAYERS
// =============================================================

function updateWordAndCategory() {
    setText("category-line", `Category: ${currentCategory || "Waiting"}`);
}

function syncSelfAlive() {
    const me = players.find(player => player.username === username);
    if (me) isAlive = me.alive !== false;
}

function getAliveNames() {
    return players.filter(p => p.alive !== false).map(p => p.username);
}

function getNumber(name) {
    return players.find(p => p.username === name)?.number || "";
}

function renderPlayers() {
    const grid = $("players-grid");
    if (!grid) return;

    grid.innerHTML = "";
    [...players].sort((a, b) => Number(a.number || 999) - Number(b.number || 999)).forEach(player => {
        const card = document.createElement("div");
        const speaking = currentSpeaker === player.username;
        const dead = player.alive === false;
        const initial = escapeHTML((player.username || "?").trim().charAt(0).toUpperCase() || "?");

        card.className = `player ${speaking ? "speaking" : ""} ${dead ? "dead" : ""}`;
        card.innerHTML = `
            <div class="avatar-wrap">
                <div class="avatar">${initial}</div>
                <div class="number-badge">${escapeHTML(player.number ?? "")}</div>
                ${player.ready ? '<div class="ready-badge">✓</div>' : ""}
                ${speaking && !dead ? '<div class="mic-badge">🎙️</div>' : ""}
            </div>
            <div class="player-name">${escapeHTML(player.username)}</div>
            <div class="player-state">${dead ? "OUT" : speaking ? "Speaking" : player.ready ? "Ready" : ""}</div>
        `;
        grid.appendChild(card);
    });
}

function handleTurn(data) {
    currentSpeaker = data.current_player || null;
    currentRound = Number(data.round || currentRound);
    setText("round-line", `Round ${currentRound}`);
    renderPlayers();

    if (currentSpeaker === username && isAlive) {
        startCountdown("turn-timer", Number(data.seconds || 30));
        setText("room-status", "Your turn — describe your word");
        setMicState(true);
        setText("voice-hint", "🎙️ Your mic is live. Tap mic to mute/unmute.");
    } else {
        startCountdown("turn-timer", Number(data.seconds || 30));
        setText("room-status", `${currentSpeaker || "Player"}'s turn`);
        setMicState(false);
        setText("voice-hint", "Mic turns ON automatically during your turn.");
    }
}

function markPlayerDead(name, civilian = true) {
    players = players.map(player =>
        player.username === name ? { ...player, alive: false } : player
    );
    if (name === username) {
        isAlive = false;
        setMicState(false);
    }
}

function showEvent(title, text, autoClose = 2600) {
    setText("event-title", title);
    setText("event-text", text);
    show("event-overlay");
    if (autoClose) {
        setTimeout(() => hide("event-overlay"), autoClose);
    }
}

function closeEvent() {
    hide("event-overlay");
}

function handleReactionPhase(data) {
    stopTimer();
    currentSpeaker = null;
    setMicState(false);
    hide("vote-overlay");

    if (data.dead_player === username) {
        isAlive = false;
    }

    players = Array.isArray(data.players) ? data.players : players.map(p => p.username === data.dead_player ? { ...p, alive: false } : p);
    markPlayerDead(data.dead_player);
    renderPlayers();

    setText("room-status", "Reaction phase");
    startCountdown("turn-timer", Number(data.seconds || 10));
    showEvent("Elimination", data.message || "A villager is out!", 4200);
    addSystemMessage(data.message || "A villager is out!");
    setMicState(false);
}

function handleGameOver(data) {
    stopTimer();
    currentSpeaker = null;
    setMicState(false);
    hide("vote-overlay");
    hide("category-overlay");
    hide("category-result-overlay");
    hide("event-overlay");

    const civiliansWin = data.winner === "civilians";
    setText("gameover-title", civiliansWin ? "CIVILIANS WIN! 🎉" : "SPY WINS! 🕵️");
    setText("gameover-message", data.message || "Game over.");
    setText(
        "spy-reveal",
        data.spy_player
            ? `The Spy was No.${getNumber(data.spy_player)} ${data.spy_player} • Villagers' word: ${data.word || "—"} • Spy's word: ${data.spy_word || "—"}`
            : "The Spy was revealed."
    );
    setText("room-status", "Game Over");
    show("game-over-overlay");
}

// =============================================================
// VOTING
// =============================================================

function openVoting(names) {
    const grid = $("vote-grid");
    if (!grid) return;

    stopTimer();
    voted = false;
    grid.innerHTML = "";
    setText("vote-status", isAlive ? "Choose the player you suspect." : "You are out. Spectating only.");

    if (!isAlive) {
        show("vote-overlay");
        return;
    }

    names
        .filter(name => name !== username)
        .forEach(name => {
            const button = document.createElement("button");
            button.className = "vote-btn";
            button.textContent = `No.${getNumber(name)}  ${name}`;
            button.onclick = () => castVote(name);
            grid.appendChild(button);
        });

    show("vote-overlay");
    // The countdown is intentionally restarted here after the overlay appears.
    startCountdown("turn-timer", VOTE_TIME);
    setText("room-status", "Voting Phase");
}

function castVote(target) {
    if (!isAlive || voted) return;
    voted = true;
    sendWS({ action: "cast_vote", vote: target });
    setText("vote-status", `Your vote: No.${getNumber(target)} ${target}`);
    document.querySelectorAll(".vote-btn").forEach(button => {
        button.disabled = true;
        if (button.textContent.includes(target)) button.classList.add("selected");
    });
}

// =============================================================
// COUNTDOWN
// =============================================================

function startCountdown(elementId, seconds, onEnd = null) {
    clearInterval(timerInterval);
    timerEndAt = Date.now() + Math.max(0, Number(seconds)) * 1000;

    const tick = () => {
        const left = Math.max(0, Math.ceil((timerEndAt - Date.now()) / 1000));
        setText(elementId, `${left}${elementId.includes("timer") && elementId !== "turn-timer" ? "s" : ""}`);

        if (left <= 0) {
            clearInterval(timerInterval);
            timerInterval = null;
            if (typeof onEnd === "function") onEnd();
        }
    };

    tick();
    timerInterval = setInterval(tick, 200);
}

function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    setText("turn-timer", "--");
}

// =============================================================
// CHAT / REACTIONS / MENU
// =============================================================

function addSystemMessage(text) {
    addChatMessage("System", text, true);
}

function addChatMessage(sender, text, system = false) {
    const container = $("messages");
    if (!container) return;
    const message = document.createElement("div");
    message.className = `message ${system ? "system" : ""}`;
    message.innerHTML = `<span class="sender">${escapeHTML(sender)}:</span> ${escapeHTML(text)}`;
    container.appendChild(message);
    while (container.children.length > 100) container.removeChild(container.firstElementChild);
    container.scrollTop = container.scrollHeight;
}

function addReactionMessage(sender, emoji) {
    const container = $("messages");
    if (!container) return;
    const message = document.createElement("div");
    message.className = "message reaction";
    message.innerHTML = `<span class="sender">${escapeHTML(sender)}</span> ${escapeHTML(emoji)}`;
    container.appendChild(message);
    container.scrollTop = container.scrollHeight;
}

function sendChat() {
    const input = $("chat-input");
    const text = (input?.value || "").trim();
    if (!text) return;
    if (sendWS({ action: "chat", text })) input.value = "";
}

function focusChat() {
    $("chat-input")?.focus();
}

function toggleReactions() {
    $("reaction-panel")?.classList.toggle("hidden");
}

function sendReaction(emoji) {
    hide("reaction-panel");
    sendWS({ action: "reaction", emoji });
}

function toggleSound() {
    soundEnabled = !soundEnabled;
    $("sound-button").textContent = soundEnabled ? "🔊" : "🔇";
    showToast(soundEnabled ? "Sound on" : "Sound off");
    hide("menu-overlay");
}

function toggleMenu() {
    show("menu-overlay");
}

function openRules() {
    hide("menu-overlay");
    show("rules-overlay");
}

function showPlayerCount() {
    showToast(`Alive players: ${players.filter(p => p.alive !== false).length}/${players.length}`);
}

function leaveGame() {
    try { closeAgora(); } catch (_) {}
    try { ws?.close(); } catch (_) {}
    location.reload();
}

// =============================================================
// AGORA VOICE — RELIABLE FLOW
// =============================================================

async function initAgora(channelName) {
    if (agoraClient) return;
    if (typeof AgoraRTC === "undefined") {
        throw new Error("Agora SDK is not loaded.");
    }

    agoraClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

    agoraClient.on("user-published", async (user, mediaType) => {
        try {
            await agoraClient.subscribe(user, mediaType);
            if (mediaType === "audio" && user.audioTrack) {
                remoteAudioTracks.set(String(user.uid), user.audioTrack);
                playRemoteTrack(user.audioTrack);
            }
        } catch (error) {
            console.warn("Agora subscribe error", error);
        }
    });

    agoraClient.on("user-unpublished", user => {
        remoteAudioTracks.delete(String(user.uid));
    });

    agoraClient.on("user-left", user => {
        remoteAudioTracks.delete(String(user.uid));
    });

    agoraClient.on("connection-state-change", state => {
        if (state === "DISCONNECTED") showToast("Voice connection lost. Retrying...");
    });

    agoraUid = `spy_${clientId}_${Math.random().toString(36).slice(2, 8)}`.slice(0, 64);

    await agoraClient.join(
        AGORA_APP_ID,
        `spy-${String(channelName)}`,
        AGORA_TOKEN,
        agoraUid
    );

    agoraJoined = true;
}

function playRemoteTrack(track) {
    if (!track) return;
    try {
        const promise = track.play();
        if (promise?.catch) {
            promise.catch(() => {
                show("audio-unlock");
            });
        }
    } catch (_) {
        show("audio-unlock");
    }
}

async function unlockAudio() {
    audioUnlocked = true;
    hide("audio-unlock");
    for (const track of remoteAudioTracks.values()) {
        try { await track.play(); } catch (_) {}
    }
}

async function requestMicrophone() {
    try {
        await prepareMicrophone();
        showToast("Microphone permission is ready.");
    } catch (error) {
        console.error(error);
        alert("Microphone could not start. Please allow microphone access for this site, then try again.");
    }
    hide("menu-overlay");
}

async function prepareMicrophone() {
    if (!agoraClient || !agoraJoined) {
        try {
            await initAgora(room);
        } catch (error) {
            throw error;
        }
    }

    if (localAudioTrack) return true;
    if (micBusy) return false;
    micBusy = true;

    try {
        localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
            encoderConfig: "speech_low_quality",
            AEC: true,
            AGC: true,
            ANS: true
        });

        // Keep the track muted until our turn starts.
        await localAudioTrack.setMuted(true);

        if (!localAudioTrackPublished) {
            await agoraClient.publish([localAudioTrack]);
            localAudioTrackPublished = true;
        }

        updateMicUI(false);
        return true;
    } finally {
        micBusy = false;
    }
}

async function setMicState(shouldBeOn) {
    if (!localAudioTrack) {
        if (!shouldBeOn) {
            updateMicUI(false);
            return;
        }

        // Automatically creating a microphone outside a gesture can be rejected by some browsers.
        // The Ready/Enable microphone buttons call prepareMicrophone() early, so this normally exists.
        try {
            await prepareMicrophone();
        } catch (_) {
            updateMicUI(false);
            showToast("Tap 🎤 once to allow microphone access.", 3000);
            return;
        }
    }

    if (!isAlive || currentSpeaker !== username) shouldBeOn = false;

    try {
        await localAudioTrack.setMuted(!shouldBeOn);
        updateMicUI(shouldBeOn);
    } catch (error) {
        console.warn("Mic mute/unmute error", error);
        updateMicUI(false);
    }
}

async function toggleMic() {
    if (!isAlive) {
        showToast("You are eliminated.");
        return;
    }

    // First tap outside a turn is intentionally a permission gesture.
    if (!localAudioTrack) {
        try {
            await prepareMicrophone();
            if (currentSpeaker === username) {
                await setMicState(true);
            } else {
                showToast("Mic ready — it will go live on your turn.");
            }
        } catch (error) {
            console.error(error);
            alert("Please allow microphone access and try again.");
        }
        return;
    }

    if (currentSpeaker !== username) {
        showToast("Microphone is available during your turn.");
        return;
    }

    const currentlyMuted = localAudioTrack.isMuted === true;
    await setMicState(currentlyMuted);
}

function updateMicUI(isOn = false) {
    const button = $("mic-button");
    if (!button) return;

    button.classList.toggle("active", !!isOn);
    button.textContent = isOn ? "🎙️" : "🎤";

    if (!isAlive) {
        button.classList.add("disabled");
        return;
    }
    button.classList.remove("disabled");
}

async function closeAgora() {
    try {
        if (localAudioTrack) {
            try { localAudioTrack.stop(); } catch (_) {}
            try { localAudioTrack.close(); } catch (_) {}
        }
        localAudioTrack = null;
        localAudioTrackPublished = false;

        if (agoraClient && agoraJoined) {
            await agoraClient.leave();
        }
    } catch (_) {}

    remoteAudioTracks.clear();
    agoraJoined = false;
    agoraClient = null;
}

// =============================================================
// INITIAL EVENTS
// =============================================================

window.addEventListener("load", () => {
    const roomInput = $("room-code");
    const nameInput = $("username");
    const chatInput = $("chat-input");

    roomInput?.addEventListener("input", e => {
        e.target.value = String(e.target.value || "").replace(/\D/g, "").slice(0, 4);
    });

    nameInput?.addEventListener("keydown", e => {
        if (e.key !== "Enter") return;
        const code = String(roomInput?.value || "").replace(/\D/g, "");
        joinRoom(code.length === 4 ? "join" : "create");
    });

    roomInput?.addEventListener("keydown", e => {
        if (e.key === "Enter") joinRoom("join");
    });

    chatInput?.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            e.preventDefault();
            sendChat();
        }
    });

    document.addEventListener("click", () => {
        if (remoteAudioTracks.size && !audioUnlocked) {
            unlockAudio();
        }
    }, { once: false, passive: true });

    updateMicUI(false);

    const urlRoom = new URLSearchParams(location.search).get("room");
    if (urlRoom && /^\d{4}$/.test(urlRoom)) {
        roomInput.value = urlRoom;
        roomInput.focus();
    }
});

window.addEventListener("beforeunload", () => {
    try { closeAgora(); } catch (_) {}
});
