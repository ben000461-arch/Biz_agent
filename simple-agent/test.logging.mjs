// Action-log test with a FAKE Telegram, FAKE Ollama and FAKE Supabase. Not shipped.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { createLogger } from './logger.js';

const ports = { tg: 18701, ollama: 18702, app: 18703, sb: 18704 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-log-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL:', m); } };

const sent = [];
const tg = http.createServer((req, res) => {
  const ch = []; req.on('data', (c) => ch.push(c));
  req.on('end', () => {
    const m = req.url.split('/').pop();
    if (m === 'sendMessage') { const b = JSON.parse(Buffer.concat(ch).toString()); sent.push({ chat: String(b.chat_id), text: b.text }); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(m === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} }));
  });
});
const ollama = http.createServer((req, res) => {
  const ch = []; req.on('data', (c) => ch.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(ch).toString());
    const system = body.messages[0].content; const user = body.messages[body.messages.length - 1].content;
    let out;
    if (system.includes('You are a helpful, direct assistant')) out = { reply: 'Hello there.' };
    else if (/^add \d+ and \d+/.test(user)) { const [, a, b] = /add (\d+) and (\d+)/.exec(user); out = { action: 'add', a: +a, b: +b }; }
    else if (/spreadsheet of/i.test(user)) out = { action: 'write_excel', filename: 'expenses', sheet_rows: [['Item', 'Cost'], ['Rent', 1200]] };
    else if (/draft an email/i.test(user)) out = { action: 'draft_email', recipient: 'zed@example.com', email_subject: 'Secret subject', email_body: 'SECRETBODY' };
    else out = { action: 'chat' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify(out) } }));
  });
});

// fake Supabase: records every POST; can be switched to fail
const rows = []; const reqs = []; let sbFail = false;
const sb = http.createServer((req, res) => {
  const ch = []; req.on('data', (c) => ch.push(c));
  req.on('end', () => {
    reqs.push({ url: req.url, headers: req.headers });
    if (sbFail) { res.statusCode = 500; return res.end('{}'); }
    try { for (const r of JSON.parse(Buffer.concat(ch).toString())) rows.push(r); } catch {}
    res.statusCode = 201; res.end('');
  });
});
for (const [s, p] of [[tg, ports.tg], [ollama, ports.ollama], [sb, ports.sb]]) await new Promise((r) => s.listen(p, r));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- unit: logger on its own ----------------------------------------------
{
  const off = createLogger({});
  ok(off.enabled === false, 'off without settings');
  off.log({ chat_id: '1', kind: 'action' }); ok(off.pending() === 0, 'off logger buffers nothing');

  const got = [];
  const lg = createLogger({ url: `http://127.0.0.1:${ports.sb}/`, key: 'sb_secret_abc', fetchImpl: async (u, o) => { got.push({ u, o }); return { ok: true }; } });
  lg.log({ chat_id: '9', kind: 'action', action: 'add', status: 'done', text: 'MY PRIVATE MESSAGE', email_body: 'BODY', detail: 'a\nb', ms: 12.4 });
  await lg.flush();
  const sentRow = JSON.parse(got[0].o.body)[0];
  ok(!JSON.stringify(sentRow).includes('PRIVATE') && !JSON.stringify(sentRow).includes('BODY'), 'unknown fields (message text) are dropped');
  ok(sentRow.detail === 'a b' && sentRow.ms === 12, 'newlines flattened, ms rounded');
  ok(got[0].u.endsWith('/rest/v1/agent_logs') && !got[0].u.includes('//rest'), 'url built cleanly');
  ok(got[0].o.headers.apikey === 'sb_secret_abc' && !got[0].o.headers.authorization, 'new-style key: apikey only');

  const got1 = [];
  const lgU = createLogger({ url: 'https://abc.supabase.co/rest/v1/', key: 'k', fetchImpl: async (u) => { got1.push(u); return { ok: true }; } });
  lgU.log({ chat_id: '1', kind: 'chat' }); await lgU.flush();
  ok(got1[0] === 'https://abc.supabase.co/rest/v1/agent_logs', 'URL pasted with /rest/v1/ still works: ' + got1[0]);

  const got2 = [];
  const lg2 = createLogger({ url: 'http://x', key: 'eyJabc', fetchImpl: async (u, o) => { got2.push(o); return { ok: true }; } });
  lg2.log({ chat_id: '1', kind: 'chat' }); await lg2.flush();
  ok(got2[0].headers.authorization === 'Bearer eyJabc', 'JWT key also sent as bearer');

  let n = 0;
  const lg3 = createLogger({ url: 'http://x', key: 'k', fetchImpl: async () => { n++; if (n === 1) return { ok: false, status: 500 }; return { ok: true }; } });
  lg3.log({ chat_id: '1', kind: 'action', action: 'a' }); await lg3.flush();
  ok(lg3.pending() === 1 && /500/.test(lg3.lastError() || ''), 'failed write is kept for retry');
  lg3.log({ chat_id: '1', kind: 'action', action: 'b' }); await lg3.flush();
  ok(lg3.pending() === 0 && n === 2, 'retried together with the next row');

  const lg4 = createLogger({ url: 'http://x', key: 'k', maxBuffer: 3, fetchImpl: async () => { throw new Error('down'); } });
  for (let i = 0; i < 10; i++) lg4.log({ chat_id: '1', kind: 'action', action: String(i) });
  await lg4.flush();
  ok(lg4.pending() === 3, 'buffer is capped');
  const lg5 = createLogger({ url: 'http://x', key: 'k', fetchImpl: async () => { throw new Error('boom'); } });
  let threw = false; try { lg5.log({ chat_id: '1', kind: 'action' }); await lg5.flush(); } catch { threw = true; }
  ok(!threw, 'logger never throws');
}

// ---- the whole bot ----------------------------------------------------------
function startApp(env) {
  const proc = spawn('node', ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, GROQ_API_KEY: '', HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
      TELEGRAM_API_BASE: `http://127.0.0.1:${ports.tg}`, OLLAMA_HOST: `http://127.0.0.1:${ports.ollama}`, PORT: String(ports.app),
      TENANTS_FILE: path.join(tmp, 'data', 'tenants.json'), WORKSPACES_DIR: path.join(tmp, 'ws'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
  return { proc, log: () => log };
}
async function waitUp() { for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${ports.app}/health`)).ok) return; } catch {} await sleep(100); } throw new Error('no start'); }
let uid = 5000;
const say = (text, chat = 111) => fetch(`http://127.0.0.1:${ports.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' },
  body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat, username: 'u' }, text } }) });

const app = startApp({ SUPABASE_URL: `http://127.0.0.1:${ports.sb}`, SUPABASE_SERVICE_KEY: 'sb_secret_test' });
try {
  await waitUp();
  ok(/action log: on/.test(app.log()), 'startup says action log is on');

  await say('add 2 and 3'); await sleep(500);
  await say('draft an email to zed@example.com saying hi, subject Secret subject'); await sleep(500);
  await say('make a spreadsheet of my expenses'); await sleep(500);
  await say('no'); await sleep(500);
  await say('what time is it'); await sleep(500);
  await say('/help'); await sleep(500);
  await say('sell my car and wire the money'); await sleep(600);

  const by = (f) => rows.filter(f);
  ok(by((r) => r.action === 'add' && r.status === 'done' && r.kind === 'action').length === 1, 'add logged as done');
  ok(by((r) => r.action === 'write_excel' && r.status === 'asked').length === 1, 'confirmation logged as asked');
  ok(by((r) => r.action === 'write_excel' && r.status === 'cancelled').length === 1, 'cancel logged');
  ok(by((r) => r.action === 'fact' && r.kind === 'chat').length >= 1, 'fact reply logged as chat');
  ok(by((r) => r.kind === 'command' && r.action === '/help').length === 1, 'command logged by name only');
  ok(rows.every((r) => r.chat_id === '111' && r.business), 'rows carry chat id and business');
  ok(rows.every((r) => r.ts === undefined), 'ts left to the database default');

  const all = JSON.stringify(rows);
  for (const secret of ['SECRETBODY', 'zed@example.com', 'Secret subject', 'sell my car', 'wire the money', 'what time', 'add 2 and 3', 'my expenses']) {
    ok(!all.includes(secret), `no message text in the log: "${secret}"`);
  }
  ok(reqs.every((r) => r.headers.apikey === 'sb_secret_test'), 'every write used the key');

  // Supabase down: the bot must keep working, and catch up later
  sbFail = true; const before = rows.length; sent.length = 0;
  await say('add 4 and 5'); await sleep(600);
  ok(sent.some((m) => /4 \+ 5 = 9/.test(m.text)), 'bot still answers while the log is down');
  sbFail = false;
  await say('add 6 and 7'); await sleep(800);
  ok(sent.some((m) => /6 \+ 7 = 13/.test(m.text)), 'bot answers after recovery');
  ok(rows.length - before >= 2, 'missed rows were caught up');
} finally {
  app.proc.kill();
}

// ---- off by default ----------------------------------------------------------
const before2 = reqs.length;
const app2 = startApp({ SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '' });
try {
  await waitUp();
  ok(/action log: off/.test(app2.log()), 'startup says action log is off');
  await say('add 1 and 1'); await sleep(500);
  ok(reqs.length === before2, 'nothing written when off');
} finally { app2.proc.kill(); }

console.log(`logging: ${pass} passed, ${fail} failed`);
for (const s of [tg, ollama, sb]) s.close();
process.exit(fail ? 1 : 0);
