// Notes survive a restart; each business only sees its own; the owner's files go to workspaces/owner (not the Desktop).
// FAKE Telegram + Ollama. Run: node test.notes.mjs
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createNotes } from './notes.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- unit
console.log('\n[notes store: unit]');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-u-'));
  const f = path.join(dir, 'notes.json');
  const a = createNotes(f);
  check('empty at first', a.list('1').length === 0);
  check('add returns the count', a.add('1', 'one') === 1 && a.add('1', 'two') === 2 && a.add('2', 'other') === 1);
  const b = createNotes(f); // a fresh load = what a restart does
  check('a fresh load sees the saved notes', b.list('1').map((n) => n.text).join() === 'one,two' && b.list('2').length === 1);
  check('the file is private (0600)', (fs.statSync(f).mode & 0o777) === 0o600, (fs.statSync(f).mode & 0o777).toString(8));
  check('remove deletes only that business', b.remove('1') === true && b.list('1').length === 0 && createNotes(f).list('2').length === 1);
  b.add('3', 'x'.repeat(5000));
  check('very long notes are trimmed', b.list('3')[0].text.length === 2000);
  for (let i = 0; i < 520; i++) b.add('4', `n${i}`);
  check('keeps the newest 500', b.list('4').length === 500 && b.list('4')[0].text === 'n20');
  fs.writeFileSync(f, '{not json');
  const c = createNotes(f);
  check('a damaged file is kept aside, not overwritten', c.list('2').length === 0 && fs.readdirSync(dir).some((x) => x.startsWith('notes.json.unreadable-')));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- the real server
const P = { tg: 18941, ollama: 18942, app: 18943 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const json = (res, body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

const sent = [];
const tg = http.createServer(async (req, res) => {
  const method = req.url.split('/').pop(); const raw = await readBody(req);
  if (method === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
  json(res, method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} });
});
const ollama = http.createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  const system = body.messages[0].content;
  const user = body.messages[body.messages.length - 1].content;
  let out;
  if (system.includes('You are a helpful, direct assistant')) out = { reply: 'Hello there.' };
  else if (/^note /i.test(user)) out = { action: 'add_note', note: user.slice(5) };
  else if (/list notes/i.test(user)) out = { action: 'list_notes' };
  else if (/spreadsheet of/i.test(user)) out = { action: 'write_excel', filename: 'expenses', sheet_rows: [['Item', 'Cost'], ['Rent', 1200]] };
  else out = { action: 'chat' };
  json(res, { message: { content: JSON.stringify(out) } });
});
await new Promise((r) => tg.listen(P.tg, r));
await new Promise((r) => ollama.listen(P.ollama, r));

const tenantsFile = path.join(tmp, 'data', 'tenants.json');
const ws = path.join(tmp, 'ws');
let proc = null;
async function start() {
  proc = spawn('node', ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', GROQ_API_KEY: '', HOME: home, OWNER_WORKSPACE: '',
      TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
      TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app),
      TENANTS_FILE: tenantsFile, WORKSPACES_DIR: ws, CONNECTIONS_FILE: path.join(tmp, 'conn.json'),
      AGENT_TICK_MS: '600000', EVENT_POLL_MS: '600000', SIGNUP_POLL_MS: '600000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) return; } catch {} await wait(100); }
  throw new Error('server did not start');
}
async function stop() { if (!proc) return; const p = proc; proc = null; p.kill('SIGTERM'); await new Promise((r) => { p.once('exit', r); setTimeout(r, 3000); }); }
let uid = 1;
async function say(chat, text, { quietMs = 600, maxMs = 10000 } = {}) {
  const start0 = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  const t0 = Date.now(); let last = Date.now(), seen = start0;
  while (Date.now() - t0 < maxMs) { await wait(50); if (sent.length !== seen) { seen = sent.length; last = Date.now(); } else if (seen > start0 && Date.now() - last > quietMs) break; }
  return sent.slice(start0).filter((m) => m.chat_id === String(chat)).map((m) => m.text).join('\n---\n');
}

try {
  await start();
  console.log('\n[notes survive a restart]');
  let t = await say(111, 'note call the Hendersons about the quote');
  if (/\(yes\/no\)|Sound good|yes or no/i.test(t)) t = await say(111, 'yes');
  check('note saved', /saved/i.test(t), t);
  const inv = /start=(\w+)/.exec(await say(111, '/invite Paint Co'))?.[1];
  await say(222, `/start ${inv}`);
  t = await say(222, 'note order more primer');
  if (/\(yes\/no\)|Sound good|yes or no/i.test(t)) t = await say(222, 'yes');
  check('a business saves its own note', /saved/i.test(t), t);

  await stop();
  await start();
  t = await say(111, 'list notes');
  check('after a restart, the owner\'s note is still there', /call the Hendersons about the quote/.test(t), t);
  check('...and only the owner\'s', !/primer/.test(t), t);
  t = await say(222, 'list notes');
  check('the business sees only its own note after the restart', /order more primer/.test(t) && !/Hendersons/.test(t), t);
  check('notes are kept next to tenants.json (so backups of data/ include them)', fs.existsSync(path.join(tmp, 'data', 'notes.json')));

  console.log('\n[owner workspace]');
  t = await say(111, 'make a spreadsheet of my expenses');
  if (/\(yes\/no\)|Sound good|yes or no/i.test(t)) t = await say(111, 'yes');
  check('the owner\'s file goes to workspaces/owner', fs.existsSync(path.join(ws, 'owner', 'expenses.xlsx')), t);
  check('...not onto the real Desktop', !fs.existsSync(path.join(home, 'Desktop', 'expenses.xlsx')));
  check('the reply never says "Desktop"', !/Desktop/.test(t), t);

  console.log('\n[removing a business removes its notes]');
  await say(111, '/remove 222');
  await wait(300);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'notes.json'), 'utf8'));
  check('their notes are gone, the owner\'s stay', !saved['222'] && Array.isArray(saved['111']) && saved['111'].length === 1, JSON.stringify(Object.keys(saved)));
} finally {
  await stop();
  tg.close(); ollama.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
