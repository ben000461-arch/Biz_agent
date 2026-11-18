// Agents that run before calendar events. FAKE Telegram, Ollama and Google.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { parseSchedule, describeSchedule, nextRuns, localDate, fromLocal, startOfLocalDay } from './when.js';

const P = { tg: 18711, ollama: 18712, app: 18713, google: 18714 };
const TZ = 'America/Los_Angeles';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ev-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');
fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('[pure: schedule parsing and run times]');
const S = (t) => parseSchedule(t, { tz: TZ });
check('"30 minutes before every meeting"', S('30 minutes before every meeting')?.kind === 'before_event' && S('30 minutes before every meeting').minutes === 30);
check('"an hour before each appointment" = 60', S('an hour before each appointment')?.minutes === 60);
check('"before every meeting" = 30', S('before every meeting')?.minutes === 30);
check('"15 min before my meetings"', S('15 min before my meetings')?.minutes === 15);
check('too small/large are refused', !S('1 minute before every meeting') && !S('10 hours before every meeting'), JSON.stringify([S('1 minute before every meeting'), S('10 hours before every meeting')]));
check('describes in plain words', /30 minutes before each calendar event/.test(describeSchedule({ kind: 'before_event', minutes: 30 }, TZ)), describeSchedule({ kind: 'before_event', minutes: 30 }, TZ));
check('existing schedules still parse', S('every weekday at 8am')?.kind === 'daily' && S('only when I ask')?.kind === 'manual' && S('tomorrow at 9am')?.kind === 'once');
const now = new Date('2026-10-26T20:00:00Z'); // 1pm PDT Monday
check('localDate in the owner\'s zone', localDate(new Date('2026-10-27T03:00:00Z'), TZ) === '2026-10-26');
check('startOfLocalDay is midnight local', startOfLocalDay(now, TZ).toISOString() === '2026-10-26T07:00:00.000Z', startOfLocalDay(now, TZ).toISOString());
check('fromLocal builds a UTC time (DST aware)', fromLocal('2026-10-27', '09:30', TZ)?.toISOString() === '2026-10-27T16:30:00.000Z' && fromLocal('2026-12-01', '09:30', TZ)?.toISOString() === '2026-12-01T17:30:00.000Z');
check('fromLocal refuses nonsense', !fromLocal('nope', '09:00', TZ) && !fromLocal('2026-10-27', '25:00', TZ) && !fromLocal('2026-02-31', '09:00', TZ));
const runs = nextRuns({ kind: 'daily', time: '08:00', days: [1, 2, 3, 4, 5] }, { now, tz: TZ, days: 7 });
check('daily weekday runs: 5 in the next 7 days, in order, all in the future', runs.length === 5 && runs.every((d, i) => d > now && (i === 0 || d > runs[i - 1])), JSON.stringify(runs));
check('once in range lists, once out of range does not', nextRuns({ kind: 'once', at: '2026-10-28T16:00:00.000Z' }, { now, tz: TZ, days: 7 }).length === 1 && nextRuns({ kind: 'once', at: '2026-12-28T16:00:00.000Z' }, { now, tz: TZ, days: 7 }).length === 0);
check('manual and before_event have no fixed run times', nextRuns({ kind: 'manual' }, { now, tz: TZ, days: 7 }).length === 0 && nextRuns({ kind: 'before_event', minutes: 30 }, { now, tz: TZ, days: 7 }).length === 0);

// ---- the real bot
const sent = [], agentCalls = [];
const tg = http.createServer(async (req, res) => {
  const method = req.url.split('/').pop(); const raw = await readBody(req);
  if (method === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
  json(res, 200, method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} });
});
const ollama = http.createServer(async (req, res) => {
  const b = JSON.parse(await readBody(req)); const s = b.messages[0].content, u = b.messages[b.messages.length - 1].content;
  let out;
  if (s.includes('a small automated agent')) { agentCalls.push(u); out = { reply: `Heads up: ${/Board review/.test(u) ? 'Board review is coming.' : /Standup/.test(u) ? 'Standup is coming.' : 'a meeting is coming.'}` }; }
  else if (s.includes('helpful, direct assistant')) out = { reply: 'Hi.' };
  else out = { action: 'chat' };
  json(res, 200, { message: { content: JSON.stringify(out) } });
});
const SC = ['https://www.googleapis.com/auth/gmail.compose', 'https://www.googleapis.com/auth/calendar.events'];
const g = { items: [], hits: 0 };
const google = http.createServer(async (req, res) => {
  const raw = await readBody(req); const url = new URL(req.url, 'http://x');
  if (url.pathname === '/token') { const p = new URLSearchParams(raw); return json(res, 200, p.get('grant_type') === 'authorization_code' ? { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, scope: SC.join(' ') } : { access_token: 'AT2', expires_in: 3600 }); }
  if (url.pathname === '/revoke') return json(res, 200, {});
  if (url.pathname === '/gmail/users/me/profile') return json(res, 200, { emailAddress: 'o@biz.com' });
  if (url.pathname === '/calendar/calendars/primary/events') {
    g.hits++;
    const lo = Date.parse(url.searchParams.get('timeMin') || 0), hi = Date.parse(url.searchParams.get('timeMax') || 9e15);
    return json(res, 200, { items: g.items.filter((e) => Date.parse(e.start.dateTime || e.start.date) < hi && Date.parse(e.end.dateTime || e.end.date) > lo) });
  }
  json(res, 404, {});
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [google, P.google]]) await new Promise((r) => s.listen(p, r));
const gv = `http://127.0.0.1:${P.google}`;
const startApp = () => {
  const proc = spawn('node', ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env, TZ, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', GROQ_API_KEY: '', HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
      TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app),
      TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: path.join(tmp, 'conn.json'), PUBLIC_URL: 'https://example.ngrok-free.dev',
      GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csecret', TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      GOOGLE_AUTH_BASE: `${gv}/auth`, GOOGLE_TOKEN_URL: `${gv}/token`, GOOGLE_REVOKE_URL: `${gv}/revoke`, GMAIL_API_BASE: `${gv}/gmail`, CALENDAR_API_BASE: `${gv}/calendar`,
      AGENT_TICK_MS: '300', EVENT_POLL_MS: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
  return { proc, log: () => log };
};
const up = async () => { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) return; } catch {} await wait(100); } throw new Error('no start'); };
const stop = (a) => new Promise((r) => { a.proc.once('exit', r); a.proc.kill('SIGTERM'); setTimeout(() => a.proc.kill('SIGKILL'), 2000); });
let uid = 9000;
async function say(chat, text, ms = 900) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  await wait(ms);
  return sent.slice(start).map((m) => m.text).join('\n---\n');
}
const stateFrom = (txt) => new URL(/https?:\/\/\S+/.exec(txt)[0]).searchParams.get('state');
const mins = (m) => new Date(Date.now() + m * 60000).toISOString();
const ev = (id, title, startISO, endISO) => ({ id, summary: title, start: { dateTime: startISO }, end: { dateTime: endISO || new Date(Date.parse(startISO) + 3600000).toISOString() } });
const ag = (extra) => ({ id: 'abeef1', name: 'Pre-meeting', purpose: 'Brief me before meetings', info: '', tools: ['calendar'], sheet: null, schedule: { kind: 'before_event', minutes: 30 }, enabled: true, model: 'coop', createdAt: mins(-600), lastRunAt: null, lastStatus: null, runs: 0, armedAt: mins(-600), briefed: {}, ...extra });
const writeTenants = (agents) => fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants: { 111: { chatId: '111', name: 'Owner', isAdmin: true, createdAt: mins(-9000), tools: ['files', 'email', 'spreadsheets', 'utilities', 'calendar'], instructions: '', schemaVersion: 3, agents } } }));
const connect = async () => { const t = await say(111, '/connect'); await fetch(`http://127.0.0.1:${P.app}/oauth/google/callback?code=GOODCODE&state=${stateFrom(t)}`); await wait(300); };

writeTenants([ag()]);
let app = startApp(); await up();

try {
  console.log('\n[before Google is connected]');
  g.items = [ev('x1', 'Board review', mins(20))];
  await wait(1200);
  check('nothing runs and the calendar is not touched', agentCalls.length === 0 && g.hits === 0, `${agentCalls.length} ${g.hits}`);

  console.log('\n[connected: which events trigger a brief]');
  g.items = [
    ev('e20', 'Board review', mins(20)), ev('e180', 'Far away', mins(180)), ev('e1', 'Too soon', mins(1)), ev('eold', 'Started already', mins(-10)),
    { id: 'eall', summary: 'All day thing', start: { date: new Date().toISOString().slice(0, 10) }, end: { date: new Date(Date.now() + 864e5).toISOString().slice(0, 10) } },
  ];
  await connect();
  await wait(1800);
  check('exactly one brief, for the meeting 20 minutes away', agentCalls.length === 1 && /Board review/.test(agentCalls[0]), JSON.stringify(agentCalls.map((x) => x.slice(0, 200))));
  const briefMsgs = sent.filter((m) => /Board review is coming/.test(m.text));
  check('it was sent to the owner on Telegram', briefMsgs.length === 1 && briefMsgs[0].chat_id === '111');
  check('the others were skipped (far, too soon, already started, all-day)', !agentCalls.some((x) => /Far away|Too soon|Started already|All day thing/.test(x.split('Board review')[0] || '')) );
  await wait(1500);
  check('polling again does not send it twice', agentCalls.length === 1);
  const saved = JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['111'].agents[0];
  check('it remembers it briefed that meeting (and counts a run)', Object.keys(saved.briefed || {}).length === 1 && saved.runs === 1 && saved.lastStatus, JSON.stringify(saved));

  console.log('\n[a meeting that moves into range later, and restart safety]');
  g.items.push(ev('elater', 'Standup', mins(33)));
  await wait(1200);
  check('a meeting 33 minutes away waits (outside the 30-minute lead)', agentCalls.length === 1);
  g.items = g.items.filter((e) => e.id !== 'elater'); g.items.push(ev('elater', 'Standup', mins(25))); // time passes / it moves closer
  await wait(1500);
  check('once it is within 30 minutes it gets its own brief', agentCalls.length === 2 && /Standup/.test(agentCalls[1]), JSON.stringify(agentCalls.map((x) => x.slice(0, 80))));
  await stop(app);
  const before = agentCalls.length;
  app = startApp(); await up(); await wait(1800);
  check('after a restart nothing is sent again', agentCalls.length === before, `${agentCalls.length} vs ${before}`);

  console.log('\n[pause + daily cap]');
  const ids = JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['111'].agents[0].id;
  await say(111, '/agent pause 1');
  g.items.push(ev('epaused', 'While paused', mins(15)));
  const b2 = agentCalls.length; await wait(1500);
  check('a paused agent sends nothing', agentCalls.length === b2);
  await say(111, '/agent resume 1');
  await wait(1500);
  check('resumed: it briefs the meeting that is still ahead', agentCalls.length === b2 + 1 && /While paused/.test(agentCalls[agentCalls.length - 1]), JSON.stringify(agentCalls.slice(-1)));

  console.log('\n[practise run]');
  g.items = [ev('e-prac', 'Investor call', mins(300))];
  let t = await say(111, '/agent run 1');
  check('/agent run practises on the next meeting within a day', /Investor call|meeting is coming/.test(t), t);
  g.items = [];
  t = await say(111, '/agent run 1');
  check('with no meeting coming up it says so plainly', /don.t see a meeting|no meeting|nothing coming/i.test(t), t);

  console.log('\n[wizard]');
  await say(111, '/agent delete 1'); await say(111, 'yes');
  t = await say(111, 'build an agent');
  t += await say(111, 'brief me on my meetings'); t += await say(111, 'skip'); t += await say(111, 'calendar');
  t += await say(111, '30 minutes before every meeting');
  check('wizard accepts "30 minutes before every meeting" and asks to confirm', /30 minutes before each calendar event/.test(t) && /(yes|create)/i.test(t), t.slice(-500));
  t = await say(111, 'yes');
  const made = JSON.parse(fs.readFileSync(tenantsFile, 'utf8')).tenants['111'].agents;
  check('agent created with a before_event schedule', made.length === 1 && made[0].schedule.kind === 'before_event' && made[0].schedule.minutes === 30, t + JSON.stringify(made));

  check('no crashes or secrets in the log', !/TypeError|ReferenceError|Unhandled|AT1|RT1|csecret/.test(app.log()), app.log().slice(-400));
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await stop(app);
  for (const s of [tg, ollama, google]) s.close();
  setTimeout(() => process.exit(fail ? 1 : 0), 200);
}
