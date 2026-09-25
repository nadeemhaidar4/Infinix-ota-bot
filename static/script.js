let ws;
let username = "";
let room = "";
let isAlive = true;
let userCapacity = 4;

// Agora Variables
const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4";
let rtcClient;
let localAudioTrack;

async function fetchActiveUsers() {
    try {
        const response = await fetch('/get_active_users');
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
        joinSection.innerHTML = '<p class="text-green-400 font-bold text-xl animate-pulse text-center mt-10">SEARCHING FOR MATCH...</p>';
        try {
            const response = await fetch(`/get_random_room/${userCapacity}`);
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    } 
    else if (mode === 'create') {
        joinSection.innerHTML = '<p class="text-blue-400 font-bold text-xl animate-pulse text-center mt-10">CREATING ROOM...</p>';
        try {
            const response = await fetch('/create_new_room');
            const data = await response.json();
            room = data.room_id;
        } catch (error) { return alert("Server error!"); }
    }
    else if (mode === 'join') {
        let code = prompt("Enter 4-Digit Room ID to join your friends:");
        if(!code || code.trim() === "") return; 
        room = code.trim();
    }

    document.getElementById("join-section").classList.add("hidden");
    document.getElementById("game-section").classList.remove("hidden");
    document.getElementById("game-section").classList.add("flex");
    document.getElementById("current-room-display").innerText = `(ROOM: ${room})`;

    // WebSocket Connect (Passing Capacity)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${room}/${username}/${userCapacity}`);

    ws.onmessage = function(event) {
        handleServerMessage(JSON.parse(event.data));
    };

    // Agora Setup with Try-Catch so Game continues even if Mic blocks (Useful for testing)
    try {
        await initAgora(room, username);
    } catch (err) {
        console.error("Agora Init Error: ", err);
        alert("Mic permission denied or in use. You can still play via text chat!");
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
    await localAudioTrack.setMuted(false);
    updateMicUI(true);
}

// User manually clicking mic button
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
    updateMicUI(isMuted); // If it was muted, now it is unmuted (true)
}

// Server controlling mic (Mute during others turn)
async function setMicState(unmute) {
    if (!localAudioTrack) return;
    await localAudioTrack.setMuted(!unmute);
    updateMicUI(unmute);
}

function updateMicUI(isOn) {
    const micUI = document.getElementById("mic-status");
    if (isOn) {
        micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white animate-pulse"></div><span>MIC ON</span>';
        micUI.classList.remove("bg-red-500/80", "border-red-500");
        micUI.classList.add("bg-green-500/80", "border-green-500");
        micUI.style.boxShadow = "0 0 10px rgba(0,255,0,0.5)";
    } else {
        micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white"></div><span>MIC OFF</span>';
        micUI.classList.remove("bg-green-500/80", "border-green-500");
        micUI.classList.add("bg-red-500/80", "border-red-500");
        micUI.style.boxShadow = "0 0 10px rgba(255,0,0,0.5)";
    }
}

function handleServerMessage(data) {
    const msgDiv = document.getElementById("messages");
    const alertBox = document.getElementById("game-alert");

    if (data.type === "chat") {
        msgDiv.innerHTML += `<p><b class="${data.sender==='System' ? 'text-yellow-400' : 'text-blue-300'}">${data.sender}:</b> ${data.text}</p>`;
    } 
    else if (data.type === "game_start") {
        isAlive = true;
        document.getElementById("my-word").innerText = data.word;
        msgDiv.innerHTML += `<p class="text-green-400 font-bold text-center mt-2">-- GAME STARTED --</p>`;
    }
    else if (data.type === "turn_update") {
        alertBox.innerText = data.message;
        if (data.current_player === username && isAlive) {
            setMicState(true);
            document.getElementById("turn-controls").classList.remove("hidden");
        } else {
            setMicState(false);
            document.getElementById("turn-controls").classList.add("hidden");
        }
    }
    else if (data.type === "start_voting") {
        setMicState(false); 
        document.getElementById("turn-controls").classList.add("hidden");
        if (isAlive) {
            const voteArea = document.getElementById("vote-area");
            const voteBtns = document.getElementById("vote-buttons");
            voteBtns.innerHTML = "";
            data.players.forEach(p => {
                if (p !== username) {
                    voteBtns.innerHTML += `<button onclick="castVote('${p}')" class="bg-red-600 p-2 rounded font-bold">${p}</button>`;
                }
            });
            voteArea.classList.remove("hidden");
            alertBox.innerText = "Time to Vote!";
        }
    }
    else if (data.type === "reaction_phase") {
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
        msgDiv.innerHTML += `<p class="text-blue-400 font-bold text-center mt-2">-- ROUND 2 --</p>`;
        setMicState(false);
    }
    else if (data.type === "game_over") {
        alertBox.innerText = data.message;
        alertBox.className = data.winner === 'spy' ? "text-red-500 font-bold text-xl h-6 text-center" : "text-green-500 font-bold text-xl h-6 text-center";
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
    document.getElementById("turn-controls").classList.add("hidden");
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
