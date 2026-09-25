# Quiz Rush Multiplayer

A simple multiplayer quiz game designed to run on a single low-cost/free web service.

## Features
- Create 4-digit room
- Join by 4-digit code
- 2-8 players
- Host controls
- 10-question games
- 15-second server-authoritative timer
- One answer per player
- Fast correct answers receive a higher score
- Live leaderboard
- Chat
- Automatic return to lobby if fewer than 2 players remain
- No database, no Redis, no external realtime service, no microphone dependency

## Render
Build command:
`pip install -r requirements.txt`

Start command:
`uvicorn app.main:app --host 0.0.0.0 --port $PORT`

Important: keep the Render service at one instance. This app intentionally keeps room data in memory, which makes it simple and cheap, but multiple instances would need shared state.
