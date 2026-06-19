# OTA Telegram Bot - Infinix / Tecno / itel

Monitors `osupdate.transsion-os.com` and auto-posts to Telegram channel when new OTA drops.

### Local Run
```
pip install -r requirements.txt
# edit devices.json if needed
# set BOT_TOKEN / CHAT_ID in config.json or ENV
python bot.py
```

### 1. Telegram Bot Setup

1. Telegram me @BotFather -> `/newbot` -> Name do -> Token copy karo
   Example token: `123456789:AAH...`
2. Ek Channel banao (Public/Private)
3. Apne bot ko channel me Add karo, **Admin** banao (Post Messages permission)
4. Chat ID nikalna:
   - Public channel: `@your_channel_username`
   - Private: Bot ko channel me message bhejne do, phir:
     `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
     usme `"chat":{"id":-1001234567890,...}` milega – yahi CHAT_ID hai

### 2. GitHub pe dalna

```bash
cd ota_telegram_bot
git init
git add .
git commit -m "OTA Telegram bot"
git branch -M main
git remote add origin https://github.com/<youruser>/ota-telegram-bot.git
git push -u origin main
```

`.gitignore` me `state.json` already ignored hai, tokens config.json me mat commit karo – Render pe ENV vars use karo.

### 3. Render.com Deploy

**Option A – render.yaml (1-click)**
1. GitHub repo ko Render se connect karo
2. New > Blueprint > repo select → it will read `render.yaml`
3. Environment variables set karo:
   - `BOT_TOKEN` = your BotFather token
   - `CHAT_ID` = `@channel` ya `-100...`
   - `CHECK_INTERVAL` = 300

**Option B – Manual**
- Render Dashboard → New → Web Service
- Connect your GitHub repo
- Build Command: `pip install -r requirements.txt`
- Start Command: `python bot.py`
- Instance: Free
- Environment → Add:
  ```
  BOT_TOKEN = 123456:ABC...
  CHAT_ID = @my_ota_channel
  CHECK_INTERVAL = 300
  PYTHONUNBUFFERED = 1
  ```

Deploy hote hi bot start ho jayega aur channel me `✅ OTA Watcher started` message aayega.

Render free plan me 15 min inactivity pe sleep hota hai — is bot me ek Flask health server `/` port 10000 pe chalta hai, to Web Service ke roop me hamesha up rehta hai. Polling background thread me chalti hai.

Logs: Render Dashboard → Logs

### Devices add karna

`devices.json` edit karo (locally ya GitHub pe):
```json
[
  {
    "name": "Infinix Hot 50 Pro+",
    "brand": "Infinix",
    "model": "Infinix X6861",
    "osVersion": "15.1.2.165",
    "country": "IN",
    "lang": "en",
    "android_id": "603c17d732628de0"
  },
  {
    "name": "Tecno Spark 30",
    "brand": "TECNO",
    "model": "TECNO BF6",
    "osVersion": "14.0.0.100",
    "country": "IN",
    "lang": "en",
    "android_id": "a1b2c3d4e5f67890"
  }
]
```
Push to GitHub → Render auto-redeploy.

android_id = 16 hex chars, `Settings.Secure.ANDROID_ID` se, random bhi chal sakta hai.

### API Notes

Real endpoint (smali `LP1/n.smali` se):
```
POST https://osupdate.transsion-os.com/OSUpdate/api/getPushInfo
```
Agar 403 aaye to `LU1/d.smali` me sign headers check karna padega.

### Files
- `bot.py` – poller + Flask health server
- `devices.json` – devices list
- `config.json` – local fallback config
- `render.yaml` – Render blueprint
- `requirements.txt`
