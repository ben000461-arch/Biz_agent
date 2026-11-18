// End-to-end test with a FAKE Telegram and a FAKE Ollama. Not shipped — only
// used to check tenant isolation, invites, confirmations and queueing work.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import XLSX from 'xlsx';

const ports = { tg: 18601, ollama: 18602, app: 18603 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const desktop = path.join(tmp, 'home', 'Desktop');
const wsRoot = path.join(tmp, 'ws');
const tenantsFile = path.join(tmp, 'data', 'tenants.json');

// ---- fake Telegram ---------------------------------------------------------
const sent = []; // { method, chat_id, text?, filename? }
const tgServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const raw = Buffer.concat(chunks).toString('latin1');
    if (method === 'sendMessage') {
      const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sent.push({ method, chat_id: String(b.chat_id), text: b.text });
    } else if (method === 'sendDocument') {
      const chat = /name="chat_id"\r\n\r\n(\d+)/.exec(raw)?.[1];
      const filename = /filename="([^"]+)"/.exec(raw)?.[1];
      sent.push({ method, chat_id: chat, filename });
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} }));
  });
});

// ---- fake Ollama -----------------------------------------------------------
const ollamaServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const system = body.messages[0].content;
    const user = body.messages[body.messages.length - 1].content;
    let out;
    if (system.includes('You are a helpful, direct assistant')) {
      out = { reply: /how are you/i.test(user) ? "I'm doing well! Thanks for asking. Here is a third sentence. And a fourth one." : 'Hello there.' };
    } else if (system.startsWith('You are given the current contents')) {
      const rows = JSON.parse(/Current table:\n(.*)\n\nRequested change:/s.exec(user)[1]);
      if (/oranges/i.test(user)) rows.push(['Oranges', 40, 0.75]);
      out = { rows };
    } else if (/^add \d+ and \d+/.test(user)) {
      const [, a, b] = /add (\d+) and (\d+)/.exec(user);
      out = { action: 'add', a: +a, b: +b };
    } else if (/oranges/i.test(user)) out = { action: 'edit_excel', filename: 'inventory' };
    else if (/inventory/i.test(user)) out = { action: 'view_excel', filename: 'inventory' };
    else if (/spreadsheet of/i.test(user)) out = { action: 'write_excel', filename: 'expenses', sheet_rows: [['Item', 'Cost'], ['Rent', 1200], ['Food', 300]] };
    else if (/draft an email/i.test(user)) out = { action: 'draft_email', recipient: 'John', email_subject: 'Friday', email_body: 'Can we move Friday?' };
    else if (/^note /i.test(user)) out = { action: 'add_note', note: user.slice(5) };
    else if (/list notes/i.test(user)) out = { action: 'list_notes' };
    else out = { action: 'chat' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify(out) } }));
  });
});

await new Promise((r) => tgServer.listen(ports.tg, r));
await new Promise((r) => ollamaServer.listen(ports.ollama, r));

// ---- the app under test ----------------------------------------------------
function startApp() {
  const proc = spawn('node', ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', GROQ_API_KEY: '', // tests never touch your real Supabase or Groq
      HOME: path.join(tmp, 'home'), OWNER_WORKSPACE: 'desktop',
      TELEGRAM_BOT_TOKEN: 'TESTTOKEN',
      ADMIN_TELEGRAM_ID: '111',
      TELEGRAM_WEBHOOK_SECRET: 'sekret',
      TELEGRAM_API_BASE: `http://127.0.0.1:${ports.tg}`,
      OLLAMA_HOST: `http://127.0.0.1:${ports.ollama}`,
      PORT: String(ports.app),
      TENANTS_FILE: tenantsFile,
      WORKSPACES_DIR: wsRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  return { proc, getLog: () => log };
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`http://127.0.0.1:${ports.app}/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('app did not start');
}

let updateId = 1000;
async function post(chat, text, from = chat, headers = { 'x-telegram-bot-api-secret-token': 'sekret' }) {
  return fetch(`http://127.0.0.1:${ports.app}/telegram-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ update_id: ++updateId, message: { chat: { id: chat }, from: { id: from, username: `u${from}` }, text } }),
  });
}

// Send one message, wait until the bot has been quiet for a moment, and
// return everything it sent in response.
async function say(chat, text, { from = chat, quietMs = 350, maxMs = 4000 } = {}) {
  const startLen = sent.length;
  await post(chat, text, from);
  const t0 = Date.now();
  let last = Date.now();
  let seen = startLen;
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (sent.length !== seen) { seen = sent.length; last = Date.now(); }
    else if (seen > startLen && Date.now() - last > quietMs) break;
  }
  return sent.slice(startLen);
}
const texts = (msgs) => msgs.filter((m) => m.method === 'sendMessage').map((m) => m.text).join('\n---\n');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); }
}

// Admin's pre-existing spreadsheet on the Desktop.
{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Item', 'Qty', 'Price'], ['Apples', 50, 0.5], ['Bread', 20, 3]]), 'Sheet1');
  XLSX.writeFile(wb, path.join(desktop, 'inventory.xlsx'));
}

let { proc, getLog } = startApp();
await waitUp();

console.log('\n[webhook secret]');
{
  const bad = await post(111, 'hi', 111, { 'x-telegram-bot-api-secret-token': 'wrong' });
  const none = await post(111, 'hi', 111, {});
  check('wrong secret rejected with 401', bad.status === 401);
  check('missing secret rejected with 401', none.status === 401);
  check('no reply was sent for rejected requests', sent.length === 0);
}

console.log('\n[admin basics]');
let m = await say(111, 'add 7 and 15');
for (const q of ["What's the website link", 'website link', 'dashboard', 'where do i log in', 'what is the login url']) {
  const w = await say(111, q);
  check(`site question "${q}" -> real link`, /ben000461-arch\.github\.io\/coop-agent-legal\/login\.html/.test(texts(w)), texts(w));
}
const w2 = await say(111, 'what is the best website for hiking');
check('unrelated "website" question is not hijacked', !/login\.html/.test(texts(w2)), texts(w2));
check('admin math works', texts(m) === '7 + 15 = 22', texts(m));
m = await say(111, 'what does my inventory look like');
check('admin sees own Desktop inventory (fuzzy match)', /Apples \| 50 \| 0.5/.test(texts(m)), texts(m));

console.log('\n[invites + registration]');
m = await say(111, '/invite Smith Law');
const link = /https:\/\/t\.me\/TestBot\?start=([a-f0-9]{10})/.exec(texts(m));
check('/invite returns a t.me link with a code', !!link, texts(m));
const code = link?.[1];

m = await say(222, 'hello there');
check('stranger gets invite-only message', /invite-only/.test(texts(m)), texts(m));
m = await say(222, '/start nonsense');
check('bad invite code rejected', /isn't valid/.test(texts(m)), texts(m));
m = await say(222, `/start ${code}`, { maxMs: 4000 });
check('valid code registers the business', /Hi Smith Law/.test(texts(m)), texts(m));
check('admin notified of the sign-up', sent.some((x) => x.chat_id === '111' && /Smith Law just signed up/.test(x.text || '')));
m = await say(333, `/start ${code}`);
check('invite is single-use', /isn't valid/.test(texts(m)), texts(m));
check('tenants.json persisted the business', JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['222']?.name === 'Smith Law');
m = await say(222, '/invite Evil Corp');
check('non-admin cannot /invite', /isn't available/.test(texts(m)), texts(m));

console.log('\n[isolation]');
m = await say(222, 'what does my inventory look like');
check("business can't see the admin's Desktop spreadsheet", /don't have any spreadsheets/.test(texts(m)), texts(m));
await say(111, 'note buy milk');
m = await say(222, 'list notes');
check("business doesn't see the admin's notes", /don't have any notes/.test(texts(m)), texts(m));

console.log('\n[confirm-before-write + file delivery]');
m = await say(222, 'make a spreadsheet of my expenses: rent 1200, food 300');
check('write_excel asks before creating', /Sound good\?/.test(texts(m)) && !fs.existsSync(path.join(wsRoot, '222', 'expenses.xlsx')), texts(m));
m = await say(222, 'yes');
check('yes creates the file in THEIR workspace', fs.existsSync(path.join(wsRoot, '222', 'expenses.xlsx')));
check("file is NOT on the admin's Desktop", !fs.existsSync(path.join(desktop, 'expenses.xlsx')));
check('file is sent back as a Telegram attachment', m.some((x) => x.method === 'sendDocument' && x.chat_id === '222' && x.filename === 'expenses.xlsx'), JSON.stringify(m));

m = await say(222, 'make a spreadsheet of my expenses: rent 1200, food 300');
check('overwrite warning shown when file exists', /already exists and will be replaced/.test(texts(m)), texts(m));
m = await say(222, 'no');
check('"no" cancels', /scrapped/.test(texts(m)), texts(m));

m = await say(222, 'show inventory');
check("asking for the admin's file name gives a clean not-found listing only THEIR files", /couldn't find a spreadsheet matching "inventory"\. You've got: expenses\.xlsx/.test(texts(m)), texts(m));

console.log('\n[edit flow with fuzzy name + queueing]');
// fire the edit and the "yes" back-to-back with no waiting — the per-chat
// queue must run them in order.
const before = sent.length;
await post(111, 'add oranges to inventory, quantity 40, price 0.75');
await post(111, 'yes');
for (let i = 0; i < 60 && sent.length < before + 2; i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 300));
const seq = sent.slice(before).map((x) => x.text || x.method);
check('edit asked first, then applied (in order)', /Here's what I'll change/.test(seq[0] || '') && /Updated "inventory.xlsx"/.test(seq[1] || ''), JSON.stringify(seq));
{
  const wb = XLSX.readFile(path.join(desktop, 'inventory.xlsx'));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
  check('Oranges row actually written to the admin file', rows.some((r) => r[0] === 'Oranges'), JSON.stringify(rows));
}

console.log('\n[email, chat, caps]');
m = await say(222, 'draft an email to John about Friday');
check('email draft is shown in chat', /Subject: Friday/.test(texts(m)) && /Nothing was sent/.test(texts(m)), texts(m));
m = await say(222, 'how are you');
check('chat reply capped at two sentences', texts(m) === "I'm doing well! Thanks for asking.", texts(m));

console.log('\n[tools gating + instructions]');
m = await say(111, '/tools 222 files,email');
check('/tools updates a business', /Tools for 222: files, email/.test(texts(m)), texts(m));
m = await say(222, 'make a spreadsheet of my expenses: rent 1200, food 300');
check('disabled tool group is refused', /isn't switched on/.test(texts(m)), texts(m));
m = await say(222, '/instructions We are a family law firm. Keep it formal.');
check('/instructions saves notes', /Saved/.test(texts(m)), texts(m));
check('instructions persisted', JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['222'].instructions.includes('family law'));
m = await say(111, '/businesses');
check('/businesses lists them', /Smith Law — chat 222/.test(texts(m)), texts(m));

console.log('\n[restart + remove]');
proc.kill();
await new Promise((r) => setTimeout(r, 300));
({ proc, getLog } = startApp());
await waitUp();
m = await say(222, 'hello');
check('business still registered after restart', !/invite-only/.test(texts(m)) && /Hello there/.test(texts(m)), texts(m));
m = await say(111, '/remove 222');
check('/remove works and keeps their files', /Removed/.test(texts(m)) && fs.existsSync(path.join(wsRoot, '222', 'expenses.xlsx')), texts(m));
m = await say(222, 'hello again');
check('removed business is locked out', /invite-only/.test(texts(m)), texts(m));
m = await say(111, '/remove 111');
check('admin cannot be removed', /can't be removed/.test(texts(m)), texts(m));

proc.kill();
tgServer.close();
ollamaServer.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\n--- server log ---\n' + getLog());
process.exit(fail ? 1 : 0);
