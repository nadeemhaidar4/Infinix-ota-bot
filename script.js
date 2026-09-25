let ws;
let username = "";
let room = "";
let isAlive = true;

// Agora Variables
const AGORA_APP_ID = "YOUR_AGORA_APP_ID_HERE"; // <-- Yahan apna Agora App ID dalein
let rtcClient;
let localAudioTrack;

async function joinRoom() {
    username = document.getElementById("username").value.trim();
    room = document.getElementById("room").value.trim();
    
    if(!username || !room) return alert("Name and Room code required!");

    document.getElementById("join-section").classList.add("hidden");
    document.getElementById("game-section").classList.remove("hidden");

    // 1. Connect WebSocket
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws/${room}/${username}`);

    ws.onmessage = function(event) {
        handleServerMessage(JSON.parse(event.data));
    };

    // 2. Connect Voice Chat (Agora)
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
    
    // Start with mic Muted
    await localAudioTrack.setMuted(true);
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
        // Kisi ki turn aayi
        alertBox.innerText = data.message;
        
        if (data.current_player === username && isAlive) {
            // Meri baari! Mic On karo.
            setMicState(true);
            document.getElementById("turn-controls").classList.remove("hidden");
        } else {
            // Dusre ki baari. Mera Mic Off rakho.
            setMicState(false);
            document.getElementById("turn-controls").classList.add("hidden");
        }
    }
    
    else if (data.type === "start_voting") {
        setMicState(false); // Voting ke time silence
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
            setMicState(true); // PANIC MODE - Unmute alive players
        }
    }

    else if (data.type === "new_round") {
        msgDiv.innerHTML += `<p class="text-blue-400 font-bold text-center mt-2">-- ROUND 2 --</p>`;
        setMicState(false); // Sannata wapas
    }

    else if (data.type === "game_over") {
        alertBox.innerText = data.message;
        alertBox.className = data.winner === 'spy' ? "text-red-500 font-bold text-xl h-6" : "text-green-500 font-bold text-xl h-6";
        document.getElementById("vote-area").classList.add("hidden");
        setMicState(true); // Game over me sab aapas me baat kar sakte hain
    }

    // Auto-scroll chat to bottom
    msgDiv.scrollTop = msgDiv.scrollHeight;
}

async function setMicState(unmute) {
    if (!localAudioTrack) return;
    const micUI = document.getElementById("mic-status");
    
    if (unmute) {
        await localAudioTrack.setMuted(false);
        micUI.innerText = "MIC ON";
        micUI.classList.replace("bg-red-500", "bg-green-500");
    } else {
        await localAudioTrack.setMuted(true);
        micUI.innerText = "MIC OFF";
        micUI.classList.replace("bg-green-500", "bg-red-500");
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