let ws = null;

let room = "";
let username = "";
let capacity = 6;

let players = [];
let categories = [];
let selectedCategory = null;

let isReady = false;
let isAlive = true;
let currentSpeaker = null;

let secretWord = "—";

let timerHandle = null;
let timerEnd = 0;

let soundOn = true;

/* WebRTC */
let micPermission = false;
let micOn = false;
let localStream = null;

let peerConnections = new Map();
let pendingIce = new Map();
let rtcStarted = false;


const $ = id => document.getElementById(id);


function esc(value) {
    return String(value ?? "").replace(
        /[&<>'"]/g,
        c => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            "'": "&#39;",
            '"': "&quot;"
        }[c])
    );
}


function show(id) {
    $(id)?.classList.remove("hidden");
}


function hide(id) {
    $(id)?.classList.add("hidden");
}


function send(data) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}


/* -------------------------------------------------------
   JOIN ROOM
------------------------------------------------------- */

async function joinRoom() {

    username = $("name-input").value.trim();
    capacity = Number($("capacity").value) || 6;
    room = $("room-input").value.trim();

    if (!username) {
        alert("Enter your name first.");
        $("name-input").focus();
        return;
    }

    try {

        if (!room) {

            const response = await fetch(
                `/create_new_room?capacity=${capacity}`
            );

            const data = await response.json();

            if (data.error) {
                throw new Error(data.error);
            }

            room = data.room_id;
        }

        connectWS();

    } catch (error) {

        alert(
            error.message ||
            "Could not create room."
        );
    }
}


function connectWS() {

    const protocol =
        location.protocol === "https:"
            ? "wss"
            : "ws";

    ws = new WebSocket(
        `${protocol}://${location.host}/ws/${encodeURIComponent(room)}/${capacity}?username=${encodeURIComponent(username)}`
    );

    ws.onopen = () => {
        addSystem("Connected to room.");
    };

    ws.onmessage = event => {

        try {
            handle(JSON.parse(event.data));
        } catch (error) {
            console.error(error);
        }
    };

    ws.onclose = () => {

        if (
            $("game") &&
            !$("game").classList.contains("hidden")
        ) {
            addSystem(
                "Connection closed. Refresh to reconnect."
            );
        }
    };

    ws.onerror = () => {
        addSystem("Connection error.");
    };
}


/* -------------------------------------------------------
   SERVER EVENTS
------------------------------------------------------- */

function handle(data) {

    switch (data.type) {

        case "connected":

            room = data.room;
            capacity = data.capacity;
            username = data.username;

            players = data.players || [];

            $("room-id").textContent = room;

            show("game");
            hide("home");

            renderPlayers();

            isAlive =
                players.find(
                    p => p.username === username
                )?.alive !== false;

            startRTC();

            break;


        case "lobby_update":

            players = data.players || players;

            renderPlayers();

            if (data.state === "waiting") {

                show("ready-overlay");

                $("ready-status").textContent =
                    `Players: ${players.length}/${data.capacity}. Everyone must be ready.`;

                $("ready-button").textContent =
                    isReady
                        ? "Ready ✓"
                        : "I'm Ready";

            } else {

                hide("ready-overlay");
            }

            syncRTCPlayers();

            break;


        case "category_select":

            categories = data.categories || [];

            selectedCategory = null;

            buildCategories();

            show("category-overlay");

            startCountdown(
                "category-count",
                data.seconds || 9,
                null
            );

            break;


        case "category_vote_update":

            updateCategoryCounts(
                data.counts || {}
            );

            break;


        case "category_result":

            hide("category-overlay");

            $("chosen-category").textContent =
                data.category || "Random";

            show("category-result-overlay");

            startCountdown(
                "result-count",
                data.seconds || 3,
                () => hide("category-result-overlay")
            );

            break;


        case "role_info":

            secretWord = data.word || "—";

            isAlive = true;

            setWordLine(
                data.category,
                secretWord
            );

            $("round-line").textContent =
                `Round ${data.round || 1}`;

            break;


        case "round_start":

            players = data.players || players;

            isAlive =
                players.find(
                    p => p.username === username
                )?.alive !== false;

            currentSpeaker = null;

            setMic(false);

            $("round-line").textContent =
                `Round ${data.round}`;

            renderPlayers();

            addSystem(
                `Round ${data.round} description starts.`
            );

            updateMicUI();

            syncRTCPlayers();

            break;


        case "turn_update":

            currentSpeaker =
                data.current_player;

            $("round-line").textContent =
                `Round ${data.round || 1}`;

            startCountdown(
                "timer",
                data.seconds || 30,
                null
            );

            renderPlayers();

            updateMicUI();

            if (currentSpeaker === username) {

                addSystem(
                    "Your turn. Describe your word without saying it."
                );

                setMic(true);

            } else {

                setMic(false);
            }

            break;


        case "start_voting":

            currentSpeaker = null;

            setMic(false);

            startCountdown(
                "timer",
                data.seconds || 30,
                null
            );

            renderPlayers();

            updateMicUI();

            openVoting(
                data.players || []
            );

            addSystem(
                `Round ${data.round || 1} description is over. Vote starts.`
            );

            break;


        case "vote_update":

            $("vote-status").textContent =
                `Votes received: ${data.count || 0}/${data.total || 0}`;

            break;


        case "vote_error":

            $("vote-status").textContent =
                data.message || "Vote error.";

            break;


        case "vote_tie":

            hide("vote-overlay");

            addSystem(
                data.message ||
                "Vote tie. Vote again."
            );

            setTimeout(
                () => openVoting(
                    data.players || []
                ),
                500
            );

            break;


        case "vote_result":

            hide("vote-overlay");

            addSystem(
                `Vote result: No.${data.number} ${data.eliminated} was selected.`
            );

            break;


        case "reaction_phase":

            currentSpeaker = null;

            setMic(false);

            if (data.dead_player === username) {
                isAlive = false;
            }

            markDead(
                data.dead_player
            );

            startCountdown(
                "timer",
                data.seconds || 10,
                null
            );

            showEvent(
                "Elimination",
                data.message ||
                `${data.dead_player} is out.`
            );

            updateMicUI();

            break;


        case "new_round":

            hide("event-overlay");

            players = data.players || players;

            isAlive =
                players.find(
                    p => p.username === username
                )?.alive !== false;

            currentSpeaker = null;

            setMic(false);

            $("round-line").textContent =
                `Round ${data.round}`;

            renderPlayers();

            addSystem(
                `Round ${data.round} description starts.`
            );

            updateMicUI();

            syncRTCPlayers();

            break;


        case "chat":

            addChat(
                data.sender,
                data.text
            );

            break;


        case "reaction":

            addChat(
                data.sender,
                data.emoji
            );

            break;


        case "game_over":

            stopTimer();

            currentSpeaker = null;

            setMic(false);

            hide("vote-overlay");
            hide("event-overlay");

            updateMicUI();

            showGameOver(data);

            break;


        case "rtc_signal":

            handleRTCSignal(data);

            break;


        case "error":

            alert(
                data.message ||
                "Server error."
            );

            break;
    }
}


/* -------------------------------------------------------
   WORD
------------------------------------------------------- */

function setWordLine(category, word) {

    $("word-line").innerHTML =
        `<strong>Category: ${esc(category || "")}</strong><br>
         <span>My word: ${esc(word || "—")}</span>`;
}


/* -------------------------------------------------------
   CATEGORY
------------------------------------------------------- */

function buildCategories() {

    const grid =
        $("category-grid");

    grid.innerHTML = "";

    categories.forEach(category => {

        const button =
            document.createElement("button");

        button.textContent = category;

        button.dataset.category =
            category;

        button.onclick =
            () => selectCategory(category);

        grid.appendChild(button);
    });

    $("category-confirm")
        .classList
        .add("disabled");
}


function selectCategory(category) {

    selectedCategory = category;

    [
        ...$("category-grid").children
    ].forEach(button => {

        button.classList.toggle(
            "selected",
            button.dataset.category === category
        );
    });

    $("category-confirm")
        .classList
        .remove("disabled");

    send({
        action: "category_vote",
        category
    });
}


function confirmCategory() {

    if (selectedCategory) {

        send({
            action: "category_vote",
            category: selectedCategory
        });
    }
}


function updateCategoryCounts(counts) {

    [
        ...$("category-grid").children
    ].forEach(button => {

        const category =
            button.dataset.category;

        const count =
            counts[category] || 0;

        button.textContent =
            count
                ? `${category} • ${count}`
                : category;
    });
}


/* -------------------------------------------------------
   READY
------------------------------------------------------- */

function toggleReady() {

    isReady = !isReady;

    send({
        action: "set_ready",
        ready: isReady
    });

    $("ready-button").textContent =
        isReady
            ? "Ready ✓"
            : "I'm Ready";
}


/* -------------------------------------------------------
   PLAYERS
------------------------------------------------------- */

function renderPlayers() {

    const grid =
        $("players-grid");

    if (!grid) return;

    grid.innerHTML = "";

    [
        ...players
    ]
        .sort(
            (a, b) =>
                (a.number || 99) -
                (b.number || 99)
        )
        .forEach(player => {

            const element =
                document.createElement("div");

            element.className =
                `player ${
                    player.alive === false
                        ? "dead"
                        : ""
                }`;

            const initial =
                esc(
                    (player.username || "?")[0]
                        .toUpperCase()
                );

            element.innerHTML = `
                <div class="avatar ${
                    currentSpeaker === player.username
                        ? "speaking"
                        : ""
                }">

                    <span class="num">
                        ${player.number || ""}
                    </span>

                    ${initial}

                    ${
                        player.ready
                            ? '<span class="ready-dot">✓</span>'
                            : ""
                    }

                </div>

                <div class="player-name">
                    ${esc(player.username)}
                </div>

                ${
                    currentSpeaker === player.username
                        ? '<div class="speaking-text">Speaking</div>'
                        : ""
                }
            `;

            grid.appendChild(element);
        });
}


function markDead(name) {

    players = players.map(
        player =>
            player.username === name
                ? {
                    ...player,
                    alive: false
                }
                : player
    );

    renderPlayers();
}


/* -------------------------------------------------------
   TIMER
------------------------------------------------------- */

function startCountdown(
    id,
    seconds,
    onEnd
) {

    clearInterval(timerHandle);

    const element = $(id);

    if (!element) return;

    timerEnd =
        Date.now() +
        Number(seconds) * 1000;

    const tick = () => {

        const left =
            Math.max(
                0,
                Math.ceil(
                    (timerEnd - Date.now()) / 1000
                )
            );

        element.textContent = left;

        if (left <= 0) {

            clearInterval(timerHandle);

            timerHandle = null;

            if (onEnd) {
                onEnd();
            }
        }
    };

    tick();

    timerHandle =
        setInterval(
            tick,
            200
        );
}


function stopTimer() {

    clearInterval(
        timerHandle
    );

    timerHandle = null;

    $("timer").textContent = "--";
}


/* -------------------------------------------------------
   VOTING
------------------------------------------------------- */

function openVoting(names) {

    const grid =
        $("vote-grid");

    grid.innerHTML = "";

    if (!isAlive) {

        $("vote-status").textContent =
            "You are eliminated. You are spectating.";

        show("vote-overlay");

        return;
    }

    names
        .filter(name => name !== username)
        .forEach(name => {

            const button =
                document.createElement("button");

            button.className =
                "vote-btn";

            button.textContent =
                `No.${getNumber(name)}  ${name}`;

            button.onclick =
                () => castVote(name);

            grid.appendChild(button);
        });

    $("vote-status").textContent =
        "Choose the player you suspect.";

    show("vote-overlay");
}


function getNumber(name) {

    return (
        players.find(
            player =>
                player.username === name
        )?.number || ""
    );
}


function castVote(name) {

    if (!isAlive) return;

    send({
        action: "cast_vote",
        vote: name
    });

    $("vote-grid").innerHTML =
        `<div style="
            grid-column:1/-1;
            font-weight:700;
            padding:18px;
            text-align:center
        ">
            🎯 Target locked: ${esc(name)}
        </div>`;

    $("vote-status").textContent =
        "Waiting for other players...";
}


/* -------------------------------------------------------
   EVENTS / GAME OVER
------------------------------------------------------- */

function showEvent(title, text) {

    $("event-title").textContent =
        title;

    $("event-text").textContent =
        text;

    show("event-overlay");
}


function closeEvent() {

    hide("event-overlay");
}


function showGameOver(data) {

    $("gameover-title").textContent =
        data.winner === "civilians"
            ? "CIVILIANS WIN! 🎉"
            : "SPY WINS! 🕵️";

    $("gameover-message").textContent =
        data.message || "Game over.";

    $("spy-reveal").textContent =
        data.spy_player
            ? `The Spy was: ${data.spy_player} • Villagers' word: ${data.word || "—"} • Spy word: ${data.spy_word || "—"}`
            : "Spy revealed.";

    show("gameover-overlay");
}


/* -------------------------------------------------------
   CHAT
------------------------------------------------------- */

function addSystem(text) {

    addChat(
        "System",
        text
    );
}


function addChat(sender, text) {

    const box =
        $("messages");

    if (!box) return;

    const message =
        document.createElement("div");

    message.className =
        "message";

    message.innerHTML =
        sender === "System"
            ? `<span class="sender">🔔 System:</span> ${esc(text)}`
            : `<span class="sender">${esc(sender)}:</span> ${esc(text)}`;

    box.appendChild(message);

    while (box.children.length > 100) {
        box.firstChild.remove();
    }

    box.scrollTop =
        box.scrollHeight;
}


function sendChat() {

    const input =
        $("chat-input");

    const text =
        input.value.trim();

    if (!text) return;

    send({
        action: "chat",
        text
    });

    input.value = "";
}


/* -------------------------------------------------------
   UI
------------------------------------------------------- */

function toggleReactions() {

    $("reaction-panel")
        .classList
        .toggle("hidden");
}


function sendReaction(emoji) {

    hide("reaction-panel");

    send({
        action: "reaction",
        emoji
    });
}


function focusChat() {

    $("chat-input").focus();
}


function toggleSound() {

    soundOn = !soundOn;

    addSystem(
        soundOn
            ? "Sound enabled."
            : "Sound muted."
    );

    hide("menu-overlay");
}


function toggleMenu() {

    show("menu-overlay");
}


function openRules() {

    hide("menu-overlay");

    show("rules-overlay");
}


function showPlayersCount() {

    addSystem(
        `Players alive: ${
            players.filter(
                p => p.alive !== false
            ).length
        }/${capacity}`
    );
}


function leaveGame() {

    try {
        closeRTC();
    } catch {}

    if (ws) {
        ws.close();
    }

    location.reload();
}


/* =======================================================
   WEBRTC VOICE
======================================================= */

const rtcConfig = {

    iceServers: [

        {
            urls:
                "stun:stun.l.google.com:19302"
        },

        {
            urls:
                "stun:stun1.l.google.com:19302"
        }
    ]
};


async function startRTC() {

    if (rtcStarted || !ws) {
        return;
    }

    rtcStarted = true;

    syncRTCPlayers();
}


function syncRTCPlayers() {

    if (!rtcStarted) {
        return;
    }

    for (const player of players) {

        if (
            player.username !== username &&
            !peerConnections.has(player.username)
        ) {

            createPeer(
                player.username,
                shouldInitiate(player.username)
            );
        }
    }

    for (
        const name of [
            ...peerConnections.keys()
        ]
    ) {

        const exists =
            players.some(
                player =>
                    player.username === name &&
                    player.alive !== false
            );

        if (!exists) {
            closePeer(name);
        }
    }
}


/*
    Lower player number creates the offer.
    This avoids WebRTC "offer collision".
*/

function shouldInitiate(remoteName) {

    const myNumber =
        players.find(
            p => p.username === username
        )?.number || 999;

    const remoteNumber =
        players.find(
            p => p.username === remoteName
        )?.number || 999;

    return myNumber < remoteNumber;
}


function createPeer(
    remoteName,
    initiator
) {

    if (
        !remoteName ||
        remoteName === username
    ) {
        return null;
    }

    if (
        peerConnections.has(remoteName)
    ) {
        return peerConnections.get(
            remoteName
        );
    }

    const pc =
        new RTCPeerConnection(
            rtcConfig
        );

    peerConnections.set(
        remoteName,
        pc
    );

    pendingIce.set(
        remoteName,
        []
    );


    /*
        Receive audio even before
        our microphone is enabled.
    */

    if (localStream) {

        for (
            const track
            of localStream.getTracks()
        ) {

            pc.addTrack(
                track,
                localStream
            );
        }

    } else {

        pc.addTransceiver(
            "audio",
            {
                direction: "recvonly"
            }
        );
    }


    pc.onicecandidate = event => {

        if (event.candidate) {

            send({
                action: "rtc_ice",
                target: remoteName,
                signal: event.candidate
            });
        }
    };


    pc.ontrack = event => {

        const audio =
            document.createElement("audio");

        audio.autoplay = true;
        audio.playsInline = true;

        audio.srcObject =
            event.streams[0];

        audio.dataset.peer =
            remoteName;

        document.body.appendChild(
            audio
        );

        audio
            .play()
            .catch(() => {});

        pc._audio = audio;
    };


    pc.onconnectionstatechange = () => {

        if (
            [
                "failed",
                "closed"
            ].includes(
                pc.connectionState
            )
        ) {

            closePeer(remoteName);

            setTimeout(
                () => {

                    if (
                        players.some(
                            p =>
                                p.username === remoteName &&
                                p.alive !== false
                        )
                    ) {

                        createPeer(
                            remoteName,
                            shouldInitiate(remoteName)
                        );
                    }
                },
                1500
            );
        }
    };


    if (initiator) {
        makeOffer(
            remoteName,
            pc
        );
    }

    return pc;
}


async function makeOffer(
    name,
    pc
) {

    try {

        const offer =
            await pc.createOffer();

        await pc.setLocalDescription(
            offer
        );

        send({
            action: "rtc_offer",
            target: name,
            signal: pc.localDescription
        });

    } catch (error) {

        console.warn(
            "WebRTC offer error:",
            error
        );
    }
}


async function handleRTCSignal(data) {

    const from = data.from;

    if (
        !from ||
        from === username
    ) {
        return;
    }

    let pc =
        peerConnections.get(from);

    if (!pc) {

        pc = createPeer(
            from,
            data.signal_type === "rtc_offer"
        );
    }

    if (!pc) {
        return;
    }

    try {

        if (
            data.signal_type === "rtc_offer"
        ) {

            await pc.setRemoteDescription(
                new RTCSessionDescription(
                    data.signal
                )
            );

            const answer =
                await pc.createAnswer();

            await pc.setLocalDescription(
                answer
            );

            send({
                action: "rtc_answer",
                target: from,
                signal: pc.localDescription
            });

        }

        else if (
            data.signal_type === "rtc_answer"
        ) {

            await pc.setRemoteDescription(
                new RTCSessionDescription(
                    data.signal
                )
            );
        }

        else if (
            data.signal_type === "rtc_ice"
        ) {

            if (pc.remoteDescription) {

                await pc.addIceCandidate(
                    new RTCIceCandidate(
                        data.signal
                    )
                );

            } else {

                pendingIce
                    .get(from)
                    .push(data.signal);
            }
        }


        if (
            pc.remoteDescription &&
            pendingIce.get(from)?.length
        ) {

            for (
                const candidate
                of pendingIce.get(from)
            ) {

                await pc.addIceCandidate(
                    new RTCIceCandidate(
                        candidate
                    )
                );
            }

            pendingIce.set(
                from,
                []
            );
        }

    } catch (error) {

        console.warn(
            "WebRTC signaling error:",
            error
        );
    }
}


function closePeer(name) {

    const pc =
        peerConnections.get(name);

    if (pc) {

        try {
            pc.close();
        } catch {}

        if (pc._audio) {
            pc._audio.remove();
        }
    }

    peerConnections.delete(name);
    pendingIce.delete(name);
}


function closeRTC() {

    for (
        const name
        of [...peerConnections.keys()]
    ) {

        closePeer(name);
    }

    if (localStream) {

        localStream
            .getTracks()
            .forEach(
                track => track.stop()
            );

        localStream = null;
    }

    rtcStarted = false;
    micOn = false;

    updateMicUI();
}


/* -------------------------------------------------------
   MICROPHONE
------------------------------------------------------- */

async function requestMic() {

    if (localStream) {
        return true;
    }

    if (
        !navigator.mediaDevices ||
        !navigator.mediaDevices.getUserMedia
    ) {

        addSystem(
            "This browser does not support microphone access."
        );

        return false;
    }

    try {

        localStream =
            await navigator.mediaDevices.getUserMedia(
                {
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    },
                    video: false
                }
            );

        micPermission = true;


        /*
            Add microphone track to
            every existing peer connection.
        */

        for (
            const [name, pc]
            of peerConnections
        ) {

            for (
                const track
                of localStream.getTracks()
            ) {

                pc.addTrack(
                    track,
                    localStream
                );
            }
        }


        addSystem(
            "Microphone enabled."
        );

        return true;

    } catch (error) {

        console.warn(
            "Microphone error:",
            error
        );

        addSystem(
            "Microphone permission was denied or unavailable. Please allow microphone access in browser settings."
        );

        return false;
    }
}


async function setMic(on) {

    /*
        Only current speaker can transmit.
    */

    if (
        !isAlive ||
        currentSpeaker !== username
    ) {

        on = false;
    }


    if (
        on &&
        !localStream
    ) {

        const allowed =
            await requestMic();

        if (!allowed) {

            updateMicUI();

            return;
        }
    }


    if (localStream) {

        localStream
            .getAudioTracks()
            .forEach(
                track => {
                    track.enabled = !!on;
                }
            );
    }


    micOn = !!on;

    updateMicUI();
}


async function toggleMic() {

    if (!isAlive) {

        addSystem(
            "You are eliminated and cannot use the game microphone."
        );

        return;
    }


    /*
        If it isn't our turn, the first tap
        simply asks for microphone permission.
    */

    if (
        currentSpeaker !== username
    ) {

        const allowed =
            await requestMic();

        if (allowed) {

            addSystem(
                "Mic permission is ready. It will activate automatically on your turn."
            );
        }

        return;
    }


    await setMic(
        !micOn
    );
}


function updateMicUI() {

    const button =
        $("mic-button");

    if (!button) {
        return;
    }

    button.classList.toggle(
        "active",
        micOn
    );

    button.textContent =
        micOn
            ? "🎙️"
            : "🎤";

    button.title =
        (
            isAlive &&
            currentSpeaker === username
        )
            ? "Tap to mute/unmute"
            : "Tap once to allow microphone access";
}


/* -------------------------------------------------------
   EVENTS
------------------------------------------------------- */

$("chat-input")
    .addEventListener(
        "keydown",
        event => {

            if (event.key === "Enter") {
                sendChat();
            }
        }
    );


window.addEventListener(
    "beforeunload",
    closeRTC
);


window.addEventListener(
    "load",
    () => {

        $("room-input")
            .addEventListener(
                "input",
                event => {

                    event.target.value =
                        event.target.value
                            .replace(/\D/g, "")
                            .slice(0, 4);
                }
            );


        $("name-input")
            .addEventListener(
                "keydown",
                event => {

                    if (event.key === "Enter") {
                        joinRoom();
                    }
                }
            );
    }
);
