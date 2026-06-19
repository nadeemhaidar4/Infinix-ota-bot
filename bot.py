#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import time
import os
import threading
from pathlib import Path
import requests
from flask import Flask, jsonify

CONFIG_PATH  = Path(__file__).parent / "config.json"
DEVICES_PATH = Path(__file__).parent / "devices.json"
STATE_PATH   = Path(__file__).parent / "state.json"

# ─────────────────────────────────────────
# UTILS
# ─────────────────────────────────────────
def load_json(path, default):
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return default

def load_config():
    cfg = load_json(CONFIG_PATH, {})
    cfg["bot_token"]              = os.environ.get("BOT_TOKEN",       cfg.get("bot_token", ""))
    cfg["chat_id"]                = os.environ.get("CHAT_ID",         cfg.get("chat_id", ""))
    cfg["check_interval_seconds"] = int(os.environ.get("CHECK_INTERVAL", cfg.get("check_interval_seconds", 300)))
    cfg["send_raw_json"]          = os.environ.get("SEND_RAW_JSON", str(cfg.get("send_raw_json", False))).lower() == "true"
    return cfg

def load_devices():
    if DEVICES_PATH.exists():
        return load_json(DEVICES_PATH, [])
    return load_json(CONFIG_PATH, {}).get("devices", [])

def load_state():
    return load_json(STATE_PATH, {})

def save_state(state):
    with open(STATE_PATH, "w") as f:
        json.dump(state, f, indent=2)

# ─────────────────────────────────────────
# VERSION COMPARE
# ─────────────────────────────────────────
def parse_version(v):
    try:
        return tuple(int(x) for x in str(v).strip().split("."))
    except:
        return (0,)

def is_newer(new_v, old_v):
    return parse_version(new_v) > parse_version(old_v)

# ─────────────────────────────────────────
# OTA CHECK - FIXED HOSTS ONLY
# ─────────────────────────────────────────
HOSTS = [
    "https://osupdate-api.palmplaystore.com"
]
ENDPOINT = "/api/setting-config/os-update-detail"

def check_ota(device: dict):
    payload = {
        "brand":     device["brand"],
        "country":   device.get("country", "IN"),
        "gaId":      device["android_id"],
        "iuid":      device["android_id"],
        "lang":      device.get("lang", "en"),
        "model":     device["model"],
        "osVersion": device["osVersion"],
    }
    headers = {
        "Content-Type": "application/json; charset=utf-8",
        "Accept":       "application/json",
        "User-Agent":   "okhttp/4.9.0",
    }

    for base in HOSTS:
        try:
            url = base + ENDPOINT
            print(f"    → POST {url}")
            r = requests.post(url, json=payload, headers=headers, timeout=20)
            print(f"    ← HTTP {r.status_code}")
            print(f"    ← Body: {r.text[:400]}")

            if r.status_code == 200:
                return {"ok": True, "host": base, "data": r.json(), "payload": payload}
            else:
                print(f"    Non-200 from {base}, trying next...")

        except requests.exceptions.ConnectionError as e:
            print(f"    Connection error {base}: {e}")
        except requests.exceptions.Timeout:
            print(f"    Timeout {base}")
        except Exception as e:
            print(f"    Error {base}: {e}")

    return {"ok": False, "error": "All hosts failed", "payload": payload}

# ─────────────────────────────────────────
# PARSE RESPONSE
# ─────────────────────────────────────────
def parse_ota(api_json: dict):
    if not api_json:
        return None

    # Code check
    code = api_json.get("code", 200)
    msg  = api_json.get("msg", "")
    print(f"    API code={code} msg={msg}")

    if code not in (200, 0):
        return None

    data = api_json.get("data", api_json)

    if data is None:
        return None
    if isinstance(data, list):
        if not data:
            return None
        data = data[0]
    if isinstance(data, dict) and "data" in data and isinstance(data["data"], dict):
        data = data["data"]
    if not isinstance(data, dict):
        return None

    print(f"    Data keys: {list(data.keys())}")

    version = (
        data.get("osSmallVersion") or
        data.get("versionName")    or
        data.get("newVersion")     or
        data.get("osVersion")      or
        data.get("version")        or ""
    )

    if not version:
        print("    No version field found!")
        return None

    return {
        "version":   str(version).strip(),
        "changelog": data.get("updateLog") or data.get("changeLog") or data.get("description") or "",
        "size":      data.get("fileSize")  or data.get("size") or 0,
        "url":       data.get("packageUrl") or data.get("downloadUrl") or data.get("url") or "",
        "md5":       data.get("md5") or data.get("fileMd5") or data.get("packageMd5") or "",
        "raw":       data,
    }

# ─────────────────────────────────────────
# TELEGRAM
# ─────────────────────────────────────────
def tg_send(bot_token, chat_id, text):
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{bot_token}/sendMessage",
            json={
                "chat_id":                  chat_id,
                "text":                     text,
                "parse_mode":               "HTML",
                "disable_web_page_preview": True,
            },
            timeout=15,
        )
        resp = r.json()
        if not resp.get("ok"):
            print(f"  TG Error: {resp}")
        return resp
    except Exception as e:
        print(f"  TG Exception: {e}")
        return None

def format_msg(device, ota):
    size_str = ""
    try:
        sz = int(ota["size"])
        if sz > 0:
            size_str = f"📁 Size: <b>{sz/1024/1024:.1f} MB</b>\n"
    except:
        pass

    dl_line = f'🔗 <a href="{ota["url"]}">Download Package</a>\n' if ota["url"] else ""
    md5_line = f'🔐 MD5: <code>{ota["md5"]}</code>\n'             if ota["md5"] else ""
    changelog = str(ota["changelog"])[:1000] if ota["changelog"] else "Not available"

    return (
        f"🚀 <b>New OTA Update!</b>\n\n"
        f"📱 <b>{device.get('name', device['model'])}</b>\n"
        f"🔖 <code>{device['model']}</code>\n\n"
        f"📦 Old: <code>{device['osVersion']}</code>\n"
        f"🆕 New: <code>{ota['version']}</code>\n"
        f"🌍 Country: {device.get('country','IN')}\n\n"
        f"{size_str}{dl_line}{md5_line}\n"
        f"📝 <b>Changelog:</b>\n{changelog}\n\n"
        f"#{device['brand']} #{device['model'].replace(' ','_')} #OTA"
    )

# ─────────────────────────────────────────
# MAIN LOOP
# ─────────────────────────────────────────
def poll_loop():
    cfg       = load_config()
    bot_token = cfg["bot_token"]
    chat_id   = cfg["chat_id"]
    interval  = cfg["check_interval_seconds"]
    devices   = load_devices()

    if not bot_token:
        print("!!! BOT_TOKEN missing"); return
    if not chat_id:
        print("!!! CHAT_ID missing"); return
    if not devices:
        print("!!! No devices found"); return

    state = load_state()

    print("=" * 50)
    print(f"✅ OTA Bot Started | {len(devices)} device(s) | every {interval}s")
    print("=" * 50)

    device_list = "\n".join(
        f"  • {d.get('name', d['model'])} ({d['osVersion']})" for d in devices
    )
    tg_send(bot_token, chat_id,
        f"✅ <b>OTA Watcher Online!</b>\n\n"
        f"📡 Monitoring {len(devices)} device(s):\n{device_list}\n\n"
        f"⏱ Interval: {interval}s"
    )

    while True:
        print(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] Checking {len(devices)} device(s)...")

        for dev in devices:
            key      = f"{dev['model']}_{dev.get('country','IN')}"
            dev_name = dev.get("name", dev["model"])
            print(f"\n  [{dev_name}] v{dev['osVersion']}")

            res = check_ota(dev)

            if not res["ok"]:
                print(f"  ❌ All hosts failed")
                continue

            ota = parse_ota(res["data"])

            if not ota:
                print(f"  → No update data in response")
                continue

            print(f"  → API version: {ota['version']}")

            last = state.get(key, "")

            if is_newer(ota["version"], dev["osVersion"]):
                if ota["version"] != last:
                    print(f"  🎉 NEW! {dev['osVersion']} → {ota['version']}")
                    r = tg_send(bot_token, chat_id, format_msg(dev, ota))
                    if r and r.get("ok"):
                        state[key] = ota["version"]
                        save_state(state)
                        print(f"  ✅ Sent & saved")
                    if cfg.get("send_raw_json"):
                        tg_send(bot_token, chat_id,
                                f"<pre>{json.dumps(res['data'], indent=2)[:3900]}</pre>")
                else:
                    print(f"  Already notified for {ota['version']}")
            else:
                print(f"  ✅ Up to date")

        print(f"\n  💤 Sleep {interval}s...")
        time.sleep(interval)

# ─────────────────────────────────────────
# FLASK
# ─────────────────────────────────────────
app = Flask(__name__)

@app.route("/")
def health():
    return jsonify({
        "status":   "ok",
        "devices":  len(load_devices()),
        "state":    load_state(),
    })

@app.route("/ping")
def ping():
    return jsonify({"pong": True})

# ─────────────────────────────────────────
# ENTRY
# ─────────────────────────────────────────
if __name__ == "__main__":
    threading.Thread(target=poll_loop, daemon=True).start()
    port = int(os.environ.get("PORT", 10000))
    print(f"Flask on port {port}")
    app.run(host="0.0.0.0", port=port, debug=False)
