from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pathlib import Path
import asyncio
import json
import random
import time
from typing import Any


# =========================================================
# APP / PATHS
# =========================================================

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Who Is The Spy")

app.mount(
    "/static",
    StaticFiles(directory=str(STATIC_DIR)),
    name="static"
)


# =========================================================
# CONFIG
# =========================================================

MIN_PLAYERS = 4
MAX_PLAYERS = 8

TURN_TIME = 30
REACTION_TIME = 10
ROOM_EXPIRE_SECONDS = 15 * 60
ACTIVE_USER_TIMEOUT = 20


# =========================================================
# WORD PAIRS
# =========================================================

WORD_PAIRS = [
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
    {"civilian": "Flame", "spy": "Ember"},
    {"civilian": "Heat", "spy": "Cold"},
    {"civilian": "Day", "spy": "Night"},
    {"civilian": "Morning", "spy": "Evening"},
    {"civilian": "Today", "spy": "Tomorrow"},
    {"civilian": "Week", "spy": "Month"},
    {"civilian": "Year", "spy": "Decade"},
    {"civilian": "Past", "spy": "Future"},
    {"civilian": "History", "spy": "Science"},
    {"civilian": "Math", "spy": "Physics"},
    {"civilian": "English", "spy": "Hindi"},
]


# =========================================================
# GLOBAL STATE
# =========================================================

rooms: dict[str, dict[str, Any]] = {}
active_clients: dict[str, float] = {}
rooms_lock = asyncio.Lock()


# =========================================================
# HELPERS
# =========================================================

def now() -> float:
    return time.time()


def valid_capacity(capacity: int) -> bool:
    return MIN_PLAYERS <= capacity <= MAX_PLAYERS


def valid_mode(mode: str) -> bool:
    return mode in ("spy", "wordless")


def clean_username(name: str) -> str:
    name = (name or "").strip()

    if not name:
        return ""

    # Keep names reasonably short.
    name = name[:20]

    # Remove control characters.
    name = "".join(ch for ch in name if ch.isprintable())

    return name.strip()


def make_room(room_id: str, capacity: int, mode: str) -> dict[str, Any]:
    return {
        "room_id": room_id,
        "capacity": capacity,
        "mode": mode,
        "state": "waiting",
        "created_at": now(),
        "last_activity": now(),

        # username -> player dict
        "players": {},

        # Current connected websocket objects
        "connections": set(),

        # Alive player usernames
        "alive_list": [],

        # Speaking
        "current_speaker": None,
        "turn_task": None,
        "turn_id": 0,

        # Voting
        "votes": {},

        # Selected word pair / spy
        "pair": None,
        "spy_username": None,

        # Reaction/new round timer
        "reaction_task": None,
    }


def connected_usernames(room: dict[str, Any]) -> list[str]:
    return [
        username
        for username, data in room["players"].items()
        if data.get("connected") is True
        and data.get("ws") is not None
    ]


def alive_connected_usernames(room: dict[str, Any]) -> list[str]:
    return [
        username
        for username in room["alive_list"]
        if username in room["players"]
        and room["players"][username].get("connected") is True
        and room["players"][username].get("is_alive") is True
    ]


def player_snapshot(room: dict[str, Any]) -> list[dict[str, Any]]:
    result = []

    for username in connected_usernames(room):
        player = room["players"][username]

        result.append(
            {
                "username": username,
                "ready": bool(player.get("ready", False)),
                "alive": bool(player.get("is_alive", True)),
            }
        )

    return result


def all_players_ready(room: dict[str, Any]) -> bool:
    users = connected_usernames(room)

    if len(users) != room["capacity"]:
        return False

    return all(
        room["players"][username].get("ready", False)
        for username in users
    )


def cancel_task(task: asyncio.Task | None) -> None:
    if task and not task.done() and task is not asyncio.current_task():
        task.cancel()


async def send_json(websocket: WebSocket, payload: dict[str, Any]) -> None:
    try:
        await websocket.send_text(json.dumps(payload))
    except Exception:
        pass


# =========================================================
# ROOM MANAGER
# =========================================================

class RoomManager:

    async def cleanup_expired_rooms(self) -> None:
        current = now()

        async with rooms_lock:
            delete_ids = []

            for room_id, room in rooms.items():
                connected = len(room["connections"])

                if connected == 0:
                    if current - room["last_activity"] > ROOM_EXPIRE_SECONDS:
                        delete_ids.append(room_id)

            for room_id in delete_ids:
                room = rooms.get(room_id)

                if room:
                    cancel_task(room.get("turn_task"))
                    cancel_task(room.get("reaction_task"))

                rooms.pop(room_id, None)

    async def new_room(self, capacity: int, mode: str) -> str:
        await self.cleanup_expired_rooms()

        async with rooms_lock:
            while True:
                room_id = str(random.randint(1000, 9999))

                if room_id not in rooms:
                    rooms[room_id] = make_room(
                        room_id,
                        capacity,
                        mode
                    )
                    return room_id

    async def random_room(self, capacity: int, mode: str) -> str:
        await self.cleanup_expired_rooms()

        async with rooms_lock:
            # Prefer a waiting room with same mode/capacity.
            candidates = []

            for room_id, room in rooms.items():
                if (
                    room["state"] == "waiting"
                    and room["capacity"] == capacity
                    and room["mode"] == mode
                    and len(room["connections"]) < capacity
                ):
                    candidates.append(room_id)

            if candidates:
                candidates.sort(
                    key=lambda room_id: rooms[room_id]["created_at"]
                )

                rooms[candidates[0]]["last_activity"] = now()
                return candidates[0]

            # No available room: reserve a new one.
            while True:
                room_id = str(random.randint(1000, 9999))

                if room_id not in rooms:
                    rooms[room_id] = make_room(
                        room_id,
                        capacity,
                        mode
                    )
                    return room_id


manager = RoomManager()


# =========================================================
# HTTP
# =========================================================

@app.get("/", response_class=HTMLResponse)
async def home():
    index_file = STATIC_DIR / "index.html"

    if not index_file.exists():
        return HTMLResponse(
            "<h1>static/index.html not found</h1>",
            status_code=500
        )

    return HTMLResponse(
        index_file.read_text(encoding="utf-8")
    )


@app.get("/get_active_users")
async def get_active_users(client_id: str | None = None):
    current_time = now()

    if client_id:
        active_clients[client_id] = current_time

    stale = [
        cid
        for cid, last_seen in active_clients.items()
        if current_time - last_seen > ACTIVE_USER_TIMEOUT
    ]

    for cid in stale:
        active_clients.pop(cid, None)

    return {
        "active_users": len(active_clients)
    }


@app.get("/get_random_room/{capacity}")
async def get_random_room(
    capacity: int,
    mode: str = "spy"
):
    if not valid_capacity(capacity):
        return {
            "error": "Capacity must be between 4 and 8."
        }

    if not valid_mode(mode):
        mode = "spy"

    room_id = await manager.random_room(
        capacity,
        mode
    )

    return {
        "room_id": room_id,
        "capacity": capacity,
        "mode": mode
    }


@app.get("/create_new_room")
async def create_new_room(
    capacity: int = 6,
    mode: str = "spy"
):
    if not valid_capacity(capacity):
        return {
            "error": "Capacity must be between 4 and 8."
        }

    if not valid_mode(mode):
        mode = "spy"

    room_id = await manager.new_room(
        capacity,
        mode
    )

    return {
        "room_id": room_id,
        "capacity": capacity,
        "mode": mode
    }


# =========================================================
# BROADCAST FUNCTIONS
# =========================================================

async def broadcast(room: dict[str, Any], payload: dict[str, Any]) -> None:
    connections = list(room["connections"])

    if not connections:
        return

    message = json.dumps(payload)

    dead_connections = []

    for ws in connections:
        try:
            await ws.send_text(message)
        except Exception:
            dead_connections.append(ws)

    for ws in dead_connections:
        room["connections"].discard(ws)


async def broadcast_lobby(room: dict[str, Any]) -> None:
    await broadcast(
        room,
        {
            "type": "lobby_update",
            "state": room["state"],
            "capacity": room["capacity"],
            "mode": room["mode"],
            "players": player_snapshot(room),
            "current_speaker": room.get("current_speaker"),
        }
    )


# =========================================================
# GAME WIN / END
# =========================================================

async def finish_game(
    room: dict[str, Any],
    winner: str,
    message: str
) -> None:

    if room["state"] == "game_over":
        return

    room["state"] = "game_over"
    room["last_activity"] = now()

    cancel_task(room.get("turn_task"))
    cancel_task(room.get("reaction_task"))

    room["turn_task"] = None
    room["reaction_task"] = None
    room["current_speaker"] = None

    await broadcast(
        room,
        {
            "type": "game_over",
            "winner": winner,
            "message": message,
            "spy_player": room.get("spy_username"),
        }
    )


async def check_win_after_disconnect(
    room: dict[str, Any],
    disconnected_username: str
) -> bool:

    if room["state"] not in ("playing", "voting"):
        return False

    player = room["players"].get(disconnected_username)

    if not player:
        return False

    # If the spy leaves during a live game, civilians win.
    if (
        player.get("role") == "spy"
        and room["state"] != "waiting"
    ):
        await finish_game(
            room,
            "civilians",
            f"{disconnected_username} was the SPY and left the room. Civilians WIN!"
        )
        return True

    alive = alive_connected_usernames(room)

    if len(alive) <= 2:
        await finish_game(
            room,
            "spy",
            "Only two players remain. SPY WINS!"
        )
        return True

    return False


# =========================================================
# TURN SYSTEM
# =========================================================

async def turn_timeout_worker(
    room_id: str,
    expected_turn_id: int,
    speaker: str
) -> None:

    try:
        await asyncio.sleep(TURN_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)

    if not room:
        return

    if room["state"] != "playing":
        return

    if room["turn_id"] != expected_turn_id:
        return

    if room.get("current_speaker") != speaker:
        return

    await broadcast(
        room,
        {
            "type": "turn_timeout",
            "current_player": speaker
        }
    )

    await advance_turn(
        room,
        speaker,
        automatic=True
    )


async def start_turn(
    room: dict[str, Any],
    speaker: str
) -> None:

    if room["state"] != "playing":
        return

    if speaker not in room["alive_list"]:
        return

    if (
        speaker not in room["players"]
        or not room["players"][speaker].get("is_alive", False)
        or not room["players"][speaker].get("connected", False)
    ):
        return

    cancel_task(room.get("turn_task"))

    room["turn_id"] += 1
    turn_id = room["turn_id"]
    room["current_speaker"] = speaker
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "turn_update",
            "current_player": speaker,
            "seconds": TURN_TIME,
            "turn_id": turn_id,
        }
    )

    room["turn_task"] = asyncio.create_task(
        turn_timeout_worker(
            room["room_id"],
            turn_id,
            speaker
        )
    )


async def begin_voting(room: dict[str, Any]) -> None:

    if room["state"] != "playing":
        return

    cancel_task(room.get("turn_task"))
    room["turn_task"] = None

    room["state"] = "voting"
    room["current_speaker"] = None
    room["votes"] = {}
    room["last_activity"] = now()

    alive = alive_connected_usernames(room)

    await broadcast(
        room,
        {
            "type": "start_voting",
            "players": alive
        }
    )


async def advance_turn(
    room: dict[str, Any],
    finished_speaker: str,
    automatic: bool = False
) -> None:

    if room["state"] != "playing":
        return

    cancel_task(room.get("turn_task"))
    room["turn_task"] = None

    alive = alive_connected_usernames(room)
    room["alive_list"] = alive

    if len(alive) <= 2:
        await finish_game(
            room,
            "spy",
            "Only two players remain. SPY WINS!"
        )
        return

    if finished_speaker in alive:
        current_index = alive.index(finished_speaker)
    else:
        current_index = -1

    next_index = current_index + 1

    if next_index >= len(alive):
        await begin_voting(room)
        return

    next_player = alive[next_index]

    await start_turn(
        room,
        next_player
    )


async def restart_round_after_reaction(
    room_id: str,
    dead_player: str
) -> None:

    try:
        await asyncio.sleep(REACTION_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)

    if not room:
        return

    if room["state"] != "reaction":
        return

    alive = alive_connected_usernames(room)
    room["alive_list"] = alive

    if len(alive) <= 2:
        await finish_game(
            room,
            "spy",
            "Only two players remain. SPY WINS!"
        )
        return

    room["state"] = "playing"
    room["current_speaker"] = None
    room["turn_id"] += 1
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "new_round",
            "players": alive
        }
    )

    await asyncio.sleep(0.5)

    if room["state"] == "playing" and alive:
        await start_turn(
            room,
            alive[0]
        )


# =========================================================
# VOTING
# =========================================================

async def calculate_votes(room: dict[str, Any]) -> None:

    if room["state"] != "voting":
        return

    votes = room["votes"]

    if not votes:
        return

    alive = set(alive_connected_usernames(room))

    valid_votes = [
        candidate
        for voter, candidate in votes.items()
        if voter in alive
        and candidate in alive
        and voter != candidate
    ]

    if not valid_votes:
        room["votes"] = {}

        await broadcast(
            room,
            {
                "type": "vote_reset",
                "message": "No valid votes. Voting again."
            }
        )

        return

    counts: dict[str, int] = {}

    for candidate in valid_votes:
        counts[candidate] = counts.get(candidate, 0) + 1

    highest = max(counts.values())

    leaders = [
        player
        for player, count in counts.items()
        if count == highest
    ]

    # Tie -> voting again.
    if len(leaders) > 1:
        room["votes"] = {}

        await broadcast(
            room,
            {
                "type": "vote_tie",
                "players": leaders,
                "message": "Vote tie! Everyone vote again."
            }
        )

        await asyncio.sleep(1)

        if room["state"] == "voting":
            await broadcast(
                room,
                {
                    "type": "start_voting",
                    "players": alive_connected_usernames(room)
                }
            )

        return

    eliminated_player = leaders[0]

    if eliminated_player not in room["players"]:
        return

    eliminated_role = room["players"][eliminated_player].get("role")

    # Spy caught.
    if eliminated_role == "spy":

        await finish_game(
            room,
            "civilians",
            f"{eliminated_player} was the SPY! Civilians WIN!"
        )

        return

    # Civilian eliminated.
    room["players"][eliminated_player]["is_alive"] = False
    room["players"][eliminated_player]["ready"] = False

    if eliminated_player in room["alive_list"]:
        room["alive_list"].remove(eliminated_player)

    alive = alive_connected_usernames(room)
    room["alive_list"] = alive

    room["state"] = "reaction"
    room["current_speaker"] = None
    room["votes"] = {}
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "reaction_phase",
            "dead_player": eliminated_player,
            "seconds": REACTION_TIME,
            "message": (
                f"{eliminated_player} was a CIVILIAN! "
                f"10 seconds reaction phase."
            )
        }
    )

    if len(alive) <= 2:
        await finish_game(
            room,
            "spy",
            f"{eliminated_player} was a Civilian. SPY WINS!"
        )
        return

    cancel_task(room.get("reaction_task"))

    room["reaction_task"] = asyncio.create_task(
        restart_round_after_reaction(
            room["room_id"],
            eliminated_player
        )
    )


# =========================================================
# WEBSOCKET
# =========================================================

@app.websocket("/ws/{room_id}/{capacity}/{mode}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    capacity: int,
    mode: str,
    username: str = Query("")
):
    await websocket.accept()

    username = clean_username(username)

    if not username:
        await send_json(
            websocket,
            {
                "type": "error",
                "message": "Please enter a valid player name."
            }
        )
        await websocket.close()
        return

    if not valid_capacity(capacity):
        await send_json(
            websocket,
            {
                "type": "error",
                "message": "Invalid player capacity."
            }
        )
        await websocket.close()
        return

    if not valid_mode(mode):
        mode = "spy"

    room = rooms.get(room_id)

    # If the room wasn't pre-created, create it now.
    if room is None:
        room = make_room(
            room_id,
            capacity,
            mode
        )
        rooms[room_id] = room

    # Validate reserved room.
    if room["capacity"] != capacity:
        await send_json(
            websocket,
            {
                "type": "error",
                "message": (
                    f"This room is configured for "
                    f"{room['capacity']} players."
                )
            }
        )
        await websocket.close()
        return

    if room["mode"] != mode:
        await send_json(
            websocket,
            {
                "type": "error",
                "message": "This room uses a different game mode."
            }
        )
        await websocket.close()
        return

    # No late joins once the game has begun.
    if room["state"] != "waiting":
        await send_json(
            websocket,
            {
                "type": "error",
                "message": "This game has already started."
            }
        )
        await websocket.close()
        return

    if len(room["connections"]) >= room["capacity"]:
        await send_json(
            websocket,
            {
                "type": "error",
                "message": "Room is full!"
            }
        )
        await websocket.close()
        return

    if username in room["players"] and room["players"][username].get("connected"):
        await send_json(
            websocket,
            {
                "type": "error",
                "message": "That player name is already in this room."
            }
        )
        await websocket.close()
        return

    # If a previously disconnected name is reused, reset that player.
    room["players"][username] = {
        "ws": websocket,
        "ready": False,
        "role": None,
        "word": None,
        "is_alive": True,
        "connected": True,
    }

    room["connections"].add(websocket)
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "chat",
            "sender": "System",
            "text": (
                f"{username} joined the room "
                f"({len(room['connections'])}/{room['capacity']})."
            )
        }
    )

    await broadcast_lobby(room)

    try:
        while True:
            raw = await websocket.receive_text()

            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if not isinstance(data, dict):
                continue

            action = data.get("action")

            room["last_activity"] = now()

            # ---------------------------------------------
            # READY
            # ---------------------------------------------
            if action == "set_ready":

                if room["state"] != "waiting":
                    continue

                ready = bool(data.get("ready"))

                room["players"][username]["ready"] = ready

                await broadcast_lobby(room)

                if all_players_ready(room):
                    await start_game(room)

            # ---------------------------------------------
            # CHAT
            # ---------------------------------------------
            elif action == "chat":

                text = str(data.get("text", "")).strip()

                if not text:
                    continue

                text = text[:300]

                await broadcast(
                    room,
                    {
                        "type": "chat",
                        "sender": username,
                        "text": text
                    }
                )

            # ---------------------------------------------
            # REACTION
            # ---------------------------------------------
            elif action == "reaction":

                emoji = str(data.get("emoji", "")).strip()

                if not emoji:
                    continue

                emoji = emoji[:12]

                await broadcast(
                    room,
                    {
                        "type": "reaction",
                        "sender": username,
                        "emoji": emoji
                    }
                )

            # ---------------------------------------------
            # END TURN
            # ---------------------------------------------
            elif action == "end_turn":

                if room["state"] != "playing":
                    continue

                if room.get("current_speaker") != username:
                    continue

                if not room["players"][username].get("is_alive"):
                    continue

                await broadcast(
                    room,
                    {
                        "type": "turn_ended",
                        "player": username
                    }
                )

                await advance_turn(
                    room,
                    username,
                    automatic=False
                )

            # ---------------------------------------------
            # VOTE
            # ---------------------------------------------
            elif action == "cast_vote":

                if room["state"] != "voting":
                    continue

                player_info = room["players"].get(username)

                if not player_info:
                    continue

                if not player_info.get("is_alive"):
                    continue

                if username in room["votes"]:
                    await send_json(
                        websocket,
                        {
                            "type": "vote_error",
                            "message": "You already voted."
                        }
                    )
                    continue

                candidate = clean_username(
                    str(data.get("vote", ""))
                )

                alive = alive_connected_usernames(room)

                if candidate not in alive:
                    continue

                if candidate == username:
                    await send_json(
                        websocket,
                        {
                            "type": "vote_error",
                            "message": "You cannot vote for yourself."
                        }
                    )
                    continue

                room["votes"][username] = candidate

                await broadcast(
                    room,
                    {
                        "type": "vote_update",
                        "voter": username,
                        "count": len(room["votes"]),
                        "total": len(alive)
                    }
                )

                # Every alive player has voted.
                alive_voters = [
                    player
                    for player in alive
                    if player in room["votes"]
                ]

                if len(alive_voters) == len(alive):
                    await calculate_votes(room)

            # ---------------------------------------------
            # PING
            # ---------------------------------------------
            elif action == "ping":
                await send_json(
                    websocket,
                    {"type": "pong"}
                )

    except WebSocketDisconnect:
        pass

    except Exception:
        pass

    finally:
        # ---------------------------------------------
        # DISCONNECT
        # ---------------------------------------------
        if websocket in room["connections"]:
            room["connections"].discard(websocket)

        player = room["players"].get(username)

        if player:
            player["connected"] = False
            player["ws"] = None
            player["ready"] = False

            if room["state"] == "waiting":
                # When roster changes before game start,
                # everybody must ready again.
                for p_name in connected_usernames(room):
                    room["players"][p_name]["ready"] = False

            elif player.get("is_alive"):
                player["is_alive"] = False

                if username in room["alive_list"]:
                    room["alive_list"].remove(username)

                room["votes"].pop(username, None)

        room["last_activity"] = now()

        # If no one is left, remove room.
        if len(room["connections"]) == 0:
            cancel_task(room.get("turn_task"))
            cancel_task(room.get("reaction_task"))
            rooms.pop(room_id, None)
            return

        # Notify everybody.
        await broadcast(
            room,
            {
                "type": "chat",
                "sender": "System",
                "text": f"{username} left the room."
            }
        )

        # If waiting, simply update lobby.
        if room["state"] == "waiting":
            await broadcast_lobby(room)
            return

        # Check whether disconnect ended game.
        game_finished = await check_win_after_disconnect(
            room,
            username
        )

        if game_finished:
            return

        # If the disconnected person was speaking,
        # continue with next alive player.
        if (
            room["state"] == "playing"
            and room.get("current_speaker") == username
        ):
            await advance_turn(
                room,
                username,
                automatic=False
            )

        elif room["state"] == "voting":
            alive = alive_connected_usernames(room)

            if not alive:
                return

            # Remove any votes whose voter is no longer alive.
            room["votes"] = {
                voter: candidate
                for voter, candidate in room["votes"].items()
                if voter in alive
            }

            if len(room["votes"]) == len(alive):
                await calculate_votes(room)


# =========================================================
# GAME START
# =========================================================

async def start_game(room: dict[str, Any]) -> None:

    if room["state"] != "waiting":
        return

    users = connected_usernames(room)

    if len(users) != room["capacity"]:
        return

    if not all_players_ready(room):
        return

    pair = random.choice(WORD_PAIRS)
    spy = random.choice(users)

    room["pair"] = pair
    room["spy_username"] = spy
    room["alive_list"] = list(users)

    random.shuffle(room["alive_list"])

    room["state"] = "playing"
    room["votes"] = {}
    room["current_speaker"] = None
    room["last_activity"] = now()

    # Assign secret roles/words.
    for player_name in users:
        role = "spy" if player_name == spy else "civilian"

        if role == "spy":
            word = (
                None
                if room["mode"] == "wordless"
                else pair["spy"]
            )
        else:
            word = pair["civilian"]

        room["players"][player_name]["role"] = role
        room["players"][player_name]["word"] = word
        room["players"][player_name]["is_alive"] = True

    # Private role + word message to each player.
    for player_name in users:

        player = room["players"][player_name]

        await send_json(
            player["ws"],
            {
                "type": "game_start",
                "role": player["role"],
                "word": player["word"],
                "mode": room["mode"],
                "players": [
                    {
                        "username": p,
                        "alive": room["players"][p]["is_alive"]
                    }
                    for p in room["alive_list"]
                ]
            }
        )

    await broadcast(
        room,
        {
            "type": "chat",
            "sender": "System",
            "text": "Everyone is ready! Game started."
        }
    )

    await broadcast_lobby(room)

    await asyncio.sleep(1)

    if room["state"] == "playing" and room["alive_list"]:
        await start_turn(
            room,
            room["alive_list"][0]
        )
