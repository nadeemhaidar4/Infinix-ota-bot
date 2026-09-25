from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import json
import random
import asyncio

app = FastAPI()

# Frontend static files serve karne ke liye
app.mount("/static", StaticFiles(directory="static"), name="static")

rooms = {}
word_pairs = [
    {"civilian": "Apple", "spy": "Mango"},
    {"civilian": "School", "spy": "College"},
    {"civilian": "Car", "spy": "Bike"},
    {"civilian": "Dog", "spy": "Cat"}
]

class RoomManager:
    def __init__(self):
        self.rooms = {}

    async def broadcast(self, room_id, message: dict):
        if room_id in self.rooms:
            for ws in self.rooms[room_id]['connections']:
                try:
                    await ws.send_text(json.dumps(message))
                except:
                    pass

manager = RoomManager()

@app.get("/")
async def get():
    with open("static/index.html", "r") as f:
        return HTMLResponse(f.read())

@app.websocket("/ws/{room_id}/{username}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str):
    await websocket.accept()

    if room_id not in manager.rooms:
        manager.rooms[room_id] = {
            'connections': [],
            'players': {}, # username -> {role, is_alive, word}
            'alive_list': [],
            'turn_index': 0,
            'votes': {},
            'state': 'waiting'
        }
    
    room = manager.rooms[room_id]
    
    if len(room['connections']) >= 4:
        await websocket.send_text(json.dumps({"type": "error", "message": "Room is full!"}))
        await websocket.close()
        return

    room['connections'].append(websocket)
    room['players'][username] = {"ws": websocket, "role": "", "is_alive": True, "word": ""}
    
    await manager.broadcast(room_id, {
        "type": "chat", "sender": "System", 
        "text": f"{username} joined. ({len(room['connections'])}/4)"
    })

    # Auto-start Game when 4 players join
    if len(room['connections']) == 4 and room['state'] == 'waiting':
        room['state'] = 'playing'
        pair = random.choice(word_pairs)
        spy_username = random.choice(list(room['players'].keys()))
        room['alive_list'] = list(room['players'].keys())

        for p_name, p_data in room['players'].items():
            role = "spy" if p_name == spy_username else "civilian"
            word = pair["spy"] if role == "spy" else pair["civilian"]
            p_data['role'] = role
            p_data['word'] = word
            
            await p_data['ws'].send_text(json.dumps({
                "type": "game_start", "role": role, "word": word, "players": room['alive_list']
            }))
        
        await asyncio.sleep(2)
        await start_turn(room_id)

    try:
        while True:
            data = await websocket.receive_text()
            parsed_data = json.loads(data)
            action = parsed_data.get("action")

            if action == "chat":
                await manager.broadcast(room_id, {"type": "chat", "sender": username, "text": parsed_data["text"]})
            
            elif action == "end_turn":
                current_player = room['alive_list'][room['turn_index']]
                if username == current_player:
                    room['turn_index'] += 1
                    if room['turn_index'] < len(room['alive_list']):
                        await start_turn(room_id)
                    else:
                        room['state'] = 'voting'
                        room['votes'] = {}
                        await manager.broadcast(room_id, {"type": "start_voting", "players": room['alive_list']})
            
            elif action == "cast_vote":
                voted_for = parsed_data["vote"]
                room['votes'][username] = voted_for
                
                # Check if all alive players have voted
                if len(room['votes']) == len(room['alive_list']):
                    await calculate_votes(room_id)

    except WebSocketDisconnect:
        room['connections'].remove(websocket)
        del room['players'][username]
        if username in room['alive_list']:
            room['alive_list'].remove(username)
        await manager.broadcast(room_id, {"type": "chat", "sender": "System", "text": f"{username} left."})

async def start_turn(room_id):
    room = manager.rooms[room_id]
    current_player = room['alive_list'][room['turn_index']]
    await manager.broadcast(room_id, {
        "type": "turn_update", 
        "current_player": current_player,
        "message": f"{current_player}'s turn to speak!"
    })

async def calculate_votes(room_id):
    room = manager.rooms[room_id]
    votes = list(room['votes'].values())
    
    # Sabse zyada vote kisko mile (Simple logic: set me max count)
    eliminated_player = max(set(votes), key=votes.count)
    eliminated_role = room['players'][eliminated_player]['role']
    
    if eliminated_role == 'spy':
        # SPY KILLED -> CIVILIANS WIN
        room['state'] = 'game_over'
        await manager.broadcast(room_id, {
            "type": "game_over", "winner": "civilians", 
            "message": f"🎉 {eliminated_player} was the SPY! Civilians WIN!"
        })
    else:
        # CIVILIAN KILLED
        room['players'][eliminated_player]['is_alive'] = False
        room['alive_list'].remove(eliminated_player)
        
        if len(room['alive_list']) <= 2:
            # 1 Spy, 1 Civilian left -> SPY WINS
            room['state'] = 'game_over'
            await manager.broadcast(room_id, {
                "type": "game_over", "winner": "spy",
                "message": f"💀 {eliminated_player} was a Civilian. Only 2 left. SPY WINS!"
            })
        else:
            # REACTION PHASE (10 Secs Chaos)
            await manager.broadcast(room_id, {
                "type": "reaction_phase", 
                "dead_player": eliminated_player,
                "message": f"💀 {eliminated_player} was a CIVILIAN! Panic for 10 seconds!"
            })
            
            await asyncio.sleep(10)
            
            # Start Next Round
            room['turn_index'] = 0
            room['state'] = 'playing'
            await manager.broadcast(room_id, {"type": "new_round"})
            await start_turn(room_id)
