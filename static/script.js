// =========================================================
// GLOBAL STATE
// =========================================================

let ws = null;

let username = "";
let room = "";

let selectedGameMode = "spy";
let userCapacity = 6;

let isAlive = true;
let isReady = false;

let players = [];
let currentSpeaker = null;

let currentTimerInterval = null;
let currentTimerTimeout = null;

let rtcClient = null;
let localAudioTrack = null;
let agoraJoined = false;
let micBusy = false;

let soundEnabled = true;

let turnSeconds = 30;
let activeTurnId = 0;

const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4";

const myClientId =
    Math.random().toString(36).substring(2, 15) +
    Date.now().toString(36);


// =========================================================
// DOM HELPERS
// =========================================================

function $(id) {
    return document.getElementById(id);
}


function setText(id, text) {
    const el = $(id);

    if (el) {
        el.textContent = text;
    }
}


function show(id) {
    const el = $(id);

    if (el) {
        el.classList.remove("hidden");
    }
}


function hide(id) {
    const el = $(id);

    if (el) {
        el.classList.add("hidden");
    }
}


// =========================================================
// HTML ESCAPE
// =========================================================

function escapeHTML(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}


// =========================================================
// SOUND
// =========================================================

function playSound(type) {

    if (!soundEnabled) {
        return;
    }

    let el = null;

    switch (type) {

        case "click":
            el = $("sound-click");
            break;

        case "start":
            el = $("sound-start");
            break;

        case "turn":
            el = $("sound-turn");
            break;

        case "timeout":
            el = $("sound-timeout");
            break;

        case "win":
            el = $("sound-win");
            break;

        case "lose":
            el = $("sound-lose");
            break;
    }

    if (!el) {
        return;
    }

    try {
        el.currentTime = 0;

        const promise = el.play();

        if (promise && typeof promise.catch === "function") {
            promise.catch(() => {});
        }
    } catch (_) {}
}


// =========================================================
// MODE
// =========================================================

function selectGameMode(mode) {

    playSound("click");

    selectedGameMode =
        mode === "wordless"
            ? "wordless"
            : "spy";

    const spyButton = $("mode-spy");
    const wordlessButton = $("mode-wordless");

    spyButton.classList.remove("selected");
    wordlessButton.classList.remove("selected");

    if (selectedGameMode === "spy") {
        spyButton.classList.add("selected");
    } else {
        wordlessButton.classList.add("selected");
    }
}


// =========================================================
// ACTIVE USERS
// =========================================================

async function fetchActiveUsers() {

    try {

        const response = await fetch(
            `/get_active_users?client_id=${encodeURIComponent(myClientId)}`,
            {
                cache: "no-store"
            }
        );

        if (!response.ok) {
            return;
        }

        const data = await response.json();

        setText(
            "active-users-count",
            data.active_users ?? 0
        );

    } catch (_) {}
}


window.addEventListener(
    "load",
    () => {

        fetchActiveUsers();

        setInterval(
            fetchActiveUsers,
            5000
        );

        $("chat-input").addEventListener(
            "keydown",
            function(event) {

                if (event.key === "Enter") {

                    event.preventDefault();

                    sendChat();
                }
            }
        );
    }
);


// =========================================================
// JOIN ROOM
// =========================================================

async function joinRoom(mode) {

    playSound("click");

    const nameInput = $("username");
    const capacityInput = $("capacity");

    username = nameInput.value.trim();

    userCapacity =
        Number(capacityInput.value) || 6;

    if (!username) {

        alert("Please enter your player name.");

        nameInput.focus();

        return;
    }

    if (username.length > 20) {

        alert("Player name must be 20 characters or less.");

        return;
    }

    // Basic validation.
    username = username.replace(
        /[\u0000-\u001F\u007F]/g,
        ""
    ).trim();

    if (!username) {
        alert("Please enter a valid player name.");
        return;
    }

    $("loading-text").textContent =
        mode === "random"
            ? "Finding a room..."
            : mode === "create"
                ? "Creating room..."
                : "Joining room...";

    let roomId = "";

    try {

        if (mode === "random") {

            const response = await fetch(
                `/get_random_room/${userCapacity}?mode=${encodeURIComponent(selectedGameMode)}`,
                {
                    cache: "no-store"
                }
            );

            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(
                    data.error || "Unable to find room."
                );
            }

            roomId = String(data.room_id);

        } else if (mode === "create") {

            const response = await fetch(
                `/create_new_room?capacity=${userCapacity}&mode=${encodeURIComponent(selectedGameMode)}`,
                {
                    cache: "no-store"
                }
            );

            const data = await response.json();

            if (!response.ok || data.error) {
                throw new Error(
                    data.error || "Unable to create room."
                );
            }

            roomId = String(data.room_id);

        } else {

            const entered = prompt(
                "Enter Room Code:"
            );

            if (!entered) {

                $("loading-text").textContent = "";

                return;
            }

            roomId = entered.trim();

            if (!roomId) {

                $("loading-text").textContent = "";

                return;
            }
        }

    } catch (error) {

        console.error(error);

        $("loading-text").textContent = "";

        alert(
            error?.message ||
            "Server error. Please try again."
        );

        return;
    }

    room = roomId;

    $("loading-text").textContent =
        `Connecting to room ${room}...`;

    // Change screen.
    hide("lobby-screen");
    show("game-screen");

    setText(
        "room-name",
        room
    );

    setText(
        "room-status",
        "Connecting..."
    );

    isReady = false;
    isAlive = true;
    players = [];
    currentSpeaker = null;

    resetReadyButton();
    stopTurnTimer();
    closeAllOverlays();

    renderPlayers();

    connectWebSocket();

    // Join Agora without opening the microphone.
    // Microphone is created only when our turn starts.
    try {

        await initAgora(
            room
        );

    } catch (error) {

        console.error(
            "Agora initialization error:",
            error
        );

        // Game can continue even when voice fails.
        addSystemMessage(
            "Voice chat could not initialize. Text chat is still available."
        );
    }

    $("loading-text").textContent = "";
}


// =========================================================
// WEBSOCKET
// =========================================================

function connectWebSocket() {

    const protocol =
        window.location.protocol === "https:"
            ? "wss:"
            : "ws:";

    const wsUrl =
        `${protocol}//${window.location.host}` +
        `/ws/${encodeURIComponent(room)}` +
        `/${encodeURIComponent(userCapacity)}` +
        `/${encodeURIComponent(selectedGameMode)}` +
        `?username=${encodeURIComponent(username)}`;

    try {

        ws = new WebSocket(wsUrl);

    } catch (error) {

        console.error(error);

        alert("Could not connect to the game server.");

        return;
    }

    ws.onopen = function() {

        setText(
            "room-status",
            "Waiting for players..."
        );

        addSystemMessage(
            "Connected to the room."
        );
    };


    ws.onmessage = function(event) {

        try {

            const data =
                JSON.parse(event.data);

            handleServerMessage(data);

        } catch (error) {

            console.error(
                "Invalid server message:",
                error
            );
        }
    };


    ws.onerror = function(error) {

        console.error(
            "WebSocket error:",
            error
        );
    };


    ws.onclose = function() {

        if (
            $("game-screen").classList.contains("hidden")
        ) {
            return;
        }

        if (
            $("game-over-overlay").classList.contains("hidden")
        ) {

            addSystemMessage(
                "Disconnected from server."
            );

            setText(
                "room-status",
                "Disconnected"
            );

        }
    };
}


// =========================================================
// SEND WS
// =========================================================

function sendWS(payload) {

    if (!ws) {
        return false;
    }

    if (ws.readyState !== WebSocket.OPEN) {
        return false;
    }

    try {

        ws.send(
            JSON.stringify(payload)
        );

        return true;

    } catch (error) {

        console.error(error);

        return false;
    }
}


// =========================================================
// READY
// =========================================================

function toggleReady() {

    playSound("click");

    if (!ws || ws.readyState !== WebSocket.OPEN) {

        alert("Not connected to the room.");

        return;
    }

    if (
        !$("ready-button") ||
        $("ready-button").disabled
    ) {
        return;
    }

    isReady = !isReady;

    sendWS({
        action: "set_ready",
        ready: isReady
    });

    updateReadyButton();
}


function resetReadyButton() {

    isReady = false;

    const button = $("ready-button");

    if (!button) {
        return;
    }

    button.disabled = false;

    button.classList.remove(
        "ready-state",
        "cancel-state"
    );

    button.textContent = "Get Ready";
}


function updateReadyButton() {

    const button = $("ready-button");

    if (!button) {
        return;
    }

    if (isReady) {

        button.classList.add(
            "ready-state"
        );

        button.classList.remove(
            "cancel-state"
        );

        button.textContent =
            "✓ Ready • Cancel";

    } else {

        button.classList.remove(
            "ready-state"
        );

        button.classList.add(
            "cancel-state"
        );

        button.textContent =
            "Get Ready";
    }
}


function hideReadyButton() {

    const button = $("ready-button");

    if (button) {
        button.classList.add("hidden");
    }
}


function showReadyButton() {

    const button = $("ready-button");

    if (!button) {
        return;
    }

    button.classList.remove("hidden");
}


// =========================================================
// SERVER MESSAGES
// =========================================================

function handleServerMessage(data) {

    if (!data || typeof data !== "object") {
        return;
    }

    switch (data.type) {

        case "error":

            alert(
                data.message ||
                "Something went wrong."
            );

            break;


        // -------------------------------------------------
        // LOBBY
        // -------------------------------------------------

        case "lobby_update":

            players =
                Array.isArray(data.players)
                    ? data.players
                    : [];

            currentSpeaker =
                data.current_speaker || null;

            renderPlayers();

            setText(
                "room-status",
                getStatusText(data)
            );

            if (data.state === "waiting") {

                showReadyButton();

                $("ready-button").disabled = false;

            } else {

                hideReadyButton();

            }

            break;


        // -------------------------------------------------
        // CHAT
        // -------------------------------------------------

        case "chat":

            addChatMessage(
                data.sender,
                data.text
            );

            break;


        // -------------------------------------------------
        // REACTION
        // -------------------------------------------------

        case "reaction":

            addReactionMessage(
                data.sender,
                data.emoji
            );

            break;


        // -------------------------------------------------
        // GAME START
        // -------------------------------------------------

        case "game_start":

            playSound("start");

            isAlive = true;

            activeTurnId = 0;

            players =
                Array.isArray(data.players)
                    ? data.players.map(function(player) {

                        if (typeof player === "string") {

                            return {
                                username: player,
                                ready: true,
                                alive: true
                            };
                        }

                        return {
                            username: player.username,
                            ready: true,
                            alive:
                                player.alive !== false
                        };

                    })
                    : [];

            hideReadyButton();

            show("secret-banner");

            showSecret(
                data.role,
                data.word,
                data.mode
            );

            setText(
                "room-status",
                "Match Started"
            );

            setAlert(
                "Game Started! Check your secret word."
            );

            renderPlayers();

            break;


        // -------------------------------------------------
        // TURN UPDATE
        // -------------------------------------------------

        case "turn_update":

            currentSpeaker =
                data.current_player || null;

            activeTurnId =
                Number(data.turn_id || 0);

            setText(
                "room-status",
                `${currentSpeaker || "?"}'s turn`
            );

            if (
                currentSpeaker === username &&
                isAlive
            ) {

                playSound("turn");

                setAlert(
                    "🎙️ Your turn! Describe your word."
                );

                startTurnTimer(
                    Number(data.seconds || 30)
                );

                setMicState(
                    true
                );

            } else {

                setAlert(
                    `🎙️ ${currentSpeaker || "Player"} is speaking...`
                );

                stopTurnTimer();

                setMicState(
                    false
                );
            }

            renderPlayers();

            break;


        // -------------------------------------------------
        // TURN TIMEOUT
        // -------------------------------------------------

        case "turn_timeout":

            playSound("timeout");

            setAlert(
                `${data.current_player || "Player"}'s time is up.`
            );

            break;


        // -------------------------------------------------
        // TURN ENDED
        // -------------------------------------------------

        case "turn_ended":

            if (data.player === username) {

                setAlert(
                    "Your turn ended."
                );

            } else {

                setAlert(
                    `${data.player} passed the mic.`
                );
            }

            break;


        // -------------------------------------------------
        // START VOTING
        // -------------------------------------------------

        case "start_voting":

            currentSpeaker = null;

            stopTurnTimer();

            setMicState(
                false
            );

            renderPlayers();

            if (isAlive) {

                openVoting(
                    Array.isArray(data.players)
                        ? data.players
                        : []
                );

                setAlert(
                    "Voting Phase"
                );

            } else {

                setAlert(
                    "Voting Phase • You are spectating."
                );
            }

            break;


        // -------------------------------------------------
        // VOTE UPDATE
        // -------------------------------------------------

        case "vote_update":

            setText(
                "vote-status",
                `Votes: ${data.count || 0}/${data.total || 0}`
            );

            break;


        // -------------------------------------------------
        // VOTE ERROR
        // -------------------------------------------------

        case "vote_error":

            setText(
                "vote-status",
                data.message || "Vote error."
            );

            break;


        // -------------------------------------------------
        // VOTE TIE
        // -------------------------------------------------

        case "vote_tie":

            playSound("timeout");

            hide("vote-overlay");

            setAlert(
                data.message ||
                "Vote tie! Vote again."
            );

            setTimeout(
                function() {

                    if (isAlive) {

                        openVoting(
                            Array.isArray(data.players)
                                ? getAliveNames()
                                : getAliveNames()
                        );
                    }

                },
                700
            );

            break;


        // -------------------------------------------------
        // VOTE RESET
        // -------------------------------------------------

        case "vote_reset":

            setAlert(
                data.message ||
                "Voting again."
            );

            break;


        // -------------------------------------------------
        // REACTION PHASE
        // -------------------------------------------------

        case "reaction_phase":

            playSound("lose");

            stopTurnTimer();

            setMicState(
                false
            );

            hide("vote-overlay");

            setAlert(
                data.message ||
                "Reaction phase."
            );

            markPlayerDead(
                data.dead_player
            );

            if (
                data.dead_player === username
            ) {

                isAlive = false;

                setMicState(
                    false
                );

                addSystemMessage(
                    "You were eliminated. You can spectate."
                );

            } else if (isAlive) {

                // Voice is kept disabled during reaction.
                setMicState(false);
            }

            renderPlayers();

            break;


        // -------------------------------------------------
        // NEW ROUND
        // -------------------------------------------------

        case "new_round":

            playSound("start");

            currentSpeaker = null;

            stopTurnTimer();

            setMicState(
                false
            );

            setAlert(
                "New round started."
            );

            break;


        // -------------------------------------------------
        // GAME OVER
        // -------------------------------------------------

        case "game_over":

            stopTurnTimer();

            setMicState(
                false
            );

            hide("vote-overlay");

            showGameOver(
                data.winner,
                data.message,
                data.spy_player
            );

            break;


        // -------------------------------------------------
        // PONG
        // -------------------------------------------------

        case "pong":

            break;
    }
}


// =========================================================
// STATUS
// =========================================================

function getStatusText(data) {

    if (data.state === "waiting") {

        const count =
            Array.isArray(data.players)
                ? data.players.length
                : 0;

        const readyCount =
            Array.isArray(data.players)
                ? data.players.filter(
                    p => p.ready
                ).length
                : 0;

        return `Waiting • ${count}/${data.capacity} • Ready ${readyCount}/${data.capacity}`;
    }

    if (data.state === "playing") {
        return "Game in progress";
    }

    if (data.state === "voting") {
        return "Voting";
    }

    if (data.state === "reaction") {
        return "Reaction phase";
    }

    if (data.state === "game_over") {
        return "Game Over";
    }

    return "Waiting...";
}


// =========================================================
// PLAYER GRID
// =========================================================

function renderPlayers() {

    const grid = $("players-grid");

    if (!grid) {
        return;
    }

    grid.innerHTML = "";

    const totalSlots =
        Math.max(
            Number(userCapacity || 6),
            players.length
        );

    for (
        let index = 0;
        index < totalSlots;
        index++
    ) {

        const player =
            players[index];

        if (!player) {

            grid.appendChild(
                createEmptyPlayerCard(
                    index + 1
                )
            );

            continue;
        }

        grid.appendChild(
            createPlayerCard(
                player,
                index + 1
            )
        );
    }
}


function createEmptyPlayerCard(number) {

    const wrapper =
        document.createElement("div");

    wrapper.className =
        "player-card empty-card";

    wrapper.innerHTML = `
        <div class="avatar-ring">
            <div class="avatar-face">
                <span class="empty-plus">+</span>
            </div>
            <div class="number-badge">
                ${number}
            </div>
        </div>

        <div class="player-name">
            Empty
        </div>
    `;

    return wrapper;
}


function createPlayerCard(player, number) {

    const wrapper =
        document.createElement("div");

    wrapper.className =
        "player-card";

    const name =
        String(player.username || "Player");

    const initial =
        name.charAt(0).toUpperCase();

    const isMe =
        name === username;

    const alive =
        player.alive !== false;

    const ready =
        player.ready === true;

    const speaking =
        name === currentSpeaker;

    let ringClass = "";

    if (!alive) {
        ringClass = "dead";
    } else if (speaking) {
        ringClass = "speaking";
    } else if (ready) {
        ringClass = "ready";
    }

    let badge = "";

    if (!alive) {

        badge =
            `<div class="dead-badge">💀</div>`;

    } else if (speaking) {

        badge =
            `<div class="mic-badge">🎤</div>`;

    } else if (
        ready &&
        !currentSpeaker
    ) {

        badge =
            `<div class="ready-badge">✓</div>`;
    }

    wrapper.innerHTML = `
        <div class="avatar-ring ${ringClass}">

            <div class="number-badge">
                ${number}
            </div>

            <div class="avatar-face">
                ${escapeHTML(initial)}
            </div>

            ${badge}

        </div>

        <div class="player-name ${isMe ? "you-label" : ""}">
            ${escapeHTML(
                isMe ? "You" : name
            )}
        </div>
    `;

    return wrapper;
}


function markPlayerDead(deadPlayer) {

    players =
        players.map(function(player) {

            if (
                player.username === deadPlayer
            ) {

                return {
                    ...player,
                    alive: false,
                    ready: false
                };
            }

            return player;
        });

    renderPlayers();
}


function getAliveNames() {

    return players
        .filter(
            player => player.alive !== false
        )
        .map(
            player => player.username
        );
}


// =========================================================
// SECRET WORD
// =========================================================

function showSecret(
    role,
    word,
    mode
) {

    const value =
        $("secret-value");

    const roleText =
        $("secret-role");

    if (role === "spy") {

        if (mode === "wordless") {

            value.textContent =
                "NO WORD";

            roleText.textContent =
                "🕵️ You are the SPY • Guess the word from descriptions.";

        } else {

            value.textContent =
                word || "SPY WORD";

            roleText.textContent =
                "🕵️ You are the SPY • You have a different word.";

        }

        value.style.color =
            "#ff6a73";

    } else {

        value.textContent =
            word || "WORD";

        roleText.textContent =
            "👨‍👩‍👧 You are a VILLAGER • Find the Spy.";

        value.style.color =
            "#ffe15b";
    }
}


// =========================================================
// TIMER
// =========================================================

function startTurnTimer(seconds) {

    stopTurnTimer();

    turnSeconds =
        Math.max(
            1,
            Number(seconds || 30)
        );

    const timerWrap =
        $("timer-wrap");

    const progress =
        $("timer-progress");

    const text =
        $("timer-text");

    timerWrap.classList.add(
        "show"
    );

    progress.classList.remove(
        "warning",
        "danger"
    );

    progress.style.width =
        "100%";

    updateTimerUI();

    currentTimerInterval =
        setInterval(
            function() {

                turnSeconds--;

                updateTimerUI();

                if (turnSeconds <= 10) {

                    progress.classList.add(
                        "warning"
                    );

                    progress.classList.remove(
                        "danger"
                    );
                }

                if (turnSeconds <= 5) {

                    progress.classList.add(
                        "danger"
                    );

                    progress.classList.remove(
                        "warning"
                    );

                    if (turnSeconds > 0) {
                        playSound("timeout");
                    }
                }

                if (turnSeconds <= 0) {

                    clearInterval(
                        currentTimerInterval
                    );

                    currentTimerInterval =
                        null;
                }

            },
            1000
        );
}


function updateTimerUI() {

    const text =
        $("timer-text");

    const progress =
        $("timer-progress");

    if (!text || !progress) {
        return;
    }

    text.textContent =
        `YOUR TURN: ${Math.max(0, turnSeconds)}s`;

    const percent =
        Math.max(
            0,
            Math.min(
                100,
                (turnSeconds / 30) * 100
            )
        );

    progress.style.width =
        `${percent}%`;
}


function stopTurnTimer() {

    if (currentTimerInterval) {

        clearInterval(
            currentTimerInterval
        );

        currentTimerInterval =
            null;
    }

    if (currentTimerTimeout) {

        clearTimeout(
            currentTimerTimeout
        );

        currentTimerTimeout =
            null;
    }

    const timerWrap =
        $("timer-wrap");

    if (timerWrap) {

        timerWrap.classList.remove(
            "show"
        );
    }
}


// =========================================================
// TURN
// =========================================================

function endMyTurn() {

    playSound("click");

    if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
    }

    if (!isAlive) {
        return;
    }

    if (currentSpeaker !== username) {
        return;
    }

    sendWS({
        action: "end_turn"
    });

    stopTurnTimer();

    setMicState(
        false
    );
}


// =========================================================
// VOTING
// =========================================================

function openVoting(playerNames) {

    const overlay =
        $("vote-overlay");

    const grid =
        $("vote-grid");

    if (!overlay || !grid) {
        return;
    }

    grid.innerHTML = "";

    const candidates =
        Array.from(
            new Set(
                playerNames
                    .filter(
                        name =>
                            name &&
                            name !== username
                    )
            )
        );

    if (!candidates.length) {

        setText(
            "vote-status",
            "No available targets."
        );

    } else {

        setText(
            "vote-status",
            "Choose the player you suspect."
        );
    }

    candidates.forEach(
        function(playerName, index) {

            const button =
                document.createElement("button");

            button.className =
                "vote-btn";

            button.type =
                "button";

            button.textContent =
                `${index + 1}. ${playerName}`;

            button.addEventListener(
                "click",
                function() {

                    castVote(
                        playerName
                    );
                }
            );

            grid.appendChild(
                button
            );
        }
    );

    show("vote-overlay");
}


function castVote(player) {

    playSound("click");

    if (!isAlive) {
        return;
    }

    if (!player) {
        return;
    }

    const success =
        sendWS({
            action: "cast_vote",
            vote: player
        });

    if (!success) {
        return;
    }

    const grid =
        $("vote-grid");

    if (grid) {

        grid.innerHTML = "";

        const waiting =
            document.createElement("div");

        waiting.style.gridColumn =
            "1 / -1";

        waiting.style.textAlign =
            "center";

        waiting.style.fontWeight =
            "900";

        waiting.style.padding =
            "15px";

        waiting.textContent =
            `🎯 Target Locked: ${player}`;

        grid.appendChild(
            waiting
        );
    }

    setText(
        "vote-status",
        "Waiting for other players..."
    );
}


// =========================================================
// CHAT
// =========================================================

function sendChat() {

    playSound("click");

    const input =
        $("chat-input");

    if (!input) {
        return;
    }

    const text =
        input.value.trim();

    if (!text) {
        return;
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {

        alert("Not connected to the room.");

        return;
    }

    sendWS({
        action: "chat",
        text: text
    });

    input.value = "";
}


function addChatMessage(
    sender,
    text
) {

    const container =
        $("messages");

    if (!container) {
        return;
    }

    const message =
        document.createElement("div");

    message.className =
        sender === "System"
            ? "message system"
            : "message";

    if (sender === "System") {

        message.textContent =
            text || "";

    } else {

        message.innerHTML =
            `<span class="sender">${
                escapeHTML(sender)
            }:</span> ${
                escapeHTML(text)
            }`;
    }

    container.appendChild(
        message
    );

    trimMessages();

    container.scrollTop =
        container.scrollHeight;
}


function addSystemMessage(text) {

    addChatMessage(
        "System",
        text
    );
}


function addReactionMessage(
    sender,
    emoji
) {

    const container =
        $("messages");

    if (!container) {
        return;
    }

    const message =
        document.createElement("div");

    message.className =
        "message reaction";

    message.innerHTML =
        `<strong>${escapeHTML(sender)}</strong> ${escapeHTML(emoji)}`;

    container.appendChild(
        message
    );

    trimMessages();

    container.scrollTop =
        container.scrollHeight;
}


function trimMessages() {

    const container =
        $("messages");

    if (!container) {
        return;
    }

    while (
        container.children.length > 100
    ) {

        container.removeChild(
            container.firstElementChild
        );
    }
}


// =========================================================
// REACTIONS
// =========================================================

function toggleReactions() {

    playSound("click");

    const panel =
        $("reaction-panel");

    panel.classList.toggle(
        "hidden"
    );
}


function sendReaction(emoji) {

    playSound("click");

    hide("reaction-panel");

    sendWS({
        action: "reaction",
        emoji: emoji
    });
}


// =========================================================
// MIC / AGORA
// =========================================================

async function initAgora(channelName) {

    if (
        typeof AgoraRTC === "undefined"
    ) {

        throw new Error(
            "Agora SDK is not loaded."
        );
    }

    rtcClient =
        AgoraRTC.createClient({
            mode: "rtc",
            codec: "vp8"
        });

    rtcClient.on(
        "user-published",
        async function(
            user,
            mediaType
        ) {

            try {

                await rtcClient.subscribe(
                    user,
                    mediaType
                );

                if (
                    mediaType === "audio" &&
                    user.audioTrack
                ) {

                    user.audioTrack.play();
                }

            } catch (error) {

                console.error(
                    "Agora subscribe error:",
                    error
                );
            }
        }
    );


    rtcClient.on(
        "user-unpublished",
        function(user, mediaType) {

            console.log(
                "Agora user unpublished:",
                user.uid,
                mediaType
            );
        }
    );


    rtcClient.on(
        "user-left",
        function(user) {

            console.log(
                "Agora user left:",
                user.uid
            );
        }
    );


    // Use a unique browser-session UID.
    const agoraUid =
        (
            "spy_" +
            myClientId +
            "_" +
            Math.random()
                .toString(36)
                .substring(2, 8)
        ).substring(0, 64);

    /*
     * The current project uses an Agora App ID without a token.
     * This works only when the Agora project is configured for
     * App ID authentication. If the project requires tokens,
     * a backend token endpoint must be added.
     */

    await rtcClient.join(
        AGORA_APP_ID,
        String(channelName),
        null,
        agoraUid
    );

    agoraJoined = true;

    // IMPORTANT:
    // Do not create microphone track here.
    // It will be created only on the player's turn.
    updateMicUI(false);
}


// ---------------------------------------------------------
// START LOCAL MIC
// ---------------------------------------------------------

async function startLocalMicrophone() {

    if (micBusy) {
        return;
    }

    if (!rtcClient || !agoraJoined) {

        return;
    }

    micBusy = true;

    try {

        if (!localAudioTrack) {

            localAudioTrack =
                await AgoraRTC.createMicrophoneAudioTrack(
                    {
                        encoderConfig: "speech_low_quality"
                    }
                );

            await rtcClient.publish(
                [localAudioTrack]
            );
        }

        await localAudioTrack.setMuted(
            false
        );

        updateMicUI(true);

    } catch (error) {

        console.error(
            "Microphone error:",
            error
        );

        updateMicUI(false);

        let message =
            "Microphone could not start.";

        if (
            error &&
            error.message
        ) {

            message =
                `Microphone error: ${error.message}`;
        }

        addSystemMessage(
            message
        );

        alert(
            "Microphone could not start. " +
            "Please allow microphone permission for this site, " +
            "then try again."
        );

    } finally {

        micBusy = false;
    }
}


// ---------------------------------------------------------
// STOP LOCAL MIC
// ---------------------------------------------------------

async function stopLocalMicrophone() {

    if (!localAudioTrack) {

        updateMicUI(false);

        return;
    }

    try {

        await localAudioTrack.setMuted(
            true
        );

    } catch (_) {}

    updateMicUI(false);
}


// ---------------------------------------------------------
// PUBLIC MIC TOGGLE
// ---------------------------------------------------------

async function toggleMic() {

    playSound("click");

    if (!isAlive) {

        alert(
            "You are eliminated and can only spectate."
        );

        return;
    }

    if (currentSpeaker !== username) {

        alert(
            "Microphone is available only during your turn."
        );

        return;
    }

    if (!localAudioTrack) {

        await startLocalMicrophone();

        return;
    }

    try {

        const currentlyMuted =
            localAudioTrack.isMuted;

        await localAudioTrack.setMuted(
            !currentlyMuted
        );

        updateMicUI(
            currentlyMuted
        );

    } catch (error) {

        console.error(
            error
        );

        updateMicUI(false);
    }
}


// ---------------------------------------------------------
// MIC STATE
// ---------------------------------------------------------

async function setMicState(
    shouldBeOn
) {

    if (!shouldBeOn) {

        await stopLocalMicrophone();

        return;
    }

    if (!isAlive) {

        await stopLocalMicrophone();

        return;
    }

    if (
        currentSpeaker !== username
    ) {

        await stopLocalMicrophone();

        return;
    }

    if (!localAudioTrack) {

        await startLocalMicrophone();

        return;
    }

    try {

        await localAudioTrack.setMuted(
            false
        );

        updateMicUI(true);

    } catch (_) {

        updateMicUI(false);
    }
}


// ---------------------------------------------------------
// MIC UI
// ---------------------------------------------------------

function updateMicUI(
    isOn
) {

    const button =
        $("mic-button");

    if (!button) {
        return;
    }

    if (isOn) {

        button.classList.add(
            "active"
        );

        button.classList.remove(
            "off"
        );

        button.textContent =
            "🎙️";

    } else {

        button.classList.remove(
            "active"
        );

        button.classList.add(
            "off"
        );

        button.textContent =
            "🎤";
    }
}


// =========================================================
// MENU
// =========================================================

function toggleMenu() {

    playSound("click");

    const menu =
        $("menu-card");

    if (!menu) {
        return;
    }

    menu.classList.toggle(
        "hidden"
    );
}


function toggleVolume() {

    playSound("click");

    soundEnabled =
        !soundEnabled;

    addSystemMessage(
        soundEnabled
            ? "Game sounds enabled."
            : "Game sounds muted."
    );

    hide("menu-card");
}


function spectateMode() {

    hide("menu-card");

    if (isAlive) {

        addSystemMessage(
            "You are currently playing. Spectate mode becomes relevant after elimination."
        );

    } else {

        addSystemMessage(
            "Spectate mode enabled."
        );
    }
}


// =========================================================
// RULES
// =========================================================

function openRules() {

    hide("menu-card");

    const mode =
        selectedGameMode;

    const content =
        $("rules-content");

    if (!content) {
        return;
    }

    if (mode === "wordless") {

        content.innerHTML = `
            <h3>Wordless Spy</h3>

            <p>
                All villagers receive the same secret word.
                The Spy receives no word.
            </p>

            <h3>Villager</h3>

            <p>
                Listen to the descriptions and find the
                player who does not seem to know the word.
            </p>

            <h3>Spy</h3>

            <p>
                The Spy has no word. Listen carefully,
                hide your identity and try to guess the
                secret word.
            </p>

            <h3>Turns</h3>

            <p>
                Each alive player gets one speaking turn.
                The turn lasts 30 seconds.
            </p>

            <h3>Voting</h3>

            <p>
                After everyone speaks, alive players vote.
                The player with the highest votes is eliminated.
            </p>

            <h3>Win</h3>

            <p>
                Villagers win when the Spy is eliminated.
                The Spy wins when only two players remain.
            </p>
        `;

    } else {

        content.innerHTML = `
            <h3>Who's the Spy</h3>

            <p>
                All villagers get the same word.
                The Spy receives a different but related word.
            </p>

            <h3>Villager</h3>

            <p>
                Describe your word without saying the actual
                word and work together to identify the Spy.
            </p>

            <h3>Spy</h3>

            <p>
                The Spy gets a different word. Give descriptions
                that fit your word while trying to avoid suspicion.
            </p>

            <h3>Turns</h3>

            <p>
                Each alive player gets one speaking turn.
                Every turn has a 30 second limit.
            </p>

            <h3>Voting</h3>

            <p>
                After the speaking round, everyone votes.
                If there is a tie, the vote starts again.
            </p>

            <h3>Win</h3>

            <p>
                Villagers win by eliminating the Spy.
                The Spy wins when only two players remain.
            </p>
        `;
    }

    show("rules-overlay");
}


function closeRules() {

    playSound("click");

    hide("rules-overlay");
}


// =========================================================
// GAME OVER
// =========================================================

function showGameOver(
    winner,
    message,
    spyPlayer
) {

    const winnerEl =
        $("winner-text");

    const messageEl =
        $("game-over-message");

    const revealEl =
        $("spy-reveal");

    if (
        winner === "civilians"
    ) {

        playSound("win");

        winnerEl.textContent =
            "CIVILIANS WIN! 🎉";

        winnerEl.classList.add(
            "civilians"
        );

        winnerEl.classList.remove(
            "spy"
        );

    } else {

        playSound("lose");

        winnerEl.textContent =
            "SPY WINS! 🕵️";

        winnerEl.classList.add(
            "spy"
        );

        winnerEl.classList.remove(
            "civilians"
        );
    }

    messageEl.textContent =
        message ||
        "The game has ended.";

    if (spyPlayer) {

        revealEl.textContent =
            `The Spy was: ${spyPlayer}`;

    } else {

        revealEl.textContent =
            "Spy revealed.";
    }

    show(
        "game-over-overlay"
    );
}


// =========================================================
// FOCUS CHAT
// =========================================================

function focusChat() {

    playSound("click");

    const input =
        $("chat-input");

    if (!input) {
        return;
    }

    input.focus();

    input.scrollIntoView({
        block: "center",
        behavior: "smooth"
    });
}


// =========================================================
// COPY ROOM CODE
// =========================================================

async function copyRoomCode() {

    playSound("click");

    if (!room) {
        return;
    }

    try {

        await navigator.clipboard.writeText(
            room
        );

        setAlert(
            `Room code ${room} copied!`
        );

    } catch (_) {

        // Fallback for browsers blocking clipboard API.
        try {

            const input =
                document.createElement("input");

            input.value =
                room;

            document.body.appendChild(
                input
            );

            input.select();

            document.execCommand(
                "copy"
            );

            input.remove();

            setAlert(
                `Room code ${room} copied!`
            );

        } catch (error) {

            prompt(
                "Copy this room code:",
                room
            );
        }
    }
}


// =========================================================
// ALERT
// =========================================================

function setAlert(text) {

    const element =
        $("alert-bar");

    if (!element) {
        return;
    }

    element.textContent =
        text || "";
}


// =========================================================
// CLOSE ALL OVERLAYS
// =========================================================

function closeAllOverlays() {

    hide("vote-overlay");
    hide("rules-overlay");
    hide("game-over-overlay");
    hide("reaction-panel");
    hide("menu-card");
}


// =========================================================
// CLEANUP AGORA
// =========================================================

async function cleanupAgora() {

    try {

        if (localAudioTrack) {

            try {
                localAudioTrack.stop();
            } catch (_) {}

            try {
                localAudioTrack.close();
            } catch (_) {}

            localAudioTrack =
                null;
        }

        if (
            rtcClient &&
            agoraJoined
        ) {

            await rtcClient.leave();
        }

    } catch (error) {

        console.error(
            "Agora cleanup error:",
            error
        );

    } finally {

        rtcClient = null;
        agoraJoined = false;

        updateMicUI(false);
    }
}


// =========================================================
// LEAVE GAME
// =========================================================

async function leaveGame() {

    playSound("click");

    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {

        try {
            ws.close();
        } catch (_) {}
    }

    await cleanupAgora();

    stopTurnTimer();

    window.location.href =
        window.location.pathname;
}


// =========================================================
// PAGE CLOSE
// =========================================================

window.addEventListener(
    "beforeunload",
    function() {

        try {

            if (
                ws &&
                ws.readyState === WebSocket.OPEN
            ) {

                ws.close();
            }

        } catch (_) {}

        try {

            if (localAudioTrack) {
                localAudioTrack.stop();
                localAudioTrack.close();
            }

        } catch (_) {}
    }
);


// =========================================================
// AUTO HIDE REACTION PANEL
// =========================================================

document.addEventListener(
    "click",
    function(event) {

        const panel =
            $("reaction-panel");

        if (!panel) {
            return;
        }

        if (
            panel.classList.contains("hidden")
        ) {
            return;
        }

        const clickedInside =
            panel.contains(event.target);

        const controls =
            event.target.closest(
                ".bottom-control"
            );

        if (
            !clickedInside &&
            !controls
        ) {

            hide(
                "reaction-panel"
            );
        }
    }
);


// =========================================================
// INITIAL UI
// =========================================================

selectGameMode(
    "spy"
);

resetReadyButton();
