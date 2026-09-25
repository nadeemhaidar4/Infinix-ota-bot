let ws;
let username = "";
let room = "";
let isAlive = true;
let userCapacity = 4;
let activePlayersList = [];
let currentSpeaker = null;

const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4"; 
let rtcClient;
let localAudioTrack;

let currentTimerInterval;
let currentTimeout;
const TURN_TIME_LIMIT = 30; // 30 seconds limit

const myClientId = Math.random().toString(36).substring(2, 15);

function playSound(type) {
    let sound;
    switch(type) {
        case 'click': sound = document.getElementById("sfx-click"); break;
        case 'start': sound = document.getElementById("sfx-start"); break;
        case 'turn': sound = document.getElementById("sfx-turn"); break;
        case 'timeout': sound = document.getElementById("sfx-timeout"); break;
        case 'caught': sound = document.getElementById("sfx-spy-caught"); break;
        case 'dead': sound = document.getElementById("sfx-civ-dead"); break;
        case 'over': sound = document.getElementById("sfx-game-over"); break;
    }
    if (sound) {
        sound.currentTime = 0;
        sound.play().catch(e => console.log("Audio block"));
    }
}

async function fetchActiveUsers() {
    try {
        const response = await fetch(`/get_active_users?client_id=${myClientId}`);
        const data = await response.json();
        document.getElementById('active-users-count').innerText = data.active_users;
    } catch (error) {}
}
window.onload = fetchActiveUsers;
setInterval(fetchActiveUsers, 5000);

async function joinRoom(mode) {
    playSound('click');
    username = document.getElementById("username").value.trim();
    userCapacity = document.getElementById("capacity-select").value;
    
    if(!username) return alert("Please enter your name!");

    const loadingText = document.getElementById("join-loading");
    loadingText.classList.remove("hidden");

    if (mode === 'random') {
        loadingText.innerText = "Matching...";
        try {
            const response = await fetch(`/get_random_room/${userCapacity}`);
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    } 
    else if (mode === 'create') {
        loadingText.innerText = "Creating Room...";
        try {
            const response = await fetch('/create_new_room');
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    }
    else if (mode === 'join') {
        let code = prompt("Enter Room ID:");
        if(!code || code.trim() === "") {
            loadingText.classList.add("hidden");
            return;
        }
        room = code.trim();
    }

    document.getElementById("join-section").classList.add("hidden");
    document.getElementById("game-section").classList.remove("hidden");
    document.getElementById("game-section").classList.add("flex");
    
    document.getElementById("room-name-display").innerText = `${room}`;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${room}/${username}/${userCapacity}`);

    ws.onmessage = function(event) {
        handleServerMessage(JSON.parse(event.data));
    };

    try {
        await initAgora(room, username);
    } catch (err) {
        console.error("Agora Error: ", err);
        updateMicUI(false);
    }
}

async function initAgora(channelName, uid) {
    rtcClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    
    if(rtcClient.getAudioContext().state === 'suspended') {
        rtcClient.getAudioContext().resume();
    }

    rtcClient.on("user-published", async (user, mediaType) => {
        await rtcClient.subscribe(user, mediaType);
        if (mediaType === "audio") {
            try {
                if(rtcClient.getAudioContext().state === 'suspended') {
                    await rtcClient.getAudioContext().resume();
                }
                user.audioTrack.play();
            } catch(err) {}
        }
    });

    await rtcClient.join(AGORA_APP_ID, channelName, null, uid);
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
    
    await rtcClient.publish([localAudioTrack]);
    await localAudioTrack.setMuted(false);
    updateMicUI(true);
}

async function toggleMic() {
    playSound('click');
    if (!localAudioTrack) {
        try {
            localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
            await rtcClient.publish([localAudioTrack]);
            await localAudioTrack.setMuted(false);
            updateMicUI(true);
        } catch (err) {
            alert("Allow mic access!");
        }
        return;
    }
    
    const isMuted = localAudioTrack.isMuted;
    await localAudioTrack.setMuted(!isMuted);
    updateMicUI(isMuted); 
}

async function setMicState(unmute) {
    if (!localAudioTrack) return;
    await localAudioTrack.setMuted(!unmute);
    updateMicUI(unmute);
}

function updateMicUI(isOn) {
    const bottomMic = document.getElementById("bottom-mic-btn");
    
    if (isOn) {
        bottomMic.classList.replace("inactive", "active");
    } else {
        bottomMic.classList.replace("active", "inactive");
    }
}

// Function to render players dynamically
function renderPlayersGrid(players) {
    const grid = document.getElementById("players-grid-container");
    grid.innerHTML = "";
    
    players.forEach((p, index) => {
        let isMe = p === username;
        let isSpeaking = p === currentSpeaker;
        let activeClass = isMe ? 'active' : '';
        let speakingClass = isSpeaking ? 'speaking' : '';
        let initial = p.charAt(0).toUpperCase();
        
        let micState = (p === currentSpeaker) ? '<div class="mic-badge on">🎤</div>' : '<div class="mic-badge off">🔇</div>';
        
        let html = `
            <div class="player-card" id="player-card-${p}">
                <div class="player-avatar-wrapper ${activeClass} ${speakingClass}">
                    <div class="number-badge">${index + 1}</div>
                    <span class="player-initial">${initial}</span>
                    ${micState}
                </div>
                <div class="player-name">${isMe ? 'You' : p}</div>
            </div>
        `;
        grid.innerHTML += html;
    });
}

function updatePlayerStates(deadPlayerName) {
    if(deadPlayerName) {
        let card = document.getElementById(`player-card-${deadPlayerName}`);
        if(card) {
            card.querySelector('.player-avatar-wrapper').classList.add('dead');
            card.querySelector('.player-avatar-wrapper').classList.remove('active', 'speaking');
            card.querySelector('.mic-badge').className = "mic-badge off";
            card.querySelector('.mic-badge').innerText = "💀";
        }
    }
}

function startTurnTimer() {
    playSound('turn');
    let timeLeft = TURN_TIME_LIMIT;
    const timerContainer = document.getElementById("turn-timer-container");
    const progressBar = document.getElementById("turn-progress-bar");
    const countdownTxt = document.getElementById("turn-countdown");
    
    timerContainer.classList.remove("hidden");
    progressBar.style.width = "100%";
    progressBar.classList.remove("bg-red-500", "bg-yellow-400");
    progressBar.classList.add("bg-green-400");
    countdownTxt.innerText = `YOUR TURN: ${timeLeft}s`;
    countdownTxt.classList.remove("text-red-500", "text-yellow-400");
    countdownTxt.classList.add("text-green-400");

    clearInterval(currentTimerInterval);
    clearTimeout(currentTimeout);

    currentTimerInterval = setInterval(() => {
        timeLeft--;
        countdownTxt.innerText = `YOUR TURN: ${timeLeft}s`;
        progressBar.style.width = `${(timeLeft / TURN_TIME_LIMIT) * 100}%`;
        
        if(timeLeft === 10) {
            progressBar.classList.replace("bg-green-400", "bg-yellow-400");
            countdownTxt.classList.replace("text-green-400", "text-yellow-400");
        }
        if(timeLeft === 5) {
            playSound('timeout');
            progressBar.classList.replace("bg-yellow-400", "bg-red-500");
            countdownTxt.classList.replace("text-yellow-400", "text-red-500");
        }
        if(timeLeft <= 0) {
            clearInterval(currentTimerInterval);
        }
    }, 1000);

    currentTimeout = setTimeout(() => {
        endMyTurn();
    }, TURN_TIME_LIMIT * 1000);
}

function stopTurnTimer() {
    clearInterval(currentTimerInterval);
    clearTimeout(currentTimeout);
    document.getElementById("turn-timer-container").classList.add("hidden");
}

function handleServerMessage(data) {
    const msgDiv = document.getElementById("messages");
    const alertBox = document.getElementById("game-alert-box");

    if (data.type === "chat") {
        if(data.sender === "System") {
            msgDiv.innerHTML += `<p class="text-center text-yellow-300 font-bold my-1 text-[10px] uppercase">${data.text}</p>`;
        } else {
            let color = data.sender === username ? '#4FC3F7' : '#FFFFFF';
            // Output directly as Player: Message without "System"
            msgDiv.innerHTML += `<p><b style="color:${color};">${data.sender}:</b> <span style="color:#EEE;">${data.text}</span></p>`;
        }
    } 
    else if (data.type === "game_start") {
        playSound('start');
        isAlive = true;
        activePlayersList = data.players;
        document.getElementById("my-word").innerText = data.word;
        document.getElementById("secret-word-banner").classList.remove("hidden");
        document.getElementById("game-status-text").innerText = "Match Started";
        renderPlayersGrid(activePlayersList);
        alertBox.innerText = "Game Started! Check your word.";
    }
    else if (data.type === "turn_update") {
        currentSpeaker = data.current_player;
        alertBox.innerText = data.message;
        renderPlayersGrid(activePlayersList); 
        
        if (data.current_player === username && isAlive) {
            setMicState(true);
            startTurnTimer();
        } else {
            setMicState(false);
            stopTurnTimer();
        }
    }
    else if (data.type === "start_voting") {
        playSound('timeout');
        setMicState(false); 
        stopTurnTimer();
        currentSpeaker = null;
        renderPlayersGrid(activePlayersList);
        
        if (isAlive) {
            const voteArea = document.getElementById("vote-overlay");
            const voteBtns = document.getElementById("vote-buttons");
            voteBtns.innerHTML = "";
            data.players.forEach((p, i) => {
                if (p !== username) {
                    voteBtns.innerHTML += `
                    <button onclick="playSound('click'); castVote('${p}')" class="game-btn btn-blue shadow-lg border-2 border-blue-400">
                        <div class="number-badge" style="position:static; margin-right:5px;">${i+1}</div>
                        ${p}
                    </button>`;
                }
            });
            voteArea.classList.remove("hidden");
            alertBox.innerText = "Voting Phase";
        }
    }
    else if (data.type === "reaction_phase") {
        playSound('dead');
        alertBox.innerHTML = `<span class="text-red-500">${data.message}</span>`;
        document.getElementById("vote-overlay").classList.add("hidden");
        
        activePlayersList = activePlayersList.filter(p => p !== data.dead_player);
        updatePlayerStates(data.dead_player);

        if (username === data.dead_player) {
            isAlive = false;
            setMicState(false);
            alertBox.innerText = "You died. You can only listen.";
        } else if (isAlive) {
            setMicState(true);
        }
    }
    else if (data.type === "new_round") {
        playSound('start');
        alertBox.innerText = "New Round Started";
        setMicState(false);
    }
    else if (data.type === "game_over") {
        if (data.winner === 'civilians') playSound('caught');
        else playSound('over');
        
        document.getElementById("vote-overlay").classList.add("hidden");
        document.getElementById("game-status-text").innerText = "Game Over";
        
        const overlay = document.getElementById("vote-overlay");
        overlay.innerHTML = `
            <h2 class="text-4xl font-black ${data.winner === 'spy' ? 'text-red-500' : 'text-green-500'} mb-2 text-center" style="font-family: 'Fredoka One', cursive;">${data.winner === 'spy' ? 'SPY WINS!' : 'CIVILIANS WIN!'}</h2>
            <p class="text-white text-sm font-bold text-center mb-8">${data.message}</p>
            <button onclick="leaveGame()" class="game-btn btn-blue">Back to Lobby</button>
        `;
        overlay.classList.remove("hidden");
        setMicState(true);
    }
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

function sendChat() {
    playSound('click');
    const input = document.getElementById("chat-input");
    if (input.value.trim() !== "") {
        ws.send(JSON.stringify({ action: "chat", text: input.value }));
        input.value = "";
    }
}

document.getElementById("chat-input").addEventListener("keypress", function(event) {
    if (event.key === "Enter") {
        event.preventDefault();
        sendChat();
    }
});

function endMyTurn() {
    playSound('click');
    ws.send(JSON.stringify({ action: "end_turn" }));
    stopTurnTimer();
    setMicState(false);
}

function castVote(player) {
    ws.send(JSON.stringify({ action: "cast_vote", vote: player }));
    document.getElementById("vote-overlay").innerHTML = `<h2 class="text-2xl font-black text-green-400 mt-10">Target Locked: ${player}</h2><p class="mt-4 text-white text-sm">Waiting for others...</p>`;
}

function leaveGame() {
    playSound('click');
    window.location.reload();
}
