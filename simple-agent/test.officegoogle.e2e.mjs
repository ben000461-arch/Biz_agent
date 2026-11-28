// Office Google, end to end through the real server: an employee connects their OWN Google from the Office
// dashboard, Agent plans a Gmail draft / calendar event with it, the step runs on their account only, and the
// office's rules switch can turn all of it off. Fake Google, Supabase and AI model.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${String(d).slice(0, 400)}` : ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const base = 46100 + Math.floor(Math.random() * 400);
const P = { app: base, tg: base + 1, ollama: base + 2, sb: base + 3, google: base + 4, groq: base + 5 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
const KEY = 'a'.repeat(64);
const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const SITE = 'https://www.co-optech.com';
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TOK = { owner: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJvIn0.sigowner1', emp: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJlIn0.sigemp111' };
const people = { [TOK.owner]: { id: U(1), role: 'owner', email: 'ben@demo.test' }, [TOK.emp]: { id: U(2), role: 'employee', email: 'sam@demo.test' } };

const tg = http.createServer(async (req, res) => { await readBody(req); json(res, 200, { ok: true, result: {} }); });
const ollama = http.createServer(async (req, res) => { await readBody(req); json(res, 200, { message: { content: '{}' } }); });

// ---- fake Supabase: two people in office 333
let rules = { sites: { mode: 'any', allow: [], block: [] }, approval: 'small', never: { money: true, send: false, delete: false }, google: true };
const sb = http.createServer(async (req, res) => {
  await readBody(req); const u = new URL(req.url, 'http://x');
  const uid = (u.searchParams.get('user_id') || '').replace('eq.', '');
  const p = Object.values(people).find((x) => x.id === uid);
  if (u.pathname === '/auth/v1/user') { const t = (req.headers.authorization || '').replace(/^Bearer /, ''); const who = people[t]; return who ? json(res, 200, { id: who.id, email: who.email, email_confirmed_at: '2026-01-01' }) : json(res, 401, {}); }
  if (u.pathname === '/rest/v1/tenant_users') return json(res, 200, p ? [{ chat_id: 333 }] : []);
  if (u.pathname === '/rest/v1/office_members') return json(res, 200, p ? [{ chat_id: 333, role: p.role, email: p.email, name: '' }] : []);
  if (u.pathname === '/rest/v1/office_businesses') return json(res, 200, u.searchParams.get('chat_id') === 'eq.333' ? [{ rules, name: 'Demo', accent: null }] : []);
  json(res, 200, []);
});

// ---- fake Google
const g = { drafts: [], events: [], revoked: [], tokens: 0, calendarReads: 0 };
const google = http.createServer(async (req, res) => {
  const raw = await readBody(req); const u = new URL(req.url, 'http://x');
  if (u.pathname === '/token') {
    const p = new URLSearchParams(raw);
    if (p.get('grant_type') === 'authorization_code') { g.tokens++; return p.get('code') === 'GOOD' ? json(res, 200, { access_token: `AT${g.tokens}`, refresh_token: `RT${g.tokens}`, expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.events' }) : json(res, 400, { error: 'invalid_grant' }); }
    return json(res, 200, { access_token: 'ATR', expires_in: 3600 });
  }
  if (u.pathname === '/revoke') { g.revoked.push(u.searchParams.get('token')); return json(res, 200, {}); }
  if (u.pathname === '/gmail/users/me/profile') return json(res, 200, { emailAddress: 'sam.personal@gmail.test' });
  if (u.pathname === '/gmail/users/me/drafts' && req.method === 'POST') { g.drafts.push({ auth: req.headers.authorization, raw: Buffer.from(JSON.parse(raw).message.raw, 'base64url').toString('utf8') }); return json(res, 200, { id: 'd1' }); }
  if (u.pathname === '/calendar/calendars/primary/events' && req.method === 'POST') { g.events.push(JSON.parse(raw)); return json(res, 200, { id: 'ev1' }); }
  if (u.pathname === '/calendar/calendars/primary/events') { g.calendarReads++; return json(res, 200, { items: [{ id: 'x', summary: 'Dentist', start: { dateTime: '2027-01-07T17:00:00Z' }, end: { dateTime: '2027-01-07T18:00:00Z' } }] }); }
  json(res, 404, {});
});

// ---- fake AI: answers with whatever plan the test sets, and remembers the prompt
let nextPlan = { say: 'ok', steps: [] }; const prompts = [];
const groq = http.createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  prompts.push(body.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'));
  json(res, 200, { choices: [{ message: { content: JSON.stringify(nextPlan) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [sb, P.sb], [google, P.google], [groq, P.groq]]) await new Promise((r) => s.listen(p, r));

const tenantsFile = path.join(tmp, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
const t = (id, name) => ({ chatId: String(id), name, isAdmin: id === 111, createdAt: new Date().toISOString(), tools: ['files', 'utilities'], instructions: '', schemaVersion: 3, tz: 'America/Los_Angeles' });
fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: { 111: t(111, 'Admin'), 333: t(333, 'Demo') } }));
const gv = `http://127.0.0.1:${P.google}`;
const proc = spawn('node', ['server.js'], {
  cwd: path.dirname(new URL(import.meta.url).pathname),
  env: {
    ...process.env, GROQ_API_KEY: 'gsk_test', GROQ_API_BASE: `http://127.0.0.1:${P.groq}`, HOME: tmp,
    TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`,
    PORT: String(P.app), TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: path.join(tmp, 'conn.json'),
    SITE_URL: `${SITE}/`, SUPABASE_URL: `http://127.0.0.1:${P.sb}`, SUPABASE_SERVICE_KEY: 'sb_secret_test',
    PUBLIC_URL: 'https://api.test', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', TOKEN_ENCRYPTION_KEY: KEY,
    GOOGLE_AUTH_BASE: `${gv}/auth`, GOOGLE_TOKEN_URL: `${gv}/token`, GOOGLE_REVOKE_URL: `${gv}/revoke`, GMAIL_API_BASE: `${gv}/gmail`, CALENDAR_API_BASE: `${gv}/calendar`,
    OFFICE_APP_URL: 'https://www.co-optech.com/office/', OFFICE_CACHE_MS: '1',
    AGENT_TICK_MS: '600000', EVENT_POLL_MS: '600000', SIGNUP_POLL_MS: '600000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await wait(100); }

async function call(p, { tok = TOK.emp, origin, body, method = 'POST' } = {}) {
  const o = origin ?? (p.startsWith('/web/agent') ? EXT : SITE);
  const res = await fetch(`http://127.0.0.1:${P.app}${p}`, { method, redirect: 'manual', headers: { origin: o, 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let b = null; try { b = await res.json(); } catch {}
  return { status: res.status, body: b, location: res.headers.get('location') };
}
const cb = (qs) => fetch(`http://127.0.0.1:${P.app}/oauth/google/callback?${qs}`, { redirect: 'manual' });
const PAGE = { url: 'https://crm.example.com/clients/7', title: 'Client', text: 'Tom Reyes, tom@acme.test', elements: [{ id: 'e1', kind: 'button', label: 'Edit' }] };
const plan = (request) => call('/web/agent/plan', { body: { request, page: PAGE } });

try {
  console.log('[connecting]');
  let r = await call('/web/office/google', { method: 'GET' });
  check('not connected at first; allowed by the office', r.status === 200 && r.body.available === true && r.body.allowed === true && r.body.connected === false, JSON.stringify(r));
  check('signed out: refused', (await call('/web/office/google', { method: 'GET', tok: null })).status === 401);
  r = await call('/web/office/google/connect', { body: {} });
  const link = new URL(r.body.url);
  check('connect gives a Google sign-in link back to our server', link.pathname === '/auth' && link.searchParams.get('redirect_uri') === 'https://api.test/oauth/google/callback' && link.searchParams.get('access_type') === 'offline', r.body.url);
  check('only drafts + calendar are asked for (nothing that reads or sends mail)', !/gmail\.(send|readonly|modify)|drive/.test(link.searchParams.get('scope')));
  const state = link.searchParams.get('state');
  let res = await cb(`code=GOOD&state=${state}`);
  check('after Google, they land back on their Office Account page', res.status === 302 && res.headers.get('location') === 'https://www.co-optech.com/office/?google=connected#account', `${res.status} ${res.headers.get('location')}`);
  check('the link works once only', (await cb(`code=GOOD&state=${state}`)).status === 400);
  r = await call('/web/office/google', { method: 'GET' });
  check('now connected, showing which Google account', r.body.connected === true && r.body.email === 'sam.personal@gmail.test', JSON.stringify(r.body));
  check('it’s the employee’s own: the owner is still not connected', (await call('/web/office/google', { method: 'GET', tok: TOK.owner })).body.connected === false);
  const conn = fs.readFileSync(path.join(tmp, 'conn.json'), 'utf8');
  check('the saved sign-in is encrypted (no token in the file)', !/RT1|AT1/.test(conn) && conn.includes(`u:${U(2)}`));
  r = await call('/web/office/google/connect', { tok: TOK.owner, body: {} });
  res = await cb(`error=access_denied&state=${new URL(r.body.url).searchParams.get('state')}`);
  check('cancelling on Google’s screen goes back to Office, saying so', res.status === 302 && /google=cancelled#account$/.test(res.headers.get('location')));
  r = await call('/web/office/google/connect', { tok: TOK.owner, body: {} });
  res = await cb(`code=BAD&state=${new URL(r.body.url).searchParams.get('state')}`);
  check('a failed sign-in goes back to Office too (no token details in the address)', res.status === 302 && /google=failed#account$/.test(res.headers.get('location')));

  console.log('\n[planning with Google]');
  nextPlan = { say: 'Drafting it.', steps: [{ do: 'gmail_draft', to: 'tom@acme.test', subject: 'Your quote', value: 'Hi Tom,\n\nHere is the quote.' }] };
  prompts.length = 0; g.calendarReads = 0;
  r = await plan('write an email to Tom with the quote');
  check('the plan has a Gmail draft step, waiting for approval', r.status === 200 && r.body.steps.length === 1 && r.body.steps[0].do === 'gmail_draft' && r.body.steps[0].kind === 'google' && r.body.auto === false, JSON.stringify(r.body));
  check('the planner was told about their Google (and that drafts never send)', prompts.some((p) => /GOOGLE: this employee connected their own Google/.test(p) && /never sends/.test(p)));
  check('their calendar wasn’t read for an email', g.calendarReads === 0 && !prompts.some((p) => /THEIR CALENDAR/.test(p)));
  nextPlan = { say: 'Booking it.', steps: [{ do: 'calendar_add', value: 'Call with Tom', start: '2027-01-07T15:00', end: '2027-01-07T15:30' }] };
  prompts.length = 0;
  r = await plan('book a call with Tom on Jan 7 at 3pm');
  check('calendar question: their next 7 days were read and given as facts', g.calendarReads === 1 && prompts.some((p) => /THEIR CALENDAR, next 7 days/.test(p)), `${g.calendarReads}`);
  check('the event step shows the name and time in plain words', r.body.steps[0]?.label === 'Add to your calendar: “Call with Tom”, Thu, Jan 7, 3:00 PM to 3:30 PM', JSON.stringify(r.body.steps));
  const owner = await call('/web/agent/plan', { tok: TOK.owner, body: { request: 'write an email to Tom', page: PAGE } });
  check('someone who hasn’t connected Google gets no Google steps', owner.status === 200 && owner.body.steps.length === 0, JSON.stringify(owner.body));

  console.log('\n[running a step]');
  const draftStep = { do: 'gmail_draft', to: 'tom@acme.test', subject: 'Your quote', value: 'Hi Tom,\n\nHere is the quote.' };
  r = await call('/web/agent/google', { body: { step: draftStep } });
  check('the draft is saved, and Agent says it wasn’t sent', r.status === 200 && /wasn’t sent/.test(r.body.message) && g.drafts.length === 1, JSON.stringify(r));
  check('the draft has the right person and subject', /To: tom@acme\.test/.test(g.drafts[0]?.raw) && /Subject: =\?UTF-8\?B\?/.test(g.drafts[0]?.raw));
  r = await call('/web/agent/google', { body: { step: { do: 'calendar_add', value: 'Call with Tom', start: '2027-01-07T15:00', end: '2027-01-07T15:30' } } });
  check('the event is added at the right time in the office’s time zone', r.status === 200 && g.events.length === 1 && g.events[0].start.dateTime === '2027-01-07T23:00:00.000Z' && g.events[0].start.timeZone === 'America/Los_Angeles', JSON.stringify(g.events[0]));
  const nd = g.drafts.length;
  r = await call('/web/agent/google', { body: { step: { do: 'gmail_draft', to: 'evil@x.test\r\nBcc: all@x.test', subject: 'x', value: 'y' } } });
  check('a tampered step is checked again and refused; nothing saved', r.status === 400 && g.drafts.length === nd, JSON.stringify(r));
  r = await call('/web/agent/google', { body: { step: { do: 'click', id: 'e1' } } });
  check('only Google steps can run here', r.status === 400);
  r = await call('/web/agent/google', { tok: TOK.owner, body: { step: draftStep } });
  check('someone not connected: told to connect first; nothing saved', r.status === 409 && /Account page/.test(r.body.message) && g.drafts.length === nd);
  check('the extension’s origin is allowed; other websites aren’t', (await call('/web/agent/google', { origin: 'https://evil.test', body: { step: draftStep } })).status === 403);
  check('nothing from the email or event is in the server log', !/Here is the quote|Call with Tom|tom@acme/.test(log));

  console.log('\n[owner turns Google off]');
  rules = { ...rules, google: false };
  prompts.length = 0;
  nextPlan = { say: 'Drafting.', steps: [{ do: 'gmail_draft', to: 'tom@acme.test', subject: 'x', value: 'y' }] };
  r = await plan('write an email to Tom');
  check('off: the planner isn’t told about Google and no Google step comes back', r.status === 200 && r.body.steps.length === 0 && !prompts.some((p) => /GOOGLE: this employee/.test(p)), JSON.stringify(r.body));
  r = await call('/web/agent/google', { body: { step: draftStep } });
  check('off: running a step is refused, nothing saved', r.status === 403 && r.body.error === 'rule_google' && g.drafts.length === nd);
  r = await call('/web/office/google/connect', { body: {} });
  check('off: can’t start connecting', r.status === 403 && /turned Google off/.test(r.body.message));
  check('off: the Account page is told it’s not allowed', (await call('/web/office/google', { method: 'GET' })).body.allowed === false);
  rules = { ...rules, google: true };

  console.log('\n[disconnecting]');
  r = await call('/web/office/google/disconnect', { body: {} });
  check('disconnect: removed here and revoked at Google', r.status === 200 && g.revoked.length >= 1 && (await call('/web/office/google', { method: 'GET' })).body.connected === false);
  r = await call('/web/agent/google', { body: { step: draftStep } });
  check('after disconnecting, steps can’t run', r.status === 409);
} finally {
  proc.kill('SIGTERM'); await wait(300);
  for (const s of [tg, ollama, sb, google, groq]) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
