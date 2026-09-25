from __future__ import annotations

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import Any
import asyncio
import json
import random
import string
import time

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Who Is The Spy")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

MIN_PLAYERS = 4
MAX_PLAYERS = 8

CATEGORY_TIME = 9
CATEGORY_RESULT_TIME = 3
TURN_TIME = 30
VOTE_TIME = 30
REACTION_TIME = 10
ROOM_EXPIRE_SECONDS = 30 * 60
ACTIVE_USER_TIMEOUT = 30

CATEGORIES = [
    "Life",
    "Sports",
    "Characters/Professions",
    "Animals/Plants/Nature",
    "Other",
    "Random",
]

WORD_BANK = {
    "Life": [
        ("Mopping", "Sweeping"),
        ("Cooking", "Baking"),
        ("Shower", "Bath"),
        ("Birthday", "Wedding"),
        ("School", "College"),
        ("Doctor", "Nurse"),
        ("Hospital", "Clinic"),
        ("Breakfast", "Lunch"),
        ("Coffee", "Tea"),
        ("Bus", "Train"),
        ("House", "Apartment"),
        ("Market", "Mall"),
        ("Phone", "Tablet"),
        ("Movie", "Drama"),
        ("Book", "Magazine"),
        ("Pen", "Pencil"),
        ("Chair", "Sofa"),
        ("Bed", "Couch"),
        ("Money", "Coin"),
        ("Job", "Business"),
        ("Office", "Factory"),
        ("Soap", "Shampoo"),
        ("Towel", "Napkin"),
        ("Key", "Lock"),
        ("Bottle", "Cup"),
        ("Spoon", "Fork"),
    ],
    "Sports": [
        ("Football", "Cricket"),
        ("Tennis", "Badminton"),
        ("Basketball", "Volleyball"),
        ("Running", "Walking"),
        ("Swimming", "Diving"),
        ("Boxing", "Wrestling"),
        ("Golf", "Hockey"),
        ("Chess", "Ludo"),
        ("Bat", "Racket"),
        ("Goal", "Point"),
        ("Stadium", "Arena"),
        ("Coach", "Referee"),
    ],
    "Characters/Professions": [
        ("Police", "Detective"),
        ("Teacher", "Professor"),
        ("Doctor", "Surgeon"),
        ("Pilot", "Driver"),
        ("Actor", "Director"),
        ("Singer", "Dancer"),
        ("Chef", "Waiter"),
        ("Lawyer", "Judge"),
        ("Farmer", "Gardener"),
        ("Firefighter", "Soldier"),
        ("King", "Queen"),
        ("Prince", "Princess"),
    ],
    "Animals/Plants/Nature": [
        ("Dog", "Cat"),
        ("Tiger", "Lion"),
        ("Elephant", "Rhino"),
        ("Monkey", "Ape"),
        ("Bear", "Wolf"),
        ("Snake", "Lizard"),
        ("Eagle", "Hawk"),
        ("Parrot", "Pigeon"),
        ("Duck", "Swan"),
        ("Fish", "Shark"),
        ("Rose", "Lotus"),
        ("Jasmine", "Lily"),
        ("Tree", "Bush"),
        ("Flower", "Leaf"),
        ("Forest", "Jungle"),
        ("River", "Lake"),
        ("Mountain", "Hill"),
        ("Ocean", "Sea"),
        ("Rain", "Snow"),
        ("Desert", "Beach"),
    ],
    "Other": [
        ("Computer", "Laptop"),
        ("Camera", "Video"),
        ("Television", "Radio"),
        ("Music", "Song"),
        ("Map", "Compass"),
        ("Mirror", "Glass"),
        ("Door", "Window"),
        ("Table", "Desk"),
        ("Light", "Bulb"),
        ("Fan", "AC"),
        ("Gold", "Silver"),
        ("Diamond", "Ruby"),
        ("Red", "Pink"),
        ("Blue", "Green"),
        ("Black", "White"),
        ("Circle", "Square"),
        ("Triangle", "Rectangle"),
        ("Fire", "Smoke"),
        ("Sun", "Moon"),
        ("Star", "Planet"),
    ],
}

rooms: dict[str, dict[str, Any]] = {}
active_clients: dict[str, float] = {}


def now() -> float:
    return time.time()


def clean_username(value: Any) -> str:
    value = str(value or "")
    value = "".join(c for c in value.strip() if c.isprintable())
    return value[:20].strip()


def valid_capacity(capacity: int) -> bool:
    return MIN_PLAYERS <= capacity <= MAX_PLAYERS


def normalize_mode(mode: str | None) -> str:
    return "spy"


def create_room(room_id: str, capacity: int, mode: str = "spy") -> dict[str, Any]:
    return {
        "room_id": room_id,
        "capacity": capacity,
        "mode": normalize_mode(mode),
        "state": "waiting",
        "created_at": now(),
        "last_activity": now(),
        "players": {},
        "connections": set(),
        "alive_list": [],
        "current_speaker": None,
        "turn_id": 0,
        "round": 0,
        "category": None,
        "pair": None,
        "spy_username": None,
        "category_votes": {},
        "votes": {},
        "turn_task": None,
        "category_task": None,
        "vote_task": None,
        "reaction_task": None,
        "category_resolving": False,
        "vote_resolving": False,
    }


def connected_usernames(room: dict[str, Any]) -> list[str]:
    return [
        username
        for username, player in room["players"].items()
        if player.get("connected") and player.get("ws") in room["connections"]
    ]


def alive_connected_usernames(room: dict[str, Any]) -> list[str]:
    return [
        username
        for username in room["alive_list"]
        if username in room["players"]
        and room["players"][username].get("is_alive", False)
        and room["players"][username].get("connected", False)
    ]


def player_snapshot(room: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for username, player in room["players"].items():
        if not player.get("connected"):
            continue
        result.append(
            {
                "username": username,
                "number": player["number"],
                "ready": bool(player.get("ready")),
                "alive": bool(player.get("is_alive", True)),
            }
        )
    return sorted(result, key=lambda p: p["number"])


def cancel_task(task: asyncio.Task | None) -> None:
    if task and not task.done():
        task.cancel()


async def send_json(ws: WebSocket | None, payload: dict[str, Any]) -> None:
    if not ws:
        return
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        pass


async def broadcast(room: dict[str, Any], payload: dict[str, Any]) -> None:
    if not room["connections"]:
        return
    message = json.dumps(payload)
    dead: list[WebSocket] = []
    for ws in list(room["connections"]):
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        room["connections"].discard(ws)


async def send_to_player(room: dict[str, Any], username: str, payload: dict[str, Any]) -> None:
    player = room["players"].get(username)
    if player and player.get("connected"):
        await send_json(player.get("ws"), payload)


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
        },
    )


def choose_category_and_pair(requested: str) -> tuple[str, tuple[str, str]]:
    category = requested
    if category == "Random":
        category = random.choice(list(WORD_BANK.keys()))
    return category, random.choice(WORD_BANK[category])


async def finish_game(room: dict[str, Any], winner: str, message: str) -> None:
    if room["state"] == "game_over":
        return

    for key in ("turn_task", "category_task", "vote_task", "reaction_task"):
        cancel_task(room.get(key))
        room[key] = None

    room["state"] = "game_over"
    room["current_speaker"] = None
    room["last_activity"] = now()
    room["vote_resolving"] = False
    room["category_resolving"] = False

    await broadcast(
        room,
        {
            "type": "game_over",
            "winner": winner,
            "message": message,
            "spy_player": room.get("spy_username"),
            "word": room["pair"][0] if room.get("pair") else None,
            "spy_word": room["pair"][1] if room.get("pair") else None,
            "round": room.get("round", 1),
        },
    )


async def resolve_category(room: dict[str, Any]) -> None:
    if room["state"] != "category" or room["category_resolving"]:
        return

    room["category_resolving"] = True
    cancel_task(room.get("category_task"))
    room["category_task"] = None

    counts = {category: 0 for category in CATEGORIES}
    for vote in room["category_votes"].values():
        if vote in counts:
            counts[vote] += 1

    maximum = max(counts.values()) if counts else 0
    leaders = [category for category, count in counts.items() if count == maximum and count > 0]
    selected = random.choice(leaders) if leaders else random.choice(CATEGORIES)

    category, pair = choose_category_and_pair(selected)
    room["category"] = category
    room["pair"] = pair
    room["state"] = "category_result"
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "category_result",
            "category": category,
            "seconds": CATEGORY_RESULT_TIME,
        },
    )

    try:
        await asyncio.sleep(CATEGORY_RESULT_TIME)
    except asyncio.CancelledError:
        room["category_resolving"] = False
        return

    if room["state"] == "category_result":
        await start_game(room)

    room["category_resolving"] = False


async def category_timeout_worker(room_id: str) -> None:
    try:
        await asyncio.sleep(CATEGORY_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)
    if not room or room["state"] != "category":
        return

    await resolve_category(room)


async def start_category_selection(room: dict[str, Any]) -> None:
    if len(connected_usernames(room)) < MIN_PLAYERS:
        room["state"] = "waiting"
        await broadcast_lobby(room)
        return

    room["state"] = "category"
    room["category_votes"] = {}
    room["category_resolving"] = False
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "category_select",
            "seconds": CATEGORY_TIME,
            "categories": CATEGORIES,
        },
    )

    cancel_task(room.get("category_task"))
    room["category_task"] = asyncio.create_task(category_timeout_worker(room["room_id"]))


async def start_game(room: dict[str, Any]) -> None:
    users = connected_usernames(room)
    if len(users) < MIN_PLAYERS:
        room["state"] = "waiting"
        await broadcast_lobby(room)
        return

    spy = random.choice(users)
    room["spy_username"] = spy
    room["alive_list"] = users[:]
    random.shuffle(room["alive_list"])
    room["round"] = 1
    room["votes"] = {}
    room["current_speaker"] = None

    civilian_word, spy_word = room["pair"]

    for username in users:
        player = room["players"][username]
        player["is_alive"] = True
        player["ready"] = False
        player["role"] = "spy" if username == spy else "civilian"
        player["word"] = spy_word if username == spy else civilian_word

        await send_to_player(
            room,
            username,
            {
                "type": "game_start",
                "role": player["role"],
                "word": player["word"],
                "category": room["category"],
                "round": 1,
            },
        )

    room["state"] = "playing"
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "round_start",
            "round": 1,
            "category": room["category"],
            "seconds": TURN_TIME,
            "players": player_snapshot(room),
        },
    )

    await asyncio.sleep(0.45)
    if room["state"] == "playing":
        alive = alive_connected_usernames(room)
        if len(alive) <= 2:
            await finish_game(room, "spy", "Only two players remain. SPY WINS!")
        elif alive:
            await start_turn(room, alive[0])


async def start_turn(room: dict[str, Any], speaker: str) -> None:
    if room["state"] != "playing":
        return

    alive = alive_connected_usernames(room)
    if speaker not in alive:
        if alive:
            speaker = alive[0]
        else:
            await finish_game(room, "spy", "Not enough connected players remain.")
            return

    cancel_task(room.get("turn_task"))

    room["turn_id"] += 1
    room["current_speaker"] = speaker
    room["last_activity"] = now()
    expected_turn = room["turn_id"]

    await broadcast(
        room,
        {
            "type": "turn_update",
            "current_player": speaker,
            "seconds": TURN_TIME,
            "turn_id": expected_turn,
            "round": room["round"],
        },
    )

    room["turn_task"] = asyncio.create_task(
        turn_timeout_worker(room["room_id"], expected_turn, speaker)
    )


async def turn_timeout_worker(room_id: str, turn_id: int, speaker: str) -> None:
    try:
        await asyncio.sleep(TURN_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)
    if not room:
        return
    if room["state"] != "playing":
        return
    if room["turn_id"] != turn_id or room["current_speaker"] != speaker:
        return

    await broadcast(
        room,
        {
            "type": "turn_timeout",
            "current_player": speaker,
        },
    )
    await advance_turn(room, speaker, automatic=True)


async def advance_turn(room: dict[str, Any], finished_speaker: str, automatic: bool = False) -> None:
    if room["state"] != "playing":
        return

    cancel_task(room.get("turn_task"))
    room["turn_task"] = None
    room["last_activity"] = now()

    alive = alive_connected_usernames(room)
    room["alive_list"] = [name for name in room["alive_list"] if room["players"].get(name, {}).get("is_alive", False)]

    if len(alive) <= 2:
        await finish_game(room, "spy", "Only two players remain. SPY WINS!")
        return

    if finished_speaker in alive:
        try:
            current_index = alive.index(finished_speaker)
        except ValueError:
            current_index = -1
    else:
        current_index = -1

    next_index = current_index + 1
    if next_index >= len(alive):
        await begin_voting(room)
        return

    await start_turn(room, alive[next_index])


async def begin_voting(room: dict[str, Any]) -> None:
    if room["state"] != "playing":
        return

    cancel_task(room.get("turn_task"))
    room["turn_task"] = None
    room["current_speaker"] = None
    room["state"] = "voting"
    room["votes"] = {}
    room["vote_resolving"] = False
    room["last_activity"] = now()

    alive = alive_connected_usernames(room)
    if len(alive) <= 2:
        await finish_game(room, "spy", "Only two players remain. SPY WINS!")
        return

    await broadcast(
        room,
        {
            "type": "start_voting",
            "players": alive,
            "seconds": VOTE_TIME,
            "round": room["round"],
        },
    )

    cancel_task(room.get("vote_task"))
    room["vote_task"] = asyncio.create_task(vote_timeout_worker(room["room_id"], room["round"]))


async def vote_timeout_worker(room_id: str, round_no: int) -> None:
    try:
        await asyncio.sleep(VOTE_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)
    if not room or room["state"] != "voting" or room["round"] != round_no:
        return

    alive = alive_connected_usernames(room)
    if all(name in room["votes"] for name in alive) and alive:
        await calculate_votes(room)
        return

    if not room["votes"]:
        await broadcast(
            room,
            {
                "type": "vote_timeout",
                "message": "Time is up. Vote again.",
                "players": alive,
                "seconds": VOTE_TIME,
            },
        )
    else:
        await broadcast(
            room,
            {
                "type": "vote_timeout",
                "message": "Time is up. Votes received were incomplete. Vote again.",
                "players": alive,
                "seconds": VOTE_TIME,
            },
        )

    room["votes"] = {}
    room["vote_task"] = asyncio.create_task(vote_timeout_worker(room_id, round_no))
    await broadcast(
        room,
        {
            "type": "start_voting",
            "players": alive,
            "seconds": VOTE_TIME,
            "round": round_no,
        },
    )


async def calculate_votes(room: dict[str, Any]) -> None:
    if room["state"] != "voting" or room["vote_resolving"]:
        return

    room["vote_resolving"] = True
    cancel_task(room.get("vote_task"))
    room["vote_task"] = None

    alive_list = alive_connected_usernames(room)
    alive = set(alive_list)

    valid_votes = [
        candidate
        for voter, candidate in room["votes"].items()
        if voter in alive and candidate in alive and voter != candidate
    ]

    if not valid_votes:
        room["votes"] = {}
        room["vote_resolving"] = False
        await broadcast(room, {"type": "vote_reset", "message": "No valid votes. Vote again."})
        room["vote_task"] = asyncio.create_task(vote_timeout_worker(room["room_id"], room["round"]))
        await broadcast(
            room,
            {
                "type": "start_voting",
                "players": alive_list,
                "seconds": VOTE_TIME,
                "round": room["round"],
            },
        )
        return

    counts: dict[str, int] = {}
    for candidate in valid_votes:
        counts[candidate] = counts.get(candidate, 0) + 1

    highest = max(counts.values())
    leaders = [candidate for candidate, count in counts.items() if count == highest]

    if len(leaders) > 1:
        room["votes"] = {}
        room["vote_resolving"] = False
        await broadcast(
            room,
            {
                "type": "vote_tie",
                "players": alive_list,
                "message": "Vote tie! Vote again.",
                "seconds": VOTE_TIME,
            },
        )
        room["vote_task"] = asyncio.create_task(vote_timeout_worker(room["room_id"], room["round"]))
        return

    eliminated = leaders[0]
    if eliminated not in room["players"]:
        room["vote_resolving"] = False
        return

    player = room["players"][eliminated]
    number = player["number"]
    role = player.get("role") or "civilian"

    await broadcast(
        room,
        {
            "type": "vote_result",
            "eliminated": eliminated,
            "number": number,
            "role": role,
            "round": room["round"],
        },
    )

    room["votes"] = {}

    if role == "spy":
        await asyncio.sleep(1.2)
        room["vote_resolving"] = False
        await finish_game(
            room,
            "civilians",
            f"No.{number} is out. He/She is the spy!",
        )
        return

    player["is_alive"] = False
    player["ready"] = False
    if eliminated in room["alive_list"]:
        room["alive_list"].remove(eliminated)

    room["state"] = "reaction"
    room["current_speaker"] = None
    room["last_activity"] = now()

    alive = alive_connected_usernames(room)

    await broadcast(
        room,
        {
            "type": "reaction_phase",
            "dead_player": eliminated,
            "dead_number": number,
            "seconds": REACTION_TIME,
            "message": f"No.{number} is out. He/She is a villager!",
            "players": player_snapshot(room),
        },
    )

    room["vote_resolving"] = False

    if len(alive) <= 2:
        await asyncio.sleep(0.6)
        await finish_game(
            room,
            "spy",
            f"No.{number} is out. He/She is a villager. Only two players remain. SPY WINS!",
        )
        return

    cancel_task(room.get("reaction_task"))
    room["reaction_task"] = asyncio.create_task(
        restart_round_after_reaction(room["room_id"])
    )


async def restart_round_after_reaction(room_id: str) -> None:
    try:
        await asyncio.sleep(REACTION_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)
    if not room or room["state"] != "reaction":
        return

    alive = alive_connected_usernames(room)
    room["alive_list"] = [
        name for name in room["alive_list"]
        if room["players"].get(name, {}).get("is_alive", False)
    ]

    if len(alive) <= 2:
        await finish_game(room, "spy", "Only two players remain. SPY WINS!")
        return

    room["round"] += 1
    room["state"] = "playing"
    room["votes"] = {}
    room["current_speaker"] = None
    room["last_activity"] = now()

    await broadcast(
        room,
        {
            "type": "new_round",
            "round": room["round"],
            "category": room["category"],
            "players": player_snapshot(room),
            "seconds": TURN_TIME,
        },
    )

    await asyncio.sleep(0.5)
    if room["state"] == "playing":
        alive = alive_connected_usernames(room)
        if alive:
            await start_turn(room, alive[0])


async def sync_current_state(room: dict[str, Any], username: str) -> None:
    player = room["players"].get(username)
    if not player:
        return

    if room["state"] == "waiting":
        await send_to_player(
            room,
            username,
            {
                "type": "lobby_update",
                "state": "waiting",
                "capacity": room["capacity"],
                "mode": room["mode"],
                "players": player_snapshot(room),
                "current_speaker": None,
            },
        )
        return

    if room["state"] in ("category", "category_result"):
        if room["state"] == "category":
            await send_to_player(
                room,
                username,
                {
                    "type": "category_select",
                    "seconds": CATEGORY_TIME,
                    "categories": CATEGORIES,
                },
            )
        else:
            await send_to_player(
                room,
                username,
                {
                    "type": "category_result",
                    "category": room["category"],
                    "seconds": CATEGORY_RESULT_TIME,
                },
            )
        return

    if room["state"] == "game_over":
        await send_to_player(
            room,
            username,
            {
                "type": "game_over",
                "winner": "civilians" if player.get("role") != "spy" else "spy",
                "message": "The game has ended.",
                "spy_player": room.get("spy_username"),
                "word": room["pair"][0] if room.get("pair") else None,
                "spy_word": room["pair"][1] if room.get("pair") else None,
                "round": room.get("round", 1),
            },
        )
        return

    await send_to_player(
        room,
        username,
        {
            "type": "game_start",
            "role": player.get("role"),
            "word": player.get("word"),
            "category": room.get("category"),
            "round": room.get("round", 1),
        },
    )

    await send_to_player(
        room,
        username,
        {
            "type": "round_start" if room["round"] == 1 else "new_round",
            "round": room["round"],
            "category": room["category"],
            "seconds": TURN_TIME,
            "players": player_snapshot(room),
        },
    )

    if room["state"] == "playing" and room.get("current_speaker"):
        await send_to_player(
            room,
            username,
            {
                "type": "turn_update",
                "current_player": room["current_speaker"],
                "seconds": TURN_TIME,
                "turn_id": room["turn_id"],
                "round": room["round"],
            },
        )
    elif room["state"] == "voting":
        await send_to_player(
            room,
            username,
            {
                "type": "start_voting",
                "players": alive_connected_usernames(room),
                "seconds": VOTE_TIME,
                "round": room["round"],
            },
        )
    elif room["state"] == "reaction":
        dead = next(
            (
                n
                for n, p in room["players"].items()
                if not p.get("is_alive", True)
            ),
            None,
        )
        if dead:
            dead_number = room["players"][dead]["number"]
            await send_to_player(
                room,
                username,
                {
                    "type": "reaction_phase",
                    "dead_player": dead,
                    "dead_number": dead_number,
                    "seconds": REACTION_TIME,
                    "message": f"No.{dead_number} is out. He/She is a villager!",
                    "players": player_snapshot(room),
                },
            )


async def maintenance_worker() -> None:
    while True:
        await asyncio.sleep(30)
        current = now()

        stale_clients = [
            client_id
            for client_id, last_seen in active_clients.items()
            if current - last_seen > ACTIVE_USER_TIMEOUT
        ]
        for client_id in stale_clients:
            active_clients.pop(client_id, None)

        for room_id, room in list(rooms.items()):
            room["last_activity"] = max(room["last_activity"], room["created_at"])
            if (
                not room["connections"]
                and current - room["last_activity"] > ROOM_EXPIRE_SECONDS
            ):
                for key in ("turn_task", "category_task", "vote_task", "reaction_task"):
                    cancel_task(room.get(key))
                rooms.pop(room_id, None)


@app.on_event("startup")
async def startup_event() -> None:
    asyncio.create_task(maintenance_worker())


@app.get("/", response_class=HTMLResponse)
async def index() -> HTMLResponse:
    index_file = STATIC_DIR / "index.html"
    return HTMLResponse(index_file.read_text(encoding="utf-8"))


@app.get("/get_active_users")
async def get_active_users(client_id: str | None = None) -> dict[str, int]:
    current = now()
    if client_id:
        active_clients[client_id] = current
    stale = [
        cid for cid, last_seen in active_clients.items()
        if current - last_seen > ACTIVE_USER_TIMEOUT
    ]
    for cid in stale:
        active_clients.pop(cid, None)
    return {"active_users": len(active_clients)}


@app.get("/create_new_room")
async def create_new_room(capacity: int = 6, mode: str = "spy") -> dict[str, Any]:
    if not valid_capacity(capacity):
        return JSONResponse(
            status_code=400,
            content={"error": "Capacity must be between 4 and 8."},
        )

    mode = normalize_mode(mode)
    for _ in range(100):
        room_id = "".join(random.choices(string.digits, k=4))
        if room_id not in rooms:
            rooms[room_id] = create_room(room_id, capacity, mode)
            return {
                "ok": True,
                "room_id": room_id,
                "capacity": capacity,
                "mode": mode,
                "join_url": f"{'/'}?room={room_id}",
            }

    return JSONResponse(
        status_code=503,
        content={"error": "Could not generate a room ID. Please try again."},
    )


@app.get("/room_info/{room_id}")
async def room_info(room_id: str) -> dict[str, Any]:
    room_id = str(room_id or "").strip()
    if not (len(room_id) == 4 and room_id.isdigit()):
        return JSONResponse(
            status_code=400,
            content={"error": "Room ID must be 4 digits."},
        )

    room = rooms.get(room_id)
    if room is None:
        return JSONResponse(
            status_code=404,
            content={"error": "Room not found. Check the Room ID."},
        )

    return {
        "ok": True,
        "room_id": room_id,
        "capacity": room["capacity"],
        "mode": room["mode"],
        "state": room["state"],
        "players": len(connected_usernames(room)),
        "available_slots": max(0, room["capacity"] - len(connected_usernames(room))),
        "joinable": room["state"] == "waiting" and len(connected_usernames(room)) < room["capacity"],
    }


@app.get("/get_random_room/{capacity}")
async def get_random_room(capacity: int, mode: str = "spy") -> dict[str, Any]:
    if not valid_capacity(capacity):
        return JSONResponse(
            status_code=400,
            content={"error": "Capacity must be between 4 and 8."},
        )

    mode = normalize_mode(mode)
    candidates = [
        room
        for room in rooms.values()
        if room["state"] == "waiting"
        and room["capacity"] == capacity
        and room["mode"] == mode
        and len(connected_usernames(room)) < capacity
    ]

    if candidates:
        candidates.sort(key=lambda room: room["created_at"])
        room = candidates[0]
        return {
            "ok": True,
            "room_id": room["room_id"],
            "capacity": capacity,
            "mode": mode,
            "players": len(connected_usernames(room)),
        }

    return await create_new_room(capacity, mode)


@app.websocket("/ws/{room_id}/{capacity}/{mode}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    capacity: int,
    mode: str,
    username: str = Query(""),
) -> None:
    await websocket.accept()

    username = clean_username(username)
    mode = normalize_mode(mode)

    if not username:
        await send_json(websocket, {"type": "error", "message": "Please enter a valid player name."})
        await websocket.close()
        return

    if not valid_capacity(capacity):
        await send_json(websocket, {"type": "error", "message": "Invalid player capacity."})
        await websocket.close()
        return

    room = rooms.get(room_id)
    if room is None:
        await send_json(
            websocket,
            {"type": "error", "code": "ROOM_NOT_FOUND", "message": "Room not found. Please check the Room ID."},
        )
        await websocket.close(code=1008)
        return

    if room["capacity"] != capacity:
        await send_json(
            websocket,
            {"type": "error", "message": f"This room is configured for {room['capacity']} players."},
        )
        await websocket.close()
        return

    if room["mode"] != mode:
        await send_json(websocket, {"type": "error", "message": "This room uses a different game mode."})
        await websocket.close()
        return

    existing = room["players"].get(username)

    if existing and existing.get("connected"):
        await send_json(websocket, {"type": "error", "message": "That name is already in the room."})
        await websocket.close()
        return

    if not existing and room["state"] != "waiting":
        await send_json(websocket, {"type": "error", "message": "This game has already started."})
        await websocket.close()
        return

    if not existing and len(connected_usernames(room)) >= room["capacity"]:
        await send_json(websocket, {"type": "error", "message": "Room is full."})
        await websocket.close()
        return

    connected_numbers = {
        int(p.get("number", 0))
        for p in room["players"].values()
        if p.get("connected")
    }

    if existing:
        old_number = int(existing.get("number", 0))
        if old_number not in connected_numbers:
            number = old_number
        else:
            number = next(
                (n for n in range(1, room["capacity"] + 1) if n not in connected_numbers),
                old_number,
            )

        player = existing
        player.update(
            number=number,
            ws=websocket,
            connected=True,
            last_seen=now(),
        )
    else:
        number = next(
            (n for n in range(1, room["capacity"] + 1) if n not in connected_numbers),
            room["capacity"],
        )
        player = {
            "username": username,
            "number": number,
            "ws": websocket,
            "connected": True,
            "ready": False,
            "is_alive": True,
            "role": None,
            "word": None,
            "last_seen": now(),
        }
        room["players"][username] = player

    room["connections"].add(websocket)
    room["last_activity"] = now()

    await send_json(
        websocket,
        {
            "type": "connected",
            "room": room_id,
            "capacity": room["capacity"],
            "mode": room["mode"],
            "username": username,
            "players": player_snapshot(room),
            "state": room["state"],
        },
    )

    if room["state"] == "waiting":
        await broadcast_lobby(room)
    else:
        await sync_current_state(room, username)
        await broadcast_lobby(room)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            room["last_activity"] = now()
            action = data.get("action")

            if action == "set_ready" and room["state"] == "waiting":
                player["ready"] = bool(data.get("ready"))
                await broadcast_lobby(room)

                users = connected_usernames(room)
                if (
                    len(users) >= MIN_PLAYERS
                    and len(users) == room["capacity"]
                    and all(room["players"][name].get("ready") for name in users)
                ):
                    await start_category_selection(room)

            elif action == "category_vote" and room["state"] == "category":
                requested = str(data.get("category", ""))
                if requested not in CATEGORIES:
                    continue

                room["category_votes"][username] = requested

                counts = {category: 0 for category in CATEGORIES}
                for vote in room["category_votes"].values():
                    if vote in counts:
                        counts[vote] += 1

                await broadcast(room, {"type": "category_vote_update", "counts": counts})

                connected = connected_usernames(room)
                if connected and all(name in room["category_votes"] for name in connected):
                    await resolve_category(room)

            elif (
                action == "end_turn"
                and room["state"] == "playing"
                and room.get("current_speaker") == username
            ):
                await broadcast(room, {"type": "turn_ended", "player": username})
                await advance_turn(room, username)

            elif action == "cast_vote" and room["state"] == "voting":
                if not player.get("is_alive"):
                    await send_json(websocket, {"type": "vote_error", "message": "You are eliminated."})
                    continue

                if username in room["votes"]:
                    await send_json(websocket, {"type": "vote_error", "message": "You already voted."})
                    continue

                target = clean_username(data.get("vote"))
                alive = alive_connected_usernames(room)
                if target not in alive or target == username:
                    await send_json(websocket, {"type": "vote_error", "message": "Choose another alive player."})
                    continue

                room["votes"][username] = target
                await broadcast(
                    room,
                    {
                        "type": "vote_update",
                        "count": len(room["votes"]),
                        "total": len(alive),
                    },
                )

                if all(name in room["votes"] for name in alive):
                    await calculate_votes(room)

            elif action == "chat":
                text = str(data.get("text", "")).strip()[:300]
                if text:
                    await broadcast(room, {"type": "chat", "sender": username, "text": text})

            elif action == "reaction":
                emoji = str(data.get("emoji", "")).strip()[:16]
                if emoji:
                    await broadcast(room, {"type": "reaction", "sender": username, "emoji": emoji})

            elif action == "ping":
                await send_json(websocket, {"type": "pong", "time": now()})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        print("WebSocket error:", exc)
    finally:
        room["connections"].discard(websocket)
        player["connected"] = False
        player["ws"] = None
        player["ready"] = False
        player["last_seen"] = now()
        room["last_activity"] = now()

        if room["state"] == "waiting":
            for connected_name in connected_usernames(room):
                room["players"][connected_name]["ready"] = False
            if room["connections"]:
                await broadcast(room, {"type": "chat", "sender": "System", "text": f"{username} left the room."})
                await broadcast_lobby(room)
        else:
            # A disconnected spy immediately ends the game for civilians.
            if player.get("role") == "spy" and room["state"] != "game_over":
                await finish_game(
                    room,
                    "civilians",
                    f"{username} was the SPY and left the room. Civilians win!",
                )
            else:
                if username in room["alive_list"]:
                    room["alive_list"].remove(username)
                player["is_alive"] = False

                if room["state"] == "playing" and room.get("current_speaker") == username:
                    await advance_turn(room, username, automatic=True)
                elif room["state"] == "voting":
                    room["votes"].pop(username, None)
                    alive = alive_connected_usernames(room)
                    if len(alive) <= 2:
                        await finish_game(room, "spy", "Only two players remain. SPY WINS!")
                    elif alive and all(name in room["votes"] for name in alive):
                        await calculate_votes(room)
                elif room["state"] == "category":
                    room["category_votes"].pop(username, None)
                    connected = connected_usernames(room)
                    if connected and all(name in room["category_votes"] for name in connected):
                        await resolve_category(room)
                elif room["state"] == "reaction":
                    alive = alive_connected_usernames(room)
                    if len(alive) <= 2:
                        await finish_game(room, "spy", "Only two players remain. SPY WINS!")

                if room["connections"] and room["state"] != "game_over":
                    await broadcast(
                        room,
                        {"type": "chat", "sender": "System", "text": f"{username} left the game."},
                    )
                    await broadcast_lobby(room)

        if not room["connections"]:
            room["last_activity"] = now()
