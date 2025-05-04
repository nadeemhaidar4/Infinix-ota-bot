import os
import requests
import time
import logging
from telegram import Bot

# Enable logging
logging.basicConfig(
    format='[%(levelname)s] %(message)s',
    level=logging.INFO
)

# Load the bot token from environment variable
BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
CHANNEL_ID = "@infinixupdatetracker"

bot = Bot(token=BOT_TOKEN)

DEVICE_MODELS = [
    "X6871", "X6850", "X6850B", "X6851", "X6851B", "X6852", "X6853",
    "X6880", "X6881", "X6860", "X6861", "X6962", "X1101", "X1101B",
    "CL6", "CL6k", "CL7", "CL7k", "CL8", "CL9", "CLA5", "CLA6",
    "LI6", "LI7", "LI9", "AE10", "AE11", "T1001", "T1101"
]

def check_ota(model):
    try:
        url = "https://osupdate.transsion-os.com/OSUpdate/api/getPushInfo"
        payload = {
            "fingerprint": f"Infinix/INFINIX_{model}/{model}:12/SP1A.210812.016/INFINIX_{model}_V1/000000:user/release-keys",
            "local_code": "en",
            "model": model,
            "region": "IN"
        }
        response = requests.post(url, json=payload, timeout=10)
        if response.status_code == 200 and response.json().get("data"):
            return response.json()["data"]
    except Exception as e:
        logging.error(f"Error checking OTA for {model}: {e}")
    return None

def main():
    logging.info("Starting OTA monitor...")
    sent_versions = {}

    while True:
        for model in DEVICE_MODELS:
            logging.info(f"Checking {model}...")
            data = check_ota(model)
            if data:
                version = data.get("versionCode")
                if version and sent_versions.get(model) != version:
                    msg = f"**New OTA for {model}**\nVersion: {version}\nDesc: {data.get('versionDesc', 'N/A')}"
                    bot.send_message(chat_id=CHANNEL_ID, text=msg, parse_mode="Markdown")
                    sent_versions[model] = version
        time.sleep(600)  # check every 10 minutes

if __name__ == "__main__":
    main()