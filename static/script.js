let ws;
let username = "";
let room = "";
let isAlive = true;
let userCapacity = 4;
let activePlayersList = [];

const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4"; 
let rtcClient;
let localAudioTrack;

let currentTimerInterval;
let currentTimeout;
const TURN_TIME_LIMIT = 30; // 30 Seconds for turn

const myClientId = Math.random().toString(36).substring(2, 15);

// Sound effects map
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

// Force resume audio context for browsers blocking auto-play
async function playAudioTrack(user) {
    try {
        if(rtcClient.getAudioContext().state === 'suspended') {
            await rtcClient.getAudioContext().resume();
        }
        user.audioTrack.play();
    } catch(err) {
        console.error("Audio playback failed", err);
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
    
    if(!username) return alert("PLAYER NAME is required!");

    const joinSection = document.getElementById("join-section");

    if (mode === 'random') {
        joinSection.innerHTML = '<p class="text-blue-400 font-bold text-xl animate-pulse text-center mt-6">Searching for match...</p>';
        try {
            const response = await fetch(`/get_random_room/${userCapacity}`);
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    } 
    else if (mode === 'create') {
        joinSection.innerHTML = '<p class="text-blue-400 font-bold text-xl animate-pulse text-center mt-6">Creating Room...</p>';
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
        alert("Please enable microphone permissions in your browser.");
        updateMicUI(false);
    }
}

async function initAgora(channelName, uid) {
    rtcClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    
    // Resume audio context directly on first interaction
    if(rtcClient.getAudioContext().state === 'suspended') {
        rtcClient.getAudioContext().resume();
    }

    rtcClient.on("user-published", async (user, mediaType) => {
        await rtcClient.subscribe(user, mediaType);
        if (mediaType === "audio") {
            playAudioTrack(user);
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
        micUI.innerHTML = '<div class="w-2.5 h-2.5 rounded-full bg-white animate-pulse"></div><span>MIC ON</span>';
        micUI.classList.replace("bg-red-600", "bg-green-600");
    } else {
        micUI.innerHTML = '<div class="w-2.5 h-2.5 rounded-full bg-white"></div><span>MIC OFF</span>';
        micUI.classList.replace("bg-green-600", "bg-red-600");
    }
}

function updateActivePlayersList(playersArr, currentSpeaker) {
    const listDiv = document.getElementById("active-players-list");
    listDiv.innerHTML = "";
    playersArr.forEach(p => {
        let micIcon = (p === currentSpeaker) ? '🔊' : '🔇';
        let color = (p === username) ? 'text-blue-400 font-bold' : 'text-gray-300';
        listDiv.innerHTML += `<span class="${color} bg-gray-800 px-2 py-1 rounded text-xs">${micIcon} ${p}</span>`;
    });
}

function startTurnTimer() {
    playSound('turn');
    let timeLeft = TURN_TIME_LIMIT; // 30 seconds
    const timerContainer = document.getElementById("turn-timer-container");
    const progressBar = document.getElementById("turn-progress-bar");
    const countdownTxt = document.getElementById("turn-countdown");
    
    timerContainer.classList.remove("hidden");
    progressBar.style.width = "100%";
    progressBar.classList.replace("bg-red-500", "bg-green-500");
    progressBar.classList.replace("bg-yellow-400", "bg-green-500");
    countdownTxt.innerText = `YOUR TURN TO SPEAK: ${timeLeft}s`;
    countdownTxt.classList.remove("text-red-500", "text-yellow-400");
    countdownTxt.classList.add("text-green-400");

    clearInterval(currentTimerInterval);
    clearTimeout(currentTimeout);

    currentTimerInterval = setInterval(() => {
        timeLeft--;
        countdownTxt.innerText = `YOUR TURN TO SPEAK: ${timeLeft}s`;
        progressBar.style.width = `${(timeLeft / TURN_TIME_LIMIT) * 100}%`;
        
        if(timeLeft === 10) {
            progressBar.classList.replace("bg-green-500", "bg-yellow-400");
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
    const alertBox = document.getElementById("game-alert");

    // Chat Format Fix (No 'System', straight player names)
    if (data.type === "chat") {
        if(data.sender === "System") {
            msgDiv.innerHTML += `<p class="text-center text-xs text-gray-500 italic my-1">${data.text}</p>`;
        } else {
            let color = data.sender === username ? 'text-blue-400' : 'text-gray-300';
            msgDiv.innerHTML += `<p><b class="${color}">${data.sender}:</b> <span class="text-white">${data.text}</span></p>`;
        }
    } 
    else if (data.type === "game_start") {
        playSound('start');
        isAlive = true;
        activePlayersList = data.players;
        document.getElementById("my-word").innerText = data.word;
        document.getElementById("players-list-container").classList.remove("hidden");
        updateActivePlayersList(activePlayersList, null);
        msgDiv.innerHTML += `<p class="text-green-500 font-bold text-center mt-2 border-y border-green-800 py-1">MISSION COMMENCED</p>`;
    }
    else if (data.type === "turn_update") {
        alertBox.innerText = data.message;
        updateActivePlayersList(activePlayersList, data.current_player);
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
        updateActivePlayersList(activePlayersList, null);
        if (isAlive) {
            const voteArea = document.getElementById("vote-area");
            const voteBtns = document.getElementById("vote-buttons");
            voteBtns.innerHTML = "";
            data.players.forEach(p => {
                if (p !== username) {
                    voteBtns.innerHTML += `<button onclick="playSound('click'); castVote('${p}')" class="btn btn-dark p-2.5 rounded-lg font-bold text-sm shadow-md">${p}</button>`;
                }
            });
            voteArea.classList.remove("hidden");
            alertBox.innerText = "Time to Vote! Identify the Spy.";
        }
    }
    else if (data.type === "reaction_phase") {
        playSound('dead');
        alertBox.innerHTML = `<span class="text-red-500">${data.message}</span>`;
        document.getElementById("vote-area").classList.add("hidden");
        if (username === data.dead_player) {
            isAlive = false;
            setMicState(false);
            alertBox.innerText = "You are DEAD. You can only listen and chat.";
        } else if (isAlive) {
            setMicState(true);
        }
    }
    else if (data.type === "new_round") {
        playSound('start');
        msgDiv.innerHTML += `<p class="text-blue-400 font-bold text-center mt-2 border-y border-blue-800 py-1">NEXT ROUND</p>`;
        setMicState(false);
    }
    else if (data.type === "game_over") {
        if (data.winner === 'civilians') {
            playSound('caught');
        } else {
            playSound('over');
        }
        alertBox.innerText = data.message;
        alertBox.className = data.winner === 'spy' ? "text-red-500 font-black text-xl text-center uppercase tracking-widest" : "text-green-500 font-black text-xl text-center uppercase tracking-widest";
        document.getElementById("vote-area").classList.add("hidden");
        setMicState(true); // Open mic for all after game over
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

// Ensure Enter key sends chat
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
    document.getElementById("vote-area").innerHTML = `<p class="text-green-400 text-center w-full font-bold">Target locked: ${player}</p>`;
}

function leaveGame() {
    playSound('click');
    if(confirm("Abandon mission and return to lobby?")) {
        window.location.reload();
    }
}
