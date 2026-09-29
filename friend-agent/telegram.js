// friend-agent — thin wrapper around Telegram's Bot API.
//
// Just one job: send a message to the one allowed chat. Telegram's HTTP API
// is simple enough that raw fetch (same pattern already used for Groq) is
// the right amount of dependency — no SDK, no new package to install.

const { TELEGRAM_BOT_TOKEN } = process.env;

export async function sendTelegramMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}
