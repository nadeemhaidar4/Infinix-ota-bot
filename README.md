# Ang Mang Chowk Chang

A simple multiplayer web version of the traditional 5x5 Ang Mang Chowk Chang / Chowka Bara family of games.

## Included
- 2-4 player private room
- 4 digit Create Room / Join Room
- 4 pawns per player
- 4-shell Kavdi roll: 1, 2, 3, 4, 8
- Bonus turn on 4 or 8
- Capture gives an extra turn
- Safe X squares
- Inner path unlocks after first capture
- Center home
- Host start/restart
- Chat
- Server-authoritative turn timer
- No database / Redis / external realtime service

## Render
Build:
`pip install -r requirements.txt`

Start:
`uvicorn app.main:app --host 0.0.0.0 --port $PORT`

Keep the Render service at one instance because game rooms are stored in process memory.
