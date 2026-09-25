let ws;
let username = "";
let room = "";
let isAlive = true;
let userCapacity = 4;

const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4";
let rtcClient;
let localAudioTrack;

let currentTimerInterval;
let currentTimeout;

const myClientId = Math.random().toString(36).substring(2, 15);

// --- Sound Function ---
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
        sound.play().catch(e => console.log("Audio play blocked until user interacts"));
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
    username = document.getElementById("username").value.trim();
    userCapacity = document.getElementById("capacity-select").value;
    
    if(!username) return alert("PLAYER NAME is required!");

    const joinSection = document.getElementById("join-section");

    if (mode === 'random') {
        joinSection.innerHTML = '<p class="text-blue-400 font-bold text-xl animate-pulse text-center mt-10">Searching for match...</p>';
        try {
            const response = await fetch(`/get_random_room/${userCapacity}`);
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    } 
    else if (mode === 'create') {
        joinSection.innerHTML = '<p class="text-blue-400 font-bold text-xl animate-pulse text-center mt-10">Creating Room...</p>';
        try {
            const response = await fetch('/create_new_room');
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    }
    else if (mode === 'join') {
        let code = prompt("Enter 4-Digit Room ID:");
        if(!code || code.trim() === "") {
            window.location.reload(); 
            return;
        }
        room = code.trim();
    }

    document.getElementById("join-section").classList.add("hidden");
    document.getElementById("game-section").classList.remove("hidden");
    document.getElementById("game-section").classList.add("flex");
    document.getElementById("current-room-display").innerText = `(ID: ${room})`;

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
    
    rtcClient.on("user-published", async (user, mediaType) => {
        await rtcClient.subscribe(user, mediaType);
        if (mediaType === "audio") user.audioTrack.play();
    });

    await rtcClient.join(AGORA_APP_ID, channelName, null, uid);
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
    
    await rtcClient.publish([localAudioTrack]);
    await localAudioTrack.setMuted(false);
    updateMicUI(true);
}

async function toggleMic() {
    if (!localAudioTrack) {
        try {
            localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
            await rtcClient.publish([localAudioTrack]);
            await localAudioTrack.setMuted(false);
            updateMicUI(true);
        } catch (err) {
            alert("Please allow Microphone access in your browser settings!");
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
    const micUI = document.getElementById("mic-status");
    if (isOn) {
        micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white animate-pulse"></div><span>MIC ON</span>';
        micUI.classList.remove("bg-red-600");
        micUI.classList.add("bg-green-600");
    } else {
        micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white"></div><span>MIC OFF</span>';
        micUI.classList.remove("bg-green-600");
        micUI.classList.add("bg-red-600");
    }
}

function startTurnTimer() {
    playSound('turn');
    let timeLeft = 15;
    const timerContainer = document.getElementById("turn-timer-container");
    const progressBar = document.getElementById("turn-progress-bar");
    const countdownTxt = document.getElementById("turn-countdown");
    
    timerContainer.classList.remove("hidden");
    progressBar.style.width = "100%";
    progressBar.classList.replace("bg-red-500", "bg-yellow-400");
    countdownTxt.innerText = `YOUR TURN: ${timeLeft}s`;
    countdownTxt.classList.replace("text-red-500", "text-yellow-400");

    clearInterval(currentTimerInterval);
    clearTimeout(currentTimeout);

    currentTimerInterval = setInterval(() => {
        timeLeft--;
        countdownTxt.innerText = `YOUR TURN: ${timeLeft}s`;
        progressBar.style.width = `${(timeLeft / 15) * 100}%`;
        
        if(timeLeft === 5) {
            playSound('timeout');
            countdownTxt.classList.replace("text-yellow-400", "text-red-500");
            progressBar.classList.replace("bg-yellow-400", "bg-red-500");
        }
        if(timeLeft <= 0) {
            clearInterval(currentTimerInterval);
        }
    }, 1000);

    currentTimeout = setTimeout(() => {
        endMyTurn();
    }, 15000);
}

function stopTurnTimer() {
    clearInterval(currentTimerInterval);
    clearTimeout(currentTimeout);
    document.getElementById("turn-timer-container").classList.add("hidden");
}

function handleServerMessage(data) {
    const msgDiv = document.getElementById("messages");
    const alertBox = document.getElementById("game-alert");

    if (data.type === "chat") {
        msgDiv.innerHTML += `<p><b class="${data.sender==='System' ? 'text-yellow-500' : 'text-blue-400'}">${data.sender}:</b> <span class="text-gray-200">${data.text}</span></p>`;
    } 
    else if (data.type === "game_start") {
        playSound('start');
        isAlive = true;
        document.getElementById("my-word").innerText = data.word;
        msgDiv.innerHTML += `<p class="text-green-500 font-bold text-center mt-2">-- GAME STARTED --</p>`;
    }
    else if (data.type === "turn_update") {
        alertBox.innerText = data.message;
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
        if (isAlive) {
            const voteArea = document.getElementById("vote-area");
            const voteBtns = document.getElementById("vote-buttons");
            voteBtns.innerHTML = "";
            data.players.forEach(p => {
                if (p !== username) {
                    voteBtns.innerHTML += `<button onclick="playSound('click'); castVote('${p}')" class="btn btn-dark p-2 rounded-lg font-bold">${p}</button>`;
                }
            });
            voteArea.classList.remove("hidden");
            alertBox.innerText = "Time to Vote!";
        }
    }
    else if (data.type === "reaction_phase") {
        playSound('dead');
        alertBox.innerHTML = `<span class="text-red-500">${data.message}</span>`;
        document.getElementById("vote-area").classList.add("hidden");
        if (username === data.dead_player) {
            isAlive = false;
            setMicState(false);
            alertBox.innerText = "You are DEAD. You can only chat now.";
        } else if (isAlive) {
            setMicState(true);
        }
    }
    else if (data.type === "new_round") {
        playSound('start');
        msgDiv.innerHTML += `<p class="text-blue-400 font-bold text-center mt-2">-- NEXT ROUND --</p>`;
        setMicState(false);
    }
    else if (data.type === "game_over") {
        if (data.winner === 'civilians') {
            playSound('caught');
        } else {
            playSound('over');
        }
        alertBox.innerText = data.message;
        alertBox.className = data.winner === 'spy' ? "text-red-500 font-bold text-lg text-center" : "text-green-500 font-bold text-lg text-center";
        document.getElementById("vote-area").classList.add("hidden");
        setMicState(true);
    }
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

function sendChat() {
    const input = document.getElementById("chat-input");
    if (input.value.trim() !== "") {
        ws.send(JSON.stringify({ action: "chat", text: input.value }));
        input.value = "";
    }
}

function endMyTurn() {
    ws.send(JSON.stringify({ action: "end_turn" }));
    stopTurnTimer();
    setMicState(false);
}

function castVote(player) {
    ws.send(JSON.stringify({ action: "cast_vote", vote: player }));
    document.getElementById("vote-area").innerHTML = `<p class="text-green-400 text-center w-full font-bold">Voted for ${player}</p>`;
}

function leaveGame() {
    if(confirm("Are you sure you want to leave the game?")) {
        window.location.reload();
    }
}
