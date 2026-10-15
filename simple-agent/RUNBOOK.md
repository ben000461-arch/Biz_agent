# Running Biz_agent on the iMac

## Start it (three Terminal tabs, in this order)

Tab 1 — the local AI:
    ollama serve

Tab 2 — the public tunnel:
    ngrok http --url=oversized-extradite-unbroken.ngrok-free.dev 3000

Tab 3 — the bot:
    cd ~/Desktop/Biz_agent/simple-agent && npm start

## Is it working?
- Open https://oversized-extradite-unbroken.ngrok-free.dev/health — it should say {"ok":true}
- Message the bot on Telegram: "hello"

## If something is off
- Bot silent, /health works -> check Tab 3 for errors, Ctrl+C then `npm start`
- /health fails -> Tab 2 (ngrok) stopped; re-run its command
- Replies are very slow or fail -> Tab 1 (ollama) stopped; re-run `ollama serve`
- After a restart the bot forgets recent chat (memory is in RAM only). Pending yes/no offers are lost too.

## Keep the iMac awake
System Settings -> Lock Screen: "Turn display off on power adapter when inactive" = Never (or a long time)
System Settings -> Displays -> Advanced: turn ON "Prevent automatic sleeping on power adapter when the display is off"
Keep it plugged in, and don't close Terminal windows.
Quick check from Terminal:  pmset -g | grep -E " sleep| displaysleep"   (sleep should be 0)

## Never put in this file or in chat
API keys, bot tokens, .env contents, the Supabase service key.
