from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path
from typing import Any
import asyncio
import random
import string
import time

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Quiz Rush Multiplayer")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

MIN_PLAYERS = 2
MAX_PLAYERS = 8
QUESTION_TIME = 15
REVEAL_TIME = 3
TOTAL_QUESTIONS = 10
ROOM_IDLE_SECONDS = 30 * 60

QUESTION_BANK = [
    {"q": "Which planet is known as the Red Planet?", "a": ["Earth", "Mars", "Jupiter", "Venus"], "c": 1},
    {"q": "How many sides does a hexagon have?", "a": ["5", "6", "7", "8"], "c": 1},
    {"q": "Which ocean is the largest?", "a": ["Atlantic", "Indian", "Pacific", "Arctic"], "c": 2},
    {"q": "What is H2O commonly called?", "a": ["Salt", "Water", "Oxygen", "Hydrogen"], "c": 1},
    {"q": "Which animal is known as the fastest land animal?", "a": ["Horse", "Lion", "Cheetah", "Tiger"], "c": 2},
    {"q": "How many days are in a leap year?", "a": ["364", "365", "366", "367"], "c": 2},
    {"q": "Which is the smallest prime number?", "a": ["0", "1", "2", "3"], "c": 2},
    {"q": "Which country is famous for the Eiffel Tower?", "a": ["Italy", "France", "Spain", "Germany"], "c": 1},
    {"q": "What is the capital of Japan?", "a": ["Kyoto", "Tokyo", "Osaka", "Sapporo"], "c": 1},
    {"q": "Which gas do plants mainly absorb from the air?", "a": ["Oxygen", "Nitrogen", "Carbon Dioxide", "Helium"], "c": 2},
    {"q": "How many colors are traditionally in a rainbow?", "a": ["5", "6", "7", "8"], "c": 2},
    {"q": "Which instrument has black and white keys?", "a": ["Guitar", "Violin", "Piano", "Flute"], "c": 2},
    {"q": "What is 12 × 8?", "a": ["86", "96", "108", "112"], "c": 1},
    {"q": "Which continent is the Sahara Desert in?", "a": ["Asia", "Africa", "Europe", "Australia"], "c": 1},
    {"q": "Which metal is liquid at room temperature?", "a": ["Iron", "Mercury", "Copper", "Silver"], "c": 1},
    {"q": "Which sport uses a shuttlecock?", "a": ["Tennis", "Badminton", "Cricket", "Hockey"], "c": 1},
    {"q": "What is the largest mammal?", "a": ["Elephant", "Giraffe", "Blue Whale", "Hippo"], "c": 2},
    {"q": "Which month has 28 days in a normal year?", "a": ["January", "February", "April", "June"], "c": 1},
    {"q": "Which number is even?", "a": ["13", "17", "21", "24"], "c": 3},
    {"q": "What is the freezing point of water in Celsius?", "a": ["0°C", "10°C", "32°C", "100°C"], "c": 0},
]

rooms: dict[str, dict[str, Any]] = {}


def now() -> float:
    return time.time()


def clean_name(value: str) -> str:
    value = "".join(ch for ch in str(value or "").strip() if ch.isprintable())
    return value[:20].strip()


def make_code() -> str:
    for _ in range(1000):
        code = "".join(random.choices(string.digits, k=4))
        if code not in rooms:
            return code
    raise RuntimeError("Could not allocate room code")


def create_room(max_players: int) -> dict[str, Any]:
    code = make_code()
    return {
        "code": code,
        "max_players": max_players,
        "created_at": now(),
        "last_activity": now(),
        "state": "lobby",          # lobby/question/reveal/game_over
        "players": {},             # name -> player dict
        "host": None,
        "question_order": [],
        "question_index": -1,
        "current_question": None,
        "question_deadline": 0.0,
        "question_task": None,
        "reveal_task": None,
        "answers": {},
        "round_locked": False,
    }


def player_list(room: dict[str, Any]):
    ordered = sorted(room["players"].values(), key=lambda p: p["number"])
    return [
        {
            "name": p["name"],
            "number": p["number"],
            "score": p["score"],
            "is_host": p["name"] == room["host"],
            "connected": p["connected"],
            "answered": p["name"] in room["answers"],
        }
        for p in ordered
    ]


async def send(ws: WebSocket | None, payload: dict[str, Any]):
    if not ws:
        return
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def broadcast(room: dict[str, Any], payload: dict[str, Any]):
    for player in list(room["players"].values()):
        ws = player.get("ws")
        if ws and player.get("connected"):
            await send(ws, payload)


async def send_state(room: dict[str, Any]):
    await broadcast(
        room,
        {
            "type": "state",
            "state": room["state"],
            "host": room["host"],
            "players": player_list(room),
            "question_index": room["question_index"],
            "total_questions": len(room["question_order"]) or TOTAL_QUESTIONS,
        },
    )


def cancel_task(task):
    if task and not task.done():
        task.cancel()


def room_has_enough_players(room: dict[str, Any]) -> bool:
    return sum(1 for p in room["players"].values() if p["connected"]) >= MIN_PLAYERS


def connected_count(room: dict[str, Any]) -> int:
    return sum(1 for p in room["players"].values() if p["connected"])


def choose_questions() -> list[dict[str, Any]]:
    items = QUESTION_BANK[:]
    random.shuffle(items)
    return items[:TOTAL_QUESTIONS]


async def start_game(room: dict[str, Any]):
    if room["state"] != "lobby":
        return

    if not room_has_enough_players(room):
        return

    room["state"] = "question"
    room["question_order"] = choose_questions()
    room["question_index"] = -1
    room["answers"] = {}
    room["round_locked"] = False

    await broadcast(room, {"type": "game_started", "total_questions": len(room["question_order"])})
    await asyncio.sleep(0.2)
    await start_next_question(room)


async def start_next_question(room: dict[str, Any]):
    if room["state"] == "game_over":
        return

    room["question_index"] += 1
    room["answers"] = {}
    room["round_locked"] = False

    if room["question_index"] >= len(room["question_order"]):
        await finish_game(room)
        return

    room["state"] = "question"
    room["current_question"] = room["question_order"][room["question_index"]]
    room["question_deadline"] = now() + QUESTION_TIME

    q = room["current_question"]
    payload = {
        "type": "question",
        "number": room["question_index"] + 1,
        "total": len(room["question_order"]),
        "question": q["q"],
        "answers": q["a"],
        "deadline": int(room["question_deadline"] * 1000),
    }
    await broadcast(room, payload)

    cancel_task(room["question_task"])
    room["question_task"] = asyncio.create_task(question_timeout(room["code"]))


async def question_timeout(room_code: str):
    try:
        await asyncio.sleep(QUESTION_TIME + 0.15)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_code)
    if not room or room["state"] != "question":
        return
    await reveal_question(room)


async def reveal_question(room: dict[str, Any]):
    if room["round_locked"] or room["state"] != "question":
        return

    room["round_locked"] = True
    cancel_task(room["question_task"])
    room["question_task"] = None

    q = room["current_question"]
    correct_index = q["c"]

    results = []
    for p in sorted(room["players"].values(), key=lambda x: x["number"]):
        if not p["connected"]:
            continue
        answer = room["answers"].get(p["name"])
        correct = answer is not None and answer["choice"] == correct_index
        gained = 0
        if correct:
            remaining = max(0.0, room["question_deadline"] - answer["at"])
            gained = 100 + int(remaining * 10)
            p["score"] += gained
        results.append(
            {
                "name": p["name"],
                "number": p["number"],
                "choice": answer["choice"] if answer else None,
                "correct": correct,
                "gained": gained,
                "score": p["score"],
            }
        )

    room["state"] = "reveal"
    await broadcast(
        room,
        {
            "type": "reveal",
            "number": room["question_index"] + 1,
            "correct": correct_index,
            "results": results,
            "leaderboard": sorted(
                [{"name": p["name"], "score": p["score"]} for p in room["players"].values() if p["connected"]],
                key=lambda x: x["score"],
                reverse=True,
            ),
        },
    )

    cancel_task(room["reveal_task"])
    room["reveal_task"] = asyncio.create_task(reveal_timeout(room["code"]))


async def reveal_timeout(room_code: str):
    try:
        await asyncio.sleep(REVEAL_TIME)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_code)
    if not room or room["state"] != "reveal":
        return

    await start_next_question(room)


async def finish_game(room: dict[str, Any]):
    room["state"] = "game_over"
    cancel_task(room["question_task"])
    cancel_task(room["reveal_task"])
    room["question_task"] = None
    room["reveal_task"] = None

    leaderboard = sorted(
        [
            {
                "name": p["name"],
                "number": p["number"],
                "score": p["score"],
            }
            for p in room["players"].values()
            if p["connected"]
        ],
        key=lambda x: (-x["score"], x["number"]),
    )

    await broadcast(
        room,
        {
            "type": "game_over",
            "leaderboard": leaderboard,
        },
    )


async def cleanup_rooms():
    while True:
        await asyncio.sleep(60)
        cutoff = now() - ROOM_IDLE_SECONDS

        for code, room in list(rooms.items()):
            if room["last_activity"] < cutoff and connected_count(room) == 0:
                cancel_task(room["question_task"])
                cancel_task(room["reveal_task"])
                rooms.pop(code, None)


@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup_rooms())


@app.get("/", response_class=HTMLResponse)
async def index():
    return HTMLResponse((STATIC_DIR / "index.html").read_text(encoding="utf-8"))


@app.get("/healthz")
async def healthz():
    return {"ok": True, "rooms": len(rooms)}


@app.get("/api/create-room")
async def api_create_room(max_players: int = 8):
    max_players = max(2, min(MAX_PLAYERS, int(max_players)))
    room = create_room(max_players)
    rooms[room["code"]] = room
    return {"ok": True, "room": room["code"], "max_players": max_players}


@app.get("/api/check-room/{room_code}")
async def api_check_room(room_code: str):
    code = "".join(ch for ch in str(room_code) if ch.isdigit())[:4]
    room = rooms.get(code)

    if not room:
        return {"ok": False, "message": "Room not found."}

    return {
        "ok": True,
        "room": code,
        "state": room["state"],
        "players": connected_count(room),
        "max_players": room["max_players"],
    }


@app.websocket("/ws/{room_code}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_code: str,
    name: str = Query(""),
):
    await websocket.accept()

    code = "".join(ch for ch in str(room_code) if ch.isdigit())[:4]
    name = clean_name(name)

    room = rooms.get(code)

    if not room:
        await send(websocket, {"type": "error", "message": "Room not found. Ask the host for a valid code."})
        await websocket.close()
        return

    if not name:
        await send(websocket, {"type": "error", "message": "Please enter your name."})
        await websocket.close()
        return

    existing = room["players"].get(name)
    if existing and existing["connected"]:
        await send(websocket, {"type": "error", "message": "That name is already in this room."})
        await websocket.close()
        return

    if not existing and connected_count(room) >= room["max_players"]:
        await send(websocket, {"type": "error", "message": "Room is full."})
        await websocket.close()
        return

    if existing:
        player = existing
        player["connected"] = True
        player["ws"] = websocket
    else:
        number = max([p["number"] for p in room["players"].values()], default=0) + 1
        player = {
            "name": name,
            "number": number,
            "score": 0,
            "connected": True,
            "ws": websocket,
        }
        room["players"][name] = player
        if room["host"] is None:
            room["host"] = name

    room["last_activity"] = now()

    await send(
        websocket,
        {
            "type": "joined",
            "room": room["code"],
            "name": name,
            "host": room["host"],
            "state": room["state"],
            "players": player_list(room),
        },
    )
    await send_state(room)

    try:
        while True:
            data = await websocket.receive_json()
            room["last_activity"] = now()
            action = data.get("action")

            if action == "start_game":
                if room["host"] != name:
                    await send(websocket, {"type": "error", "message": "Only the host can start the game."})
                    continue
                if not room_has_enough_players(room):
                    await send(websocket, {"type": "error", "message": "At least 2 players are needed."})
                    continue
                await start_game(room)

            elif action == "answer":
                if room["state"] != "question" or room["round_locked"]:
                    continue
                if name in room["answers"]:
                    continue
                choice = int(data.get("choice", -1))
                if choice not in range(4):
                    continue
                if now() > room["question_deadline"]:
                    continue

                room["answers"][name] = {"choice": choice, "at": now()}

                await send(
                    websocket,
                    {
                        "type": "answer_locked",
                        "choice": choice,
                        "answered": len(room["answers"]),
                        "total": connected_count(room),
                    },
                )
                await broadcast(
                    room,
                    {
                        "type": "answer_progress",
                        "answered": len(room["answers"]),
                        "total": connected_count(room),
                    },
                )

                if len(room["answers"]) >= connected_count(room):
                    await reveal_question(room)

            elif action == "chat":
                text = str(data.get("text", "")).strip()[:250]
                if text:
                    await broadcast(
                        room,
                        {"type": "chat", "sender": name, "text": text},
                    )

            elif action == "restart":
                if room["host"] != name:
                    continue
                if connected_count(room) < MIN_PLAYERS:
                    await send(websocket, {"type": "error", "message": "At least 2 connected players are needed."})
                    continue
                for p in room["players"].values():
                    p["score"] = 0
                await start_game(room)

            elif action == "ping":
                await send(websocket, {"type": "pong"})

    except (WebSocketDisconnect, Exception):
        pass
    finally:
        player = room["players"].get(name)
        if player and player.get("ws") is websocket:
            player["connected"] = False
            player["ws"] = None

        room["last_activity"] = now()

        if room["host"] == name:
            connected = [p["name"] for p in room["players"].values() if p["connected"]]
            room["host"] = connected[0] if connected else None

        if room["state"] == "lobby":
            await send_state(room)
        elif connected_count(room) < MIN_PLAYERS and room["state"] in ("question", "reveal"):
            room["state"] = "lobby"
            cancel_task(room["question_task"])
            cancel_task(room["reveal_task"])
            room["question_task"] = None
            room["reveal_task"] = None
            room["question_order"] = []
            room["question_index"] = -1
            room["answers"] = {}
            await broadcast(room, {"type": "returned_to_lobby", "message": "Not enough players. Waiting for at least 2 players."})
            await send_state(room)

    # Keep the room object so reconnecting players can return while Render is awake.
