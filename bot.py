#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Infinix / Tecno / itel OTA Telegram Pusher
Render-ready with health server
"""
import asyncio
import json
import time
import os
import threading
from pathlib import Path
import requests
from flask import Flask

CONFIG_PATH = Path(__file__).parent / "config.json"
DEVICES_PATH = Path(__file__).parent / "devices.json"
STATE_PATH = Path(__file__).parent / "state.json"

def load_json(path, default):
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default

def load_config():
    # ENV vars override config.json - Render ke liye
    cfg = load_json(CONFIG_PATH, {})
    cfg["bot_token"] = os.environ.get("BOT_TOKEN", cfg.get("bot_token", "PUT_YOUR_BOT_TOKEN_HERE"))
    cfg["chat_id"] = os.environ.get("CHAT_ID", cfg.get("chat_id", ""))
    cfg["check_interval_seconds"] = int(os.environ.get("CHECK_INTERVAL", cfg.get("check_interval_seconds", 300)))
    cfg["send_raw_json"] = os.environ.get("SEND_RAW_JSON", str(cfg.get("send_raw_json", False))).lower() == "true"
    return cfg

def load_devices():
    # devices.json ko prefer karo, nahi to config.json me "devices"
    if DEVICES_PATH.exists():
        return load_json(DEVICES_PATH, [])
    cfg = load_json(CONFIG_PATH, {})
    return cfg.get("devices", [])

def load_state():
    return load_json(STATE_PATH, {})

def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)

def check_ota(device: dict):
    hosts = [
        "https://osupdate.transsion-os.com",
        "https://test-osupdate.transsion-os.com",
        "https://mi-pre.shalltry.com"
    ]
    endpoint = "/OSUpdate/api/getPushInfo"
    payload = {
        "brand": device["brand"],
        "country": device.get("country", "IN"),
        "gaId": device["android_id"],
        "iuid": device["android_id"],
        "lang": device.get("lang", "en"),
        "model": device["model"],
        "osVersion": device["osVersion"]
    }
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept": "application/json",
        "User-Agent": "okhttp/4.9.0",
    }
    last_err = None
    for base in hosts:
        try:
            url = base + endpoint
            r = requests.post(url, json=payload, headers=headers, timeout=15)
            if r.status_code == 200:
                data = r.json()
                return {"ok": True, "host": base, "data": data, "payload": payload}
            else:
                last_err = f"{base} -> {r.status_code} {r.text[:200]}"
        except Exception as e:
            last_err = str(e)
            continue
    return {"ok": False, "error": last_err, "payload": payload}

def parse_ota_response(api_json: dict):
    if not api_json:
        return None
    data = api_json.get("data", api_json)
    if not data:
        return None
    if isinstance(data, list) and data:
        data = data[0]
    if not isinstance(data, dict):
        return None
    version = (
        data.get("versionName") or data.get("osVersion") or 
        data.get("newVersion") or data.get("version") or
        data.get("osSmallVersion") or ""
    )
    if not version:
        return None
    return {
        "version": str(version),
        "changelog": data.get("updateLog") or data.get("description") or data.get("changeLog") or "",
        "size": data.get("fileSize") or data.get("size") or 0,
        "url": data.get("downloadUrl") or data.get("url") or data.get("packageUrl") or "",
        "md5": data.get("md5") or data.get("fileMd5") or "",
        "raw": data
    }

def format_telegram_message(device, ota):
    size_mb = ""
    try:
        sz = int(ota["size"])
        if sz > 0:
            size_mb = f"{sz/1024/1024:.1f} MB"
    except: pass
    changelog = ota["changelog"][:800] if ota["changelog"] else "Changelog not available"
    msg = f"""🚀 <b>New OTA Found!</b>

📱 <b>{device.get('name', device['model'])}</b>
<code>{device['model']}</code>

🆕 Version: <b>{ota['version']}</b>
📦 Base: {device['osVersion']}
🌍 Country: {device.get('country','IN')}

{f"📁 Size: {size_mb}\n" if size_mb else ""}
{f"🔗 <a href='{ota['url']}'>Download URL</a>\n" if ota['url'] else ""}
{f"🔐 MD5: <code>{ota['md5']}</code>\n" if ota['md5'] else ""}

<b>Changelog:</b>
{changelog}

#OTA #{device['brand']} #{device['model'].replace(' ','_')}
"""
    return msg

async def send_telegram(bot_token, chat_id, text, disable_preview=True):
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": disable_preview
    }
    try:
        r = requests.post(url, json=payload, timeout=15)
        return r.json()
    except Exception as e:
        print(f"Telegram send error: {e}")
        return None

async def poll_loop():
    cfg = load_config()
    bot_token = cfg["bot_token"]
    chat_id = cfg["chat_id"]
    interval = cfg.get("check_interval_seconds", 300)
    devices = load_devices()

    if not bot_token or bot_token == "PUT_YOUR_BOT_TOKEN_HERE":
        print("!!! BOT_TOKEN missing. Set ENV BOT_TOKEN or config.json")
        while True: await asyncio.sleep(3600)
    if not chat_id:
        print("!!! CHAT_ID missing")
        while True: await asyncio.sleep(3600)
    if not devices:
        print("!!! devices.json me koi device nahi hai")
        while True: await asyncio.sleep(3600)

    state = load_state()
    print(f"OTA Bot started. Monitoring {len(devices)} device(s), every {interval}s")
    await send_telegram(bot_token, chat_id, f"✅ OTA Watcher started\nMonitoring: {', '.join([d['model'] for d in devices])}")

    while True:
        for dev in devices:
            key = f"{dev['model']}_{dev.get('country','IN')}"
            print(f"[{time.strftime('%H:%M:%S')}] Checking {dev['model']} {dev['osVersion']} ...", end=" ", flush=True)
            res = check_ota(dev)
            if not res["ok"]:
                print(f"FAIL: {res['error']}")
                continue
            ota = parse_ota_response(res["data"])
            if not ota:
                print("No update")
                continue
            print(f"Found: {ota['version']}")
            last_version = state.get(key)
            if ota["version"] != dev["osVersion"] and ota["version"] != last_version:
                print(f"  -> NEW! Pushing to Telegram")
                msg = format_telegram_message(dev, ota)
                await send_telegram(bot_token, chat_id, msg)
                state[key] = ota["version"]
                save_state(state)
                if cfg.get("send_raw_json", False):
                    raw = json.dumps(res["data"], indent=2)[:3900]
                    await send_telegram(bot_token, chat_id, f"<pre>{raw}</pre>")
            else:
                print("  already notified / same version")
        await asyncio.sleep(interval)

# ===== Render Health Server =====
app = Flask(__name__)

@app.route("/")
def health():
    state = load_state()
    devices = load_devices()
    return {
        "status": "ok",
        "monitored_devices": len(devices),
        "last_notified": state
    }

def run_poller_thread():
    asyncio.run(poll_loop())

if __name__ == "__main__":
    # Poller ko background thread me chalao
    threading.Thread(target=run_poller_thread, daemon=True).start()
    # Flask health server - Render isko Web Service samjhega
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
