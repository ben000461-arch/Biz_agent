// Credit meter end-to-end: spending, limits, warnings, top-ups, /usage, /plan, /topup.
// FAKE Telegram + FAKE Groq + FAKE Ollama + FAKE Supabase. Nothing real is touched.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const P = { tg: 18711, groq: 18712, ollama: 18713, sb: 18714, app: 18715 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-p2-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const DAY = 86400000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const sent = [];       // { chat_id, text }
const groqCalls = [];  // { model, auth, role }
const ollamaCalls = [];
let groqMode = 'ok';   // 'ok' | 'down'
let ledgerDown = false;
let sbMode = 'ok';     // 'ok' | 'down' (plan lookups fail)
const rows = {};       // chat_id -> tenant_plans row
const patches = [];    // { chat, body }
const posts = [];
const ledger = [];

const roleOf = (system) => (system.includes('You read a short message') ? 'router' : system.includes('helpful, direct assistant') ? 'chat' : 'other');
const answer = (system, who, user = '') => (roleOf(system) === 'router' && /notes\.txt/.test(user) ? { action: 'write_file', filename: 'notes.txt', file_content: 'hello' } : answerBase(system, who));
const answerBase = (system, who) => (roleOf(system) === 'router' ? { action: 'chat' } : { reply: `hi from ${who}` });

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
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(system, b.model, b.messages.at(-1).content)) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }));
});
const ollama = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req));
  const system = b.messages[0].content;
  ollamaCalls.push({ role: roleOf(system) });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ message: { content: JSON.stringify(answer(system, 'local', b.messages.at(-1).content)) } }));
});
const sb = http.createServer(async (req, res) => {
  const raw = await readBody(req);
  res.setHeader('content-type', 'application/json');
  const u = new URL(req.url, 'http://x');
  if (u.pathname.endsWith('/credit_ledger') && ledgerDown) { res.statusCode = 500; return res.end('{}'); }
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
    if (!rows[row.chat_id]) rows[row.chat_id] = { last_reminder: null, ...row }; else if (/merge-duplicates/.test(req.headers.prefer || '')) Object.assign(rows[row.chat_id], row);
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
fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: Object.fromEntries([[222, 'Starter Co'], [333, 'Pro Co'], [444, 'Almost80 Co'], [555, 'Empty Co'], [666, 'Trial Co'], [777, 'Daily Co'], [888, 'Outage Co'], [999, 'Burst Co']].map(([id, n]) => [String(id), tenant(id, n)])) }));
const CYCLE = iso(-10).slice(0, 10);
const plan = (id, p, extra = {}) => { rows[String(id)] = { chat_id: String(id), plan: p, ends_at: iso(20), cycle_anchor: CYCLE, created_at: iso(-10), last_reminder: null, ...extra }; };
plan(222, 'starter'); plan(333, 'pro'); plan(444, 'pro'); plan(555, 'pro'); plan(777, 'pro'); plan(888, 'pro');
plan(666, 'trial', { ends_at: iso(20), created_at: iso(-10) }); plan(999, 'trial', { ends_at: iso(20), created_at: iso(-10) });
const led = (id, delta, reason, daysAgo = 0) => ledger.push({ ts: iso(-daysAgo), chat_id: String(id), cycle: CYCLE, delta, reason, action: null, model: null, ref: null });
led(444, 3500, 'grant', 5); led(444, -2795, 'spend', 1);          // 5 credits away from 80%
led(555, 3500, 'grant', 5); led(555, -3499, 'spend', 1);          // 1 credit left
led(777, 3500, 'grant', 5); led(777, -871, 'spend', 0);           // 4 credits under today's ceiling of 875

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

const rowsFor = (id, reason) => ledger.filter((r) => r.chat_id === String(id) && r.cycle === CYCLE && (!reason || r.reason === reason));
const balance = (id) => rowsFor(id).reduce((n, r) => n + r.delta, 0);
const fileAsk = 'make me a text file called notes.txt that says hello';

console.log('\n[pro: the first message creates the monthly grant, a large chat costs 2]');
let t = await say(333, 'tell me something interesting about volcanoes');
check('a monthly grant of 3,500 was created, once', rowsFor(333, 'grant').length === 1 && rowsFor(333, 'grant')[0].delta === 3500, JSON.stringify(rowsFor(333)));
check('the large chat cost 2 credits and is labelled with the real model', rowsFor(333, 'spend').length === 1 && rowsFor(333, 'spend')[0].delta === -2 && rowsFor(333, 'spend')[0].model === LARGE && rowsFor(333, 'spend')[0].action === 'chat', JSON.stringify(rowsFor(333, 'spend')));
check('they got their answer', /hi from openai\/gpt-oss-120b/.test(t), t);

console.log('\n[an action costs 5, charged only after it is done]');
t = await say(333, fileAsk);
check('asked for a yes first, nothing charged yet', /yes/i.test(t) && rowsFor(333, 'spend').filter((r) => r.action === 'write_file').length === 0, t);
t = await say(333, 'yes');
const fileSpend = rowsFor(333, 'spend').filter((r) => r.action === 'write_file');
check('after the yes, exactly 5 credits were charged', fileSpend.length === 1 && fileSpend[0].delta === -5, JSON.stringify(fileSpend));
check('balance is 3500 - 2 - 5', balance(333) === 3493, String(balance(333)));

console.log('\n[starter: small chat is free, no ledger spend]');
let m = mark(); t = await say(222, 'tell me something interesting about volcanoes');
check('starter answered on the small model', /hi from openai\/gpt-oss-20b/.test(t), t);
check('but nothing was charged (grant only)', rowsFor(222, 'spend').length === 0 && rowsFor(222, 'grant')[0]?.delta === 1000, JSON.stringify(rowsFor(222)));

console.log('\n[80% warning: sent once, after the answer]');
t = await say(444, fileAsk);
t = await say(444, 'yes', { quietMs: 900 });
check('the action was done', /Saved|saved|notes\.txt/i.test(t), t);
check('and an 80% heads-up followed', /used 80% of this month's credits/.test(t) && /700 left/.test(t), t);
check('the 80% line comes AFTER the answer', t.indexOf('notes.txt') < t.indexOf('Heads up'), t);
t = await say(444, fileAsk); t = await say(444, 'yes', { quietMs: 900 });
check('no second warning for the next action', !/Heads up/.test(t) && rowsFor(444, 'spend').filter((r) => r.action === 'write_file').length === 2, t);

console.log('\n[out of credits: chat falls to the small model, actions pause]');
m = mark(); t = await say(555, 'tell me something interesting about volcanoes');
check('chat still answers, on the small model, never the large', /hi from openai\/gpt-oss-20b/.test(t) && since(m).g.every((x) => x.model === SMALL), t + JSON.stringify(since(m).g));
check('and that chat cost nothing', rowsFor(555, 'spend').length === 1, JSON.stringify(rowsFor(555, 'spend')));
t = await say(555, fileAsk); t = await say(555, 'yes');
check('the action is paused with a clear message', /used all of this month's credits/.test(t) && /cooptech126@gmail.com/.test(t), t);
check('no credits were taken for the blocked action', rowsFor(555, 'spend').length === 1);

console.log("\n[daily ceiling]");
t = await say(777, fileAsk); t = await say(777, 'yes');
check('an action past the daily ceiling is stopped', /today's usage limit/.test(t), t);
m = mark(); t = await say(777, 'tell me something interesting about volcanoes');
check('but a large chat that still fits goes ahead', /hi from openai\/gpt-oss-120b/.test(t), t);

console.log('\n[unmetered trial: nothing in the ledger]');
t = await say(666, 'tell me something interesting about volcanoes');
check('trial answered and the ledger has nothing for them', /hi from/.test(t) && rowsFor(666).length === 0, JSON.stringify(rowsFor(666)));

console.log('\n[ledger down: customer still answered, cheap model only]');
ledgerDown = true; m = mark(); t = await say(888, 'tell me something interesting about volcanoes');
check('answered on the small model while the ledger is unreachable', /hi from openai\/gpt-oss-20b/.test(t) && since(m).g.every((x) => x.model === SMALL), t);
ledgerDown = false;

console.log('\n[per-minute limit]');
const burst = 14;
const before = sent.length;
for (let i = 0; i < burst; i++) await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: 999 }, from: { id: 999 }, text: 'ok' } }) });
await new Promise((r) => setTimeout(r, 2500));
const notices = sent.slice(before).filter((x) => x.chat_id === '999' && /very quickly/.test(x.text));
check('a burst gets exactly one slow-down notice', notices.length === 1, `got ${notices.length}`);

console.log('\n[/usage]');
t = await say(333, '/usage');
check('shows plan, credits used and the daily limit', /Plan: Pro/.test(t) && /of 3,500 used/.test(t) && /of 875 daily limit/.test(t) && /Resets on/.test(t), t);
t = await say(666, '/usage');
check('trial /usage says it is not credit-based', /Free trial/.test(t) && /isn't measured in credits/.test(t), t);

console.log('\n[/plan]');
t = await say(333, '/plan 222 pro');
check('a business cannot use /plan', /isn't available/.test(t), t);
t = await say(111, '/plan 222');
check('/plan <id> shows the plan', /Starter Co: Starter \(active\)/.test(t), t);
t = await say(111, '/plan 222 bogus');
check('unknown plan is refused', /don't know the plan "bogus"/.test(t), t);
t = await say(111, '/plan 222 pro 0');
check('bad days are refused', /whole number from 1 to 366/.test(t), t);
t = await say(111, '/plan 123456 pro');
check('unknown chat shows usage', /Usage: \/plan/.test(t), t);
t = await say(111, '/plan 222 pro 45');
check('upgrade confirmed with the end date', /Starter Co is now on Pro for 45 days \(until \d{4}-\d{2}-\d{2}\)/.test(t), t);
check('the plan row really changed (anchor = today)', rows['222'].plan === 'pro' && rows['222'].cycle_anchor === new Date().toISOString().slice(0, 10), JSON.stringify(rows['222']));
m = mark(); t = await say(222, 'tell me something interesting about volcanoes');
check('their very next chat runs on the large model', /hi from openai\/gpt-oss-120b/.test(t), t);
check('and a fresh 3,500 grant exists for the new cycle', ledger.some((r) => r.chat_id === '222' && r.reason === 'grant' && r.delta === 3500), JSON.stringify(ledger.filter((r) => r.chat_id === '222')));
t = await say(111, '/plan 666 pilot');
check('pilot has no end date', /with no end date/.test(t) && rows['666'].ends_at === null, t + JSON.stringify(rows['666']));
t = await say(111, '/plan 666 frozen');
t = await say(666, 'hello there friend');
check('/plan frozen pauses them at once', /paused/.test(t), t);

console.log('\n[/topup]');
t = await say(333, '/topup 333');
check('a business cannot top itself up', /isn't available/.test(t), t);
t = await say(111, '/topup 333');
check('first top-up adds 500', /Added 500 credits to Pro Co/.test(t) && rowsFor(333, 'topup').length === 1, t);
t = await say(111, '/topup 333');
check('second top-up ok (Pro allows 2)', /Added 500/.test(t) && rowsFor(333, 'topup').length === 2, t);
t = await say(111, '/topup 333');
check('third is refused', /already used every top-up/.test(t) && rowsFor(333, 'topup').length === 2, t);
t = await say(111, '/topup 888');
check('top-up with the ledger fine for another business', /Added 500 credits to Outage Co/.test(t), t);
t = await say(111, '/topup abc');
check('bad id shows usage', /Usage: \/topup/.test(t), t);

console.log('\n[admin is never metered]');
const adminBefore = ledger.filter((r) => r.chat_id === '111').length;
t = await say(111, 'tell me something interesting about volcanoes');
check('admin chat costs nothing and writes no ledger rows', ledger.filter((r) => r.chat_id === '111').length === adminBefore && /hi from/.test(t), t);

console.log('\n[secrets]');
check('no keys and no message text in the bot log', !log.includes('gsk_fakekey_do_not_leak') && !/volcano/i.test(log) && !/notes\.txt/.test(log.split('\n').filter((l) => l.startsWith('[llm]') || l.startsWith('[meter]')).join('\n')));

proc.kill();
for (const s of [tg, groq, ollama, sb]) s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
