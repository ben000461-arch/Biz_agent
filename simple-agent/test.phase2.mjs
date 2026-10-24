// Phase 2 (part 1) end-to-end: plans decide which model answers a Telegram message.
// FAKE Telegram + FAKE Groq + FAKE Ollama + FAKE Supabase. Nothing real is touched.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const P = { tg: 18701, groq: 18702, ollama: 18703, sb: 18704, app: 18705 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-p2-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const sent = [];       // { chat_id, text }
const groqCalls = [];  // { model, auth, role }
const ollamaCalls = [];
let groqMode = 'ok';   // 'ok' | 'down'
let sbMode = 'ok';     // 'ok' | 'down' (plan lookups fail)
const rows = {};       // chat_id -> tenant_plans row
const patches = [];    // { chat, body }
const posts = [];
const ledger = [];

const roleOf = (system) => (system.includes('You read a short message') ? 'router' : system.includes('helpful, direct assistant') ? 'chat' : 'other');
const answer = (system, who) => (roleOf(system) === 'router' ? { action: 'chat' } : { reply: `hi from ${who}` });

const tg = http.createServer(async (req, res) => {
  const method = req.url.split('/').pop();
  const raw = await readBody(req);
  if (method === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} }));
});
const groq = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req));
  const system = b.messages[0].content;
  groqCalls.push({ model: b.model, auth: req.headers.authorization, role: roleOf(system), json: b.response_format?.type === 'json_object', effort: b.reasoning_effort });
  res.setHeader('content-type', 'application/json');
  if (groqMode === 'down') { res.statusCode = 500; return res.end('{}'); }
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(system, b.model)) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
});
const ollama = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req));
  const system = b.messages[0].content;
  ollamaCalls.push({ role: roleOf(system) });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ message: { content: JSON.stringify(answer(system, 'local')) } }));
});
const sb = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  if (u.pathname.endsWith('/credit_ledger')) { // a small fake ledger, with the one-grant-per-cycle rule
    if (req.method === 'GET') {
      const chat = /eq\.(-?\d+)/.exec(u.search)?.[1]; const cycle = /cycle=eq\.([\d-]+)/.exec(u.search)?.[1];
      return res.end(JSON.stringify(ledger.filter((r) => r.chat_id === chat && r.cycle === cycle)));
    }
    const row = JSON.parse(raw);
    if (row.reason === 'grant' && ledger.some((r) => r.chat_id === row.chat_id && r.cycle === row.cycle && r.reason === 'grant')) { res.statusCode = 409; return res.end('{}'); }
    ledger.push({ ts: new Date().toISOString(), ...row }); res.statusCode = 201; return res.end('[]');
  }
  if (!u.pathname.endsWith('/tenant_plans')) { res.statusCode = 201; return res.end('[]'); } // action log etc.
  const chat = /eq\.(-?\d+)/.exec(u.search)?.[1];
  if (req.method === 'GET') {
    if (sbMode === 'down') { res.statusCode = 500; return res.end('{}'); }
    return res.end(JSON.stringify(rows[chat] ? [rows[chat]] : []));
  }
  if (req.method === 'POST') {
    const row = JSON.parse(raw); posts.push(row);
    if (!rows[row.chat_id]) rows[row.chat_id] = { last_reminder: null, ...row };
    res.statusCode = 201; return res.end(JSON.stringify([rows[row.chat_id]]));
  }
  if (req.method === 'PATCH') {
    const body = JSON.parse(raw); patches.push({ chat, body });
    if (rows[chat]) Object.assign(rows[chat], body);
    res.statusCode = 204; return res.end();
  }
  res.end('[]');
});
for (const [s, p] of [[tg, P.tg], [groq, P.groq], [ollama, P.ollama], [sb, P.sb]]) await new Promise((r) => s.listen(p, r));

// ---- the world: who is registered, and what plan each has ---------------------------------------
const tenant = (id, name) => ({ chatId: String(id), name, createdAt: iso(-40), tools: ['files', 'email', 'spreadsheets', 'utilities', 'calendar', 'github'], instructions: '', schemaVersion: 3 });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: Object.fromEntries([[222, 'Starter Co'], [333, 'Pro Co'], [444, 'Expired Co'], [555, 'Day26 Co'], [666, 'New Co'], [777, 'Offline Co']].map(([id, n]) => [String(id), tenant(id, n)])) }));
rows['222'] = { chat_id: '222', plan: 'starter', ends_at: iso(20), cycle_anchor: iso(-10).slice(0, 10), created_at: iso(-10), last_reminder: null };
rows['333'] = { chat_id: '333', plan: 'pro', ends_at: iso(20), cycle_anchor: iso(-10).slice(0, 10), created_at: iso(-10), last_reminder: null };
rows['444'] = { chat_id: '444', plan: 'trial', ends_at: iso(-10), cycle_anchor: iso(-40).slice(0, 10), created_at: iso(-40), last_reminder: 30 };
rows['555'] = { chat_id: '555', plan: 'trial', ends_at: iso(4), cycle_anchor: iso(-26).slice(0, 10), created_at: iso(-26), last_reminder: null };

const proc = spawn('node', ['server.js'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env, HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
    TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app),
    TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'),
    GROQ_API_KEY: 'gsk_fakekey_do_not_leak', GROQ_API_BASE: `http://127.0.0.1:${P.groq}/openai/v1`,
    SUPABASE_URL: `http://127.0.0.1:${P.sb}`, SUPABASE_SERVICE_KEY: 'sb_secret_test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

let uid = 5000;
async function say(chat, text, { maxMs = 9000, quietMs = 500 } = {}) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' },
    body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }),
  });
  const t0 = Date.now(); let last = Date.now(); let seen = start;
  while (Date.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 50));
    if (sent.length !== seen) { seen = sent.length; last = Date.now(); } else if (seen > start && Date.now() - last > quietMs) break;
  }
  return sent.slice(start).filter((m) => m.chat_id === String(chat)).map((m) => m.text).join('\n---\n');
}
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };
const mark = () => ({ g: groqCalls.length, o: ollamaCalls.length });
const since = (m) => ({ g: groqCalls.slice(m.g), o: ollamaCalls.slice(m.o) });
const SMALL = 'openai/gpt-oss-20b', LARGE = 'openai/gpt-oss-120b';

console.log('\n[startup]');
check('startup line says hosted models are on and plans are on', /Models: hosted on/.test(log) && /Plans: on/.test(log), log.slice(0, 400));

console.log('\n[starter plan: small model for router and chat]');
let m = mark(); let t = await say(222, 'tell me something interesting about volcanoes');
let c = since(m);
check('starter gets an answer from the small hosted model', /hi from openai\/gpt-oss-20b/.test(t), t);
check('every starter call used the small model', c.g.length >= 2 && c.g.every((x) => x.model === SMALL), JSON.stringify(c.g));
check('no local model needed', c.o.length === 0);
check('calls ask for json and low reasoning effort', c.g.every((x) => x.json && x.effort === 'low'));
check('key sent as bearer', c.g.every((x) => x.auth === 'Bearer gsk_fakekey_do_not_leak'));

console.log('\n[pro plan: small router, large chat]');
m = mark(); t = await say(333, 'tell me something interesting about volcanoes');
c = since(m);
check('pro router used the small model', c.g.find((x) => x.role === 'router')?.model === SMALL, JSON.stringify(c.g));
check('pro chat used the large model', c.g.find((x) => x.role === 'chat')?.model === LARGE, JSON.stringify(c.g));
check('pro reply arrived', /hi from openai\/gpt-oss-120b/.test(t), t);

console.log('\n[frozen: trial ended]');
m = mark(); t = await say(444, 'tell me something interesting about volcanoes');
c = since(m);
check('frozen customer gets the fixed paused message', /free trial has ended/.test(t) && /cooptech126@gmail.com/.test(t), t);
check('NO model was called for a frozen customer', c.g.length === 0 && c.o.length === 0, JSON.stringify(c));
t = await say(444, '/connections');
check('frozen customer is blocked from other commands too', /free trial has ended/.test(await say(444, '/code fix something')));
t = await say(444, '/help');
check('but /help still works', t && !/free trial has ended/.test(t), t);

console.log('\n[trial reminder]');
t = await say(555, 'tell me something interesting about volcanoes');
check('day-26 trial gets the reminder once', /Heads up: your free trial ends/.test(t), t);
check('reminder is recorded as day 25', patches.some((p) => p.chat === '555' && p.body.last_reminder === 25), JSON.stringify(patches));
t = await say(555, 'tell me another interesting thing about volcanoes');
check('no second reminder', !/Heads up/.test(t), t);
check('trial still gets a real answer', /hi from/.test(t), t);

console.log('\n[new customer with no plan row]');
m = mark(); t = await say(666, 'tell me something interesting about volcanoes');
check('a free trial row was created for them', posts.some((p) => p.chat_id === '666' && p.plan === 'trial'), JSON.stringify(posts));
check('and they got an answer on the trial (large) model', /hi from openai\/gpt-oss-120b/.test(t), t);

console.log('\n[hosted model down: falls back, customer still answered]');
groqMode = 'down'; m = mark(); t = await say(333, 'tell me one more interesting thing about volcanoes');
c = since(m);
check('pro customer still got an answer', /hi from local/.test(t), t);
check('it came from the local model after hosted tries failed', c.o.length >= 1 && c.g.length >= 3, JSON.stringify(c));
groqMode = 'ok';

console.log('\n[plan lookup down: limited mode, not an outage]');
sbMode = 'down'; m = mark(); t = await say(777, 'tell me something interesting about volcanoes');
c = since(m);
check('customer still answered', /hi from/.test(t) && !/paused|trial has ended/.test(t), t);
check('limited mode only uses the small model (never the large)', c.g.length >= 1 && c.g.every((x) => x.model === SMALL), JSON.stringify(c.g));
sbMode = 'ok';

console.log('\n[admin and model questions]');
m = mark(); t = await say(111, 'what model are you');
check('owner is told the real model for their plan', /openai\/gpt-oss-120b/.test(t) && /not ChatGPT or Claude/.test(t), t);
check('answered by code, no model call', since(m).g.length === 0);
t = await say(222, 'what model are you');
check('a business still gets no model details', /AI assistant set up for Starter Co/.test(t) && !/gpt|llama|oss/i.test(t), t);

console.log('\n[secrets]');
check('the Groq key never appears in the bot log', !log.includes('gsk_fakekey_do_not_leak'));
check('no message text in the llm log lines', !/volcano/i.test(log.split('\n').filter((l) => l.startsWith('[llm]')).join('\n')));

proc.kill();
for (const s of [tg, groq, ollama, sb]) s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
