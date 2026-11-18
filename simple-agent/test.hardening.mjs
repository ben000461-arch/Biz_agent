// Hardening: admin alerts, dead Google sign-ins, "delete my account", connections/disconnect for the website,
// chat history (newest, own business only), and two-business separation. FAKE Telegram, Ollama, Google, Supabase.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createAlerts, redact } from './alerts.js';
import { createAccounts } from './account.js';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- unit: alerts.js
console.log('\n[alerts: unit]');
{
  let t = 0; const out = [];
  const a = createAlerts({ send: async (id, txt) => out.push({ id, txt }), adminId: '111', now: () => t, log: () => {} });
  a.alert('k1', 'first'); a.alert('k1', 'again'); await wait(5);
  check('same key is sent once per hour', out.length === 1 && out[0].id === '111' && /first/.test(out[0].txt));
  t += 61 * 60 * 1000; a.alert('k1', 'later'); await wait(5);
  check('...and again after the hour', out.length === 2);
  for (let i = 0; i < 15; i++) a.alert(`flood${i}`, 'x');
  await wait(5);
  check('no more than 10 an hour, plus one "too many" note', out.length === 2 + 9 + 1 && /Too many alerts/.test(out[out.length - 1].txt), String(out.length));
  const none = createAlerts({ send: async () => out.push(1), adminId: '', log: () => {} });
  check('no admin id: nothing is sent', none.alert('x', 'y') === false && none.enabled === false);
  check('redact hides keys and tokens', !/gsk_|sk_live|sb_secret|ya29|eyJ/.test(redact('gsk_abcdefghijklmnop sk_live_abcdefgh sb_secret_abcdefg ya29.abc-def eyJhbGciOiJIUzI1NiJ9abcdefghij')));
}

// ---------------------------------------------------------------- unit: account.js
console.log('\n[account deletion: unit]');
{
  const calls = [];
  const mk = (billing) => createAccounts({ url: 'https://p.supabase.co', key: 'sb_secret_k', fetchImpl: async (u, o) => {
    calls.push({ u, m: o.method });
    const url = new URL(u);
    if (url.pathname.endsWith('/billing_accounts')) return { ok: true, status: 200, json: async () => billing };
    if (url.pathname.endsWith('/tenant_users') && o.method === 'GET') return { ok: true, status: 200, json: async () => [{ user_id: '00000000-0000-4000-8000-000000000001' }] };
    return { ok: true, status: 200, json: async () => [{}, {}] };
  } });
  check('paid plan still running blocks deletion', (await mk([{ status: 'active', cancel_at_end: false }]).check('333')).blocked === 'paid_plan');
  check('a plan already set to cancel does not block', !(await mk([{ status: 'active', cancel_at_end: true }]).check('333')).blocked);
  check('no billing row: fine', !(await mk([]).check('333')).blocked);
  check('a bad chat id is refused', (await mk([]).remove("333&chat_id=neq.0")).error === 'bad chat');
  calls.length = 0;
  const r = await mk([]).remove('333');
  const dels = calls.filter((c) => c.m === 'DELETE').map((c) => c.u);
  check('deletes chats, logs, tool tokens and tool requests, all filtered to this chat', ['web_chat_messages', 'agent_logs', 'tool_connections', 'tool_requests'].every((t) => dels.some((u) => u.includes(`/${t}?chat_id=eq.333`))), dels.join('\n'));
  check('deletes the website login (auth user)', dels.some((u) => u.endsWith('/auth/v1/admin/users/00000000-0000-4000-8000-000000000001')));
  check('never touches payment records', !calls.some((c) => c.m === 'DELETE' && /billing_accounts|stripe_events|credit_ledger|tenant_plans/.test(c.u)));
  check('reports success', r.ok === true && r.logins === 1 && r.removed.web_chat_messages === 2, JSON.stringify(r));
  const broken = createAccounts({ url: 'https://p.supabase.co', key: 'k', fetchImpl: async (u, o) => (o.method === 'DELETE' && u.includes('agent_logs') ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, status: 200, json: async () => [] }) });
  const r2 = await broken.remove('333');
  check('a failed table is reported, the rest still run', r2.ok === false && r2.failed.includes('agent_logs') && r2.removed.web_chat_messages === 0, JSON.stringify(r2));
}

// ---------------------------------------------------------------- the real server, two businesses
const P = { tg: 18911, ollama: 18912, app: 18913, google: 18914, sb: 18915 };
const SITE = 'https://site.test';
const TZ = 'America/Los_Angeles';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hard-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (n) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${n}In0.sig${n}abcd`;
const users = { [jwt('a')]: U(1), [jwt('b')]: U(2), [jwt('paid')]: U(3), [jwt('owner')]: U(9) };

const sent = [];
const tg = http.createServer(async (req, res) => {
  const method = req.url.split('/').pop(); const raw = await readBody(req);
  if (method === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
  json(res, 200, method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} });
});
const ollama = http.createServer(async (req, res) => { await readBody(req); json(res, 200, { message: { content: JSON.stringify({ action: 'chat', reply: 'Hi.' }) } }); });
const SC = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.events'];
const g = { refresh: 'ok', revoked: [] };
const google = http.createServer(async (req, res) => {
  const raw = await readBody(req); const url = new URL(req.url, 'http://x');
  if (url.pathname === '/token') {
    const p = new URLSearchParams(raw);
    if (p.get('grant_type') === 'authorization_code') return json(res, 200, { access_token: `AT-${p.get('code')}`, refresh_token: `RT-${p.get('code')}`, expires_in: 1, scope: SC.join(' ') });
    if (g.refresh === 'dead') return json(res, 400, { error: 'invalid_grant' });
    return json(res, 200, { access_token: 'AT2', expires_in: 1 });
  }
  if (url.pathname === '/revoke') { g.revoked.push(url.searchParams.get('token')); return json(res, 200, {}); }
  if (url.pathname === '/gmail/users/me/profile') return json(res, 200, { emailAddress: 'o@biz.com' });
  if (url.pathname.startsWith('/calendar')) return json(res, 200, { items: [] });
  json(res, 404, {});
});

// a small fake PostgREST: tables of rows, eq filters, order, limit, DELETE returns the rows
const db = {
  tenant_users: [{ user_id: U(1), chat_id: 333 }, { user_id: U(2), chat_id: 335 }, { user_id: U(3), chat_id: 336 }, { user_id: U(9), chat_id: 111 }],
  web_chat_messages: [], agent_logs: [], tool_requests: [], tool_connections: [],
  billing_accounts: [{ chat_id: '336', status: 'active', cancel_at_end: false }],
  tenant_plans: [], credit_ledger: [],
};
const t0 = Date.parse('2026-11-01T00:00:00Z');
for (let i = 0; i < 350; i++) db.web_chat_messages.push({ chat_id: '333', role: i % 2 ? 'assistant' : 'user', content: `A message ${i}`, created_at: new Date(t0 + i * 1000).toISOString() });
for (let i = 0; i < 5; i++) db.web_chat_messages.push({ chat_id: '335', role: 'user', content: `B secret ${i}`, created_at: new Date(t0 + i * 1000).toISOString() });
for (const c of ['333', '335']) { db.agent_logs.push({ chat_id: c, kind: 'action' }); db.tool_requests.push({ id: Number(c), chat_id: c, tool_name: 'Slack', status: 'ready' }); db.tool_connections.push({ request_id: Number(c), chat_id: c, token_enc: 'x' }); }
const sbCalls = [];
const deletedUsers = [];
const sb = http.createServer(async (req, res) => {
  const raw = await readBody(req); const u = new URL(req.url, 'http://x');
  sbCalls.push({ m: req.method, p: u.pathname + u.search });
  if (u.pathname === '/auth/v1/user') { const tok = (req.headers.authorization || '').replace(/^Bearer /, ''); return users[tok] && !deletedUsers.includes(users[tok]) ? json(res, 200, { id: users[tok], email: 'x@e.com' }) : json(res, 401, {}); }
  const adm = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(u.pathname);
  if (adm && req.method === 'DELETE') { deletedUsers.push(adm[1]); db.tenant_users = db.tenant_users.filter((r) => r.user_id !== adm[1]); return json(res, 200, {}); }
  const table = u.pathname.replace('/rest/v1/', '');
  if (!db[table]) return json(res, 201, []);
  const filters = [...u.searchParams].filter(([k, v]) => /^eq\./.test(v)).map(([k, v]) => [k, v.slice(3)]);
  const match = (r) => filters.every(([k, v]) => String(r[k]) === decodeURIComponent(v));
  if (req.method === 'GET') {
    let out = db[table].filter(match);
    const ord = u.searchParams.get('order'); if (ord) { const [col, dir] = ord.split('.'); out = out.slice().sort((x, y) => (dir === 'desc' ? -1 : 1) * String(x[col]).localeCompare(String(y[col]))); }
    const lim = Number(u.searchParams.get('limit')); if (lim) out = out.slice(0, lim);
    return json(res, 200, out);
  }
  if (req.method === 'DELETE') { const gone = db[table].filter(match); db[table] = db[table].filter((r) => !match(r)); return json(res, 200, gone); }
  if (req.method === 'POST') { const b = JSON.parse(raw || '[]'); for (const r of [].concat(b)) db[table].push(r); return json(res, 201, []); }
  res.statusCode = 204; res.end();
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [google, P.google], [sb, P.sb]]) await new Promise((r) => s.listen(p, r));

const tenant = (id, name, isAdmin = false) => ({ chatId: String(id), name, isAdmin, createdAt: new Date().toISOString(), tools: ['files', 'email', 'spreadsheets', 'utilities', 'calendar'], instructions: '', schemaVersion: 3 });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: { 333: tenant(333, 'A Co'), 335: tenant(335, 'B Co'), 336: tenant(336, 'Paid Co'), 111: tenant(111, 'Owner', true) } }));
const ws = path.join(tmp, 'ws');
for (const c of ['333', '335']) { fs.mkdirSync(path.join(ws, c), { recursive: true }); fs.writeFileSync(path.join(ws, c, 'notes.txt'), `${c} private`); }
fs.writeFileSync(path.join(tmp, 'data', '.running'), 'left over from a crash');

const gv = `http://127.0.0.1:${P.google}`;
const proc = spawn('node', ['server.js'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env, TZ, HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
    TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app), GROQ_API_KEY: '',
    TENANTS_FILE: tenantsFile, WORKSPACES_DIR: ws, CONNECTIONS_FILE: path.join(tmp, 'conn.json'), PUBLIC_URL: 'https://example.test',
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    GOOGLE_AUTH_BASE: `${gv}/auth`, GOOGLE_TOKEN_URL: `${gv}/token`, GOOGLE_REVOKE_URL: `${gv}/revoke`, GMAIL_API_BASE: `${gv}/gmail`, CALENDAR_API_BASE: `${gv}/calendar`,
    SITE_URL: `${SITE}/coop/`, SUPABASE_URL: `http://127.0.0.1:${P.sb}`, SUPABASE_SERVICE_KEY: 'sb_secret_test',
    AGENT_TICK_MS: '600000', EVENT_POLL_MS: '600000', SIGNUP_POLL_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await wait(100); }
const APP = `http://127.0.0.1:${P.app}`;
async function call(method, p, token, body) {
  const res = await fetch(APP + p, { method, headers: { origin: SITE, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let b = null; try { b = await res.json(); } catch {}
  return { status: res.status, body: b };
}
let uid = 1;
async function say(chat, text) {
  const start = sent.length;
  await fetch(`${APP}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  await wait(600);
  return sent.slice(start).filter((m) => m.chat_id === String(chat)).map((m) => m.text).join('\n---\n');
}
async function connectGoogle(chat, code) {
  const t = await say(chat, '/connect google');
  const link = /https?:\/\/\S+/.exec(t)?.[0];
  const state = link ? new URL(link).searchParams.get('state') : '';
  const r = await fetch(`${APP}/oauth/google/callback?code=${code}&state=${state}`);
  return { status: r.status, html: await r.text() };
}
const toAdmin = () => sent.filter((m) => m.chat_id === '111').map((m) => m.text);

try {
  console.log('\n[restart alert]');
  await wait(300);
  check('a leftover run marker means the last run crashed: the admin is told', toAdmin().some((t) => /restarted after an unexpected stop/.test(t)), JSON.stringify(toAdmin()));

  console.log('\n[connect page wording + connections]');
  let c = await connectGoogle(333, 'A');
  check('the "connected" page no longer sends web users to Telegram', c.status === 200 && /You can close this tab\./.test(c.html) && !/Telegram/.test(c.html), c.html.slice(-200));
  await connectGoogle(335, 'B');
  let r = await call('GET', '/web/connections', jwt('a'));
  check('connections: Google shows connected', r.status === 200 && r.body.google.connected === true && r.body.google.expired === false && r.body.github.connected === false, JSON.stringify(r.body));
  check('connections never include a token', !/RT-|AT-|token/i.test(JSON.stringify(r.body)));
  r = await call('GET', '/web/connections', null);
  check('connections: no login -> 401', r.status === 401);

  console.log('\n[disconnect from the website]');
  r = await call('POST', '/web/disconnect', jwt('a'), { provider: 'nonsense' });
  check('unknown provider refused', r.status === 400);
  r = await call('POST', '/web/disconnect', jwt('a'), { provider: 'google', chat_id: '335' });
  check('disconnect works and answers in plain words', r.status === 200 && /no longer have access to your Google/.test(r.body.message), JSON.stringify(r.body));
  check('Google was told to revoke it too', g.revoked.includes('RT-A'), JSON.stringify(g.revoked));
  r = await call('GET', '/web/connections', jwt('b'));
  check('a chat_id in the body is ignored: B is still connected', r.body.google.connected === true, JSON.stringify(r.body));
  r = await call('GET', '/web/connections', jwt('a'));
  check('A now shows disconnected', r.body.google.connected === false);

  console.log('\n[a Google sign-in dies]');
  g.refresh = 'dead';
  const before = sent.length;
  r = await call('GET', '/web/schedule', jwt('b'));
  await wait(400);
  const toB = sent.slice(before).filter((m) => m.chat_id === '335').map((m) => m.text).join('\n');
  check('the calendar says reconnect', r.status === 200 && r.body.calendar === 'reconnect', JSON.stringify(r.body?.calendar));
  check('B is told on Telegram, in plain words, how to fix it', /Google connection stopped working/.test(toB) && /connect/.test(toB), toB);
  check('the admin is told which business', toAdmin().some((t) => /Google stopped working for B Co \(chat 335\)/.test(t)));
  check('nobody else is told', !sent.slice(before).some((m) => m.chat_id === '333'));
  r = await call('GET', '/web/connections', jwt('b'));
  check('connections shows "expired" so the card can say Reconnect', r.body.google.connected === false && r.body.google.expired === true, JSON.stringify(r.body.google));
  const n1 = sent.length;
  await call('GET', '/web/schedule', jwt('b')); await wait(300);
  check('told only once (not on every request)', !sent.slice(n1).some((m) => /stopped working/.test(m.text)));
  g.refresh = 'ok';
  await connectGoogle(335, 'B2');
  r = await call('GET', '/web/connections', jwt('b'));
  check('reconnecting clears the "expired" flag', r.body.google.connected === true && r.body.google.expired === false, JSON.stringify(r.body.google));

  console.log('\n[chat history]');
  r = await call('GET', '/web/chat/history', jwt('a'));
  const msgs = r.body?.messages || [];
  check('history returns the NEWEST messages, oldest first', msgs.length === 300 && msgs[msgs.length - 1].content === 'A message 349' && msgs[0].content === 'A message 50', `${msgs.length} ${msgs[0]?.content} … ${msgs[msgs.length - 1]?.content}`);
  check('A never sees B\'s messages', !msgs.some((m) => /B secret/.test(m.content)));
  r = await call('GET', '/web/chat/history', jwt('b'));
  check('B sees only its own', r.body.messages.length === 5 && r.body.messages.every((m) => /B secret/.test(m.content)));

  console.log('\n[delete my account: website]');
  r = await call('POST', '/web/account/delete', jwt('a'), {});
  check('without typing DELETE nothing happens', r.status === 400 && r.body.error === 'confirm' && db.agent_logs.some((x) => x.chat_id === '333'));
  r = await call('POST', '/web/account/delete', jwt('paid'), { confirm: 'DELETE' });
  check('a running paid plan must be cancelled first', r.status === 409 && r.body.error === 'paid_plan' && /Cancel it first/.test(r.body.message), JSON.stringify(r.body));
  r = await call('POST', '/web/account/delete', jwt('owner'), { confirm: 'DELETE' });
  check('the owner account cannot be deleted from the website', r.status === 403);
  await connectGoogle(333, 'A3');
  const adminBefore = toAdmin().length;
  r = await call('POST', '/web/account/delete', jwt('a'), { confirm: 'DELETE' });
  await wait(500);
  check('delete answers ok', r.status === 200 && r.body.ok === true && r.body.partial.length === 0, JSON.stringify(r.body));
  check('A\'s chats, logs, tool tokens and tool requests are gone', !['web_chat_messages', 'agent_logs', 'tool_connections', 'tool_requests'].some((t) => db[t].some((x) => String(x.chat_id) === '333')));
  check('B\'s data is untouched', db.web_chat_messages.filter((x) => x.chat_id === '335').length === 5 && db.agent_logs.some((x) => x.chat_id === '335') && db.tool_connections.some((x) => x.chat_id === '335'));
  check('only A\'s login was deleted', deletedUsers.length === 1 && deletedUsers[0] === U(1), JSON.stringify(deletedUsers));
  check('payment records were not deleted', !sbCalls.some((x) => x.m === 'DELETE' && /billing_accounts|credit_ledger|tenant_plans|stripe_events/.test(x.p)));
  check('every delete was filtered to chat 333', sbCalls.filter((x) => x.m === 'DELETE' && x.p.startsWith('/rest/v1/')).every((x) => /chat_id=eq\.333(&|$)/.test(x.p)), JSON.stringify(sbCalls.filter((x) => x.m === 'DELETE')));
  check('A\'s Google access was revoked with Google', g.revoked.includes('RT-A3'));
  check('A\'s files are deleted, B\'s are not', !fs.existsSync(path.join(ws, '333')) && fs.existsSync(path.join(ws, '335', 'notes.txt')));
  const tf = JSON.parse(fs.readFileSync(tenantsFile, 'utf8'));
  check('A is removed from the bot, B and the owner remain', !tf.tenants['333'] && tf.tenants['335'] && tf.tenants['111']);
  check('A is told on Telegram', sent.some((m) => m.chat_id === '333' && /account and data are deleted/.test(m.text)));
  check('the admin is told', toAdmin().slice(adminBefore).some((t) => /A Co \(chat 333\) deleted their account from the website\. Everything was removed/.test(t)), JSON.stringify(toAdmin().slice(adminBefore)));
  r = await call('GET', '/web/connections', jwt('a'));
  check('A\'s old login no longer works', r.status === 401 || r.status === 409, `${r.status}`);
  r = await call('GET', '/web/connections', jwt('b'));
  check('B still works normally', r.status === 200 && r.body.google.connected === true);

  console.log('\n[delete my account: Telegram]');
  let t = await say(335, '/deleteaccount_confirm');
  check('confirm without asking first does nothing', /Send \/deleteaccount first/.test(t) && JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['335'], t);
  t = await say(335, '/deleteaccount');
  check('first step explains what goes and asks for the confirm command', /permanently deletes/.test(t) && /\/deleteaccount_confirm/.test(t) && db.web_chat_messages.some((x) => x.chat_id === '335'), t);
  t = await say(335, '/deleteaccount_confirm');
  check('confirm deletes everything for B', /account and data are deleted/.test(t) && !db.web_chat_messages.some((x) => x.chat_id === '335') && !JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['335'], t);
  t = await say(111, '/deleteaccount');
  check('the owner can\'t delete themselves from Telegram', /can't be deleted/.test(t), t);
  t = await say(336, '/help');
  check('/help mentions how to delete an account', /\/deleteaccount/.test(t), t);

  console.log('\n[nothing private leaks]');
  const adminText = toAdmin().join('\n');
  check('alerts never include message text or tokens', !/A message|B secret|RT-|AT-|sb_secret|csecret/.test(adminText), adminText.slice(0, 400));
  check('server log never includes message text or tokens', !/A message \d|B secret|RT-A|RT-B|AT-|csecret/.test(log));
} finally {
  proc.kill('SIGTERM');
  await wait(300);
  check('a clean stop removes the run marker (no false crash alert next time)', !fs.existsSync(path.join(tmp, 'data', '.running')));
  for (const s of [tg, ollama, google, sb]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
