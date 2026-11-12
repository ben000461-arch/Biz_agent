// E2E for the Google connection, with FAKE Telegram, Ollama and Google.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

const P = { tg: 18701, ollama: 18702, app: 18703, google: 18704 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');
const connFile = path.join(tmp, 'data', 'connections.json');
const KEY = 'ab'.repeat(32);

const sent = [];
const tg = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const method = req.url.split('/').pop();
    if (method === 'sendMessage') { const b = JSON.parse(Buffer.concat(c).toString()); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} }));
  });
});

// fake Ollama
let draftRecipient = 'john@acme.com';
const ollama = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(c).toString());
    const system = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    let out;
    if (system.includes('helpful, direct assistant')) out = { reply: 'Hi there.' };
    else if (/draft an email/i.test(user)) out = { action: 'draft_email', recipient: draftRecipient, email_subject: 'Café Friday — ünïcode', email_body: 'Can we move Friday?\nThanks' };
    else if (/calendar/i.test(user)) out = { action: 'list_events', when: /tomorrow/i.test(user) ? 'tomorrow' : 'today' };
    else out = { action: 'chat' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify(out) } }));
  });
});

// fake Google
const SC = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.events'];
const g = { drafts: [], revoked: [], tokenCalls: [], refreshRevoked: false, badAuth: 0, calendarQuery: null };
const google = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(c).toString();
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const url = new URL(req.url, 'http://x');
    const authed = /^Bearer AT/.test(req.headers.authorization || '');
    if (url.pathname === '/token') {
      const p = new URLSearchParams(raw); g.tokenCalls.push(Object.fromEntries(p));
      if (p.get('client_id') !== 'cid' || p.get('client_secret') !== 'csecret') return json({ error: 'invalid_client' }, 401);
      if (p.get('grant_type') === 'authorization_code') {
        const code = p.get('code');
        if (code === 'GOODCODE') return json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 1, scope: SC.join(' ') });
        if (code === 'NOREFRESH') return json({ access_token: 'AT1', expires_in: 1, scope: SC.join(' ') });
        if (code === 'PARTIAL') return json({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 1, scope: SC[0] });
        return json({ error: 'invalid_grant' }, 400);
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (g.refreshRevoked || p.get('refresh_token') !== 'RT1') return json({ error: 'invalid_grant' }, 400);
        return json({ access_token: 'AT2', expires_in: 1 });
      }
    }
    if (url.pathname === '/revoke') { g.revoked.push(url.searchParams.get('token')); return json({}); }
    if (!authed) { g.badAuth++; return json({ error: 'unauth' }, 401); }
    if (url.pathname === '/gmail/users/me/profile') return json({ emailAddress: 'owner@biz.com' });
    if (url.pathname === '/gmail/users/me/drafts' && req.method === 'POST') {
      const rawMsg = Buffer.from(JSON.parse(raw).message.raw, 'base64url').toString('utf8');
      g.drafts.push(rawMsg); return json({ id: 'd1' });
    }
    if (url.pathname === '/calendar/calendars/primary/events') {
      g.calendarQuery = Object.fromEntries(url.searchParams);
      return json({ items: [{ summary: 'Dentist', start: { dateTime: new Date(Date.now() + 36e5).toISOString() } }, { summary: 'Payroll day', start: { date: '2026-10-06' } }] });
    }
    json({ error: 'nope' }, 404);
  });
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [google, P.google]]) await new Promise((r) => s.listen(p, r));

function startApp(extra = {}) {
  const gv = `http://127.0.0.1:${P.google}`;
  const proc = spawn('node', ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', GROQ_API_KEY: '', HOME: path.join(tmp, 'home'),
      TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
      TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`,
      PORT: String(P.app), TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: connFile,
      PUBLIC_URL: 'https://example.ngrok-free.dev', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', TOKEN_ENCRYPTION_KEY: KEY,
      GOOGLE_AUTH_BASE: `${gv}/auth`, GOOGLE_TOKEN_URL: `${gv}/token`, GOOGLE_REVOKE_URL: `${gv}/revoke`, GMAIL_API_BASE: `${gv}/gmail`, CALENDAR_API_BASE: `${gv}/calendar`,
      ...extra,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
  return { proc, getLog: () => log };
}
async function waitUp() {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('app did not start');
}
let uid = 5000;
async function say(chat, text, { quietMs = 350, maxMs = 4000 } = {}) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  const t0 = Date.now(); let last = Date.now(), seen = start;
  while (Date.now() - t0 < maxMs) { await new Promise((r) => setTimeout(r, 50)); if (sent.length !== seen) { seen = sent.length; last = Date.now(); } else if (seen > start && Date.now() - last > quietMs) break; }
  return sent.slice(start).map((m) => m.text).join('\n---\n');
}
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const callback = (qs) => fetch(`http://127.0.0.1:${P.app}/oauth/google/callback?${qs}`);
const stateFrom = (txt) => new URL(/https?:\/\/\S+/.exec(txt)[0]).searchParams.get('state');

let app = startApp(); await waitUp();

console.log('[sign-in flow]');
check('stranger can\'t /connect', /invite-only/.test(await say(999, '/connect')));
let t = await say(111, '/connect');
const link = new URL(/https?:\/\/\S+/.exec(t)[0]);
check('/connect gives a Google link', link.origin === `http://127.0.0.1:${P.google}` && link.pathname === '/auth', t);
check('link asks for offline access + consent', link.searchParams.get('access_type') === 'offline' && link.searchParams.get('prompt') === 'consent');
check('link has both scopes, redirect uri', SC.every((s) => link.searchParams.get('scope').includes(s)) && link.searchParams.get('redirect_uri') === 'https://example.ngrok-free.dev/oauth/google/callback');
check('send-nothing scope (no gmail.send/readonly)', !/gmail\.(send|readonly|modify)|mail\.google\.com/.test(link.searchParams.get('scope')));
const state1 = link.searchParams.get('state');
check('forged state rejected', (await callback('code=GOODCODE&state=deadbeef')).status === 400);
check('cancelled sign-in handled', (await callback('error=access_denied&state=' + state1)).status === 400);
check('nothing stored after failures', !fs.existsSync(connFile));
t = await say(111, '/connections');
check('/connections: nothing yet', /Google: not connected/.test(t), t);

// no refresh token
let s2 = stateFrom(await say(111, '/connect'));
let r = await callback(`code=NOREFRESH&state=${s2}`);
check('missing refresh token refused', r.status === 400 && /lasting access/.test(await r.text()));
s2 = stateFrom(await say(111, '/connect'));
r = await callback(`code=PARTIAL&state=${s2}`);
check('unticked permissions refused', r.status === 400 && /unticked/.test(await r.text()));
check('still not connected', /Google: not connected/.test(await say(111, '/connections')));

// good sign-in
const s3 = stateFrom(await say(111, '/connect'));
const before = sent.length;
r = await callback(`code=GOODCODE&state=${s3}`);
const html = await r.text();
check('good sign-in succeeds', r.status === 200 && /Connected/.test(html), html);
check('response not cached / no referrer', r.headers.get('cache-control') === 'no-store' && r.headers.get('referrer-policy') === 'no-referrer');
await new Promise((x) => setTimeout(x, 300));
check('bot messages the chat with the account', sent.slice(before).some((m) => m.chat_id === '111' && /connected as owner@biz\.com/.test(m.text)), JSON.stringify(sent.slice(before)));
check('state is single-use', (await callback(`code=GOODCODE&state=${s3}`)).status === 400);

console.log('[vault]');
const file = fs.readFileSync(connFile, 'utf8');
check('refresh token not stored in plain text', !file.includes('RT1'));
check('email + date stored readable', file.includes('owner@biz.com') && file.includes('connectedAt'));
check('file is owner-only (0600)', (fs.statSync(connFile).mode & 0o777) === 0o600);
check('/connections shows the account', /connected as owner@biz\.com/.test(await say(111, '/connections')));

console.log('[using the connection]');
t = await say(111, 'draft an email to John (john@acme.com) about Friday');
check('draft saved to Gmail', /Saved to your Gmail drafts/.test(t) && g.drafts.length === 1, t);
let d = g.drafts[0] || '';
check('draft has To header', /^To: john@acme\.com/m.test(d), d);
const subj = /^Subject: =\?UTF-8\?B\?(.+)\?=/m.exec(d)?.[1];
check('subject encoded, unicode intact', subj && Buffer.from(subj, 'base64').toString() === 'Café Friday — ünïcode');
const bodyB64 = d.split('\r\n\r\n')[1] || '';
check('body intact', Buffer.from(bodyB64.replace(/\s/g, ''), 'base64').toString() === 'Can we move Friday?\nThanks');
check('refreshed the short-lived token', g.tokenCalls.some((c) => c.grant_type === 'refresh_token'));
check('nothing was sent (no send endpoint hit)', g.badAuth === 0);

draftRecipient = 'a@b.com\nBcc: spy@evil.com';
await say(111, 'draft an email to a@b.com');
const inj = g.drafts[1] || '';
check('header injection neutralised', !/^Bcc:/mi.test(inj), inj);
draftRecipient = 'John';
t = await say(111, 'draft an email to John');
check('name-only recipient: no bogus To header, owner told', !/^To:/m.test(g.drafts[2] || '') && /add it before sending/.test(t), t);
draftRecipient = 'john@acme.com';
const nd = g.drafts.length;
t = await say(111, 'draft an email to John about Friday'); // the model "knows" john@acme.com — but they never said it
check('an address the model made up is NOT used: no To header, owner told to add one', g.drafts.length === nd + 1 && !/^To:/m.test(g.drafts[nd] || '') && /add it before sending/.test(t), t + (g.drafts[nd] || ''));

t = await say(111, "what's on my calendar today?");
check('calendar lists events', /Dentist/.test(t) && /Payroll day/.test(t) && /all day/.test(t), t);
t = await say(111, "what's on my calendar tomorrow?");
const q = g.calendarQuery;
check('tomorrow window is a day starting tomorrow', q && new Date(q.timeMax) - new Date(q.timeMin) === 864e5 && new Date(q.timeMin) > new Date(Date.now() + 1000));

console.log('[isolation]');
const code = /start=(\w+)/.exec(await say(111, '/invite Other Biz'))[1];
await say(222, `/start ${code}`);
t = await say(222, "what's on my calendar today?");
check('other business has no calendar access', /isn't connected/.test(t), t);
t = await say(222, 'draft an email to John');
check('other business gets local draft + tip, no Gmail draft', /Nothing was sent/.test(t) && /\/connect/.test(t) && g.drafts.length === 4, `${t} drafts=${g.drafts.length}`);
check('/connections is per business', /Google: not connected/.test(await say(222, '/connections')));

console.log('[persistence]');
app.proc.kill(); await new Promise((x) => setTimeout(x, 300));
app = startApp(); await waitUp();
t = await say(111, "what's on my calendar today?");
check('connection survives restart', /Dentist/.test(t), t);

console.log('[expiry + disconnect]');
g.refreshRevoked = true;
t = await say(111, 'draft an email to John');
check('revoked/expired token: falls back + asks to reconnect', /Nothing was sent/.test(t) && /\/connect to reconnect/.test(t), t);
check('dead connection cleaned up', /Google: not connected/.test(await say(111, '/connections')));
g.refreshRevoked = false;
await callback(`code=GOODCODE&state=${stateFrom(await say(111, '/connect'))}`);
await new Promise((x) => setTimeout(x, 300));
t = await say(111, '/disconnect');
check('/disconnect asks first', /Disconnect Google\?.*\(yes\/no\)/s.test(t), t);
check('answering no changes nothing', /nothing was changed/i.test(await say(111, 'no')) && /connected as owner@biz\.com/.test(await say(111, '/connections')));
await say(111, '/disconnect_google');
t = await say(111, 'yes');
check('/disconnect works after yes', /Disconnected/.test(t), t);
check('token revoked at Google', g.revoked.includes('RT1'));
check('secret gone from disk', !fs.readFileSync(connFile, 'utf8').includes('"google"'));
t = await say(111, "what's on my calendar today?");
check('calendar needs reconnect after disconnect', /isn't connected/.test(t), t);

console.log('[/remove cleans up]');
await callback(`code=GOODCODE&state=${stateFrom(await say(111, '/connect'))}`);
// connect business 222 too, via a state minted for it
const s222 = stateFrom(await say(222, '/connect'));
await callback(`code=GOODCODE&state=${s222}`);
await new Promise((x) => setTimeout(x, 300));
await say(111, '/remove 222');
check('removing a business drops its connection', !JSON.parse(fs.readFileSync(connFile, 'utf8')).connections['222']);

console.log('[misconfiguration]');
app.proc.kill(); await new Promise((x) => setTimeout(x, 300));
app = startApp({ TOKEN_ENCRYPTION_KEY: 'tooshort' }); await waitUp();
check('bad key: google disabled, bot still runs', /Connections disabled/.test(app.getLog()));
check('/connect explains', /aren't set up/.test(await say(111, '/connect')));
check('normal chat still works', /Hi there/.test(await say(111, 'hello')));
app.proc.kill(); await new Promise((x) => setTimeout(x, 300));
app = startApp({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', TOKEN_ENCRYPTION_KEY: '' }); await waitUp();
check('no config: bot runs, draft is local', /Nothing was sent/.test(await say(111, 'draft an email to John')));

app.proc.kill(); tg.close(); ollama.close(); google.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
