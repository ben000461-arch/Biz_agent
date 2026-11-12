// eval-models.mjs — runs the model test set through the REAL bot with the REAL hosted models and tells you
// which model setup handles real requests best (across six kinds of small business), how many tokens each request uses, and what it costs.
//
//   node eval-models.mjs                       all three setups (about 10 minutes)
//   node eval-models.mjs --configs starter     just one:  starter (20b everywhere) | pro (20b routes, 120b chats) | all120 (120b everywhere)
//   node eval-models.mjs --delay 2500          wait longer between requests if Groq says "too many requests"
//   node eval-models.mjs --only sheet          only cases whose category or text contains this word
//   node eval-models.mjs --fake                no Groq at all: just checks the test itself works
//
// Safe by design: Telegram, Supabase and the local model are fakes, so nothing real is sent or stored.
// Your Groq key is read from your .env by the bot, never printed. Only YOUR test sentences are written to the report.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { CASES } from './eval-cases.mjs';
import XLSX from 'xlsx';
import dotenv from 'dotenv';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i < 0 ? def : args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true; };
const delay = Number(opt('delay', 1200));
const TPM = Number(opt('tpm', 6000)); // stay under this many tokens a minute (Groq's free tier is small); --tpm 0 turns pacing off
const LIMIT = Number(opt('limit', 0));
const FAKE = Boolean(opt('fake', false));
const only = String(opt('only', '') || '').toLowerCase();
const wanted = String(opt('configs', 'starter,pro,all120')).split(',');
const SMALL = 'openai/gpt-oss-20b', LARGE = 'openai/gpt-oss-120b';
const CONFIGS = {
  starter: { label: '20b everywhere (Starter)', plan: 'starter', env: {} },
  pro: { label: '20b routes, 120b chats (Pro)', plan: 'pro', env: {} },
  all120: { label: '120b everywhere', plan: 'pro', env: { LLM_SMALL_MODEL: LARGE } },
};
// Groq's listed prices, dollars per million tokens (check your Groq console)
const PRICE = { [SMALL]: { in: 0.07, out: 0.30 }, [LARGE]: { in: 0.15, out: 0.60 } };

const INDUSTRIES = {
  hvac: { name: 'Eval Heating and Air', about: 'a small HVAC company', inv: [['Filters', 40], ['Thermostats', 6], ['Capacitors', 12]], extra: {} },
  construction: { name: 'Eval Builders', about: 'a small general contractor doing remodels and additions', inv: [['2x4 studs', 300], ['Drywall sheets', 80], ['Screws (boxes)', 25]], extra: { jobcosts: [['Job', 'Item', 'Cost'], ['Miller kitchen', 'Cabinets', 6400]] } },
  law: { name: 'Eval Law Office', about: 'a small law office; the agent handles scheduling and client communication and never gives legal advice', inv: [['Printer paper (reams)', 12], ['Toner', 3]], extra: { billing: [['Client', 'Matter', 'Billed'], ['Hernandez', 'Lease dispute', 1200]], matters: [['Client', 'Matter', 'Deadline'], ['Nguyen', 'Contract review', '2026-11-12']] } },
  salon: { name: 'Eval Hair Studio', about: 'a hair salon with four stylists', inv: [['Shampoo', 14], ['Color tubes', 60]], extra: { bookings: [['Client', 'Service', 'Time'], ['Sarah', 'Color', 'Fri 2pm']], supplies: [['Item', 'Qty'], ['Shampoo', 14], ['Foils', 8]] } },
  bakery: { name: 'Eval Bakery and Cafe', about: 'a small bakery and cafe', inv: [['Flour (lb)', 120], ['Butter (lb)', 30]], extra: { supplies: [['Item', 'Qty'], ['Flour (lb)', 120], ['Sugar (lb)', 60], ['Eggs (dozen)', 40]] } },
  realty: { name: 'Eval Realty', about: 'a two-agent real estate office', inv: [['Yard signs', 20], ['Lockboxes', 4]], extra: { listings: [['Address', 'Price', 'Status'], ['22 Pine', 420000, 'Active']] } },
};
const ORDER = Object.keys(INDUSTRIES);
let rot = 0;
const cases0 = CASES.map((c) => ({ ...c, biz: c.biz || ORDER[rot++ % ORDER.length] })).filter((c) => !only || c.cat.includes(only) || c.t.toLowerCase().includes(only));
const cases = LIMIT ? cases0.filter((_, i) => i % Math.ceil(cases0.length / LIMIT) === 0) : cases0;
const here = path.dirname(new URL(import.meta.url).pathname);
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); });
const json = (res, code, body) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 19100 + Math.floor(Math.random() * 500) * 10;

async function runConfig(key) {
  const cfg = CONFIGS[key];
  const P = { tg: nextPort++, sb: nextPort++, ollama: nextPort++, groq: nextPort++, app: nextPort++ };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-eval-'));
  fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
  const sent = [], reactions = [], logs = [];
  const rows = {};
  const ledger = [];

  const tg = http.createServer(async (req, res) => {
    const m = req.url.split('/').pop(); const raw = await readBody(req);
    if (m === 'sendMessage') { const b = JSON.parse(raw); sent.push({ chat: String(b.chat_id), text: b.text }); }
    if (m === 'setMessageReaction') { const b = JSON.parse(raw); reactions.push(String(b.chat_id)); }
    json(res, 200, m === 'getMe' ? { ok: true, result: { username: 'EvalBot' } } : { ok: true, result: {} });
  });
  const sb = http.createServer(async (req, res) => {
    const raw = await readBody(req); const u = new URL(req.url, 'http://x');
    if (u.pathname.endsWith('/agent_logs')) { const b = JSON.parse(raw || '[]'); for (const r of [].concat(b)) logs.push(r); return json(res, 201, []); }
    if (u.pathname.endsWith('/credit_ledger')) {
      if (req.method === 'GET') { const chat = /eq\.(-?\d+)/.exec(u.search)?.[1]; const cycle = /cycle=eq\.([\d-]+)/.exec(u.search)?.[1]; return json(res, 200, ledger.filter((r) => r.chat_id === chat && r.cycle === cycle)); }
      const row = JSON.parse(raw);
      if (row.reason === 'grant' && ledger.some((r) => r.chat_id === row.chat_id && r.cycle === row.cycle && r.reason === 'grant')) return json(res, 409, {});
      ledger.push({ ts: new Date().toISOString(), ...row }); return json(res, 201, []);
    }
    if (u.pathname.endsWith('/tenant_plans')) {
      const chat = /eq\.(-?\d+)/.exec(u.search)?.[1];
      if (req.method === 'GET') return json(res, 200, rows[chat] ? [rows[chat]] : []);
      if (req.method === 'PATCH') { res.statusCode = 204; return res.end(); }
      return json(res, 201, rows[chat] ? [rows[chat]] : []);
    }
    json(res, 200, []);
  });
  const ollama = http.createServer(async (req, res) => { await readBody(req); json(res, 200, { message: { content: JSON.stringify({ action: 'chat', reply: 'local fallback answer' }) } }); });
  const servers = [[tg, P.tg], [sb, P.sb], [ollama, P.ollama]];
  if (FAKE) {
    const groq = http.createServer(async (req, res) => {
      const b = JSON.parse(await readBody(req)); const sys = b.messages[0].content;
      const user = (b.messages[b.messages.length - 1]?.content || '').toLowerCase();
      const guess = /(\d+)\s*(plus|\+)\s*(\d+)|add \d+ \+ \d+/.test(user) ? { action: 'add', a: 1, b: 2 } : /weather|wheather|rain in/.test(user) ? { action: 'weather', location: 'Denver' } : /calend|calan|meetings|schedule|week look/.test(user) && !/schedule a meeting/.test(user) ? { action: 'list_events', when: 'today' } : /draft an email|write an? .*email|email my customer/.test(user) ? { action: 'draft_email', email_subject: 's', email_body: 'b', recipient: 'John' } : /show me the inventory|what's in my budget/.test(user) ? { action: 'view_excel', filename: /inventory/.test(user) ? 'inventory' : 'budget' } : /remember that|note:/.test(user) ? { action: 'add_note', note: 'x' } : { action: 'chat' };
      const out = sys.includes('You read a short message') ? guess : { reply: 'fake answer' };
      json(res, 200, { choices: [{ message: { content: JSON.stringify(out) } }], usage: { prompt_tokens: 900, completion_tokens: 60 } });
    });
    servers.push([groq, P.groq]);
  }
  for (const [s, p] of servers) await new Promise((r) => s.listen(p, r));

  // one business per test sentence, so no sentence can influence another
  const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
  const tenants = {};
  cases.forEach((c, i) => {
    const id = String(3000 + i);
    const ind = INDUSTRIES[c.biz];
    tenants[id] = { chatId: id, name: ind.name, isAdmin: false, createdAt: iso(-40), tools: ['files', 'email', 'spreadsheets', 'utilities', 'calendar'], instructions: `We are ${ind.about}.`, schemaVersion: 3 };
    rows[id] = { chat_id: id, plan: cfg.plan, ends_at: iso(20), cycle_anchor: iso(-5).slice(0, 10), created_at: iso(-5), last_reminder: null };
    const ws = path.join(tmp, 'ws', id); fs.mkdirSync(ws, { recursive: true });
    for (const [name, data] of [['inventory', [['Item', 'Qty'], ...ind.inv]], ...Object.entries(ind.extra), ['budget', [['Item', 'Amount'], ['Fuel', 800], ['Parts', 2500]]], ['jobs', [['Customer', 'Date', 'Price', 'Paid'], ['Smith', '2026-10-20', 450, 'no']]], ['expenses', [['Date', 'What', 'Amount'], ['2026-10-02', 'Gas', 52]]]]) {
      const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(data), 'Sheet1'); XLSX.writeFile(wb, path.join(ws, `${name}.xlsx`));
    }
  });
  const tenantsFile = path.join(tmp, 'data', 'tenants.json');
  fs.mkdirSync(path.dirname(tenantsFile), { recursive: true });
  fs.writeFileSync(tenantsFile, JSON.stringify({ invites: {}, tenants }));

  const env = {
    ...process.env, HOME: path.join(tmp, 'home'), TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '1', TELEGRAM_WEBHOOK_SECRET: 's',
    TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`, PORT: String(P.app),
    TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: path.join(tmp, 'conn.json'), MODELS_FILE: path.join(tmp, 'models.json'),
    SUPABASE_URL: `http://127.0.0.1:${P.sb}`, SUPABASE_SERVICE_KEY: 'eval_fake_key',
    GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', PUBLIC_URL: '', GITHUB_APP_ID: '', GITHUB_CLIENT_ID: '',
    ...cfg.env,
  };
  if (FAKE) { env.GROQ_API_KEY = 'gsk_fake'; env.GROQ_API_BASE = `http://127.0.0.1:${P.groq}/openai/v1`; }
  const proc = spawn('node', ['server.js'], { cwd: here, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await sleep(100); }
  if (!/Models: hosted on/.test(out)) { proc.kill(); servers.forEach(([s]) => s.close()); throw new Error(`The bot did not start with hosted models on. Is GROQ_API_KEY in your .env?\n${out.slice(0, 600)}`); }

  const results = [];
  const tokensTotal = (r) => (r.tokensIn || 0) + (r.tokensOut || 0);
  let upd = 100000;
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]; const chat = String(3000 + i);
    let mark, tries = 0;
    for (;;) {
    mark = { s: sent.length, l: logs.length, o: out.length };
    await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++upd, message: { chat: { id: Number(chat) }, from: { id: Number(chat) }, text: c.t, message_id: i + 1 } }) });
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) { await sleep(100); if (sent.slice(mark.s).some((m) => m.chat === chat) || reactions.includes(chat)) break; }
    await sleep(700); // let the action log catch up
    const hitLimit = /FALLBACK|failed after/.test(out.slice(mark.o));
    if (hitLimit && !FAKE && tries++ < 2) { process.stdout.write('~'); await sleep(25000); continue; } // a hosted model was skipped (usually a rate limit): wait and ask once more
    break;
    }
    const mine = logs.slice(mark.l).filter((r) => r.chat_id === chat);
    const first = mine.find((r) => ['action', 'chat', 'blocked', 'command', 'error'].includes(r.kind));
    const outcome = !first ? 'none' : first.kind === 'chat' ? (first.action || 'chat') : first.kind === 'error' ? (first.action && first.action !== 'unknown' ? first.action : 'error') : first.kind === 'blocked' ? (first.action === 'ask' ? 'ask' : first.action === 'chat' ? 'chat' : `blocked:${first.action}`) : first.action;
    const lines = out.slice(mark.o).split('\n').filter((l) => l.startsWith('[llm]'));
    for (const l of lines) { const m = /FALLBACK from \w+ \((.*)\)\s+tokens/.exec(l) || /failed after .*?: (.*)$/.exec(l); if (m) reasons.set(m[1].slice(0, 160), (reasons.get(m[1].slice(0, 160)) || 0) + 1); }
    let tin = { [SMALL]: 0, [LARGE]: 0 }, tout = { [SMALL]: 0, [LARGE]: 0 }, fallback = 0, failed = 0, ms = 0;
    for (const l of lines) {
      const m = /\((openai\/[\w.-]+)\) (\d+)ms.*tokens in\/out (\d+|\?)\/(\d+|\?)/.exec(l);
      if (m) { tin[m[1]] = (tin[m[1]] || 0) + (Number(m[3]) || 0); tout[m[1]] = (tout[m[1]] || 0) + (Number(m[4]) || 0); ms += Number(m[2]); }
      if (/FALLBACK/.test(l) || /\[llm\] local/.test(l)) fallback++;
      if (/failed after/.test(l)) failed++;
    }
    const cost = Object.keys(PRICE).reduce((a, k) => a + ((tin[k] || 0) * PRICE[k].in + (tout[k] || 0) * PRICE[k].out) / 1e6, 0);
    const reply0 = sent.slice(mark.s).find((m) => m.chat === chat)?.text || '';
    // a spreadsheet request whose file name could not be matched is answered before any action is logged: it was still routed to a spreadsheet
    const routed = outcome === 'none' && /spreadsheet/i.test(reply0) && /(couldn't find|which one did you mean|don't have any spreadsheets)/i.test(reply0) ? 'sheet-lookup' : outcome;
    const pass = c.ok.includes(routed) || (routed === 'sheet-lookup' && (c.ok.includes('edit_excel') || c.ok.includes('view_excel')));
    results.push({ cat: c.cat, biz: c.biz, t: c.t, want: c.ok, got: routed, pass, fallback, failed, ms, tokensIn: Object.values(tin).reduce((a, b) => a + b, 0), tokensOut: Object.values(tout).reduce((a, b) => a + b, 0), cost, reply: (sent.slice(mark.s).find((m) => m.chat === chat)?.text || '').slice(0, 160) });
    process.stdout.write(pass ? '.' : 'x');
    if (!FAKE && TPM) await sleep(Math.max(delay, Math.round(((tokensTotal(results.at(-1))) / TPM) * 60000)));
    else await sleep(delay);
  }
  process.stdout.write('\n');
  proc.kill(); servers.forEach(([s]) => s.close());
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  return results;
}


// ---- preflight: ask Groq directly, the same way the bot does, so a problem shows up here with its real reason
async function preflight() {
  dotenv.config({ path: path.join(here, '.env') });
  const key = process.env.GROQ_API_KEY || '';
  const base = (process.env.GROQ_API_BASE || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
  if (!key) { console.log('No GROQ_API_KEY found in your .env. Nothing to test.'); return false; }
  let ok = true;
  for (const model of [SMALL, LARGE]) {
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: 'Reply only with JSON: {"ok":true}' }, { role: 'user', content: 'hi' }], temperature: 0, max_completion_tokens: 200, response_format: { type: 'json_object' }, reasoning_effort: 'low' }),
        signal: AbortSignal.timeout(30000),
      });
      const h = (n) => res.headers.get(n);
      if (res.ok) console.log(`  Groq ${model}: OK   (requests left today ${h('x-ratelimit-remaining-requests') ?? '?'}, tokens left this minute ${h('x-ratelimit-remaining-tokens') ?? '?'}, limit ${h('x-ratelimit-limit-tokens') ?? '?'} tokens/min)`);
      else {
        ok = false;
        let msg = ''; try { msg = (JSON.parse(await res.text())?.error?.message || '').replace(/gsk_[A-Za-z0-9_-]+/g, '[key]').slice(0, 300); } catch {}
        console.log(`  Groq ${model}: FAILED with http ${res.status}${h('retry-after') ? ` (retry after ${h('retry-after')}s)` : ''}${msg ? `\n      Groq says: ${msg}` : ''}`);
      }
    } catch (e) { ok = false; console.log(`  Groq ${model}: could not connect (${e?.name || 'error'})`); }
  }
  return ok;
}
if (!FAKE && !opt('skip-preflight', false)) {
  console.log('Checking Groq first...');
  if (!(await preflight())) { console.log('\nFix that first (a rate limit usually clears in a minute or a day), then run again. Use --skip-preflight to run anyway.'); process.exit(1); }
}
const reasons = new Map();
const all = {};
for (const key of wanted) {
  if (!CONFIGS[key]) { console.log(`Unknown setup "${key}". Choose from: ${Object.keys(CONFIGS).join(', ')}`); process.exit(1); }
  console.log(`\n=== ${CONFIGS[key].label}  (${cases.length} requests${FAKE ? ', FAKE models' : ''})`);
  all[key] = await runConfig(key);
}

console.log('\n================ RESULTS ================');
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
for (const [key, rs] of Object.entries(all)) {
  const pass = rs.filter((r) => r.pass).length, fb = rs.filter((r) => r.fallback || r.failed).length;
  const cost = rs.reduce((a, r) => a + r.cost, 0), tin = rs.reduce((a, r) => a + r.tokensIn, 0), tout = rs.reduce((a, r) => a + r.tokensOut, 0);
  const avgMs = Math.round(rs.reduce((a, r) => a + r.ms, 0) / Math.max(1, rs.length));
  console.log(`\n${CONFIGS[key].label}`);
  console.log(`  correct: ${pass}/${rs.length} (${pct(pass, rs.length)})   fell back to local model or failed: ${fb}   model time per request: ${avgMs}ms`);
  console.log(`  tokens per request: ${Math.round(tin / rs.length)} in / ${Math.round(tout / rs.length)} out   cost per request: $${(cost / rs.length).toFixed(5)}   (${rs.length} requests: $${cost.toFixed(4)})`);
  const cats = {};
  for (const r of rs) { (cats[r.cat] ||= { p: 0, n: 0 }); cats[r.cat].n++; if (r.pass) cats[r.cat].p++; }
  console.log('  by type: ' + Object.entries(cats).map(([c, v]) => `${c} ${v.p}/${v.n}`).join(' | '));
  const inds = {};
  for (const r of rs) { (inds[r.biz] ||= { p: 0, n: 0 }); inds[r.biz].n++; if (r.pass) inds[r.biz].p++; }
  console.log('  by business: ' + Object.entries(inds).map(([c, v]) => `${c} ${v.p}/${v.n}`).join(' | '));
}
if (reasons.size) {
  console.log('\nWHY A HOSTED MODEL WAS SKIPPED (most common first):');
  for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`  ${n}x  ${r}`);
}
const keys = Object.keys(all);
console.log('\nMISSES (what you asked, what was expected, what the bot did):');
let any = false;
const seen = new Set();
for (const key of keys) for (const r of all[key]) {
  if (r.pass) continue;
  any = true;
  const id = `${key}|${r.t}`; if (seen.has(id)) continue; seen.add(id);
  console.log(`  [${key}, ${r.biz}] "${r.t}"\n      wanted ${r.want.join('/')}, got ${r.got}${r.fallback ? ' (used fallback model)' : ''}${r.reply ? `\n      bot said: ${r.reply.replace(/\n/g, ' ')}` : ''}`);
}
if (!any) console.log('  none');
const reportFile = path.join(here, 'eval-report.json');
fs.writeFileSync(reportFile, JSON.stringify({ when: new Date().toISOString(), fake: FAKE, results: all }, null, 2));
console.log(`\nFull report: ${reportFile}  (only your test sentences, no keys)`);
