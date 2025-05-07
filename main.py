import os
from telethon.sync import TelegramClient, events
from telethon.tl.types import InputPeerChannel
from telethon.tl.functions.messages import ExportChatInviteRequest
from telethon.tl.types import MessageMediaPhoto, MessageMediaDocument
from telethon.tl.custom.button import Button
from telethon.sessions import StringSession
import asyncio
import logging
from telebot import TeleBot

logging.basicConfig(level=logging.INFO)

# ENV vars
API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
BOT_TOKEN = os.getenv("BOT_TOKEN")
SOURCE_CHANNEL = "TranssionUpdatesTracker"
DEST_CHANNEL = "@infinixupdatetracker"
USER_SESSION = os.getenv("USER_SESSION_STRING")

# Clients
bot = TeleBot(BOT_TOKEN)
client = TelegramClient(StringSession(USER_SESSION), API_ID, API_HASH)

async def main():
    await client.start()
    print("User Client Started.")

    @client.on(events.NewMessage(chats=SOURCE_CHANNEL))
    async def handler(event):
        try:
            msg = event.message
            text = msg.text or ""
            buttons = msg.reply_markup

            # Download media if present
            media_file = None
            if msg.media:
                media_file = await client.download_media(msg.media)

            # Prepare button layout for Bot API
            reply_markup = None
            if buttons:
                button_rows = []
                for row in buttons.rows:
                    btns = []
                    for btn in row.buttons:
                        btns.append({'text': btn.text, 'url': btn.url})
                    button_rows.append(btns)
                reply_markup = {'inline_keyboard': button_rows}

            # Send via bot
            if media_file:
                if media_file.endswith(('.jpg', '.jpeg', '.png')):
                    bot.send_photo(DEST_CHANNEL, photo=open(media_file, 'rb'), caption=text, reply_markup=reply_markup)
                else:
                    bot.send_document(DEST_CHANNEL, document=open(media_file, 'rb'), caption=text, reply_markup=reply_markup)
                os.remove(media_file)
            else:
                bot.send_message(DEST_CHANNEL, text=text, reply_markup=reply_markup)

            print("Posted to destination.")
        except Exception as e:
            print("Error:", e)

    await client.run_until_disconnected()

if __name__ == "__main__":
    asyncio.run(main())
