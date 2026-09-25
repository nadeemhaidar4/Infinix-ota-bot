from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pathlib import Path
from typing import Any
import asyncio, json, random, string, time

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Who Is The Spy")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

MIN_PLAYERS, MAX_PLAYERS = 4, 8

CATEGORY_TIME = 9
CATEGORY_RESULT_TIME = 3

TURN_TIME = 30
VOTE_TIME = 30
REACTION_TIME = 10

ROOM_EXPIRE = 30 * 60

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


def now():
    return time.time()


def clean_name(value):
    return "".join(
        c for c in str(value or "").strip()
        if c.isprintable()
    )[:20].strip()


def valid_capacity(value):
    return MIN_PLAYERS <= value <= MAX_PLAYERS


def make_room(room_id, capacity):
    return {
        "room_id": room_id,
        "capacity": capacity,
        "state": "waiting",
        "created_at": now(),
        "last_activity": now(),

        "players": {},
        "connections": set(),

        "alive": [],
        "speaker": None,

        "turn_id": 0,
        "turn_task": None,
        "vote_task": None,
        "reaction_task": None,
        "category_task": None,

        "category_votes": {},
        "category": None,
        "pair": None,

        "spy": None,
        "votes": {},
        "round": 0,
    }


rooms: dict[str, dict[str, Any]] = {}


def connected_names(room):
    return [
        n
        for n, p in room["players"].items()
        if p.get("connected") and p.get("ws")
    ]


def alive_names(room):
    return [
        n
        for n in room["alive"]
        if (
            n in room["players"]
            and room["players"][n].get("connected")
            and room["players"][n].get("alive")
        )
    ]


def snapshot(room):
    return [
        {
            "username": n,
            "number": p["number"],
            "ready": bool(p.get("ready")),
            "alive": bool(p.get("alive", True)),
        }
        for n, p in room["players"].items()
        if p.get("connected")
    ]


def cancel(task):
    if task and not task.done():
        task.cancel()


async def send(ws, payload):
    try:
        await ws.send_text(json.dumps(payload))
    except Exception:
        pass


async def broadcast(room, payload):
    message = json.dumps(payload)
    dead = []

    for ws in list(room["connections"]):
        try:
            await ws.send_text(message)
        except Exception:
            dead.append(ws)

    for ws in dead:
        room["connections"].discard(ws)


async def to_player(room, username, payload):
    player = room["players"].get(username)

    if player and player.get("ws"):
        await send(player["ws"], payload)


async def lobby(room):
    await broadcast(
        room,
        {
            "type": "lobby_update",
            "state": room["state"],
            "capacity": room["capacity"],
            "players": snapshot(room),
        },
    )


def choose_pair(category):
    if category == "Random":
        category = random.choice(list(WORD_BANK))

    return category, random.choice(WORD_BANK[category])


async def finish_game(room, winner, message):
    if room["state"] == "game_over":
        return

    for key in (
        "turn_task",
        "vote_task",
        "reaction_task",
        "category_task",
    ):
        cancel(room.get(key))
        room[key] = None

    room["state"] = "game_over"
    room["speaker"] = None

    await broadcast(
        room,
        {
            "type": "game_over",
            "winner": winner,
            "message": message,
            "spy_player": room.get("spy"),
            "word": room["pair"][0] if room.get("pair") else None,
            "spy_word": room["pair"][1] if room.get("pair") else None,
        },
    )


async def category_worker(room_id):
    try:
        await asyncio.sleep(CATEGORY_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)

    if not room or room["state"] != "category":
        return

    counts = {c: 0 for c in CATEGORIES}

    for category in room["category_votes"].values():
        if category in counts:
            counts[category] += 1

    max_count = max(counts.values()) if counts else 0

    leaders = [
        c
        for c, count in counts.items()
        if count == max_count and count > 0
    ]

    selected = (
        random.choice(leaders)
        if leaders
        else random.choice(CATEGORIES)
    )

    category, pair = choose_pair(selected)

    room["category"] = category
    room["pair"] = pair
    room["state"] = "category_result"

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
        return

    if room["state"] == "category_result":
        await start_first_round(room)


async def start_category(room):
    if len(connected_names(room)) < MIN_PLAYERS:
        room["state"] = "waiting"
        await lobby(room)
        return

    room["state"] = "category"
    room["category_votes"] = {}
    room["category"] = None
    room["pair"] = None

    await broadcast(
        room,
        {
            "type": "category_select",
            "seconds": CATEGORY_TIME,
            "categories": CATEGORIES,
        },
    )

    cancel(room.get("category_task"))

    room["category_task"] = asyncio.create_task(
        category_worker(room["room_id"])
    )


async def start_first_round(room):
    users = connected_names(room)

    if len(users) < MIN_PLAYERS:
        room["state"] = "waiting"
        await lobby(room)
        return

    spy = random.choice(users)

    room["spy"] = spy
    room["alive"] = users[:]
    random.shuffle(room["alive"])

    room["round"] = 1
    room["votes"] = {}

    for name in users:
        player = room["players"][name]

        player.update(
            alive=True,
            ready=False,
            role="spy" if name == spy else "civilian",
            word=(
                room["pair"][1]
                if name == spy
                else room["pair"][0]
            ),
        )

        await send(
            player["ws"],
            {
                "type": "role_info",
                "role": player["role"],
                "word": player["word"],
                "category": room["category"],
                "round": 1,
            },
        )

    room["state"] = "playing"

    await broadcast(
        room,
        {
            "type": "round_start",
            "round": 1,
            "category": room["category"],
            "seconds": TURN_TIME,
            "players": snapshot(room),
        },
    )

    await asyncio.sleep(0.35)

    alive = alive_names(room)

    if alive:
        await start_turn(room, alive[0])


async def start_turn(room, speaker):
    if room["state"] != "playing":
        return

    if speaker not in alive_names(room):
        return

    cancel(room.get("turn_task"))

    room["turn_id"] += 1

    turn_id = room["turn_id"]
    room["speaker"] = speaker

    await broadcast(
        room,
        {
            "type": "turn_update",
            "current_player": speaker,
            "seconds": TURN_TIME,
            "turn_id": turn_id,
            "round": room["round"],
        },
    )

    room["turn_task"] = asyncio.create_task(
        turn_timeout(
            room["room_id"],
            turn_id,
            speaker,
        )
    )


async def turn_timeout(room_id, turn_id, speaker):
    try:
        await asyncio.sleep(TURN_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)

    if (
        room
        and room["state"] == "playing"
        and room["turn_id"] == turn_id
        and room["speaker"] == speaker
    ):
        await advance_turn(room, speaker)


async def advance_turn(room, finished):
    if room["state"] != "playing":
        return

    cancel(room.get("turn_task"))
    room["turn_task"] = None

    alive = alive_names(room)
    room["alive"] = alive

    if len(alive) <= 2:
        await finish_game(
            room,
            "spy",
            "Only two players remain. The SPY wins!",
        )
        return

    try:
        index = alive.index(finished)
    except ValueError:
        index = -1

    next_index = index + 1

    if next_index >= len(alive):
        await begin_voting(room)
    else:
        await start_turn(room, alive[next_index])


async def begin_voting(room):
    if room["state"] != "playing":
        return

    cancel(room.get("turn_task"))

    room["turn_task"] = None
    room["speaker"] = None
    room["state"] = "voting"
    room["votes"] = {}

    alive = alive_names(room)

    await broadcast(
        room,
        {
            "type": "start_voting",
            "players": alive,
            "seconds": VOTE_TIME,
            "round": room["round"],
        },
    )

    cancel(room.get("vote_task"))

    room["vote_task"] = asyncio.create_task(
        vote_timeout(
            room["room_id"],
            room["round"],
        )
    )


async def vote_timeout(room_id, round_no):
    try:
        await asyncio.sleep(VOTE_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)

    if (
        not room
        or room["state"] != "voting"
        or room["round"] != round_no
    ):
        return

    if not room["votes"]:
        await broadcast(
            room,
            {
                "type": "vote_tie",
                "players": alive_names(room),
                "message": "Time is up. Everyone vote again.",
            },
        )

        room["vote_task"] = asyncio.create_task(
            vote_timeout(room_id, round_no)
        )

        return

    await calculate_votes(room)


async def calculate_votes(room):
    if room["state"] != "voting":
        return

    cancel(room.get("vote_task"))
    room["vote_task"] = None

    alive = set(alive_names(room))

    valid_votes = [
        vote
        for vote in room["votes"].values()
        if vote in alive
    ]

    if not valid_votes:
        return

    counts = {}

    for vote in valid_votes:
        counts[vote] = counts.get(vote, 0) + 1

    highest = max(counts.values())

    leaders = [
        name
        for name, count in counts.items()
        if count == highest
    ]

    if len(leaders) > 1:
        room["votes"] = {}

        await broadcast(
            room,
            {
                "type": "vote_tie",
                "players": alive_names(room),
                "message": "Vote tie! Everyone vote again.",
            },
        )

        room["vote_task"] = asyncio.create_task(
            vote_timeout(
                room["room_id"],
                room["round"],
            )
        )

        return

    eliminated = leaders[0]
    player = room["players"][eliminated]

    await broadcast(
        room,
        {
            "type": "vote_result",
            "eliminated": eliminated,
            "number": player["number"],
            "role": player.get("role"),
            "round": room["round"],
        },
    )

    if player.get("role") == "spy":
        await asyncio.sleep(1)

        await finish_game(
            room,
            "civilians",
            f"No.{player['number']} is out. "
            f"{eliminated} is the SPY!",
        )

        return

    player["alive"] = False

    if eliminated in room["alive"]:
        room["alive"].remove(eliminated)

    alive_now = alive_names(room)
    room["alive"] = alive_now

    if len(alive_now) <= 2:
        await asyncio.sleep(1)

        await finish_game(
            room,
            "spy",
            f"No.{player['number']} is out. "
            f"{eliminated} was a villager. "
            f"Only two players remain.",
        )

        return

    room["state"] = "reaction"
    room["speaker"] = None

    await broadcast(
        room,
        {
            "type": "reaction_phase",
            "dead_player": eliminated,
            "dead_number": player["number"],
            "seconds": REACTION_TIME,
            "message": (
                f"No.{player['number']} is out. "
                f"{eliminated} is a villager!"
            ),
        },
    )

    cancel(room.get("reaction_task"))

    room["reaction_task"] = asyncio.create_task(
        reaction_worker(room["room_id"])
    )


async def reaction_worker(room_id):
    try:
        await asyncio.sleep(REACTION_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_id)

    if not room or room["state"] != "reaction":
        return

    alive = alive_names(room)

    if len(alive) <= 2:
        await finish_game(
            room,
            "spy",
            "Only two players remain. The SPY wins!",
        )
        return

    room["round"] += 1
    room["state"] = "playing"
    room["votes"] = {}

    await broadcast(
        room,
        {
            "type": "new_round",
            "round": room["round"],
            "category": room["category"],
            "seconds": TURN_TIME,
            "players": snapshot(room),
        },
    )

    await asyncio.sleep(0.35)

    alive = alive_names(room)

    if alive:
        await start_turn(room, alive[0])


async def cleanup():
    while True:
        await asyncio.sleep(60)

        cutoff = now() - ROOM_EXPIRE

        for room_id, room in list(rooms.items()):
            if (
                not room["connections"]
                and room["last_activity"] < cutoff
            ):
                for key in (
                    "turn_task",
                    "vote_task",
                    "reaction_task",
                    "category_task",
                ):
                    cancel(room.get(key))

                rooms.pop(room_id, None)


@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup())


@app.get("/", response_class=HTMLResponse)
async def home():
    return HTMLResponse(
        (STATIC_DIR / "index.html").read_text(
            encoding="utf-8"
        )
    )


@app.get("/create_new_room")
async def create_new_room(capacity: int = 6):
    if not valid_capacity(capacity):
        return {
            "error": "Capacity must be between 4 and 8."
        }

    while True:
        room_id = "".join(
            random.choices(string.digits, k=4)
        )

        if room_id not in rooms:
            rooms[room_id] = make_room(
                room_id,
                capacity,
            )

            return {
                "room_id": room_id,
                "capacity": capacity,
            }


@app.get("/get_random_room/{capacity}")
async def get_random_room(capacity: int):
    if not valid_capacity(capacity):
        return {
            "error": "Capacity must be between 4 and 8."
        }

    candidates = [
        room_id
        for room_id, room in rooms.items()
        if (
            room["state"] == "waiting"
            and room["capacity"] == capacity
            and len(connected_names(room)) < capacity
        )
    ]

    if candidates:
        return {
            "room_id": candidates[0],
            "capacity": capacity,
        }

    return await create_new_room(capacity)


@app.websocket("/ws/{room_id}/{capacity}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_id: str,
    capacity: int,
    username: str = Query(""),
):
    await websocket.accept()

    username = clean_name(username)

    if not username:
        await send(
            websocket,
            {
                "type": "error",
                "message": "Please enter a player name.",
            },
        )

        await websocket.close()
        return

    if not valid_capacity(capacity):
        await send(
            websocket,
            {
                "type": "error",
                "message": "Invalid room capacity.",
            },
        )

        await websocket.close()
        return

    room = rooms.get(room_id)

    if room is None:
        room = make_room(room_id, capacity)
        rooms[room_id] = room

    if room["capacity"] != capacity:
        await send(
            websocket,
            {
                "type": "error",
                "message": "This room has a different capacity.",
            },
        )

        await websocket.close()
        return

    if (
        room["state"] != "waiting"
        and username not in room["players"]
    ):
        await send(
            websocket,
            {
                "type": "error",
                "message": "This game has already started.",
            },
        )

        await websocket.close()
        return

    if (
        username in room["players"]
        and room["players"][username].get("connected")
    ):
        await send(
            websocket,
            {
                "type": "error",
                "message": "That name is already in the room.",
            },
        )

        await websocket.close()
        return

    if (
        username not in room["players"]
        and len(connected_names(room)) >= capacity
    ):
        await send(
            websocket,
            {
                "type": "error",
                "message": "Room is full.",
            },
        )

        await websocket.close()
        return

    if username not in room["players"]:
        room["players"][username] = {
            "username": username,
            "number": len(room["players"]) + 1,
            "ws": websocket,
            "connected": True,
            "ready": False,
            "alive": True,
            "role": None,
            "word": None,
        }

    else:
        player = room["players"][username]

        player.update(
            ws=websocket,
            connected=True,
            ready=False,
        )

    room["connections"].add(websocket)
    room["last_activity"] = now()

    await send(
        websocket,
        {
            "type": "connected",
            "room": room_id,
            "capacity": room["capacity"],
            "username": username,
            "players": snapshot(room),
            "state": room["state"],
        },
    )

    await lobby(room)

    try:
        while True:
            data = json.loads(
                await websocket.receive_text()
            )

            action = data.get("action")
            room["last_activity"] = now()

            if (
                action == "set_ready"
                and room["state"] == "waiting"
            ):
                room["players"][username]["ready"] = bool(
                    data.get("ready")
                )

                await lobby(room)

                users = connected_names(room)

                if (
                    len(users) == room["capacity"]
                    and all(
                        room["players"][n].get("ready")
                        for n in users
                    )
                ):
                    await start_category(room)

            elif (
                action == "category_vote"
                and room["state"] == "category"
            ):
                category = str(
                    data.get("category", "")
                )

                if category not in CATEGORIES:
                    continue

                room["category_votes"][username] = category

                counts = {
                    category_name: sum(
                        vote == category_name
                        for vote in room["category_votes"].values()
                    )
                    for category_name in CATEGORIES
                }

                await broadcast(
                    room,
                    {
                        "type": "category_vote_update",
                        "counts": counts,
                    },
                )

                if (
                    len(room["category_votes"])
                    == len(connected_names(room))
                ):
                    cancel(room.get("category_task"))
                    room["category_task"] = None

                    await category_worker(
                        room["room_id"]
                    )

            elif (
                action == "end_turn"
                and room["state"] == "playing"
                and room["speaker"] == username
            ):
                await advance_turn(room, username)

            elif (
                action == "cast_vote"
                and room["state"] == "voting"
            ):
                player = room["players"].get(username)

                if not player or not player.get("alive"):
                    continue

                if username in room["votes"]:
                    await send(
                        websocket,
                        {
                            "type": "vote_error",
                            "message": "You already voted.",
                        },
                    )

                    continue

                target = clean_name(
                    data.get("vote", "")
                )

                alive = alive_names(room)

                if target not in alive or target == username:
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

                if all(
                    name in room["votes"]
                    for name in alive
                ):
                    await calculate_votes(room)

            elif action == "chat":
                text = str(
                    data.get("text", "")
                )[:300].strip()

                if text:
                    await broadcast(
                        room,
                        {
                            "type": "chat",
                            "sender": username,
                            "text": text,
                        },
                    )

            elif action == "reaction":
                emoji = str(
                    data.get("emoji", "")
                )[:12]

                if emoji:
                    await broadcast(
                        room,
                        {
                            "type": "reaction",
                            "sender": username,
                            "emoji": emoji,
                        },
                    )

            elif action == "ping":
                await send(
                    websocket,
                    {"type": "pong"},
                )

            # Native WebRTC signaling.
            elif action in (
                "rtc_offer",
                "rtc_answer",
                "rtc_ice",
            ):
                target = clean_name(
                    data.get("target", "")
                )

                if (
                    target in room["players"]
                    and room["players"][target].get("connected")
                ):
                    await to_player(
                        room,
                        target,
                        {
                            "type": "rtc_signal",
                            "from": username,
                            "signal": data.get("signal"),
                            "signal_type": action,
                        },
                    )

    except (
        WebSocketDisconnect,
        Exception,
    ):
        pass

    finally:
        room["connections"].discard(websocket)

        player = room["players"].get(username)

        if player:
            player.update(
                connected=False,
                ws=None,
                ready=False,
            )

        room["last_activity"] = now()

        if room["state"] == "waiting":
            for name in connected_names(room):
                room["players"][name]["ready"] = False

            if room["connections"]:
                await broadcast(
                    room,
                    {
                        "type": "chat",
                        "sender": "System",
                        "text": f"{username} left the room.",
                    },
                )

                await lobby(room)

        elif player and player.get("alive"):
            player["alive"] = False

            if username in room["alive"]:
                room["alive"].remove(username)

            if room["connections"]:
                await broadcast(
                    room,
                    {
                        "type": "chat",
                        "sender": "System",
                        "text": f"{username} left the game.",
                    },
                )

                if username == room.get("spy"):
                    await finish_game(
                        room,
                        "civilians",
                        f"{username} was the SPY and left the room. "
                        "Civilians win!",
                    )

                elif (
                    len(alive_names(room)) <= 2
                    and room["state"]
                    in (
                        "playing",
                        "voting",
                        "reaction",
                    )
                ):
                    await finish_game(
                        room,
                        "spy",
                        "Only two players remain. "
                        "The SPY wins!",
                    )

                else:
                    await lobby(room)

        if not room["connections"]:
            for key in (
                "turn_task",
                "vote_task",
                "reaction_task",
                "category_task",
            ):
                cancel(room.get(key))

            rooms.pop(room_id, None)
