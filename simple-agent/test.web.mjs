// Website chat door (POST /web/chat) end-to-end. FAKE Telegram + Groq + Ollama + Supabase (login check, links, plans).
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const P = { tg: 18711, groq: 18712, ollama: 18713, sb: 18714, app: 18715 };
const SITE = 'https://site.test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-web-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });

const sent = [], groqCalls = [], ollamaCalls = [], ledger = [], rows = {};
let authCalls = 0, authMode = 'ok';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (n) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${n}In0.sig${n}abcd`; // looks like a JWT, only the fake Supabase understands it
const users = { [jwt('pro')]: U(1), [jwt('starter')]: U(2), [jwt('frozen')]: U(3), [jwt('nolink')]: U(4), [jwt('stranger')]: U(5), [jwt('admin')]: U(6), [jwt('pro2')]: U(7), [jwt('pro3')]: U(8) };
const links = { [U(1)]: '333', [U(2)]: '222', [U(3)]: '444', [U(5)]: '999999', [U(6)]: '111', [U(7)]: '335', [U(8)]: '336' }; // U(4) has no row; U(5) points at a chat the bot doesn't know

const roleOf = (s) => (s.includes('You read a short message') ? 'router' : s.includes('helpful, direct assistant') ? 'chat' : 'other');
const answer = (s, who) => (roleOf(s) === 'router' ? { action: 'chat' } : { reply: `hi from ${who}` });
const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };

const tg = http.createServer(async (req, res) => {
  const method = req.url.split('/').pop(); const raw = await readBody(req);
  if (method === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
  json(res, 200, method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} });
});
const groq = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req)); const system = b.messages[0].content;
  groqCalls.push({ model: b.model, role: roleOf(system) });
  json(res, 200, { choices: [{ message: { content: JSON.stringify(answer(system, b.model)) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
});
const ollama = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req)); ollamaCalls.push(1);
  json(res, 200, { message: { content: JSON.stringify(answer(b.messages[0].content, 'local')) } });
});
const sb = http.createServer(async (req, res) => {
  const raw = await readBody(req); const u = new URL(req.url, 'http://x');
  if (u.pathname === '/auth/v1/user') {
    authCalls++;
    if (authMode === 'down') return json(res, 500, {});
    const tok = (req.headers.authorization || '').replace(/^Bearer /, '');
    return users[tok] ? json(res, 200, { id: users[tok], email: 'x@example.com' }) : json(res, 401, { msg: 'invalid' });
  }
  if (u.pathname.endsWith('/tenant_users')) {
    const uid = /user_id=eq\.([0-9a-f-]+)/.exec(u.search)?.[1];
    return json(res, 200, links[uid] ? [{ chat_id: Number(links[uid]) }] : []);
  }
  if (u.pathname.endsWith('/credit_ledger')) {
    if (req.method === 'GET') { const chat = /eq\.(-?\d+)/.exec(u.search)?.[1]; const cycle = /cycle=eq\.([\d-]+)/.exec(u.search)?.[1]; return json(res, 200, ledger.filter((r) => r.chat_id === chat && r.cycle === cycle)); }
    const row = JSON.parse(raw);
    if (row.reason === 'grant' && ledger.some((r) => r.chat_id === row.chat_id && r.cycle === row.cycle && r.reason === 'grant')) return json(res, 409, {});
    ledger.push({ ts: new Date().toISOString(), ...row }); return json(res, 201, []);
  }
  if (!u.pathname.endsWith('/tenant_plans')) return json(res, 201, []);
  const chat = /eq\.(-?\d+)/.exec(u.search)?.[1];
  if (req.method === 'GET') return json(res, 200, rows[chat] ? [rows[chat]] : []);
  if (req.method === 'POST') { const row = JSON.parse(raw); if (!rows[row.chat_id]) rows[row.chat_id] = { last_reminder: null, ...row }; return json(res, 201, [rows[row.chat_id]]); }
  if (req.method === 'PATCH') { if (rows[chat]) Object.assign(rows[chat], JSON.parse(raw)); res.statusCode = 204; return res.end(); }
  json(res, 200, []);
});
for (const [s, p] of [[tg, P.tg], [groq, P.groq], [ollama, P.ollama], [sb, P.sb]]) await new Promise((r) => s.listen(p, r));

const tenant = (id, name, isAdmin = false) => ({ chatId: String(id), name, isAdmin, createdAt: iso(-40), tools: ['files', 'email', 'spreadsheets', 'utilities', 'calendar', 'github'], instructions: '', schemaVersion: 3 });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: { 333: tenant(333, 'Pro Co'), 222: tenant(222, 'Starter Co'), 444: tenant(444, 'Expired Co'), 111: tenant(111, 'Owner', true), 335: tenant(335, 'Pro Two'), 336: tenant(336, 'Pro Three') } }));
const row = (id, plan, endsIn, anchorAgo) => ({ chat_id: String(id), plan, ends_at: iso(endsIn), cycle_anchor: iso(-anchorAgo).slice(0, 10), created_at: iso(-anchorAgo), last_reminder: null });
rows['333'] = row(333, 'pro', 20, 10); rows['222'] = row(222, 'starter', 20, 10); rows['444'] = { ...row(444, 'trial', -10, 40), last_reminder: 30 }; rows['111'] = row(111, 'trial', 20, 5); rows['335'] = row(335, 'pro', 20, 10); rows['336'] = row(336, 'pro', 20, 10);

const proc = spawn('node', ['server.js'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env, HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
    TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app),
    TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: path.join(tmp, 'conn.json'), PUBLIC_URL: 'https://example.ngrok-free.dev', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), SITE_URL: `${SITE}/coop/`, WEB_ORIGINS: 'https://other.test',
    GROQ_API_KEY: 'gsk_fakekey_do_not_leak', GROQ_API_BASE: `http://127.0.0.1:${P.groq}/openai/v1`,
    SUPABASE_URL: `http://127.0.0.1:${P.sb}`, SUPABASE_SERVICE_KEY: 'sb_secret_test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

const URL_ = `http://127.0.0.1:${P.app}/web/chat`;
async function web(token, message, { origin = SITE, raw, headers = {} } = {}) {
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: raw !== undefined ? raw : JSON.stringify({ message }),
  });
  let body = null; try { body = await res.json(); } catch {}
  return { status: res.status, body, headers: res.headers };
}
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => { if (cond) { pass++; console.log(`  PASS  ${name}`); } else { fail++; console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`); } };
const SMALL = 'openai/gpt-oss-20b', LARGE = 'openai/gpt-oss-120b';
const joined = (r) => (r.body?.replies || []).join('\n---\n');

console.log('\n[startup]');
check('startup says website chat is on', /Website chat: on/.test(log), log.slice(0, 300));

console.log('\n[cors]');
let r = await fetch(URL_, { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,ngrok-skip-browser-warning' } });
check('preflight from the site is accepted', r.status === 204 && r.headers.get('access-control-allow-origin') === SITE, `${r.status} ${r.headers.get('access-control-allow-origin')}`);
check('preflight allows the headers the page sends', /authorization/.test(r.headers.get('access-control-allow-headers')) && /ngrok-skip-browser-warning/.test(r.headers.get('access-control-allow-headers')));
r = await fetch(URL_, { method: 'OPTIONS', headers: { origin: 'https://evil.test', 'access-control-request-method': 'POST' } });
check('preflight from another site is refused', r.status === 403 && !r.headers.get('access-control-allow-origin'), `${r.status}`);
let w = await web(jwt('pro'), 'hello there friend', { origin: 'https://evil.test' });
check('a post from another site is refused', w.status === 403 && !w.headers.get('access-control-allow-origin'), `${w.status}`);
w = await web(jwt('pro'), 'ok', { origin: 'https://other.test' });
check('an extra listed origin (WEB_ORIGINS) is allowed', w.status === 200 && w.headers.get('access-control-allow-origin') === 'https://other.test', `${w.status}`);

console.log('\n[login check]');
await new Promise((r) => setTimeout(r, 1500)); // let any start-up warm-up call finish first
const base0 = { g: groqCalls.length, o: ollamaCalls.length };
w = await web(null, 'hello');
check('no token -> 401', w.status === 401, `${w.status}`);
w = await web('not-a-token', 'hello');
check('garbage token -> 401', w.status === 401, `${w.status}`);
w = await web('aaaa.bbbb.cccc', 'hello');
check('well-formed but unknown token -> 401 from Supabase', w.status === 401, `${w.status}`);
check('and nothing was sent to a model', groqCalls.length === base0.g && ollamaCalls.length === base0.o);

console.log('\n[a pro customer chats from the website]');
let g0 = groqCalls.length;
w = await web(jwt('pro'), 'tell me something interesting about volcanoes');
check('200 with a reply from the large model', w.status === 200 && /hi from openai\/gpt-oss-120b/.test(joined(w)), JSON.stringify(w.body));
check('router small, chat large (same rules as Telegram)', groqCalls.slice(g0).find((x) => x.role === 'router')?.model === SMALL && groqCalls.slice(g0).find((x) => x.role === 'chat')?.model === LARGE, JSON.stringify(groqCalls.slice(g0)));
check('nothing leaked to their Telegram', !sent.some((m) => m.chat_id === '333'), JSON.stringify(sent));
check('the chat was charged credits on the ledger', ledger.some((l) => l.chat_id === '333' && l.reason === 'spend' && l.delta < 0), JSON.stringify(ledger));
check('response is not cacheable', /no-store/.test(w.headers.get('cache-control') || ''));

console.log('\n[starter customer]');
g0 = groqCalls.length;
w = await web(jwt('starter'), 'tell me something interesting about volcanoes');
check('starter answered by the small model only', /hi from openai\/gpt-oss-20b/.test(joined(w)) && groqCalls.slice(g0).every((x) => x.model === SMALL), JSON.stringify(w.body));

console.log('\n[acknowledgement + follow-up memory]');
w = await web(jwt('pro'), 'ok');
check('"ok" gets a thumbs-up reply', joined(w) === '👍', JSON.stringify(w.body));
w = await web(jwt('pro'), 'thanks');
check('"thanks" gets a word', /Anytime/.test(joined(w)), JSON.stringify(w.body));

console.log('\n[paused account]');
g0 = groqCalls.length; const ol0 = ollamaCalls.length;
w = await web(jwt('frozen'), 'tell me something interesting about volcanoes');
check('paused customer gets the fixed paused message', w.status === 200 && /free trial has ended/.test(joined(w)), JSON.stringify(w.body));
check('no model was called', groqCalls.length === g0 && ollamaCalls.length === ol0);

console.log('\n[not linked]');
w = await web(jwt('nolink'), 'hello');
check('a login with no agent is told to finish setup', w.status === 200 && /isn’t linked/.test(joined(w)), JSON.stringify(w.body));
w = await web(jwt('stranger'), 'hello');
check('a link to an unknown chat is treated as not linked', w.status === 200 && /isn’t linked/.test(joined(w)), JSON.stringify(w.body));

console.log('\n[commands: everything Telegram can do works here]');
w = await web(jwt('pro'), '/connect google');
check('/connect google gives a real sign-in link', /accounts\.google|example\.ngrok-free\.dev|client_id=cid/.test(joined(w)) && /https:\/\//.test(joined(w)), JSON.stringify(w.body));
check('the link went to the page, not to Telegram', !sent.some((m) => m.chat_id === '333' && /https:\/\//.test(m.text)));
w = await web(jwt('pro'), '/connections');
check('/connections lists them', /Google: not connected/.test(joined(w)), JSON.stringify(w.body));
w = await web(jwt('pro'), '/usage');
check('/usage works and shows credits', /credit/i.test(joined(w)), JSON.stringify(w.body));
w = await web(jwt('pro'), '/help');
check('/help works', w.status === 200 && joined(w).length > 20, JSON.stringify(w.body));
w = await web(jwt('pro'), '/businesses');
check('a customer still cannot use owner commands', /isn.t available/.test(joined(w)), JSON.stringify(w.body));
w = await web(jwt('pro'), '/plan 222 business');
check('a customer cannot change plans', /isn.t available/.test(joined(w)) && rows['222'].plan === 'starter', JSON.stringify(w.body));
w = await web(jwt('admin'), '/plan 222 business');
check('the owner, logged in on the website, can run owner commands', /is now on Business/.test(joined(w)), JSON.stringify(w.body));
w = await web(jwt('admin'), '/businesses');
check('owner /businesses works', /Pro Co/.test(joined(w)), JSON.stringify(w.body));
w = await web(jwt('pro'), '/unknowncommand');
check('an unknown command gets a normal answer', w.status === 200 && joined(w).length > 0, JSON.stringify(w.body));

console.log('\n[plain words for connections]');
g0 = groqCalls.length;
for (const [q, re] of [['what are my connections', /Google: not connected/], ['can we connect google', /https:\/\//], ['connect google', /https:\/\//], ['can you connect my gmail', /https:\/\//], ['show my connections', /Google: not connected/]]) {
  w = await web(jwt('pro2'), q);
  check(`"${q}"`, re.test(joined(w)), JSON.stringify(w.body));
}
check('answered by the real commands, no model call', groqCalls.length === g0);
g0 = groqCalls.length;
w = await web(jwt('pro2'), 'how does connecting google work?');
check('a how-does-it-work question is left to the model', groqCalls.length > g0, JSON.stringify(w.body));

console.log('\n[secrets and bad input]');
g0 = groqCalls.length;
w = await web(jwt('pro3'), 'here is my key sk-abcdefghijklmnopqrstuvwxyz123456');
check('a pasted secret is refused and never reaches a model', /password or a secret key/.test(joined(w)) && groqCalls.length === g0, JSON.stringify(w.body));
w = await web(jwt('pro3'), '   ');
check('empty message -> 400', w.status === 400, `${w.status}`);
w = await web(jwt('pro3'), 'x'.repeat(2001));
check('over-long message -> 400', w.status === 400, `${w.status}`);
w = await web(jwt('pro3'), null, { raw: '{not json' });
check('broken json -> 400, not a crash', w.status === 400, `${w.status}`);
w = await web(jwt('pro3'), null, { raw: JSON.stringify({ message: { $ne: 1 } }) });
check('non-string message -> 400', w.status === 400, `${w.status}`);
w = await web(jwt('pro3'), 'ok');
check('server still fine afterwards', w.status === 200);

console.log('\n[login check is cached, and outages are not logouts]');
const a0 = authCalls;
await web(jwt('pro3'), 'ok'); await web(jwt('pro3'), 'ok');
check('repeat requests with one token do not re-ask Supabase every time', authCalls - a0 <= 0, `${authCalls - a0} extra calls`);
authMode = 'down';
w = await web('newt.oken.neverseen', 'ok');
check('Supabase down on a new token -> 503 (not 401, so the page does not log them out)', w.status === 503, `${w.status}`);
w = await web(jwt('pro3'), 'ok');
check('a token seen a moment ago still works during a blip', w.status === 200, `${w.status}`);
authMode = 'ok';

console.log('\n[telegram still works, and web/telegram share one conversation]');
const before = sent.length;
await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: 9001, message: { chat: { id: 335 }, from: { id: 335 }, text: 'thanks' } }) });
for (let i = 0; i < 40 && sent.length === before; i++) await new Promise((r) => setTimeout(r, 50));
check('a Telegram message still gets its reply in Telegram', sent.slice(before).some((m) => m.chat_id === '335' && /Anytime/.test(m.text)), JSON.stringify(sent.slice(before)));

console.log('\n[abuse limits]');
let limited = 0, okc = 0;
for (let i = 0; i < 45; i++) { const x = await web(jwt('starter'), '/connect'); if (/faster than I can keep up/.test(joined(x))) limited++; else okc++; }
check('one login is slowed after 40 requests a minute', limited >= 5 && okc <= 41, `limited ${limited}, ok ${okc}`);

console.log('\n[secrets stay out of the log]');
check('no token in the bot log', !/eyJhbGciOiJIUzI1NiJ9/.test(log));
check('no service key in the bot log', !log.includes('sb_secret_test'));
check('no message text in the bot log', !/volcano/i.test(log));
check('the Groq key never appears', !log.includes('gsk_fakekey_do_not_leak'));

proc.kill();
for (const s of [tg, groq, ollama, sb]) s.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
