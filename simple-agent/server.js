// simple-agent — the smallest possible version of the loop we actually care about:
// message in -> LLM decides what's being asked -> a real action happens -> message out.
//
// On purpose, this does almost nothing useful yet. The point isn't the command
// itself — it's proving every wire in the chain actually works, with a task
// simple enough that if something breaks, you know immediately it's the
// plumbing, not the task.
//
// The one real "action" it supports: doing actual math. Small, but genuinely
// real — the LLM has to correctly identify numbers and an operation from loose
// text, then real code (not the LLM) does the actual calculation, which is the
// same "LLM decides, code executes" pattern the real GitHub bridge (friend-agent) uses.
//
// Transport: Telegram, not SMS. Telegram needs no carrier registration and no
// paid account — just a bot token from @BotFather — which is why this swapped
// away from Twilio (Twilio requires U.S. A2P 10DLC registration for real SMS,
// which needs a paid account and business/ID info).

import 'dotenv/config';
import express from 'express';

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_ID, // your own numeric Telegram user ID — see .env.example for how to find it
  GROQ_API_KEY,
  PORT = 3000,
} = process.env;

// TELEGRAM_ALLOWED_USER_ID is deliberately NOT required here — on first run it's
// blank on purpose, so the server can start, log whoever messages it, and let
// you copy their ID in. Every message is just ignored until it's set.
for (const [name, val] of Object.entries({
  TELEGRAM_BOT_TOKEN, GROQ_API_KEY,
})) {
  if (!val) {
    console.error(`Missing required environment variable: ${name}. Check .env.example.`);
    process.exit(1);
  }
}
if (!TELEGRAM_ALLOWED_USER_ID) {
  console.warn('TELEGRAM_ALLOWED_USER_ID is not set yet — message the bot once, copy the ID that gets logged below, and add it to .env.');
}

const app = express();

async function sendTelegramMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    console.error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
  }
}

// The LLM's ONLY job: read the text and decide which action is meant, plus
// pull out the numbers needed for it. It never does the math itself — that
// happens in real code below, so a math mistake is impossible regardless of
// the model's reliability.
async function interpretCommand(text) {
  const systemPrompt = `You read a short text message and decide which of these actions it's requesting:
- "add": add two numbers. Extract "a" and "b".
- "multiply": multiply two numbers. Extract "a" and "b".
- "unknown": anything that isn't clearly one of the above.
Respond ONLY with valid JSON: {"action": "add"|"multiply"|"unknown", "a": number|null, "b": number|null}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b', // llama-3.1-8b-instant was deprecated by Groq in June 2026
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

app.post('/telegram-webhook', express.json(), async (req, res) => {
  const message = req.body.message;
  if (!message) return res.status(200).send(); // not a plain text message — ignore

  const chatId = message.chat.id;
  const fromId = message.from?.id;
  const text = (message.text || '').trim();

  if (String(fromId) !== String(TELEGRAM_ALLOWED_USER_ID)) {
    console.warn(`Ignored message from unrecognized Telegram user id: ${fromId} (@${message.from?.username || 'no username'})`);
    return res.status(200).send();
  }

  try {
    const { action, a, b } = await interpretCommand(text);

    let reply;
    if (action === 'add' && a != null && b != null) {
      reply = `${a} + ${b} = ${a + b}`;
    } else if (action === 'multiply' && a != null && b != null) {
      reply = `${a} x ${b} = ${a * b}`;
    } else {
      reply = `Didn't catch a clear command in that. Try something like "add 7 and 15".`;
    }

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('Error handling message:', err);
    await sendTelegramMessage(chatId, `Something broke on my end: ${err.message}`);
  }

  res.status(200).send();
});

app.listen(PORT, () => console.log(`simple-agent listening on port ${PORT}`));