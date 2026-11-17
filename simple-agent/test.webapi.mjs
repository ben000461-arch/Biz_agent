// Website Schedule + Agents doors (/web/schedule, /web/agents...). FAKE Telegram, Ollama, Google and Supabase.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import * as agentKit from './agents.js';

const P = { tg: 18711, ollama: 18712, app: 18713, google: 18714, sb: 18715 };
const SITE = 'https://site.test';
const TZ = 'America/Los_Angeles';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const DAY = 86400000;
const iso = (d) => new Date(Date.now() + d * DAY).toISOString();
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const sent = [];
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jwt = (n) => `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ${n}In0.sig${n}abcd`;
const users = { [jwt('a')]: U(1), [jwt('b')]: U(2), [jwt('frozen')]: U(3), [jwt('nolink')]: U(4), [jwt('nogoogle')]: U(5) };
const links = { [U(1)]: '333', [U(2)]: '335', [U(3)]: '444', [U(5)]: '336' };
const rows = {}, ledger = [];
const tg = http.createServer(async (req, res) => {
  const method = req.url.split('/').pop(); const raw = await readBody(req);
  if (method === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
  json(res, 200, method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} });
});
const oll = { agent: 0 };
const ollama = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req)); const s = b.messages[0].content;
  let out;
  if (s.includes('a small automated agent')) { oll.agent++; out = { reply: 'Hello from your agent.' }; }
  else if (s.includes('helpful, direct assistant')) out = { reply: 'Hi.' };
  else out = { action: 'chat' };
  json(res, 200, { message: { content: JSON.stringify(out) } });
});
const SC = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.events'];
const g = { events: [], items: [], mode: 'ok', posts: [] };
const google = http.createServer(async (req, res) => {
  const raw = await readBody(req); const url = new URL(req.url, 'http://x');
  if (url.pathname === '/token') { const p = new URLSearchParams(raw); return json(res, 200, p.get('grant_type') === 'authorization_code' ? { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: SC.join(' ') } : { access_token: 'AT2', expires_in: 3600 }); }
  if (url.pathname === '/revoke') return json(res, 200, {});
  if (url.pathname === '/gmail/users/me/profile') return json(res, 200, { emailAddress: 'o@biz.com' });
  if (url.pathname === '/calendar/calendars/primary/events' && req.method === 'POST') {
    if (g.mode === 'readonly') return json(res, 403, { error: { code: 403, message: 'Request had insufficient authentication scopes.', status: 'PERMISSION_DENIED' } });
    if (g.mode === 'fail') return json(res, 500, { error: { code: 500 } });
    g.posts.push(JSON.parse(raw)); return json(res, 200, { id: 'evNew' });
  }
  if (url.pathname === '/calendar/calendars/primary/events') {
    const lo = Date.parse(url.searchParams.get('timeMin') || 0), hi = Date.parse(url.searchParams.get('timeMax') || 9e15);
    const t = (e) => Date.parse(e.start.dateTime || e.start.date);
    return json(res, 200, { items: g.items.filter((e) => t(e) < hi && Date.parse(e.end.dateTime || e.end.date) > lo - 1) });
  }
  json(res, 404, {});
});
const sb = http.createServer(async (req, res) => {
  const raw = await readBody(req); const u = new URL(req.url, 'http://x');
  if (u.pathname === '/auth/v1/user') { const tok = (req.headers.authorization || '').replace(/^Bearer /, ''); return users[tok] ? json(res, 200, { id: users[tok], email: 'x@e.com' }) : json(res, 401, {}); }
  if (u.pathname.endsWith('/tenant_users')) { const uid = /user_id=eq\.([0-9a-f-]+)/.exec(u.search)?.[1]; return json(res, 200, links[uid] ? [{ chat_id: Number(links[uid]) }] : []); }
  if (u.pathname.endsWith('/credit_ledger')) {
    if (req.method === 'GET') { const chat = /eq\.(-?\d+)/.exec(u.search)?.[1]; const cycle = /cycle=eq\.([\d-]+)/.exec(u.search)?.[1]; return json(res, 200, ledger.filter((r) => r.chat_id === chat && r.cycle === cycle)); }
    const row = JSON.parse(raw);
    if (row.reason === 'grant' && ledger.some((r) => r.chat_id === row.chat_id && r.cycle === row.cycle && r.reason === 'grant')) return json(res, 409, {});
    ledger.push({ ts: new Date().toISOString(), ...row }); return json(res, 201, []);
  }
  if (!u.pathname.endsWith('/tenant_plans')) return json(res, 201, []);
  const chat = /eq\.(-?\d+)/.exec(u.search)?.[1];
  if (req.method === 'GET') return json(res, 200, rows[chat] ? [rows[chat]] : []);
  if (req.method === 'POST') { const r = JSON.parse(raw); if (!rows[r.chat_id]) rows[r.chat_id] = { last_reminder: null, ...r }; return json(res, 201, [rows[r.chat_id]]); }
  res.statusCode = 204; res.end();
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [google, P.google], [sb, P.sb]]) await new Promise((r) => s.listen(p, r));

const tenant = (id, name, isAdmin = false) => ({ chatId: String(id), name, isAdmin, createdAt: iso(-40), tools: ['files', 'email', 'spreadsheets', 'utilities', 'calendar'], instructions: '', schemaVersion: 3 });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: { 333: tenant(333, 'A Co'), 335: tenant(335, 'B Co'), 444: tenant(444, 'Frozen Co'), 336: tenant(336, 'NoGoogle Co'), 111: tenant(111, 'Owner', true) } }));
const prow = (id, plan, endsIn) => ({ chat_id: String(id), plan, ends_at: iso(endsIn), cycle_anchor: iso(-10).slice(0, 10), created_at: iso(-10), last_reminder: null });
rows['333'] = prow(333, 'pro', 20); rows['335'] = prow(335, 'pro', 20); rows['336'] = prow(336, 'pro', 20); rows['444'] = { ...prow(444, 'trial', -10), last_reminder: 30 }; rows['111'] = prow(111, 'pro', 20);

const gv = `http://127.0.0.1:${P.google}`;
const proc = spawn('node', ['server.js'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env, TZ, HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
    TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app), GROQ_API_KEY: '',
    TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: path.join(tmp, 'conn.json'), PUBLIC_URL: 'https://example.ngrok-free.dev',
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
    GOOGLE_AUTH_BASE: `${gv}/auth`, GOOGLE_TOKEN_URL: `${gv}/token`, GOOGLE_REVOKE_URL: `${gv}/revoke`, GMAIL_API_BASE: `${gv}/gmail`, CALENDAR_API_BASE: `${gv}/calendar`,
    SITE_URL: `${SITE}/coop/`, WEB_ORIGINS: 'https://other.test', SUPABASE_URL: `http://127.0.0.1:${P.sb}`, SUPABASE_SERVICE_KEY: 'sb_secret_test', WEB_API_PER_USER_MIN: '1000',
    AGENT_TICK_MS: '60000', EVENT_POLL_MS: '60000', MAX_AGENTS: '3', WEB_API_PER_USER: '150',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const BASE = `http://127.0.0.1:${P.app}/web`;
async function call(method, p, token, body, { origin = SITE, raw } = {}) {
  const res = await fetch(BASE + p, { method, headers: { ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...(origin ? { origin } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  let b = null; try { b = await res.json(); } catch {}
  return { status: res.status, body: b, headers: res.headers };
}
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const stateFrom = (txt) => new URL(/https?:\/\/\S+/.exec(txt)[0]).searchParams.get('state');
let uid = 9000;
async function say(chat, text) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  await wait(700);
  return sent.slice(start).map((m) => m.text).join('\n---\n');
}
const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const tomorrow = ymd(new Date(Date.now() + DAY * 1.5));
const yesterday = ymd(new Date(Date.now() - DAY));

try {
  console.log('\n[startup + cors]');
  check('startup says the doors are mounted', /schedule and agents doors are mounted/.test(log), log.slice(0, 300));
  let r = await fetch(`${BASE}/agents`, { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'GET' } });
  check('preflight from the site ok', r.status === 204 && r.headers.get('access-control-allow-origin') === SITE, `${r.status}`);
  r = await fetch(`${BASE}/agents/a1234/run`, { method: 'OPTIONS', headers: { origin: 'https://evil.test' } });
  check('preflight from another site refused', r.status === 403);
  r = await call('GET', '/agents', jwt('a'), undefined, { origin: 'https://evil.test' });
  check('get from another site refused', r.status === 403 && !r.headers.get('access-control-allow-origin'));
  r = await call('GET', '/agents', jwt('a'), undefined, { origin: 'https://other.test' });
  check('extra listed origin allowed', r.status === 200);
  check('responses not cacheable', /no-store/.test(r.headers.get('cache-control') || ''));

  console.log('\n[login check]');
  for (const [name, path_, m, tok] of [['schedule', '/schedule', 'GET', null], ['agents', '/agents', 'GET', 'junk'], ['create', '/agents', 'POST', null], ['event', '/schedule/event', 'POST', 'aaaa.bbbb.cccc']]) {
    r = await call(m, path_, tok, m === 'POST' ? {} : undefined);
    check(`${name}: no/bad token -> 401`, r.status === 401, `${r.status}`);
  }
  r = await call('GET', '/agents', jwt('nolink'));
  check('signed in but not linked -> 409 not_linked', r.status === 409 && r.body.error === 'not_linked', JSON.stringify(r.body));

  console.log('\n[calendar not connected yet]');
  r = await call('GET', '/schedule', jwt('a'));
  check('schedule says not_connected, no events', r.status === 200 && r.body.calendar === 'not_connected' && r.body.events.length === 0 && r.body.tz === TZ && /^\d{4}-\d\d-\d\d$/.test(r.body.today), JSON.stringify(r.body));
  r = await call('POST', '/schedule/event', jwt('a'), { title: 'Lunch', date: tomorrow, time: '12:00', minutes: 60 });
  check('adding an event -> 409 not_connected', r.status === 409 && r.body.error === 'not_connected', JSON.stringify(r.body));
  r = await call('GET', '/agents', jwt('a'));
  check('agents list: empty, cap 3, calendar tool locked with a reason', r.status === 200 && r.body.agents.length === 0 && r.body.cap === 3 && r.body.tools.find((t) => t.key === 'calendar')?.usable === false && r.body.tools.find((t) => t.key === 'calendar')?.why, JSON.stringify(r.body.tools));
  r = await call('POST', '/agents', jwt('a'), { purpose: 'brief me before meetings', schedule: '30 minutes before every meeting', tools: ['calendar'] });
  check('a before-meeting agent is refused without Google', r.status === 400, JSON.stringify(r.body));

  console.log('\n[connect Google for A]');
  let t = await say(333, '/connect');
  await fetch(`http://127.0.0.1:${P.app}/oauth/google/callback?code=GOODCODE&state=${stateFrom(t)}`);
  await wait(300);
  const inH = (h) => new Date(Date.now() + h * 3600000).toISOString();
  g.items = [
    { id: 'e1', summary: 'Dentist', start: { dateTime: inH(5) }, end: { dateTime: inH(6) } },
    { id: 'e2', summary: 'Holiday', start: { date: tomorrow }, end: { date: tomorrow } },
  ];
  r = await call('GET', '/schedule?days=7', jwt('a'));
  check('schedule lists events (timed + all-day)', r.status === 200 && r.body.calendar === 'ok' && r.body.events.length === 2 && r.body.events[0].title === 'Dentist' && r.body.events[1].allDay === true, JSON.stringify(r.body));
  check('schedule carries no tokens', !/AT1|RT1|csecret/.test(JSON.stringify(r.body)));

  console.log('\n[adding an event]');
  r = await call('POST', '/schedule/event', jwt('a'), { title: 'Lunch with Dana', date: tomorrow, time: '12:30', minutes: 45 });
  check('added after the button press (no clash)', r.status === 200 && r.body.ok && g.posts.length === 1 && g.posts[0].summary === 'Lunch with Dana', JSON.stringify(r.body));
  const dur = g.posts[0] && (new Date(g.posts[0].end.dateTime) - new Date(g.posts[0].start.dateTime)) / 60000;
  check('45 minutes long, in the owner\'s time zone', dur === 45 && g.posts[0].start.timeZone === TZ, JSON.stringify(g.posts[0]));
  g.items.push({ id: 'e3', summary: 'Lunch with Dana', start: g.posts[0].start, end: g.posts[0].end });
  const n0 = g.posts.length;
  r = await call('POST', '/schedule/event', jwt('a'), { title: 'x', date: tomorrow, time: '12:30', minutes: 45 }); // overlap check relies on fake returning items for any window
  check('an overlap asks first (needsConfirm + names the clash), adds nothing', r.status === 200 && r.body.needsConfirm === true && r.body.clash.length >= 1 && g.posts.length === n0, JSON.stringify(r.body));
  r = await call('POST', '/schedule/event', jwt('a'), { title: 'Forced', date: tomorrow, time: '12:30', minutes: 30, force: true });
  check('force:true adds anyway', r.status === 200 && r.body.ok && g.posts.length === n0 + 1);
  const bads = [
    ['empty title', { title: '  ', date: tomorrow, time: '10:00' }], ['no date', { title: 'A', time: '10:00' }], ['bad time', { title: 'A', date: tomorrow, time: '25:99' }],
    ['past', { title: 'A', date: yesterday, time: '10:00' }], ['too short', { title: 'A', date: tomorrow, time: '10:00', minutes: 1 }], ['too long', { title: 'A', date: tomorrow, time: '10:00', minutes: 5000 }],
    ['long title', { title: 'z'.repeat(90), date: tomorrow, time: '10:00' }], ['secret title', { title: 'key sk-abcdefghijklmnopqrstuvwxyz0123', date: tomorrow, time: '10:00' }],
  ];
  const n1 = g.posts.length;
  for (const [name, body] of bads) { r = await call('POST', '/schedule/event', jwt('a'), { force: true, ...body }); check(`rejects ${name}`, r.status === 400 && r.body.message, `${r.status} ${JSON.stringify(r.body)}`); }
  check('none of the bad ones reached Google', g.posts.length === n1);
  r = await call('POST', '/schedule/event', jwt('a'), undefined, { raw: '{not json' });
  check('broken JSON -> 400/500 not a crash', r.status >= 400 && r.status < 500, `${r.status}`);
  r = await call('POST', '/schedule/event', jwt('a'), undefined, { raw: JSON.stringify({ title: 'x'.repeat(20000) }) });
  check('oversize body refused', r.status === 413, `${r.status}`);
  g.mode = 'readonly';
  r = await call('POST', '/schedule/event', jwt('a'), { force: true, title: 'RO', date: tomorrow, time: '09:00' });
  check('old read-only sign-in -> 409 needs_more_access with the instruction', r.status === 409 && r.body.error === 'needs_more_access' && /\/connect google/.test(r.body.message), JSON.stringify(r.body));
  g.mode = 'fail';
  r = await call('POST', '/schedule/event', jwt('a'), { force: true, title: 'F', date: tomorrow, time: '09:00' });
  check('Google error -> 502 and nothing claimed', r.status === 502 && r.body.error === 'google_failed', JSON.stringify(r.body));
  g.mode = 'ok';

  console.log('\n[agents: build, list, cap]');
  r = await call('POST', '/agents', jwt('a'), { purpose: 'Tell me what is on my calendar and my notes', info: 'I am a dentist', tools: ['calendar', 'notes'], schedule: 'every weekday at 8am' });
  const a1 = r.body?.agent;
  check('created (201) with a sensible name, tools, schedule text', r.status === 201 && a1 && /^a[0-9a-f]+$/.test(a1.id) && a1.tools.join() === 'calendar,notes' && /8/.test(a1.scheduleText) && a1.name.length > 0, JSON.stringify(r.body));
  check('public agent shape has no secrets/internal fields', a1 && !('briefed' in a1) && !('armedAt' in a1), JSON.stringify(a1));
  r = await call('POST', '/agents', jwt('a'), { purpose: 'brief me before meetings', schedule: '30 minutes before every meeting', tools: ['calendar'], name: 'Pre-meeting' });
  const a2 = r.body?.agent;
  check('before-meeting agent allowed now Google is connected', r.status === 201 && a2.scheduleText.includes('before'), JSON.stringify(r.body));
  r = await call('POST', '/agents', jwt('a'), { purpose: 'say hi when I ask', schedule: 'only when I ask' });
  const a3 = r.body?.agent;
  check('third agent ok (manual schedule, no tools)', r.status === 201 && a3);
  r = await call('POST', '/agents', jwt('a'), { purpose: 'a fourth one', schedule: 'only when I ask' });
  check('fourth -> 409 cap', r.status === 409 && r.body.error === 'cap', JSON.stringify(r.body));
  r = await call('GET', '/agents', jwt('a'));
  check('list shows 3, ordered', r.body.agents.length === 3 && r.body.agents[0].id === a1.id);
  r = await call('GET', '/agents', jwt('b'));
  check('other business sees none of A\'s agents (isolation)', r.status === 200 && r.body.agents.length === 0);
  r = await call('POST', `/agents/${a1.id}/pause`, jwt('b'));
  check('other business cannot touch A\'s agent -> 404', r.status === 404);

  console.log('\n[agent form validation]');
  const tb = jwt('b');
  const vcases = [
    ['no purpose', { schedule: 'only when I ask' }], ['tiny purpose', { purpose: 'hi', schedule: 'only when I ask' }], ['huge purpose', { purpose: 'x'.repeat(400), schedule: 'only when I ask' }],
    ['no schedule', { purpose: 'a perfectly fine purpose' }], ['gibberish schedule', { purpose: 'a perfectly fine purpose', schedule: 'whenever the moon is blue' }],
    ['unknown tool', { purpose: 'a perfectly fine purpose', schedule: 'only when I ask', tools: ['rm -rf'] }], ['secret in info', { purpose: 'a perfectly fine purpose', schedule: 'only when I ask', info: 'my key is sk-abcdefghijklmnopqrstuvwxyz0123' }],
    ['sheet tool without a sheet name', { purpose: 'a perfectly fine purpose', schedule: 'only when I ask', tools: ['sheet'] }],
  ];
  for (const [name, body] of vcases) { r = await call('POST', '/agents', tb, body); check(`rejects: ${name}`, r.status === 400 && r.body.message || r.body.error, `${r.status} ${JSON.stringify(r.body)}`); }
  r = await call('GET', '/agents', tb);
  check('nothing got saved from the bad ones', r.body.agents.length === 0);
  r = await call('POST', '/agents', tb, { purpose: '<b>Weekly stock check</b>', schedule: 'every friday at 4pm', name: '<script>alert(1)</script>' });
  check('markup is stripped from names', r.status === 201 && !/[<>]/.test(r.body.agent.name), JSON.stringify(r.body));

  console.log('\n[run, pause, resume, schedule, delete]');
  const o0 = oll.agent;
  r = await call('POST', `/agents/${a3.id}/run`, jwt('a'));
  check('run now returns the agent\'s message', r.status === 200 && /Hello from your agent/.test(r.body.text) && oll.agent === o0 + 1 && r.body.agent.runs === 1, JSON.stringify(r.body));
  const note = sent.find((m) => /was run from your website/.test(m.text));
  check('run also tells them on Telegram: when, what it checked, and the result', note && note.chat_id === '333' && /🕒 \w{3} \w{3} \d+ at \d+:\d\d [AP]M P[DS]T/.test(note.text) && /Checked: /.test(note.text) && /Result:\nHello from your agent/.test(note.text) && r.body.notified === true, JSON.stringify(note));
  check('the Telegram note names the tools it looked at (none here) and is not sent to anyone else', /Checked: nothing/.test(note?.text || '') && !sent.some((m) => /was run from your website/.test(m.text) && m.chat_id !== '333'));
  r = await call('POST', `/agents/${a3.id}/pause`, jwt('a'));
  check('pause', r.status === 200 && r.body.agent.enabled === false);
  r = await call('POST', `/agents/${a3.id}/resume`, jwt('a'));
  check('resume', r.status === 200 && r.body.agent.enabled === true);
  r = await call('POST', `/agents/${a3.id}/schedule`, jwt('a'), { schedule: 'daily at 5:30pm' });
  check('change schedule', r.status === 200 && /5:30/.test(r.body.agent.scheduleText), JSON.stringify(r.body));
  r = await call('POST', `/agents/${a3.id}/schedule`, jwt('a'), { schedule: 'blue moon' });
  check('bad schedule refused, old one kept', r.status === 400);
  r = await call('GET', '/agents', jwt('a'));
  check('old schedule still 5:30pm', /5:30/.test(r.body.agents.find((x) => x.id === a3.id).scheduleText));
  r = await call('POST', `/agents/${a3.id}/explode`, jwt('a'));
  check('unknown verb -> 404', r.status === 404);
  r = await call('POST', `/agents/zzz/run`, jwt('a'));
  check('malformed id -> 404', r.status === 404);
  r = await call('POST', `/agents/a0000/run`, jwt('a'));
  check('unknown id -> 404', r.status === 404);
  r = await call('GET', '/schedule?days=3', jwt('a'));
  check('schedule lists the agent run times and before-meeting agents', r.body.runs.length > 0 && r.body.runs.every((x) => x.agentId && x.at) && r.body.beforeEvent.some((b) => b.agentId === a2.id && b.minutes === 30), JSON.stringify({ runs: r.body.runs.slice(0, 2), b: r.body.beforeEvent }));
  r = await call('POST', `/agents/${a3.id}/pause`, jwt('a'));
  r = await call('GET', '/schedule', jwt('a'));
  check('paused agent has no run times', !r.body.runs.some((x) => x.agentId === a3.id));
  r = await call('POST', `/agents/${a3.id}/delete`, jwt('a'));
  check('delete', r.status === 200 && r.body.ok);
  r = await call('POST', `/agents/${a3.id}/delete`, jwt('a'));
  check('delete again -> 404 (already gone)', r.status === 404);
  r = await call('POST', '/agents', jwt('a'), { purpose: 'room again after delete', schedule: 'only when I ask' });
  check('room for a new agent after delete', r.status === 201);

  console.log('\n[editing an agent]');
  const nameBefore = a1.name, schedBefore = a1.scheduleText;
  r = await call('POST', `/agents/${a1.id}/update`, jwt('a'), { purpose: 'Tell me what is new in my notes', info: 'Open 8 to 5', tools: ['notes'], schedule: '', name: '' });
  check('edit: job, info and tools change; blank name and blank time keep the old ones', r.status === 200 && r.body.agent.purpose === 'Tell me what is new in my notes' && r.body.agent.info === 'Open 8 to 5' && r.body.agent.tools.join() === 'notes' && r.body.agent.name === nameBefore && r.body.agent.scheduleText === schedBefore, JSON.stringify(r.body));
  r = await call('POST', `/agents/${a1.id}/update`, jwt('a'), { purpose: 'Tell me what is new in my notes', tools: ['notes'], schedule: 'daily at 5:30pm', name: 'Evening notes' });
  check('edit: new name and new time', r.status === 200 && r.body.agent.name === 'Evening notes' && /5:30/.test(r.body.agent.scheduleText), JSON.stringify(r.body));
  r = await call('GET', '/agents', jwt('a'));
  check('the change is saved (list shows it)', r.body.agents.find((x) => x.id === a1.id)?.name === 'Evening notes' && r.body.agents.find((x) => x.id === a1.id)?.info === '');
  for (const [name, body] of [['tiny job', { purpose: 'hi', schedule: '' }], ['bad time', { purpose: 'A perfectly fine purpose', schedule: 'blue moon' }], ['secret', { purpose: 'A perfectly fine purpose sk-abcdefghijklmnopqrstuvwxyz0123', schedule: '' }], ['unknown tool', { purpose: 'A perfectly fine purpose', tools: ['rm'], schedule: '' }]]) {
    r = await call('POST', `/agents/${a1.id}/update`, jwt('a'), body); check(`edit rejects: ${name}`, r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  }
  r = await call('GET', '/agents', jwt('a'));
  check('rejected edits changed nothing', r.body.agents.find((x) => x.id === a1.id)?.name === 'Evening notes');
  r = await call('POST', `/agents/${a1.id}/update`, jwt('b'), { purpose: 'Hijack this agent please', schedule: '' });
  check('another business cannot edit it', r.status === 404);
  r = await call('POST', `/agents/${a2.id}/update`, jwt('a'), { purpose: 'Brief me before meetings', tools: ['calendar'], schedule: '' });
  check('a before-meeting agent keeps its schedule through an edit', r.status === 200 && r.body.agent.schedule.kind === 'before_event' && r.body.agent.schedule.minutes === 30, JSON.stringify(r.body));
  r = await call('POST', `/agents/${a2.id}/update`, jwt('frozen'), { purpose: 'x'.repeat(20), schedule: '' });
  check('(a frozen account cannot edit someone else\'s agent either)', r.status === 404);

  console.log('\n[month view]');
  const monthStart = ymd(new Date(Date.now() + 30 * DAY)).slice(0, 8) + '01';
  g.items = [{ id: 'm1', summary: 'Far event', start: { dateTime: `${monthStart}T18:00:00.000Z` }, end: { dateTime: `${monthStart}T19:00:00.000Z` } }, { id: 'm2', summary: 'Soon event', start: { dateTime: inH(5) }, end: { dateTime: inH(6) } }];
  r = await call('GET', `/schedule?from=${monthStart}&days=42`, jwt('a'));
  check('a month grid can be asked for: from, 42 days, only that range\'s events', r.status === 200 && r.body.from === monthStart && r.body.days === 42 && r.body.events.some((e) => e.title === 'Far event') && !r.body.events.some((e) => e.title === 'Soon event'), JSON.stringify({ f: r.body.from, d: r.body.days, e: r.body.events.map((e) => e.title) }));
  check('agent run times are listed for that future range too', r.body.runs.length > 0 && r.body.runs.every((x) => x.at >= new Date(monthStart).toISOString().slice(0, 10)), JSON.stringify(r.body.runs.slice(0, 2)));
  r = await call('GET', `/schedule?from=2020-01-01&days=42`, jwt('a'));
  check('a month in the past lists no agent runs', r.status === 200 && r.body.runs.length === 0);
  r = await call('GET', `/schedule?from=nonsense&days=999`, jwt('a'));
  check('nonsense dates fall back to this week; days are capped at 42', r.status === 200 && r.body.days === 42 && r.body.from === r.body.today, JSON.stringify({ f: r.body.from, d: r.body.days }));
  g.items = [];

  console.log('\n[manual run limit]');
  let last;
  for (let i = 0; i < 12; i++) { last = await call('POST', `/agents/${a1.id}/run`, jwt('a')); if (last.status === 429) break; }
  check('manual runs stop at the daily limit with a friendly message', last.status === 429 && last.body.error === 'limit', `${last.status} ${JSON.stringify(last.body)}`);

  console.log('\n[paused account]');
  r = await call('GET', '/agents', jwt('frozen'));
  check('frozen account can still LOOK', r.status === 200);
  r = await call('POST', '/agents', jwt('frozen'), { purpose: 'a perfectly fine purpose', schedule: 'only when I ask' });
  check('frozen account cannot build (402)', r.status === 402, `${r.status} ${JSON.stringify(r.body)}`);
  r = await call('POST', '/schedule/event', jwt('frozen'), { title: 'A', date: tomorrow, time: '10:00' });
  check('frozen account cannot add events (402)', r.status === 402, `${r.status}`);

  console.log('\n[rate limit + hygiene]');
  let limited = 0;
  for (let i = 0; i < 170; i++) { const x = await call('GET', '/agents', jwt('nogoogle')); if (x.status === 429) limited++; }
  check('hammering one account gets 429s', limited > 0, `${limited}`);
  check('server log has no keys, tokens or typed text', !/gsk_|sb_secret_test|AT1|RT1|sk-abcdefghij|Lunch with Dana|Hello from your agent/.test(log), log.split('\n').filter((l) => /hunter2|Lunch|AT1/.test(l)).slice(0, 3).join('\n'));
  check('no crash in the server log', !/TypeError|ReferenceError|Unhandled/.test(log), log.slice(-400));

  console.log('\n[pure form validator]');
  const ctx = { tools: agentKit.availableTools({ tools: ['calendar', 'utilities', 'spreadsheets'] }, { googleOn: true, googleConnected: true }), tz: TZ, googleConnected: true, resolveSheet: (n) => ({ filename: n }) };
  const v = agentKit.validateAgentForm({ purpose: 'check the stock every friday', schedule: 'every friday at 4pm', tools: ['sheet'], sheet: 'stock.xlsx' }, ctx);
  check('valid form ok, sheet kept, name clean', v.fields && v.fields.name === 'Check the stock' && v.fields && v.fields.sheet === 'stock.xlsx' && v.fields.tools.join() === 'sheet', JSON.stringify(v));
  check('non-object body rejected', !!agentKit.validateAgentForm(null, ctx).error && !!agentKit.validateAgentForm('x', ctx).error);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  proc.kill('SIGTERM');
  for (const s of [tg, ollama, google, sb]) s.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
