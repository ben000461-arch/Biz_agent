// simple-agent — the smallest possible version of the loop we actually care about:
// message in -> LLM decides what's being asked -> a real action happens -> message out.
//
// On purpose, this does almost nothing useful yet. The point isn't the command
// itself — it's proving every wire in the chain actually works, with tasks
// simple enough that if something breaks, you know immediately it's the
// plumbing, not the task.
//
// Actions it supports:
//   - add / multiply: real math, done in code (not the LLM) so it's never wrong
//   - weather: a real external API call (Open-Meteo, no key needed) — proves
//     the agent can reach out to a real tool/service, not just compute locally
//   - add_note / list_notes: in-memory state — proves the agent can remember
//     something across messages, not just answer one-shot questions
//   - write_file: actually creates a real file on this machine's Desktop —
//     proves the agent can take a real action on the computer it runs on,
//     not just answer questions about the world
//   - draft_email: the LLM writes a real subject + body, saved as a text
//     file — this is a DRAFT only, nothing is actually sent. Sending would
//     need a real Gmail API connection (OAuth setup), which is a deliberate
//     next step, not something to fake tonight.
//   - write_excel: creates a real .xlsx file on the Desktop using the free
//     `xlsx` library — fully local, no account or API key needed
//   - edit_excel: opens an EXISTING .xlsx already on the Desktop, reads its
//     real current contents, asks the LLM to produce the updated table given
//     the request, and saves it back to the same file. This is the "connect
//     to an existing tool" pattern — reading real state before acting on it,
//     not just generating something from scratch.
// The LLM's only job every time: read the message, decide which action is
// meant, and pull out the arguments. It never performs the action itself —
// real code does, which is the same "LLM decides, code executes" pattern the
// real GitHub bridge (friend-agent) uses.
//
// Transport: Telegram, not SMS. Telegram needs no carrier registration and no
// paid account — just a bot token from @BotFather — which is why this swapped
// away from Twilio (Twilio requires U.S. A2P 10DLC registration for real SMS,
// which needs a paid account and business/ID info).

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import XLSX from 'xlsx';

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

// In-memory only, by design — resets when the server restarts. This is a
// proof that the agent CAN hold state, not a real notes product; a real
// version would use a database.
const notes = [];

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

// Real tool #1: look up current weather for a place name. Two calls to
// Open-Meteo's free, no-API-key APIs — first turn the place name into
// coordinates, then ask for the current conditions there.
async function getWeather(location) {
  const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`);
  if (!geoRes.ok) throw new Error(`Geocoding API error: ${geoRes.status}`);
  const geoData = await geoRes.json();
  const place = geoData.results?.[0];
  if (!place) return `Couldn't find a place called "${location}".`;

  const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true`);
  if (!weatherRes.ok) throw new Error(`Weather API error: ${weatherRes.status}`);
  const weatherData = await weatherRes.json();
  const current = weatherData.current_weather;
  if (!current) return `Got a location for "${location}" but no current weather data back.`;

  return `${place.name}${place.admin1 ? `, ${place.admin1}` : ''}: ${current.temperature}°C, wind ${current.windspeed} km/h.`;
}

// Real tool #2: hold a small piece of state across messages. Nothing fancy —
// the point is proving the agent can remember something you told it earlier
// in a different message, not just answer a single self-contained question.
function addNote(text) {
  notes.push({ text, at: new Date().toISOString() });
  return `Saved. You have ${notes.length} note${notes.length === 1 ? '' : 's'} now.`;
}

function listNotes() {
  if (notes.length === 0) return "You don't have any notes yet.";
  return notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n');
}

// Real tool #3: actually create a file on the Desktop of whatever machine
// this server is running on. path.basename() strips any directory parts
// from the requested filename (so "../../etc/passwd" just becomes
// "passwd"), which keeps every write confined to the Desktop folder no
// matter what a message asks for.
function writeDesktopFile(filename, content) {
  const safeName = path.basename(filename || 'note-from-agent.txt');
  const desktopPath = path.join(os.homedir(), 'Desktop', safeName);
  fs.writeFileSync(desktopPath, content, 'utf8');
  return `Created "${safeName}" on your Desktop.`;
}

// Real tool #4: draft an email as a plain-text file — NOT sent anywhere.
// The LLM writes the actual subject/body itself (this is the one case where
// it's asked to produce real prose, not just extract fields), and the code
// just formats and saves it. Actually sending would need a real Gmail
// connection (OAuth), which is separate, deliberate work.
function draftEmail(recipient, subject, body) {
  const content = `To: ${recipient || '(not specified)'}\nSubject: ${subject}\n\n${body}`;
  const safeName = `email-draft-${Date.now()}.txt`;
  const desktopPath = path.join(os.homedir(), 'Desktop', safeName);
  fs.writeFileSync(desktopPath, content, 'utf8');
  return `Drafted the email and saved it as "${safeName}" on your Desktop. Nothing was sent — just a draft to review.`;
}

// Real tool #5: create an actual .xlsx file using the free, offline `xlsx`
// (SheetJS) library — no Excel install, no account, no API key. `rows` is a
// 2D array (rows of cells) the LLM builds from the request.
function writeExcelFile(filename, rows) {
  const safeName = path.basename(filename || 'data.xlsx');
  const desktopPath = path.join(os.homedir(), 'Desktop', safeName);
  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, desktopPath);
  return `Created "${safeName}" on your Desktop with ${rows.length} row${rows.length === 1 ? '' : 's'}.`;
}

// Reads an existing spreadsheet's real current contents as a 2D array
// (header row included), so the agent is working from what's actually
// there, not guessing.
function readExcelFile(filename) {
  const safeName = path.basename(filename);
  const desktopPath = path.join(os.homedir(), 'Desktop', safeName);
  if (!fs.existsSync(desktopPath)) {
    return { error: `Couldn't find "${safeName}" on your Desktop.` };
  }
  const workbook = XLSX.readFile(desktopPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  return { safeName, desktopPath, rows };
}

// A second, separate LLM call — this one's job is different from
// interpretCommand: given the REAL current rows and the plain-English
// request, produce the full updated table. Asking for the whole table back
// (not a diff/patch) is simpler and much less error-prone for a model to
// get right than precise cell-by-cell edit instructions.
async function editExcelWithLLM(currentRows, instruction) {
  const systemPrompt = `You are given the current contents of a spreadsheet as a JSON array of rows (the first row is the header). Apply the requested change and return the FULL updated table — every existing row that should remain, plus any additions or edits requested. Keep everything not mentioned in the request unchanged. Respond ONLY with valid JSON: {"rows": [[...], [...], ...]}`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: 'openai/gpt-oss-120b',
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Current table:\n${JSON.stringify(currentRows)}\n\nRequested change:\n${instruction}` },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Groq API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  if (!Array.isArray(parsed.rows)) throw new Error('LLM did not return a usable table');
  return parsed.rows;
}

async function editExcelFile(filename, instruction) {
  const found = readExcelFile(filename);
  if (found.error) return found.error;

  const updatedRows = await editExcelWithLLM(found.rows, instruction);

  const worksheet = XLSX.utils.aoa_to_sheet(updatedRows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
  XLSX.writeFile(workbook, found.desktopPath);

  return `Updated "${found.safeName}" — it now has ${updatedRows.length} rows (was ${found.rows.length}).`;
}

async function interpretCommand(text) {
  const systemPrompt = `You read a short message and decide which of these actions it's requesting:
- "add": add two numbers. Extract "a" and "b".
- "multiply": multiply two numbers. Extract "a" and "b".
- "weather": look up current weather somewhere. Extract "location" (a city/place name).
- "add_note": remember something for later, ONLY when no file/document is mentioned. Extract "note" (the text to save).
- "list_notes": show all saved notes. No extra fields needed.
- "write_file": use this whenever the message mentions a FILE, a .txt, a document, or saving/creating something on the Desktop or computer — even if the wording is close to a note. Extract "filename" (invent a short one ending in .txt if none is given) and "file_content" (the text to put in it).
- "draft_email": the message asks to draft/write an email. Write a real, well-written "email_subject" and "email_body" yourself based on what's asked (professional tone, appropriate length). Extract "recipient" too if a name/email is mentioned, otherwise null.
- "write_excel": the message asks to CREATE a brand-new spreadsheet from scratch. Build "sheet_rows" as a 2D array of arrays (each inner array is one row of cells, include a header row as the first row if it makes sense) representing the data described. Extract "filename" (invent one ending in .xlsx if none given).
- "edit_excel": the message asks to CHANGE, UPDATE, or ADD TO an EXISTING spreadsheet (mentions an existing filename, or says "add to", "update", "edit" a spreadsheet). Extract "filename" (the existing file's name, guess ".xlsx" extension if not given).
- "unknown": anything that isn't clearly one of the above.
Rule: if the word "file" appears, or a filename like "todo.txt" is mentioned, ALWAYS choose "write_file", never "add_note".
Rule: if the message is about an EXISTING spreadsheet (updating/adding to one), choose "edit_excel", not "write_excel".
Respond ONLY with valid JSON: {"action": "add"|"multiply"|"weather"|"add_note"|"list_notes"|"write_file"|"draft_email"|"write_excel"|"edit_excel"|"unknown", "a": number|null, "b": number|null, "location": string|null, "note": string|null, "filename": string|null, "file_content": string|null, "recipient": string|null, "email_subject": string|null, "email_body": string|null, "sheet_rows": array|null}`;

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
    const {
      action, a, b, location, note, filename, file_content,
      recipient, email_subject, email_body, sheet_rows,
    } = await interpretCommand(text);

    let reply;
    if (action === 'add' && a != null && b != null) {
      reply = `${a} + ${b} = ${a + b}`;
    } else if (action === 'multiply' && a != null && b != null) {
      reply = `${a} x ${b} = ${a * b}`;
    } else if (action === 'weather' && location) {
      reply = await getWeather(location);
    } else if (action === 'add_note' && note) {
      reply = addNote(note);
    } else if (action === 'list_notes') {
      reply = listNotes();
    } else if (action === 'write_file' && file_content) {
      reply = writeDesktopFile(filename, file_content);
    } else if (action === 'draft_email' && email_subject && email_body) {
      reply = draftEmail(recipient, email_subject, email_body);
    } else if (action === 'write_excel' && Array.isArray(sheet_rows) && sheet_rows.length > 0) {
      reply = writeExcelFile(filename, sheet_rows);
    } else if (action === 'edit_excel' && filename) {
      reply = await editExcelFile(filename, text);
    } else {
      reply = `Didn't catch a clear command in that. Try "add 7 and 15", "weather in Corona", "note buy milk", "list notes", "make a file called todo.txt that says pick up milk", "draft an email to John about rescheduling Friday", or "make a spreadsheet of my expenses: rent 1200, food 300".`;
    }

    await sendTelegramMessage(chatId, reply);
  } catch (err) {
    console.error('Error handling message:', err);
    await sendTelegramMessage(chatId, `Something broke on my end: ${err.message}`);
  }

  res.status(200).send();
});

app.listen(PORT, () => console.log(`simple-agent listening on port ${PORT}`));