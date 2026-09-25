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

app = FastAPI(title="Ang Mang Chowk Chang")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

MIN_PLAYERS = 2
MAX_PLAYERS = 4
TURN_SECONDS = 25
ROOM_IDLE_SECONDS = 30 * 60

# 5x5 junior board: four players, four pawns each.
# The outer ring contains 16 cells. Each player has a rotated
# anti-clockwise path and two inner cells ending at the center.
BASE_OUTER = [
    (0, 2), (0, 1), (0, 0),
    (1, 0), (2, 0), (3, 0), (4, 0),
    (4, 1), (4, 2), (4, 3), (4, 4),
    (3, 4), (2, 4), (1, 4), (0, 4), (0, 3),
]

COLORS = ["red", "green", "blue", "yellow"]
PLAYER_LABELS = ["North", "East", "South", "West"]


def rotate(cell, turns):
    r, c = cell
    for _ in range(turns):
        r, c = c, 4 - r
    return r, c


PLAYER_PATHS = []
for turns in range(4):
    outer = [rotate(cell, turns) for cell in BASE_OUTER]
    start = outer[0]

    # Two inner cells from the player's start toward the center.
    center = (2, 2)
    dr = center[0] - start[0]
    dc = center[1] - start[1]
    step = (0 if dr == 0 else (1 if dr > 0 else -1),
            0 if dc == 0 else (1 if dc > 0 else -1))
    inner1 = (start[0] + step[0], start[1] + step[1])
    PLAYER_PATHS.append(outer + [inner1, center])

SAFE_CELLS = {
    PLAYER_PATHS[0][0],
    PLAYER_PATHS[1][0],
    PLAYER_PATHS[2][0],
    PLAYER_PATHS[3][0],
    (2, 2),
}


def now() -> float:
    return time.time()


def clean_name(value: str) -> str:
    value = "".join(ch for ch in str(value or "").strip() if ch.isprintable())
    return value[:20].strip()


def valid_max_players(value: int) -> bool:
    return MIN_PLAYERS <= value <= MAX_PLAYERS


def make_code() -> str:
    for _ in range(1000):
        code = "".join(random.choices(string.digits, k=4))
        if code not in rooms:
            return code
    raise RuntimeError("Could not create a room code")


def make_room(max_players: int) -> dict[str, Any]:
    code = make_code()
    return {
        "code": code,
        "max_players": max_players,
        "created_at": now(),
        "last_activity": now(),

        "state": "lobby",  # lobby, rolling, moving, game_over
        "host": None,

        # name -> player
        "players": {},

        "turn_order": [],
        "turn_index": -1,
        "current_player": None,
        "current_roll": None,
        "current_shells": [],
        "turn_deadline": 0.0,
        "turn_task": None,

        "message": "Waiting for players…",
        "winner": None,
    }


rooms: dict[str, dict[str, Any]] = {}


def connected_players(room):
    return [
        p for p in room["players"].values()
        if p["connected"]
    ]


def connected_count(room):
    return len(connected_players(room))


def public_players(room):
    ordered = sorted(room["players"].values(), key=lambda p: p["number"])
    return [
        {
            "name": p["name"],
            "number": p["number"],
            "color": p["color"],
            "score": sum(1 for pos in p["tokens"] if pos == 17),
            "finished": sum(1 for pos in p["tokens"] if pos == 17),
            "connected": p["connected"],
            "is_host": p["name"] == room["host"],
            "has_kill": p["has_kill"],
        }
        for p in ordered
    ]


def public_tokens(room):
    return [
        {
            "name": p["name"],
            "number": p["number"],
            "color": p["color"],
            "tokens": p["tokens"][:],
        }
        for p in sorted(room["players"].values(), key=lambda p: p["number"])
    ]


def legal_moves_for_player(room, name):
    if room["state"] != "moving":
        return []

    if room["current_player"] != name:
        return []

    player = room["players"].get(name)
    roll = room["current_roll"]

    if not player or roll not in (1, 2, 3, 4, 8):
        return []

    legal = []
    for idx, pos in enumerate(player["tokens"]):
        if can_move_token(room, player, idx, roll):
            legal.append(idx)
    return legal


def cell_for(player_index: int, progress: int):
    return PLAYER_PATHS[player_index][progress]


def occupied_at_cell(room, cell):
    found = []
    for p in room["players"].values():
        if not p["connected"]:
            continue
        player_index = p["number"] - 1
        for idx, progress in enumerate(p["tokens"]):
            if progress >= 0:
                if cell_for(player_index, progress) == cell:
                    found.append((p, idx, progress))
    return found


def can_move_token(room, player, token_index, roll):
    pos = player["tokens"][token_index]

    # A fresh pawn can only enter on 4 or 8 in this classic variant.
    if pos == -1:
        if roll not in (4, 8):
            return False
        target = PLAYER_PATHS[player["number"] - 1][0]
        occupants = occupied_at_cell(room, target)

        # Opponents cannot occupy a safe starting square, so entry is safe.
        # A player may stack their own pawns on a safe square.
        return True

    if pos == 17:
        return False

    new_pos = pos + roll

    # Cannot overshoot the center.
    if new_pos > 17:
        return False

    # Inner path requires at least one capture.
    if new_pos >= 16 and not player["has_kill"]:
        return False

    target_cell = cell_for(player["number"] - 1, new_pos)

    # On non-safe cells, one player's pawn cannot share a square
    # with another pawn of the same player.
    if target_cell not in SAFE_CELLS:
        for idx, other_pos in enumerate(player["tokens"]):
            if idx == token_index or other_pos < 0:
                continue
            if other_pos == 17 or other_pos < 0:
                continue
            if cell_for(player["number"] - 1, other_pos) == target_cell:
                return False

    return True


async def send(ws, payload):
    if not ws:
        return
    try:
        await ws.send_json(payload)
    except Exception:
        pass


async def send_view(room, player_name):
    player = room["players"].get(player_name)
    if not player or not player["connected"]:
        return

    payload = {
        "type": "state",
        "room": room["code"],
        "state": room["state"],
        "host": room["host"],
        "players": public_players(room),
        "tokens": public_tokens(room),
        "turn_order": room["turn_order"],
        "current_player": room["current_player"],
        "current_roll": room["current_roll"],
        "shells": room["current_shells"],
        "deadline": int(room["turn_deadline"] * 1000) if room["turn_deadline"] else 0,
        "message": room["message"],
        "winner": room["winner"],
        "my_name": player_name,
        "my_number": player["number"],
        "my_color": player["color"],
        "my_tokens": player["tokens"][:],
        "has_kill": player["has_kill"],
        "legal_moves": legal_moves_for_player(room, player_name),
        "can_roll": (
            room["state"] == "rolling"
            and room["current_player"] == player_name
        ),
    }
    await send(player["ws"], payload)


async def broadcast_views(room):
    for p in connected_players(room):
        await send_view(room, p["name"])


def cancel_task(task):
    if task and not task.done():
        task.cancel()


def roll_kavdi():
    shells = [random.choice([0, 1]) for _ in range(4)]
    total = sum(shells)

    if total == 0:
        result = 8
    elif total == 4:
        result = 4
    else:
        result = total

    return shells, result


def reset_tokens(room):
    for p in room["players"].values():
        p["tokens"] = [-1, -1, -1, -1]
        p["has_kill"] = False


def setup_turn_order(room):
    connected = sorted(
        connected_players(room),
        key=lambda p: p["number"]
    )

    room["turn_order"] = [p["name"] for p in connected]
    room["turn_index"] = 0
    room["current_player"] = (
        room["turn_order"][0]
        if room["turn_order"] else None
    )


async def start_game(room):
    if connected_count(room) < MIN_PLAYERS:
        return

    cancel_task(room["turn_task"])
    room["turn_task"] = None

    reset_tokens(room)
    setup_turn_order(room)

    room["state"] = "rolling"
    room["current_roll"] = None
    room["current_shells"] = []
    room["turn_deadline"] = now() + TURN_SECONDS
    room["message"] = (
        f"{room['current_player']}'s turn — roll the Kavdi."
    )
    room["winner"] = None

    await broadcast_views(room)
    room["turn_task"] = asyncio.create_task(
        turn_timeout(room["code"])
    )


async def turn_timeout(room_code):
    try:
        await asyncio.sleep(TURN_SECONDS + 0.1)
    except asyncio.CancelledError:
        return

    room = rooms.get(room_code)
    if not room:
        return

    if room["state"] in ("rolling", "moving"):
        current = room["current_player"]
        if current:
            room["message"] = (
                f"{current} ran out of time."
            )
            await advance_turn(room)


async def advance_turn(room, same_player=False):
    cancel_task(room["turn_task"])
    room["turn_task"] = None

    if same_player and room["current_player"] in room["turn_order"]:
        # Bonus roll: keep current player.
        pass
    else:
        # Remove disconnected names from the turn order.
        live_names = {
            p["name"] for p in connected_players(room)
        }
        room["turn_order"] = [
            name for name in room["turn_order"]
            if name in live_names
        ]

        if len(room["turn_order"]) < MIN_PLAYERS:
            room["state"] = "lobby"
            room["current_player"] = None
            room["current_roll"] = None
            room["current_shells"] = []
            room["message"] = "Waiting for at least 2 players."
            await broadcast_views(room)
            return

        if room["current_player"] not in room["turn_order"]:
            room["turn_index"] = 0
        else:
            current_index = room["turn_order"].index(room["current_player"])
            room["turn_index"] = (current_index + 1) % len(room["turn_order"])

        room["current_player"] = room["turn_order"][room["turn_index"]]

    room["state"] = "rolling"
    room["current_roll"] = None
    room["current_shells"] = []
    room["turn_deadline"] = now() + TURN_SECONDS
    room["message"] = (
        f"{room['current_player']}'s turn — roll the Kavdi."
    )

    await broadcast_views(room)
    room["turn_task"] = asyncio.create_task(
        turn_timeout(room["code"])
    )


async def roll_for(room, player_name):
    if room["state"] != "rolling":
        return

    if room["current_player"] != player_name:
        return

    shells, value = roll_kavdi()
    room["current_shells"] = shells
    room["current_roll"] = value

    legal = legal_moves_for_player(room, player_name)

    if not legal:
        if value in (4, 8):
            room["message"] = (
                f"{player_name} rolled {value}, but has no valid move. Bonus roll!"
            )
            await advance_turn(room, same_player=True)
        else:
            room["message"] = (
                f"{player_name} rolled {value}, but has no valid move."
            )
            await advance_turn(room, same_player=False)
        return

    room["state"] = "moving"
    room["turn_deadline"] = now() + TURN_SECONDS
    room["message"] = (
        f"{player_name} rolled {value}. Choose a pawn."
    )

    await broadcast_views(room)

    cancel_task(room["turn_task"])
    room["turn_task"] = asyncio.create_task(
        turn_timeout(room["code"])
    )


async def move_token(room, player_name, token_index):
    if room["state"] != "moving":
        return

    if room["current_player"] != player_name:
        return

    player = room["players"].get(player_name)
    if not player:
        return

    try:
        token_index = int(token_index)
    except Exception:
        return

    if token_index not in range(4):
        return

    roll = room["current_roll"]

    if roll not in (1, 2, 3, 4, 8):
        return

    if not can_move_token(room, player, token_index, roll):
        return

    old_pos = player["tokens"][token_index]

    if old_pos == -1:
        new_pos = 0
    else:
        new_pos = old_pos + roll

    player["tokens"][token_index] = new_pos

    captured = []
    if new_pos < 17:
        target_cell = cell_for(player["number"] - 1, new_pos)

        if target_cell not in SAFE_CELLS:
            for opponent in room["players"].values():
                if opponent["name"] == player_name or not opponent["connected"]:
                    continue

                opponent_index = opponent["number"] - 1
                for idx, opponent_pos in enumerate(opponent["tokens"]):
                    if opponent_pos < 0 or opponent_pos == 17:
                        continue

                    if cell_for(opponent_index, opponent_pos) == target_cell:
                        opponent["tokens"][idx] = -1
                        captured.append(
                            f"No.{opponent['number']} {opponent['name']}"
                        )

    if captured:
        player["has_kill"] = True

    if all(pos == 17 for pos in player["tokens"]):
        room["state"] = "game_over"
        room["winner"] = player_name
        room["current_player"] = None
        room["current_roll"] = None
        room["current_shells"] = []
        room["turn_deadline"] = 0
        room["message"] = (
            f"🏆 {player_name} got all 4 pawns home and wins!"
        )
        cancel_task(room["turn_task"])
        room["turn_task"] = None
        await broadcast_views(room)
        return

    if captured:
        room["message"] = (
            f"{player_name} cut {', '.join(captured)}. Extra turn!"
        )
        await advance_turn(room, same_player=True)
        return

    if roll in (4, 8):
        room["message"] = (
            f"{player_name} rolled {roll}. Extra turn!"
        )
        await advance_turn(room, same_player=True)
        return

    room["message"] = (
        f"{player_name} moved pawn No.{token_index + 1} by {roll}."
    )
    await advance_turn(room, same_player=False)


async def notify(room, message):
    room["message"] = message
    await broadcast_views(room)


@app.get("/", response_class=HTMLResponse)
async def home():
    return HTMLResponse(
        (STATIC_DIR / "index.html").read_text(
            encoding="utf-8"
        )
    )


@app.get("/healthz")
async def healthz():
    return {
        "ok": True,
        "rooms": len(rooms),
    }


@app.get("/api/create-room")
async def api_create_room(max_players: int = 4):
    try:
        max_players = int(max_players)
    except Exception:
        max_players = 4

    if not valid_max_players(max_players):
        return {
            "ok": False,
            "message": "Players must be between 2 and 4."
        }

    room = make_room(max_players)
    rooms[room["code"]] = room

    return {
        "ok": True,
        "room": room["code"],
        "max_players": room["max_players"],
    }


@app.get("/api/check-room/{room_code}")
async def api_check_room(room_code: str):
    code = "".join(ch for ch in str(room_code) if ch.isdigit())[:4]
    room = rooms.get(code)

    if not room:
        return {
            "ok": False,
            "message": "Room not found."
        }

    return {
        "ok": True,
        "room": room["code"],
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

    code = "".join(
        ch for ch in str(room_code)
        if ch.isdigit()
    )[:4]

    name = clean_name(name)
    room = rooms.get(code)

    if not room:
        await send(
            websocket,
            {
                "type": "error",
                "message": "Room not found. Ask the host for the correct 4-digit code."
            },
        )
        await websocket.close()
        return

    if not name:
        await send(
            websocket,
            {
                "type": "error",
                "message": "Please enter your name."
            },
        )
        await websocket.close()
        return

    existing = room["players"].get(name)

    if existing and existing["connected"]:
        await send(
            websocket,
            {
                "type": "error",
                "message": "That name is already in this room."
            },
        )
        await websocket.close()
        return

    if not existing and connected_count(room) >= room["max_players"]:
        await send(
            websocket,
            {
                "type": "error",
                "message": "Room is full."
            },
        )
        await websocket.close()
        return

    if existing:
        player = existing
        player["connected"] = True
        player["ws"] = websocket
    else:
        used_numbers = {
            p["number"]
            for p in room["players"].values()
        }

        number = next(
            n for n in range(1, MAX_PLAYERS + 1)
            if n not in used_numbers
        )

        player = {
            "name": name,
            "number": number,
            "color": COLORS[number - 1],
            "connected": True,
            "ws": websocket,
            "tokens": [-1, -1, -1, -1],
            "has_kill": False,
        }

        room["players"][name] = player

        if room["host"] is None:
            room["host"] = name

    room["last_activity"] = now()

    # A reconnecting player gets the complete current state.
    await send_view(room, name)

    if room["state"] == "lobby":
        await notify(
            room,
            f"{name} joined the room."
        )

    try:
        while True:
            data = await websocket.receive_json()
            room["last_activity"] = now()

            action = data.get("action")

            if action == "start_game":
                if room["host"] != name:
                    await send(
                        websocket,
                        {
                            "type": "error",
                            "message": "Only the host can start the game."
                        },
                    )
                    continue

                if connected_count(room) < MIN_PLAYERS:
                    await send(
                        websocket,
                        {
                            "type": "error",
                            "message": "At least 2 players are needed."
                        },
                    )
                    continue

                if room["state"] == "lobby":
                    await start_game(room)

            elif action == "roll":
                await roll_for(room, name)

            elif action == "move":
                await move_token(
                    room,
                    name,
                    data.get("token")
                )

            elif action == "chat":
                text = str(
                    data.get("text", "")
                ).strip()[:250]

                if text:
                    for p in connected_players(room):
                        await send(
                            p["ws"],
                            {
                                "type": "chat",
                                "sender": name,
                                "text": text,
                            },
                        )

            elif action == "restart":
                if room["host"] != name:
                    continue

                if connected_count(room) < MIN_PLAYERS:
                    await send(
                        websocket,
                        {
                            "type": "error",
                            "message": "At least 2 players are needed."
                        },
                    )
                    continue

                await start_game(room)

            elif action == "ping":
                await send(
                    websocket,
                    {
                        "type": "pong"
                    }
                )

    except (WebSocketDisconnect, Exception):
        pass

    finally:
        player = room["players"].get(name)

        if player and player.get("ws") is websocket:
            player["connected"] = False
            player["ws"] = None

        room["last_activity"] = now()

        if room["host"] == name:
            live = sorted(
                connected_players(room),
                key=lambda p: p["number"]
            )
            room["host"] = (
                live[0]["name"]
                if live else None
            )

        if (
            room["current_player"] == name
            and room["state"] in ("rolling", "moving")
        ):
            await advance_turn(room, same_player=False)

        elif (
            room["state"] in ("rolling", "moving")
            and connected_count(room) < MIN_PLAYERS
        ):
            cancel_task(room["turn_task"])
            room["turn_task"] = None
            room["state"] = "lobby"
            room["current_player"] = None
            room["current_roll"] = None
            room["current_shells"] = []
            room["turn_deadline"] = 0
            room["message"] = "Waiting for at least 2 players."
            await broadcast_views(room)

        elif room["state"] == "lobby":
            await broadcast_views(room)


async def cleanup_rooms():
    while True:
        await asyncio.sleep(60)
        cutoff = now() - ROOM_IDLE_SECONDS

        for code, room in list(rooms.items()):
            if (
                room["last_activity"] < cutoff
                and connected_count(room) == 0
            ):
                cancel_task(room["turn_task"])
                rooms.pop(code, None)


@app.on_event("startup")
async def startup():
    asyncio.create_task(cleanup_rooms())
