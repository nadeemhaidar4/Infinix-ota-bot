# Who Is The Spy — Final Fixed Version

## Deploy on Render
Build command:
```bash
pip install -r requirements.txt
```
Start command:
```bash
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

## Room flow
- Create Room creates a 4-digit room on the server and immediately joins it.
- Join Room ID checks the room first and automatically uses the room's actual player capacity/mode.
- Random Room finds an available waiting room or creates one.
- An invalid/non-existent room is rejected; it is never silently created by the WebSocket endpoint.

## Voice
- Agora RTC Web SDK is loaded from the page.
- Microphone permission is requested from a real user action (Get Ready / microphone button).
- The audio track stays muted until the player's speaking turn.
- Echo cancellation, noise suppression and automatic gain control are enabled.
