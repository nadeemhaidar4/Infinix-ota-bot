from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
import json
import random
import asyncio
import time

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")

rooms = {}
active_clients = {}

word_pairs = [
    {"civilian": "Apple", "spy": "Mango"},
    {"civilian": "School", "spy": "College"},
    {"civilian": "Car", "spy": "Bike"},
    {"civilian": "Dog", "spy": "Cat"},
    {"civilian": "Pizza", "spy": "Burger"},
    {"civilian": "River", "spy": "Lake"},
    {"civilian": "Mountain", "spy": "Hill"},
    {"civilian": "Ocean", "spy": "Sea"},
    {"civilian": "Sun", "spy": "Moon"},
    {"civilian": "Star", "spy": "Planet"},
    {"civilian": "Tree", "spy": "Bush"},
    {"civilian": "Flower", "spy": "Leaf"},
    {"civilian": "Computer", "spy": "Laptop"},
    {"civilian": "Phone", "spy": "Tablet"},
    {"civilian": "Television", "spy": "Radio"},
    {"civilian": "Book", "spy": "Magazine"},
    {"civilian": "Pen", "spy": "Pencil"},
    {"civilian": "Paper", "spy": "Notebook"},
    {"civilian": "Chair", "spy": "Sofa"},
    {"civilian": "Table", "spy": "Desk"},
    {"civilian": "Door", "spy": "Window"},
    {"civilian": "House", "spy": "Apartment"},
    {"civilian": "City", "spy": "Village"},
    {"civilian": "Country", "spy": "State"},
    {"civilian": "Shirt", "spy": "T-shirt"},
    {"civilian": "Pants", "spy": "Jeans"},
    {"civilian": "Shoes", "spy": "Boots"},
    {"civilian": "Hat", "spy": "Cap"},
    {"civilian": "Glasses", "spy": "Goggles"},
    {"civilian": "Watch", "spy": "Clock"},
    {"civilian": "Gold", "spy": "Silver"},
    {"civilian": "Diamond", "spy": "Ruby"},
    {"civilian": "Coffee", "spy": "Tea"},
    {"civilian": "Water", "spy": "Juice"},
    {"civilian": "Milk", "spy": "Butter"},
    {"civilian": "Bread", "spy": "Toast"},
    {"civilian": "Cake", "spy": "Pastry"},
    {"civilian": "Chocolate", "spy": "Candy"},
    {"civilian": "Chicken", "spy": "Fish"},
    {"civilian": "Egg", "spy": "Meat"},
    {"civilian": "Potato", "spy": "Tomato"},
    {"civilian": "Onion", "spy": "Garlic"},
    {"civilian": "Doctor", "spy": "Nurse"},
    {"civilian": "Teacher", "spy": "Student"},
    {"civilian": "Police", "spy": "Army"},
    {"civilian": "King", "spy": "Queen"},
    {"civilian": "Prince", "spy": "Princess"},
    {"civilian": "Actor", "spy": "Director"},
    {"civilian": "Singer", "spy": "Dancer"},
    {"civilian": "Piano", "spy": "Guitar"},
    {"civilian": "Flute", "spy": "Violin"},
    {"civilian": "Football", "spy": "Cricket"},
    {"civilian": "Tennis", "spy": "Badminton"},
    {"civilian": "Chess", "spy": "Ludo"},
    {"civilian": "Running", "spy": "Walking"},
    {"civilian": "Swimming", "spy": "Diving"},
    {"civilian": "Summer", "spy": "Winter"},
    {"civilian": "Rain", "spy": "Snow"},
    {"civilian": "Wind", "spy": "Storm"},
    {"civilian": "Fire", "spy": "Smoke"},
    {"civilian": "Red", "spy": "Pink"},
    {"civilian": "Blue", "spy": "Green"},
    {"civilian": "Black", "spy": "White"},
    {"civilian": "Yellow", "spy": "Orange"},
    {"civilian": "Circle", "spy": "Square"},
    {"civilian": "Triangle", "spy": "Rectangle"},
    {"civilian": "Happy", "spy": "Sad"},
    {"civilian": "Angry", "spy": "Cry"},
    {"civilian": "Laugh", "spy": "Smile"},
    {"civilian": "Love", "spy": "Hate"},
    {"civilian": "Friend", "spy": "Enemy"},
    {"civilian": "Brother", "spy": "Sister"},
    {"civilian": "Father", "spy": "Mother"},
    {"civilian": "Uncle", "spy": "Aunt"},
    {"civilian": "Boy", "spy": "Girl"},
    {"civilian": "Man", "spy": "Woman"},
    {"civilian": "Baby", "spy": "Child"},
    {"civilian": "Eye", "spy": "Ear"},
    {"civilian": "Nose", "spy": "Mouth"},
    {"civilian": "Hand", "spy": "Foot"},
    {"civilian": "Hair", "spy": "Nail"},
    {"civilian": "Heart", "spy": "Brain"},
    {"civilian": "Blood", "spy": "Bone"},
    {"civilian": "Hospital", "spy": "Clinic"},
    {"civilian": "Bank", "spy": "ATM"},
    {"civilian": "Market", "spy": "Mall"},
    {"civilian": "Park", "spy": "Garden"},
    {"civilian": "Zoo", "spy": "Museum"},
    {"civilian": "Cinema", "spy": "Theatre"},
    {"civilian": "Train", "spy": "Bus"},
    {"civilian": "Airplane", "spy": "Helicopter"},
    {"civilian": "Ship", "spy": "Boat"},
    {"civilian": "Bicycle", "spy": "Scooter"},
    {"civilian": "Road", "spy": "Street"},
    {"civilian": "Bridge", "spy": "Tunnel"},
    {"civilian": "Ticket", "spy": "Pass"},
    {"civilian": "Map", "spy": "Compass"},
    {"civilian": "Key", "spy": "Lock"},
    {"civilian": "Sword", "spy": "Knife"},
    {"civilian": "Gun", "spy": "Rifle"},
    {"civilian": "Bomb", "spy": "Grenade"},
    {"civilian": "Mirror", "spy": "Glass"},
    {"civilian": "Bottle", "spy": "Cup"},
    {"civilian": "Plate", "spy": "Bowl"},
    {"civilian": "Spoon", "spy": "Fork"},
    {"civilian": "Soap", "spy": "Shampoo"},
    {"civilian": "Towel", "spy": "Napkin"},
    {"civilian": "Bed", "spy": "Cot"},
    {"civilian": "Pillow", "spy": "Cushion"},
    {"civilian": "Blanket", "spy": "Quilt"},
    {"civilian": "Light", "spy": "Bulb"},
    {"civilian": "Fan", "spy": "AC"},
    {"civilian": "Heater", "spy": "Cooler"},
    {"civilian": "Camera", "spy": "Lens"},
    {"civilian": "Photo", "spy": "Video"},
    {"civilian": "Movie", "spy": "Drama"},
    {"civilian": "Song", "spy": "Music"},
    {"civilian": "Poem", "spy": "Story"},
    {"civilian": "Letter", "spy": "Email"},
    {"civilian": "Newspaper", "spy": "Magazine"},
    {"civilian": "News", "spy": "Gossip"},
    {"civilian": "Internet", "spy": "Wifi"},
    {"civilian": "Website", "spy": "App"},
    {"civilian": "Game", "spy": "Sport"},
    {"civilian": "Goal", "spy": "Point"},
    {"civilian": "Win", "spy": "Lose"},
    {"civilian": "Prize", "spy": "Award"},
    {"civilian": "Money", "spy": "Coin"},
    {"civilian": "Rich", "spy": "Poor"},
    {"civilian": "Job", "spy": "Business"},
    {"civilian": "Office", "spy": "Factory"},
    {"civilian": "Worker", "spy": "Boss"},
    {"civilian": "Salary", "spy": "Bonus"},
    {"civilian": "Tax", "spy": "Bill"},
    {"civilian": "Price", "spy": "Cost"},
    {"civilian": "Buy", "spy": "Sell"},
    {"civilian": "Shop", "spy": "Store"},
    {"civilian": "Customer", "spy": "Client"},
    {"civilian": "Lawyer", "spy": "Judge"},
    {"civilian": "Court", "spy": "Jail"},
    {"civilian": "Thief", "spy": "Robber"},
    {"civilian": "Crime", "spy": "Sin"},
    {"civilian": "Truth", "spy": "Lie"},
    {"civilian": "Secret", "spy": "Mystery"},
    {"civilian": "Magic", "spy": "Illusion"},
    {"civilian": "Ghost", "spy": "Spirit"},
    {"civilian": "Angel", "spy": "Demon"},
    {"civilian": "God", "spy": "Devil"},
    {"civilian": "Heaven", "spy": "Hell"},
    {"civilian": "Life", "spy": "Death"},
    {"civilian": "Birth", "spy": "Funeral"},
    {"civilian": "Marriage", "spy": "Divorce"},
    {"civilian": "Party", "spy": "Festival"},
    {"civilian": "Gift", "spy": "Present"},
    {"civilian": "Balloon", "spy": "Kite"},
    {"civilian": "Toy", "spy": "Doll"},
    {"civilian": "Puppy", "spy": "Kitten"},
    {"civilian": "Tiger", "spy": "Lion"},
    {"civilian": "Elephant", "spy": "Rhino"},
    {"civilian": "Monkey", "spy": "Ape"},
    {"civilian": "Bear", "spy": "Wolf"},
    {"civilian": "Snake", "spy": "Lizard"},
    {"civilian": "Bird", "spy": "Bat"},
    {"civilian": "Eagle", "spy": "Hawk"},
    {"civilian": "Parrot", "spy": "Pigeon"},
    {"civilian": "Duck", "spy": "Swan"},
    {"civilian": "Frog", "spy": "Toad"},
    {"civilian": "Fish", "spy": "Shark"},
    {"civilian": "Whale", "spy": "Dolphin"},
    {"civilian": "Ant", "spy": "Bee"},
    {"civilian": "Spider", "spy": "Scorpion"},
    {"civilian": "Mosquito", "spy": "Fly"},
    {"civilian": "Butterfly", "spy": "Moth"},
    {"civilian": "Rose", "spy": "Lotus"},
    {"civilian": "Jasmine", "spy": "Lily"},
    {"civilian": "Sunflower", "spy": "Marigold"},
    {"civilian": "Grass", "spy": "Weed"},
    {"civilian": "Forest", "spy": "Jungle"},
    {"civilian": "Desert", "spy": "Sand"},
    {"civilian": "Rock", "spy": "Stone"},
    {"civilian": "Dust", "spy": "Dirt"},
    {"civilian": "Mud", "spy": "Clay"},
    {"civilian": "Ice", "spy": "Snow"},
    {"civilian": "Fire", "spy": "Flame"},
    {"civilian": "Heat", "spy": "Cold"},
    {"civilian": "Day", "spy": "Night"},
    {"civilian": "Morning", "spy": "Evening"},
    {"civilian": "Today", "spy": "Tomorrow"},
    {"civilian": "Week", "spy": "Month"},
    {"civilian": "Year", "spy": "Decade"},
    {"civilian": "Century", "spy": "Millennium"},
    {"civilian": "Past", "spy": "Future"},
    {"civilian": "History", "spy": "Science"},
    {"civilian": "Math", "spy": "Physics"},
    {"civilian": "English", "spy": "Hindi"}
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

@app.get("/get_active_users")
async def get_active_users(client_id: str = None):
    current_time = time.time()
    if client_id:
        active_clients[client_id] = current_time
        
    stale_clients = [cid for cid, last_seen in active_clients.items() if current_time - last_seen > 15]
    for cid in stale_clients:
        del active_clients[cid]
        
    return {"active_users": len(active_clients)}

@app.get("/get_random_room/{capacity}")
async def get_random_room(capacity: int):
    for room_id, room_data in manager.rooms.items():
        if room_data['state'] == 'waiting' and room_data['capacity'] == capacity and len(room_data['connections']) < capacity:
            return {"room_id": room_id}
            
    while True:
        new_room = str(random.randint(1000, 9999))
        if new_room not in manager.rooms:
            return {"room_id": new_room}

@app.get("/create_new_room")
async def create_new_room():
    while True:
        new_room = str(random.randint(1000, 9999))
        if new_room not in manager.rooms:
            return {"room_id": new_room}

@app.websocket("/ws/{room_id}/{username}/{capacity}")
async def websocket_endpoint(websocket: WebSocket, room_id: str, username: str, capacity: int):
    await websocket.accept()

    if room_id not in manager.rooms:
        manager.rooms[room_id] = {
            'connections': [],
            'players': {},
            'alive_list': [],
            'turn_index': 0,
            'votes': {},
            'state': 'waiting',
            'capacity': capacity
        }
    
    room = manager.rooms[room_id]
    
    if len(room['connections']) >= room['capacity']:
        await websocket.send_text(json.dumps({"type": "error", "message": "Room is full!"}))
        await websocket.close()
        return

    room['connections'].append(websocket)
    room['players'][username] = {"ws": websocket, "role": "", "is_alive": True, "word": ""}
    
    await manager.broadcast(room_id, {
        "type": "chat", "sender": "System", 
        "text": f"{username} joined. ({len(room['connections'])}/{room['capacity']})"
    })

    if len(room['connections']) == room['capacity'] and room['state'] == 'waiting':
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
                
                if len(room['votes']) == len(room['alive_list']):
                    await calculate_votes(room_id)

    except WebSocketDisconnect:
        room['connections'].remove(websocket)
        del room['players'][username]
        if username in room['alive_list']:
            room['alive_list'].remove(username)
        
        if len(room['connections']) == 0:
            del manager.rooms[room_id]
        else:
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
    
    eliminated_player = max(set(votes), key=votes.count)
    eliminated_role = room['players'][eliminated_player]['role']
    
    if eliminated_role == 'spy':
        room['state'] = 'game_over'
        await manager.broadcast(room_id, {
            "type": "game_over", "winner": "civilians", 
            "message": f"🎉 {eliminated_player} was the SPY! Civilians WIN!"
        })
    else:
        room['players'][eliminated_player]['is_alive'] = False
        room['alive_list'].remove(eliminated_player)
        
        if len(room['alive_list']) <= 2:
            room['state'] = 'game_over'
            await manager.broadcast(room_id, {
                "type": "game_over", "winner": "spy",
                "message": f"💀 {eliminated_player} was a Civilian. Only 2 left. SPY WINS!"
            })
        else:
            await manager.broadcast(room_id, {
                "type": "reaction_phase", 
                "dead_player": eliminated_player,
                "message": f"💀 {eliminated_player} was a CIVILIAN! Panic for 10 seconds!"
            })
            
            await asyncio.sleep(10)
            
            room['turn_index'] = 0
            room['state'] = 'playing'
            await manager.broadcast(room_id, {"type": "new_round"})
            await start_turn(room_id)
