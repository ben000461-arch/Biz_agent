// simple-agent (multi-tenant) — ONE shared Telegram bot, MANY businesses.
//
// message in -> figure out which business sent it -> local LLM decides what's
// being asked -> a real action happens inside THAT business's own workspace
// -> reply goes back to them.
//
// How businesses get on the bot (no BotFather, no tokens for them):
//   1. You (the admin) text the bot:  /invite Smith Law
//   2. It hands back a one-time link. You send that link to the business.
//   3. They tap it, Telegram opens the bot and sends "/start <code>", and
//      they're registered. From then on the bot recognizes their chat.
//
// Isolation: every business gets its own workspace folder, its own notes and
// its own pending confirmations. One business can never see another's files.
// The admin's own workspace is the Desktop, so nothing from earlier versions
// changes for you.
//
// Everything that writes or overwrites data still asks yes/no first.
// The LLM only decides WHAT is being asked — real code does the work.
//
// Runs on a LOCAL model (Ollama, llama3.2:3b). Needs `ollama serve` running.

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import XLSX from 'xlsx';
import { createStore, ALL_TOOL_GROUPS } from './tenants.js';
import { createVault } from './vault.js';
import { createGoogle, NeedsReconnect } from './google.js';
import { createGitHub, readPrivateKey } from './github.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ALLOWED_USER_ID, // old name — still works as the admin ID
  ADMIN_TELEGRAM_ID = TELEGRAM_ALLOWED_USER_ID,
  TELEGRAM_WEBHOOK_SECRET,
  TELEGRAM_API_BASE = 'https://api.telegram.org',
  OLLAMA_HOST = 'http://127.0.0.1:11434',
  OLLAMA_MODEL = 'llama3.2:3b',
  TENANTS_FILE,
  WORKSPACES_DIR,
  PORT = 3000,
  // Connections (optional — the bot works without them)
  PUBLIC_URL,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  TOKEN_ENCRYPTION_KEY,
  CONNECTIONS_FILE,
  GITHUB_APP_ID,
  GITHUB_APP_SLUG,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_APP_PRIVATE_KEY_PATH,
  GOOGLE_AUTH_BASE, GOOGLE_TOKEN_URL, GOOGLE_REVOKE_URL, GMAIL_API_BASE, CALENDAR_API_BASE, GITHUB_API_BASE, GITHUB_WEB_BASE, // test overrides
} = process.env;

if (!TELEGRAM_BOT_TOKEN) {
  console.error('Missing required environment variable: TELEGRAM_BOT_TOKEN. Check .env.example.');
  process.exit(1);
}

const TG = `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}`;
const ADMIN_ID = (ADMIN_TELEGRAM_ID || '').trim();

const store = createStore(TENANTS_FILE || path.join(__dirname, 'data', 'tenants.json'));
const workspacesRoot = WORKSPACES_DIR || path.join(__dirname, 'workspaces');

if (ADMIN_ID) {
  store.ensure(ADMIN_ID, { name: 'Admin', isAdmin: true });
} else {
  console.warn('ADMIN_TELEGRAM_ID is not set yet — message the bot once, copy the ID that gets logged below, and add it to .env. Until then nobody can use the bot.');
}
if (!TELEGRAM_WEBHOOK_SECRET) {
  console.warn('TELEGRAM_WEBHOOK_SECRET is not set — anyone who finds your public URL could fake messages (including as you). Set it in .env and re-run setWebhook with secret_token.');
}

// Connections (Google, GitHub). They share one encrypted token vault, which
// needs TOKEN_ENCRYPTION_KEY and PUBLIC_URL. Each provider then needs its own
// settings; if some are missing, that provider is simply off and the rest of
// the bot still runs.
let vault = null;
let google = null;
let github = null;
if (TOKEN_ENCRYPTION_KEY || PUBLIC_URL) {
  if (TOKEN_ENCRYPTION_KEY && PUBLIC_URL) {
    try {
      vault = createVault(CONNECTIONS_FILE || path.join(__dirname, 'data', 'connections.json'), TOKEN_ENCRYPTION_KEY);
    } catch (err) {
      console.error(`Connections disabled: ${err.message}`);
    }
  } else {
    console.warn('Connections disabled: set both PUBLIC_URL and TOKEN_ENCRYPTION_KEY in .env to turn them on.');
  }
}
if (vault) {
  if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
    google = createGoogle({
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      publicUrl: PUBLIC_URL,
      vault,
      bases: { auth: GOOGLE_AUTH_BASE, token: GOOGLE_TOKEN_URL, revoke: GOOGLE_REVOKE_URL, gmail: GMAIL_API_BASE, calendar: CALENDAR_API_BASE },
    });
  } else {
    console.warn('Google connection off: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env to turn it on.');
  }
  if (GITHUB_APP_ID || GITHUB_APP_SLUG || GITHUB_CLIENT_ID || GITHUB_CLIENT_SECRET || GITHUB_APP_PRIVATE_KEY_PATH) {
    if (GITHUB_APP_ID && GITHUB_APP_SLUG && GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET && GITHUB_APP_PRIVATE_KEY_PATH) {
      try {
        github = createGitHub({
          appId: GITHUB_APP_ID,
          slug: GITHUB_APP_SLUG,
          clientId: GITHUB_CLIENT_ID,
          clientSecret: GITHUB_CLIENT_SECRET,
          privateKey: readPrivateKey(GITHUB_APP_PRIVATE_KEY_PATH),
          publicUrl: PUBLIC_URL,
          vault,
          bases: { api: GITHUB_API_BASE, web: GITHUB_WEB_BASE },
        });
      } catch (err) {
        console.error(`GitHub connection off: ${err.message}`);
      }
    } else {
      console.warn('GitHub connection off: set GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and GITHUB_APP_PRIVATE_KEY_PATH in .env to turn it on.');
    }
  }
}

const app = express();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const CONFIRM_WORDS = ['yes', 'y', 'yeah', 'yep', 'confirm', 'do it', 'go ahead', 'sure', 'correct', 'ok', 'okay'];
const CANCEL_WORDS = ['no', 'n', 'nope', 'cancel', 'stop', 'nevermind', 'never mind', "don't", 'dont'];
const isConfirmation = (t) => CONFIRM_WORDS.includes(t.trim().toLowerCase());
const isCancellation = (t) => CANCEL_WORDS.includes(t.trim().toLowerCase());

// The small local model occasionally double-escapes unicode (an apostrophe
// shows up as the literal text ’), so every outgoing message is cleaned.
function fixStrayUnicodeEscapes(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// Keep at most the first two sentences of a chat reply — the small model
// doesn't always obey the length rule in the prompt.
function trimChatReply(reply) {
  const sentences = reply.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [reply];
  return sentences.slice(0, 2).join('').trim();
}

// A safe filename: no folders, no odd characters, never "." or "..".
function safeFileName(name, fallback) {
  const base = path.basename(String(name || '')).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!base || base === '.' || base === '..') return fallback;
  return base;
}
function withExtension(name, ext) {
  return name.toLowerCase().endsWith(ext) ? name : `${name}${ext}`;
}

// Models sometimes hand back rows that aren't arrays. Force a clean 2D table.
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 500).map((r) => (Array.isArray(r) ? r : [r == null ? '' : String(r)]));
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function sendTelegramMessage(chatId, text) {
  let clean = fixStrayUnicodeEscapes(String(text));
  if (clean.length > 4000) clean = `${clean.slice(0, 3990)}\n…(trimmed)`; // Telegram caps messages at 4096
  const res = await fetch(`${TG}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: clean }),
  });
  if (!res.ok) console.error(`Telegram sendMessage failed: ${res.status} ${await res.text()}`);
}

async function sendTelegramDocument(chatId, filePath, caption) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  const res = await fetch(`${TG}/sendDocument`, { method: 'POST', body: form });
  if (!res.ok) console.error(`Telegram sendDocument failed: ${res.status} ${await res.text()}`);
}

// Needed to build the invite link. Non-fatal: without it, /invite just hands
// back the raw code instead of a link.
async function getBotUsername() {
  try {
    const res = await fetch(`${TG}/getMe`, { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    return data?.result?.username || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local model
// ---------------------------------------------------------------------------

async function callLocalModel(systemPrompt, userText) {
  let res;
  try {
    res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(90_000), // never let a hung model block a chat forever
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userText },
        ],
        format: 'json',
        stream: false,
        options: { temperature: 0 },
      }),
    });
  } catch (err) {
    throw new Error(`Couldn't reach the local model (${err.name}) — is "ollama serve" running?`);
  }
  if (!res.ok) {
    throw new Error(`Ollama API error: ${res.status} ${await res.text()} — is "ollama serve" running?`);
  }
  const data = await res.json();
  return JSON.parse(data.message.content);
}

// ---------------------------------------------------------------------------
// Per-business workspace + tools
// ---------------------------------------------------------------------------

const desktopDir = () => path.join(os.homedir(), 'Desktop');

// Where a business's files live. The admin keeps using the Desktop (so
// everything you've already built still works); everyone else gets a private
// folder named after their chat ID.
function workspaceFor(tenant) {
  const dir = tenant.isAdmin ? desktopDir() : path.join(workspacesRoot, String(tenant.chatId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const where = (tenant) => (tenant.isAdmin ? 'your Desktop' : 'your workspace');

const notesByTenant = new Map();

function addNote(tenant, text) {
  const notes = notesByTenant.get(tenant.chatId) || [];
  notes.push({ text, at: new Date().toISOString() });
  notesByTenant.set(tenant.chatId, notes);
  return `Got it, saved 👍 That's ${notes.length} note${notes.length === 1 ? '' : 's'} total now.`;
}

function listNotes(tenant) {
  const notes = notesByTenant.get(tenant.chatId) || [];
  if (notes.length === 0) return "You don't have any notes saved yet.";
  return notes.map((n, i) => `${i + 1}. ${n.text}`).join('\n');
}

async function getWeather(location) {
  const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`);
  if (!geoRes.ok) throw new Error(`Geocoding API error: ${geoRes.status}`);
  const geoData = await geoRes.json();
  const place = geoData.results?.[0];
  if (!place) return `Hmm, I couldn't find a place called "${location}" — mind double-checking the spelling?`;

  const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current_weather=true`);
  if (!weatherRes.ok) throw new Error(`Weather API error: ${weatherRes.status}`);
  const weatherData = await weatherRes.json();
  const current = weatherData.current_weather;
  if (!current) return `Found ${location}, but couldn't pull current weather for it right now.`;

  return `${place.name}${place.admin1 ? `, ${place.admin1}` : ''} is at ${current.temperature}°C right now, winds around ${current.windspeed} km/h.`;
}

function writeTextFile(tenant, filename, content) {
  const ws = workspaceFor(tenant);
  const safeName = safeFileName(filename, 'note-from-agent.txt');
  const fullPath = path.join(ws, safeName);
  fs.writeFileSync(fullPath, content, 'utf8');
  return { text: `Done — "${safeName}" is saved in ${where(tenant)}.`, file: fullPath };
}

function draftEmail(tenant, recipient, subject, body) {
  const ws = workspaceFor(tenant);
  const safeName = `email-draft-${Date.now()}.txt`;
  fs.writeFileSync(path.join(ws, safeName), `To: ${recipient || '(not specified)'}\nSubject: ${subject}\n\n${body}`, 'utf8');
  return {
    text: `Here's your draft:\n\nTo: ${recipient || '(not specified)'}\nSubject: ${subject}\n\n${body}\n\n— Nothing was sent. A copy is saved as "${safeName}" in ${where(tenant)}.`,
  };
}

function writeExcelFile(tenant, filename, rows) {
  const ws = workspaceFor(tenant);
  const safeName = withExtension(safeFileName(filename, 'data.xlsx'), '.xlsx');
  const fullPath = path.join(ws, safeName);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  XLSX.writeFile(book, fullPath);
  return {
    text: `All set — "${safeName}" is ready with ${rows.length} row${rows.length === 1 ? '' : 's'}.`,
    file: fullPath,
  };
}

// Spreadsheets in a workspace. Skips Excel's "~$name.xlsx" lock files (they
// appear while a file is open and would make names look ambiguous).
function listExcelFiles(tenant) {
  try {
    return fs.readdirSync(workspaceFor(tenant)).filter(
      (f) => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$') && !f.startsWith('.'),
    );
  } catch {
    return [];
  }
}

// Lets people say "inventory" instead of "inventory.xlsx" — matches against
// what's actually in THEIR workspace and nobody else's.
function resolveExcelFilename(tenant, hint) {
  const files = listExcelFiles(tenant);
  if (files.length === 0) return { error: `You don't have any spreadsheets in ${where(tenant)} yet.` };

  const normalize = (s) => s.toLowerCase().replace(/\.xlsx$/, '').replace(/[^a-z0-9]/g, '');
  const target = normalize(hint || '');

  let matches = files.filter((f) => normalize(f) === target);
  if (matches.length === 1) return { filename: matches[0] };

  matches = target ? files.filter((f) => normalize(f).includes(target) || target.includes(normalize(f))) : [];
  if (matches.length === 1) return { filename: matches[0] };
  if (matches.length > 1) return { error: `A few spreadsheets match "${hint}" — which one did you mean? ${matches.join(', ')}` };

  return { error: `I couldn't find a spreadsheet matching "${hint}". You've got: ${files.join(', ')}` };
}

function readExcelFile(tenant, filename) {
  const safeName = safeFileName(filename, '');
  const fullPath = path.join(workspaceFor(tenant), safeName);
  if (!safeName || !fs.existsSync(fullPath)) {
    return { error: `I can't find "${safeName || filename}" in ${where(tenant)} — is the name right?` };
  }
  const book = XLSX.readFile(fullPath);
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  return { safeName, fullPath, rows };
}

function formatRowsAsText(rows) {
  if (!rows || rows.length === 0) return '(empty)';
  const shown = rows.slice(0, 60).map((row) => row.join(' | '));
  if (rows.length > 60) shown.push(`…and ${rows.length - 60} more rows`);
  return shown.join('\n');
}

async function editExcelWithLLM(currentRows, instruction) {
  const systemPrompt = `You are given the current contents of a spreadsheet as a JSON array of rows (the first row is the header). Apply the requested change and return the FULL updated table — every existing row that should remain, plus any additions or edits requested. Keep everything not mentioned in the request unchanged. Respond ONLY with valid JSON: {"rows": [[...], [...], ...]}`;
  const parsed = await callLocalModel(systemPrompt, `Current table:\n${JSON.stringify(currentRows)}\n\nRequested change:\n${instruction}`);
  const rows = normalizeRows(parsed.rows);
  if (rows.length === 0) throw new Error('Model did not return a usable table');
  return rows;
}

function applyExcelEdit(fullPath, updatedRows) {
  const sheet = XLSX.utils.aoa_to_sheet(updatedRows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
  XLSX.writeFile(book, fullPath);
}

// A short before/after summary so the confirmation says what's changing.
function summarizeExcelDiff(oldRows, newRows) {
  const toKey = (row) => JSON.stringify(row);
  const oldKeys = new Set(oldRows.map(toKey));
  const newKeys = new Set(newRows.map(toKey));
  const added = newRows.filter((r) => !oldKeys.has(toKey(r)));
  const removed = oldRows.filter((r) => !newKeys.has(toKey(r)));

  const lines = [];
  if (added.length) lines.push(`Add: ${added.map((r) => r.join(' / ')).join('; ')}`);
  if (removed.length) lines.push(`Remove/replace: ${removed.map((r) => r.join(' / ')).join('; ')}`);
  if (!lines.length) lines.push('No visible row changes detected (might just be reordering).');
  return lines.join('\n');
}

// Saves the draft in the owner's Gmail when connected (never sends); otherwise,
// or if Gmail can't be reached, falls back to the local text copy.
async function draftEmailAction(tenant, recipient, subject, body) {
  if (!google || !google.isConnected(tenant.chatId)) {
    const local = draftEmail(tenant, recipient, subject, body);
    return google ? { text: `${local.text}\n\nTip: send /connect to save drafts straight into your Gmail.` } : local;
  }
  try {
    const to = /@/.test(recipient || '') ? recipient : '';
    await google.createDraft(tenant.chatId, { to, subject, body });
    const nameNote = recipient && !to ? `\n(I didn't have an email address for "${recipient}", so add it before sending.)` : '';
    return { text: `Saved to your Gmail drafts — nothing was sent.\n\nTo: ${recipient || '(not specified)'}\nSubject: ${subject}\n\n${body}${nameNote}` };
  } catch (err) {
    const local = draftEmail(tenant, recipient, subject, body);
    const why = err instanceof NeedsReconnect ? 'Your Google connection has expired — send /connect to reconnect.' : "I couldn't reach Gmail just now, so I only saved it here.";
    return { text: `${local.text}\n\n${why}` };
  }
}

async function calendarSummary(tenant, when) {
  if (!google) return "Calendar isn't set up on this server yet.";
  if (!google.isConnected(tenant.chatId)) return "Your calendar isn't connected yet — send /connect to link your Google account.";
  const w = ['today', 'tomorrow', 'week'].includes(when) ? when : 'today';
  let events;
  try {
    events = await google.listEvents(tenant.chatId, w);
  } catch (err) {
    if (err instanceof NeedsReconnect) return 'Your Google connection has expired — send /connect to reconnect.';
    throw err;
  }
  const label = { today: 'the rest of today', tomorrow: 'tomorrow', week: 'the next 7 days' }[w];
  if (!events.length) return `Nothing on your calendar for ${label}.`;
  const fmt = (e) => {
    const d = new Date(e.start);
    if (e.allDay) return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })} (all day)`;
    return d.toLocaleString('en-US', { ...(w === 'week' ? { weekday: 'short' } : {}), hour: 'numeric', minute: '2-digit' });
  };
  return `Your calendar for ${label}:\n${events.map((e) => `• ${fmt(e)} — ${e.title}`).join('\n')}`;
}

// Runs only after the owner said yes.
async function doDisconnect(tenant, provider) {
  if (provider === 'google' && google?.isConnected(tenant.chatId)) {
    await google.disconnect(tenant.chatId);
    return 'Disconnected — I no longer have access to your Google account.';
  }
  if (provider === 'github' && github?.isConnected(tenant.chatId)) {
    await github.disconnect(tenant.chatId);
    return 'Disconnected — I removed the GitHub app from your account, so I can no longer see any projects.';
  }
  return 'That was already disconnected.';
}

// ---- GitHub (read-only) ----
const ago = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const clip = (t, n = 90) => (String(t).length > n ? `${String(t).slice(0, n - 1)}…` : String(t));

async function githubReply(tenant, action, repoHint) {
  if (!github) return "GitHub isn't set up on this server yet.";
  if (!github.isConnected(tenant.chatId)) return "GitHub isn't connected yet — send /connect github to link it.";
  try {
    if (action === 'list_repos') {
      const list = await github.repos(tenant.chatId);
      if (!list.length) return "I'm connected, but you haven't given me any projects yet. In GitHub: Settings → Applications → Installed GitHub Apps → Configure, then pick repositories.";
      return `Projects I can see:\n${list.map((r) => `• ${r.full}${r.private ? ' 🔒' : ''}`).join('\n')}`;
    }
    if (action === 'list_prs') {
      const r = await github.openPulls(tenant.chatId, repoHint);
      if (r.error) return r.error;
      if (!r.pulls.length) return `No open pull requests in ${r.repo}.`;
      return `Open pull requests in ${r.repo}:\n${r.pulls.map((p) => `• #${p.number} ${clip(p.title)}${p.draft ? ' (draft)' : ''} — ${p.user}, ${ago(p.updatedAt)}`).join('\n')}`;
    }
    const r = await github.buildStatus(tenant.chatId, repoHint);
    if (r.error) return r.error;
    if (!r.runs.length) return `No builds have run in ${r.repo} yet.`;
    const icon = (w) => (w.status !== 'completed' ? '⏳ running' : w.conclusion === 'success' ? '✅ passed' : w.conclusion === 'failure' ? '❌ failed' : `⚪ ${w.conclusion || w.status}`);
    return `Latest builds in ${r.repo}:\n${r.runs.map((w) => `• ${clip(w.name, 40)} — ${icon(w)} (${w.branch}, ${ago(w.at)})`).join('\n')}`;
  } catch (err) {
    if (err instanceof NeedsReconnect) return 'The GitHub connection is gone (the app may have been uninstalled) — send /connect github to reconnect.';
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Understanding the message
// ---------------------------------------------------------------------------

// Each action belongs to a tool group a business can have switched on or off.
// "chat" is deliberately not listed — talking is always allowed.
const ACTION_GROUP = {
  add: 'utilities', multiply: 'utilities', weather: 'utilities', add_note: 'utilities', list_notes: 'utilities',
  write_file: 'files',
  draft_email: 'email',
  write_excel: 'spreadsheets', view_excel: 'spreadsheets', edit_excel: 'spreadsheets',
  list_events: 'calendar',
  list_repos: 'github', list_prs: 'github', build_status: 'github',
};

async function interpretCommand(tenant, text) {
  const context = tenant.isAdmin
    ? ''
    : `You are the assistant for a business called "${tenant.name}".${tenant.instructions ? ` The owner gave you these notes about their business and how they like you to talk: ${tenant.instructions}` : ''}\n`;

  // GitHub actions only appear for businesses that connected it, so everyone
  // else keeps the shorter prompt (small models route better with fewer options).
  const gh = Boolean(github?.isConnected(tenant.chatId) && tenant.tools.includes('github'));
  const ghLines = gh
    ? `- "list_repos": the message asks which projects/repos/repositories you can see.
- "list_prs": the message asks about open pull requests (PRs). Extract "repo" (the project name they mention, or null).
- "build_status": the message asks if the build/tests/CI are passing or failing. Extract "repo" (or null).
`
    : '';

  const systemPrompt = `${context}You read a short message and decide which of these actions it's requesting:
- "add": add two numbers. Extract "a" and "b".
- "multiply": multiply two numbers. Extract "a" and "b".
- "weather": look up current weather somewhere. Extract "location" (a city/place name).
- "add_note": remember something for later, ONLY when no file/document/spreadsheet is mentioned. Extract "note" (the text to save).
- "list_notes": show all saved notes. No extra fields needed.
- "write_file": use this whenever the message mentions a .txt file or a plain text document to create — NOT a spreadsheet. Extract "filename" (invent a short one ending in .txt if none is given) and "file_content" (the text to put in it).
- "draft_email": the message asks to draft/write an email. Write a real, well-written "email_subject" and "email_body" yourself based on what's asked (professional tone, appropriate length). Extract "recipient" too if a name/email is mentioned, otherwise null.
- "write_excel": the message asks to CREATE a brand-new spreadsheet from scratch (no existing file mentioned). Build "sheet_rows" as a 2D array of arrays (each inner array is one row of cells, include a header row as the first row if it makes sense) representing the data described. Extract "filename" (invent one ending in .xlsx if none given).
- "view_excel": the message asks to SEE, SHOW, LIST, or CHECK the contents of an existing spreadsheet, with NO change being requested — "what's in my inventory", "show me the budget sheet", "what does X look like". Extract "filename" as whatever name/hint they used — it does NOT need to be exact or include an extension (e.g. just "inventory" is fine), a matching step handles the rest.
- "edit_excel": the message asks to CHANGE, UPDATE, or ADD TO an EXISTING spreadsheet — this includes "add X to [filename]" style requests, where X is a new row/item being added to an existing file. Extract "filename" as whatever name/hint they used — it does NOT need to be exact or include an extension.
- "list_events": the message asks what's on their calendar, schedule, or meetings. Extract "when": "today", "tomorrow", or "week" (default "today").
${ghLines}- "chat": anything else — a greeting, small talk, a question about you, opinions, or a request you can't do with the actions above. Use "chat" whenever nothing else clearly fits. No other fields needed.
Rule: if a filename ending in ".xlsx" (or the message otherwise clearly refers to an existing spreadsheet) appears anywhere in the message, ALWAYS choose "edit_excel", never "write_file" and never "write_excel".
Rule: if the word "file" appears with a ".txt" name, or a plain text document is described with no spreadsheet mentioned, choose "write_file", never "add_note".
Respond ONLY with valid JSON: {"action": "add"|"multiply"|"weather"|"add_note"|"list_notes"|"write_file"|"draft_email"|"write_excel"|"view_excel"|"edit_excel"|"list_events"${gh ? '|"list_repos"|"list_prs"|"build_status"' : ''}|"chat", "a": number|null, "b": number|null, "location": string|null, "note": string|null, "filename": string|null, "file_content": string|null, "recipient": string|null, "email_subject": string|null, "email_body": string|null, "sheet_rows": array|null, "when": string|null${gh ? ', "repo": string|null' : ''}}`;

  return callLocalModel(systemPrompt, text);
}


// A separate, small prompt just for conversation. Splitting this from routing
// keeps the router prompt short, which the 3B model needs to stay reliable.
async function chatReply(tenant, userText) {
  const about = tenant.isAdmin
    ? ''
    : ` You work for a business called "${tenant.name}".${tenant.instructions ? ` Owner's notes: ${tenant.instructions}` : ''}`;
  const systemPrompt = `You are a friendly, concise assistant that people text on their phone.${about}
Reply in ONE short sentence (two at most, under 25 words), like a real person texting back. No lists, no paragraphs, no tutorials. When it fits, end with a short question.
You can only do these things: draft emails, create and update spreadsheets, save text files, check their calendar${github?.isConnected(tenant.chatId) ? ', and look at their GitHub projects (open pull requests, build status)' : ''}. If asked for something else (writing code, browsing the internet, calling someone), say plainly you can't do that here and mention what you can help with.
If they bring up coding or dev work, don't teach anything — offer to talk it through and ask what they want to build.
Respond ONLY with valid JSON: {"reply": "<your reply>"}`;
  try {
    const out = await callLocalModel(systemPrompt, userText);
    const r = typeof out?.reply === 'string' ? out.reply.trim() : '';
    return r ? trimChatReply(r) : null;
  } catch (err) {
    console.error('chatReply failed:', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Doing the work
// ---------------------------------------------------------------------------

// Returns { text, file? }. `file`, when present, is sent back as a Telegram
// attachment so a business can actually open what was made.
async function executeAction(tenant, action, args) {
  const { a, b, location, note, filename, file_content, recipient, email_subject, email_body, sheet_rows, when, repo } = args;

  if (action === 'add' && a != null && b != null) return { text: `${a} + ${b} = ${a + b}` };
  if (action === 'multiply' && a != null && b != null) return { text: `${a} x ${b} = ${a * b}` };
  if (action === 'weather' && location) return { text: await getWeather(location) };
  if (action === 'add_note' && note) return { text: addNote(tenant, note) };
  if (action === 'list_notes') return { text: listNotes(tenant) };
  if (action === 'disconnect') return { text: await doDisconnect(tenant, args.provider) };
  if (action === 'list_events') return { text: await calendarSummary(tenant, when) };
  if (['list_repos', 'list_prs', 'build_status'].includes(action)) return { text: await githubReply(tenant, action, repo) };
  if (action === 'draft_email' && email_subject && email_body) return draftEmailAction(tenant, recipient, email_subject, email_body);
  if (action === 'write_file' && file_content) return writeTextFile(tenant, filename, file_content);
  if (action === 'write_excel' && sheet_rows?.length > 0) return writeExcelFile(tenant, filename, sheet_rows);

  if (action === 'view_excel' && filename) {
    const resolved = resolveExcelFilename(tenant, filename);
    if (resolved.error) return { text: resolved.error };
    const found = readExcelFile(tenant, resolved.filename);
    if (found.error) return { text: found.error };
    return { text: `Here's what's in "${found.safeName}":\n\n${formatRowsAsText(found.rows)}` };
  }

  if (action === 'edit_excel' && filename) {
    // Only runs after the person said yes; `filename` was already resolved
    // to a real file and `updatedRows` computed when we asked them.
    const found = readExcelFile(tenant, filename);
    if (found.error) return { text: found.error };
    applyExcelEdit(found.fullPath, args.updatedRows);
    return {
      text: `Updated "${found.safeName}" — it's now ${args.updatedRows.length} rows (was ${found.rows.length}).`,
      file: found.fullPath,
    };
  }

  // Anything that isn't a real tool action (greetings, small talk, things we
  // can't do) goes to a second, focused model call just for talking.
  const chatted = await chatReply(tenant, args.userText || '');
  if (chatted) return { text: chatted };

  return { text: `Not sure I caught that — could you say it a different way? I can help with things like drafting an email, creating or updating a spreadsheet, or saving a text file.` };
}

// Actions that write to disk / could overwrite real data ask first.
const NEEDS_CONFIRMATION = new Set(['write_file', 'write_excel', 'edit_excel']);

async function buildConfirmationPrompt(tenant, action, args) {
  const ws = workspaceFor(tenant);
  if (action === 'write_file') {
    const name = safeFileName(args.filename, 'note-from-agent.txt');
    const clash = fs.existsSync(path.join(ws, name)) ? `\n⚠️ A file with that name already exists and will be replaced.` : '';
    return `I'll create "${name}" in ${where(tenant)} with this content:\n\n"${args.file_content}"${clash}\n\nSound good? (yes/no)`;
  }
  if (action === 'write_excel') {
    const name = withExtension(safeFileName(args.filename, 'data.xlsx'), '.xlsx');
    const clash = fs.existsSync(path.join(ws, name)) ? `\n⚠️ A file with that name already exists and will be replaced.` : '';
    const preview = args.sheet_rows.map((r) => r.join(' / ')).join('\n');
    return `I'll create "${name}" in ${where(tenant)} with:\n\n${preview}${clash}\n\nSound good? (yes/no)`;
  }
  if (action === 'edit_excel') {
    const found = readExcelFile(tenant, args.filename);
    if (found.error) return found.error;
    const updatedRows = await editExcelWithLLM(found.rows, args.instruction);
    args.updatedRows = updatedRows; // stash so confirming doesn't redo the model call
    return `Here's what I'll change in "${found.safeName}":\n\n${summarizeExcelDiff(found.rows, updatedRows)}\n\nGo ahead? (yes/no)`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Commands (/start, /help, /instructions, and admin-only ones)
// ---------------------------------------------------------------------------

function helpText(tenant) {
  const has = (g) => tenant.tools.includes(g);
  const lines = ["Here's what I can do:"];
  if (has('email')) lines.push('• Draft emails — "draft an email to John about Friday"');
  if (has('spreadsheets')) lines.push('• Spreadsheets — "make a spreadsheet of my expenses", "show my inventory", "add oranges to inventory"');
  if (has('files')) lines.push('• Text files — "make a file called todo.txt that says pick up milk"');
  if (has('calendar') && google) lines.push('• Calendar — "what\'s on my calendar today?"');
  if (lines.length === 1) return "Nothing is switched on for your account yet — ask the person who set you up.";
  lines.push("I'll always check with you before changing a file.");
  if (github?.isConnected(tenant.chatId) && has('github')) lines.push('• GitHub — "what pull requests are open?", "is the build passing?"');
  if (google || github) lines.push("Send /connect to link your accounts, and /connections to see what's linked.");
  return lines.join('\n');
}

const INVITE_ONLY_MSG = "Hi! This assistant is invite-only right now. If you've been given an invite link, tap it to get started.";

let botUsername = null;

async function handleCommand({ chatId, text, isAdmin }) {
  const [rawCmd] = text.split(/\s+/);
  const cmd = rawCmd.split('@')[0].toLowerCase();
  const arg = text.slice(rawCmd.length).trim();
  const tenant = store.get(chatId);

  const adminOnly = new Set(['/invite', '/businesses', '/remove', '/tools']);
  if (adminOnly.has(cmd) && !isAdmin) {
    await sendTelegramMessage(chatId, "That command isn't available.");
    return true;
  }

  switch (cmd) {
    case '/start': {
      if (tenant) {
        await sendTelegramMessage(chatId, `Welcome back${tenant.isAdmin ? '' : `, ${tenant.name}`}! ${helpText(tenant)}`);
        return true;
      }
      if (!arg) {
        await sendTelegramMessage(chatId, INVITE_ONLY_MSG);
        return true;
      }
      const result = store.redeemInvite(arg, chatId);
      if (result.error) {
        await sendTelegramMessage(chatId, "That invite link isn't valid anymore — ask for a fresh one.");
        return true;
      }
      const t = result.tenant;
      workspaceFor(t); // create their folder now
      await sendTelegramMessage(chatId, `Hi ${t.name}! You're all set. Just text me what you need.\n\n${helpText(t)}`);
      if (ADMIN_ID && String(chatId) !== ADMIN_ID) {
        await sendTelegramMessage(ADMIN_ID, `✅ ${t.name} just signed up (chat ${t.chatId}).`);
      }
      return true;
    }

    case '/help': {
      await sendTelegramMessage(chatId, tenant ? helpText(tenant) : INVITE_ONLY_MSG);
      return true;
    }

    case '/instructions': {
      if (!tenant) {
        await sendTelegramMessage(chatId, INVITE_ONLY_MSG);
        return true;
      }
      if (!arg) {
        await sendTelegramMessage(chatId, tenant.instructions
          ? `Your current notes for me:\n\n${tenant.instructions}\n\n(Change them with /instructions <text>, or /instructions clear.)`
          : 'I have no special notes yet. Tell me about your business and how you like me to talk: /instructions <text>');
        return true;
      }
      if (arg.toLowerCase() === 'clear') {
        store.setInstructions(chatId, '');
        await sendTelegramMessage(chatId, 'Cleared.');
        return true;
      }
      store.setInstructions(chatId, arg.slice(0, 500));
      await sendTelegramMessage(chatId, arg.length > 500 ? 'Saved (trimmed to 500 characters).' : 'Saved — I\'ll keep that in mind.');
      return true;
    }

    case '/connect': {
      if (!tenant) { await sendTelegramMessage(chatId, INVITE_ONLY_MSG); return true; }
      if (!google && !github) { await sendTelegramMessage(chatId, "Connections aren't set up on this server yet."); return true; }
      const want = arg.toLowerCase();
      if (want && want !== 'google' && want !== 'github') {
        await sendTelegramMessage(chatId, `I can connect: ${[google && 'google', github && 'github'].filter(Boolean).join(', ')}. Try /connect google or /connect github.`);
        return true;
      }
      const parts = [];
      if (google && (!want || want === 'google')) {
        parts.push(`Google (Gmail + Calendar) — I can only save email drafts and read your calendar, and I never send email on my own. Google's screen words the Gmail permission as "manage drafts and send emails"; that is the narrowest it offers.\n${google.startSignIn(chatId)}`);
      }
      if (github && (!want || want === 'github')) {
        parts.push(`GitHub — you choose exactly which projects I can see on the next screen; pick only the ones you want. For now I only look (open pull requests, build status) and change nothing, though GitHub's screen will say read and write.\n${github.startInstall(chatId)}`);
      }
      if (!parts.length) { await sendTelegramMessage(chatId, `${want === 'github' ? 'GitHub' : 'Google'} isn't set up on this server yet.`); return true; }
      await sendTelegramMessage(chatId, `Tap to connect (links work for 10 minutes):\n\n${parts.join('\n\n')}`);
      return true;
    }

    case '/connections': {
      if (!tenant) { await sendTelegramMessage(chatId, INVITE_ONLY_MSG); return true; }
      if (!vault) { await sendTelegramMessage(chatId, "Connections aren't set up on this server yet."); return true; }
      const conns = vault.status(chatId);
      const g = conns.find((c) => c.provider === 'google');
      const h = conns.find((c) => c.provider === 'github');
      const lines = [];
      if (google) lines.push(g ? `Google: connected${g.email ? ` as ${g.email}` : ''} (Gmail drafts + Calendar)` : 'Google: not connected — /connect google');
      if (github) lines.push(h ? `GitHub: connected${h.label ? ` as ${h.label}` : ''} (the projects you picked — change them in GitHub → Settings → Applications)` : 'GitHub: not connected — /connect github');
      lines.push('Disconnect with /disconnect google or /disconnect github.');
      await sendTelegramMessage(chatId, lines.join('\n'));
      return true;
    }

    case '/disconnect':
    case '/disconnect_google':
    case '/disconnect_github': {
      if (!tenant) { await sendTelegramMessage(chatId, INVITE_ONLY_MSG); return true; }
      const have = [google?.isConnected(chatId) && 'google', github?.isConnected(chatId) && 'github'].filter(Boolean);
      if (!have.length) { await sendTelegramMessage(chatId, 'Nothing is connected right now.'); return true; }

      let target = cmd === '/disconnect_google' ? 'google' : cmd === '/disconnect_github' ? 'github' : arg.toLowerCase();
      if (!target) {
        if (have.length === 1) {
          target = have[0];
        } else {
          const info = Object.fromEntries(vault.status(chatId).map((c) => [c.provider, c.email || c.label]));
          const names = { google: 'Google', github: 'GitHub' };
          await sendTelegramMessage(chatId, `Which one do you want to disconnect? Tap one:\n${have.map((p) => `/disconnect_${p} — ${names[p]}${info[p] ? ` (${info[p]})` : ''}`).join('\n')}`);
          return true;
        }
      }
      if (!['google', 'github'].includes(target)) {
        await sendTelegramMessage(chatId, `I can disconnect: ${have.join(', ')}. Try /disconnect_${have[0]}.`);
        return true;
      }
      if (!have.includes(target)) {
        await sendTelegramMessage(chatId, `${target === 'google' ? 'Google' : 'GitHub'} isn't connected.`);
        return true;
      }
      // Disconnecting changes things, so it asks first like everything else.
      pendingActions.set(String(chatId), { action: 'disconnect', args: { provider: target }, createdAt: Date.now() });
      await sendTelegramMessage(chatId, target === 'google'
        ? "Disconnect Google? I'll lose access to your Gmail drafts and calendar. You can reconnect any time with /connect google.\n\nGo ahead? (yes/no)"
        : "Disconnect GitHub? I'll remove the GitHub app from your account, so I won't see any projects. To use it again you'd install it and pick your projects again.\n\nGo ahead? (yes/no)");
      return true;
    }

    case '/invite': {
      const name = arg.replace(/[\x00-\x1f]/g, ' ').trim().slice(0, 60);
      if (!name) {
        await sendTelegramMessage(chatId, 'Usage: /invite <business name>');
        return true;
      }
      const code = store.createInvite(name);
      const link = botUsername ? `https://t.me/${botUsername}?start=${code}` : `(no bot username yet) have them send: /start ${code}`;
      await sendTelegramMessage(chatId, `Invite for ${name} (one use, expires in 7 days):\n\n${link}`);
      return true;
    }

    case '/businesses': {
      const rows = store.list().filter((t) => !t.isAdmin);
      await sendTelegramMessage(chatId, rows.length
        ? rows.map((t) => `• ${t.name} — chat ${t.chatId} — tools: ${t.tools.join(', ') || 'none'}`).join('\n')
        : 'No businesses yet. Use /invite <name> to add one.');
      return true;
    }

    case '/remove': {
      if (!arg) {
        await sendTelegramMessage(chatId, 'Usage: /remove <chatId>  (see /businesses)');
        return true;
      }
      const ok = store.remove(arg);
      if (ok) {
        if (google) await google.disconnect(arg);
        if (github) await github.disconnect(arg);
        pendingActions.delete(String(arg));
        notesByTenant.delete(String(arg));
      }
      await sendTelegramMessage(chatId, ok
        ? `Removed. Their files are still on disk in workspaces/${arg} — nothing was deleted.`
        : "Couldn't find that business (and the admin can't be removed).");
      return true;
    }

    case '/tools': {
      const [id, list] = arg.split(/\s+/);
      if (!id || !list) {
        await sendTelegramMessage(chatId, `Usage: /tools <chatId> <${ALL_TOOL_GROUPS.join(',')}|all|none>`);
        return true;
      }
      let groups;
      if (list === 'all') groups = [...ALL_TOOL_GROUPS];
      else if (list === 'none') groups = [];
      else groups = list.split(',').map((g) => g.trim());
      const bad = groups.filter((g) => !ALL_TOOL_GROUPS.includes(g));
      if (bad.length) {
        await sendTelegramMessage(chatId, `Unknown tool group: ${bad.join(', ')}. Options: ${ALL_TOOL_GROUPS.join(', ')}`);
        return true;
      }
      const ok = store.setTools(id, groups);
      await sendTelegramMessage(chatId, ok ? `Tools for ${id}: ${groups.join(', ') || 'none'}` : "Couldn't find that business.");
      return true;
    }

    default:
      return false; // not one of ours — treat as a normal message
  }
}

// ---------------------------------------------------------------------------
// Handling one incoming message
// ---------------------------------------------------------------------------

const pendingActions = new Map(); // chatId -> { action, args, createdAt }
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

const strangerRepliedAt = new Map();
const STRANGER_COOLDOWN_MS = 10 * 60 * 1000;

async function handleStranger(chatId, message) {
  console.warn(`Ignored message from unregistered chat ${chatId} (user id ${message.from?.id}, @${message.from?.username || 'no username'})`);
  if (!ADMIN_ID) return; // still in "discover my ID" mode — stay quiet
  const last = strangerRepliedAt.get(chatId) || 0;
  if (Date.now() - last < STRANGER_COOLDOWN_MS) return;
  strangerRepliedAt.set(chatId, Date.now());
  await sendTelegramMessage(chatId, INVITE_ONLY_MSG);
}

async function deliver(chatId, tenant, result) {
  await sendTelegramMessage(chatId, result.text);
  // Businesses can't open a folder on this computer, so send them the file.
  if (result.file && !tenant.isAdmin) await sendTelegramDocument(chatId, result.file);
}

async function handleMessage(message) {
  const chatId = message.chat.id;
  const key = String(chatId);
  const fromId = message.from?.id;
  const text = (message.text || '').trim();
  if (!text) return;

  const isAdmin = Boolean(ADMIN_ID) && String(fromId) === ADMIN_ID;

  if (text.startsWith('/') && (await handleCommand({ chatId, text, isAdmin }))) return;

  const tenant = store.get(chatId);
  if (!tenant) return handleStranger(chatId, message);

  try {
    // A yes/no for something we asked about earlier?
    const pending = pendingActions.get(key);
    if (pending && Date.now() - pending.createdAt < PENDING_TIMEOUT_MS) {
      if (isConfirmation(text)) {
        pendingActions.delete(key);
        return await deliver(chatId, tenant, await executeAction(tenant, pending.action, pending.args));
      }
      if (isCancellation(text)) {
        pendingActions.delete(key);
        return await sendTelegramMessage(chatId, 'No problem, scrapped that — nothing was changed.');
      }
      pendingActions.delete(key); // something else entirely: drop it, treat as new
    } else if (pending) {
      pendingActions.delete(key); // expired
    }

    const parsed = await interpretCommand(tenant, text);
    const { action } = parsed;
    parsed.userText = text;
    // Small models sometimes write the word "null"/"none" instead of a real null.
    for (const k of ['repo', 'when', 'recipient', 'filename', 'location']) {
      if (typeof parsed[k] === 'string' && /^(null|none|n\/a|undefined|nil|)$/i.test(parsed[k].trim())) parsed[k] = null;
    }
    parsed.sheet_rows = parsed.sheet_rows == null ? null : normalizeRows(parsed.sheet_rows);

    // Is this tool switched on for this business?
    const group = ACTION_GROUP[action];
    if (group && !tenant.tools.includes(group)) {
      return await sendTelegramMessage(chatId, "That isn't switched on for your account. Ask the person who set you up if you'd like it added.");
    }

    if (NEEDS_CONFIRMATION.has(action)) {
      const hasEnoughInfo =
        (action === 'write_file' && parsed.file_content) ||
        (action === 'write_excel' && parsed.sheet_rows?.length > 0) ||
        (action === 'edit_excel' && parsed.filename);

      if (hasEnoughInfo) {
        if (action === 'edit_excel') {
          const resolved = resolveExcelFilename(tenant, parsed.filename);
          if (resolved.error) return await sendTelegramMessage(chatId, resolved.error);
          parsed.filename = resolved.filename; // now a real, exact filename
        }
        const args = { ...parsed, instruction: text };
        const confirmationMsg = await buildConfirmationPrompt(tenant, action, args);
        if (confirmationMsg) {
          // edit_excel returns a plain error string when the file can't be
          // read — only keep a pending action when there's something to confirm.
          if (action !== 'edit_excel' || args.updatedRows) {
            pendingActions.set(key, { action, args, createdAt: Date.now() });
          }
          return await sendTelegramMessage(chatId, confirmationMsg);
        }
      }
    }

    await deliver(chatId, tenant, await executeAction(tenant, action, parsed));
  } catch (err) {
    console.error(`Error handling message from chat ${chatId}:`, err);
    pendingActions.delete(key);
    // Admin sees the real error; businesses get a calm generic one (the real
    // error can include file paths from this computer).
    await sendTelegramMessage(chatId, tenant.isAdmin
      ? `Ran into a snag on my end: ${err.message}`
      : 'Something went wrong on my end — please try again in a moment.');
  }
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

// One message at a time per chat. Without this, two quick messages (an edit,
// then "yes") could race each other and one would overwrite the other.
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.catch(() => {}).then(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
  return next;
}

// Telegram retries an update if we're slow to answer — ignore repeats.
const seenUpdates = new Set();
function alreadySeen(id) {
  if (id == null) return false;
  if (seenUpdates.has(id)) return true;
  seenUpdates.add(id);
  if (seenUpdates.size > 500) seenUpdates.delete(seenUpdates.values().next().value);
  return false;
}

function secretOk(req) {
  if (!TELEGRAM_WEBHOOK_SECRET) return true;
  const got = Buffer.from(req.get('x-telegram-bot-api-secret-token') || '');
  const want = Buffer.from(TELEGRAM_WEBHOOK_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// Where Google sends people back after they approve. The `state` value ties
// the visit to the chat that asked for the link.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, msg) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:system-ui;max-width:420px;margin:15vh auto;padding:0 20px;text-align:center"><h2>${esc(title)}</h2><p>${esc(msg)}</p></body>`;

app.get('/oauth/google/callback', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (!google) return res.status(404).send(page('Not available', 'Connections are not set up on this server.'));
  const { code, state, error } = req.query;
  if (error || typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).send(page('Not connected', 'The sign-in was cancelled. Go back to Telegram and send /connect to try again.'));
  }
  try {
    const { chatId, email } = await google.finishSignIn(state, code);
    res.send(page('Connected ✓', 'You can close this tab and go back to Telegram.'));
    await sendTelegramMessage(chatId, `Google connected${email ? ` as ${email}` : ''} ✅ I can now save email drafts to your Gmail and check your calendar. Try: "what's on my calendar today?"`);
  } catch (err) {
    console.error('Google sign-in failed:', err.message);
    res.status(400).send(page('Not connected', err.message));
  }
});

app.get('/oauth/github/callback', async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (!github) return res.status(404).send(page('Not available', 'GitHub is not set up on this server.'));
  const { code, state, installation_id: installationId, setup_action: setupAction, error } = req.query;
  // The owner changed which projects are shared: nothing for us to do.
  if (!error && setupAction === 'update' && typeof state !== 'string') {
    return res.send(page('Updated ✓', 'Your GitHub project choices are saved. You can close this tab.'));
  }
  if (error || typeof code !== 'string' || typeof state !== 'string') {
    return res.status(400).send(page('Not connected', 'The GitHub connection was cancelled. Go back to Telegram and send /connect github to try again.'));
  }
  try {
    const { chatId, account } = await github.finishInstall(state, code, typeof installationId === 'string' ? installationId : '');
    res.send(page('Connected ✓', 'You can close this tab and go back to Telegram.'));
    await sendTelegramMessage(chatId, `GitHub connected${account ? ` as ${account}` : ''} ✅ I can see the projects you picked. Try: "what pull requests are open?" or "is the build passing?" You can change which projects I see any time in GitHub → Settings → Applications.`);
  } catch (err) {
    console.error('GitHub connect failed:', err.message);
    res.status(400).send(page('Not connected', err.message));
  }
});

app.post('/telegram-webhook', express.json(), (req, res) => {
  if (!secretOk(req)) return res.status(401).send();
  res.status(200).send(); // answer Telegram right away; do the work in the queue

  const update = req.body || {};
  if (alreadySeen(update.update_id)) return;
  const message = update.message;
  if (!message?.chat) return;

  // Timing log, so a slow reply can be traced to its cause: "Telegram lag" is
  // how long Telegram took to deliver the message to us, "queue" is time spent
  // waiting behind this chat's earlier messages, "handled" is our own work
  // (model call included). Only commands are named — message text is never
  // logged, since it belongs to the business.
  const receivedAt = Date.now();
  const label = (message.text || '').startsWith('/') ? message.text.split(/\s+/)[0] : 'message';
  enqueue(String(message.chat.id), async () => {
    const startedAt = Date.now();
    try {
      await handleMessage(message);
    } finally {
      const lag = message.date ? Math.max(0, Math.round(receivedAt / 1000 - message.date)) : '?';
      console.log(`[chat ${message.chat.id}] ${label}: Telegram lag ${lag}s, queued ${startedAt - receivedAt}ms, handled in ${Date.now() - startedAt}ms`);
    }
  }).catch((err) => {
    console.error('Unhandled error in message queue:', err);
  });
});

// The "/" menu in Telegram. Only everyday commands; admin ones still work but stay unlisted.
async function setBotCommands() {
  try {
    await fetch(`${TG}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: [
        { command: 'help', description: 'What I can do' },
        { command: 'connect', description: 'Link Google or GitHub' },
        { command: 'connections', description: 'See what is linked' },
        { command: 'disconnect', description: 'Unlink an account' },
        { command: 'instructions', description: 'Tell me about your business' },
      ] }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* cosmetic */ }
}

botUsername = await getBotUsername();
await setBotCommands();
app.listen(PORT, () => {
  console.log(`simple-agent listening on port ${PORT} (local model: ${OLLAMA_MODEL}, ${store.list().length} registered chat(s), google: ${google ? 'on' : 'off'}, github: ${github ? 'on' : 'off'}, bot: ${botUsername ? `@${botUsername}` : 'username unknown'})`);
});