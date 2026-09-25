# QuickSave Ultimate

Features:
- Animated download state/progress UI
- Direct image/video preview
- Drag & drop URL support
- Clipboard Paste
- PWA manifest + service worker + install button
- Local download history (browser only)
- Monetization-ready ad placement
- No login/database required
- Render health endpoint
- Rate limiting, active-download limits, timeouts, redirect limit, MIME allowlist, SSRF protections and 250 MB cap

## Render
Build: `npm ci`
Start: `npm start`
Health check: `/health`

## Important
The app is for direct/public media URLs that the user is authorized to download. It does not bypass private content, DRM, authentication or platform protections.

The "progress" shown in the current no-login UI tracks the download start state. Browser-native anchor downloads do not expose reliable byte-level progress without downloading the file through JavaScript, which would unnecessarily duplicate large media in memory. The backend itself streams the file with backpressure.
