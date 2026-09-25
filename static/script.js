let ws;
let username = "";
let room = "";
let isAlive = true;

// Agora Variables
const AGORA_APP_ID = "1c843bac45114149a3c327bd6d6320d4";
let rtcClient;
let localAudioTrack;

async function joinRoom() {
    username = document.getElementById("username").value.trim();
    let roomInput = document.getElementById("room").value.trim();
    
    if(!username) return alert("Codename is required!");

    // Random Room Matchmaking Logic
    if(!roomInput) {
        document.getElementById("join-section").innerHTML = '<p class="text-green-400 font-bold text-xl animate-pulse text-center mt-10">SEARCHING FOR MATCH...</p>';
        try {
            const response = await fetch('/get_random_room');
            const data = await response.json();
            room = data.room_id;
        } catch (error) {
            return alert("Server error! Please try again.");
        }
    } else {
        room = roomInput;
    }

    document.getElementById("join-section").classList.add("hidden");
    document.getElementById("game-section").classList.remove("hidden");

    // WebSocket Connect
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${room}/${username}`);

    ws.onmessage = function(event) {
        handleServerMessage(JSON.parse(event.data));
    };

    // Agora Connect
    await initAgora(room, username);
}

async function initAgora(channelName, uid) {
    rtcClient = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    
    rtcClient.on("user-published", async (user, mediaType) => {
        await rtcClient.subscribe(user, mediaType);
        if (mediaType === "audio") user.audioTrack.play();
    });

    await rtcClient.join(AGORA_APP_ID, channelName, null, uid);
    localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack();
    
    // Start with mic ON by default!
    await localAudioTrack.setMuted(false);
    
    // Update UI directly to show MIC ON
    const micUI = document.getElementById("mic-status");
    micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white animate-pulse"></div><span>MIC ON</span>';
    micUI.classList.remove("bg-red-500/80", "border-red-500");
    micUI.classList.add("bg-green-500/80", "border-green-500");
    micUI.style.boxShadow = "0 0 10px rgba(0,255,0,0.5)";
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

async function setMicState(unmute) {
    if (!localAudioTrack) return;
    const micUI = document.getElementById("mic-status");
    
    if (unmute) {
        await localAudioTrack.setMuted(false);
        micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white animate-pulse"></div><span>MIC ON</span>';
        micUI.classList.remove("bg-red-500/80", "border-red-500");
        micUI.classList.add("bg-green-500/80", "border-green-500");
        micUI.style.boxShadow = "0 0 10px rgba(0,255,0,0.5)";
    } else {
        await localAudioTrack.setMuted(true);
        micUI.innerHTML = '<div class="w-2 h-2 rounded-full bg-white"></div><span>MIC OFF</span>';
        micUI.classList.remove("bg-green-500/80", "border-green-500");
        micUI.classList.add("bg-red-500/80", "border-red-500");
        micUI.style.boxShadow = "0 0 10px rgba(255,0,0,0.5)";
    }
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
