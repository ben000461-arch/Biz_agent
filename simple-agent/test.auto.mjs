// E2E for the cloud AI model connection, with FAKE Telegram, Ollama, GitHub and AI providers.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createVault } from './vault.js';
import { extractJson } from './models.js';

const P = { tg: 18821, ollama: 18822, app: 18823, gh: 18824, ai: 18825 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const connFile = path.join(tmp, 'data', 'connections.json');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pemFile = path.join(tmp, 'app.pem');
fs.writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };

const KEYS = { anthropic: 'sk-ant-GOODKEY1234567890abcd', openai: 'sk-openai-GOODKEY1234567890abcd', openrouter: 'sk-or-GOODKEY1234567890abcd' };

console.log('[helpers]');
check('extractJson pulls JSON out of chatty answers', extractJson('Sure! ```json\n{"path":"a.js","new_path":null}\n``` hope that helps').path === 'a.js');
check('extractJson throws when there is none', (() => { try { extractJson('nothing here'); return false; } catch { return true; } })());

// ---------- fakes ----------
const sent = [], docs = [];
const tg = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const method = req.url.split('/').pop(); const raw = Buffer.concat(c);
    if (method === 'sendMessage') { const b = JSON.parse(raw.toString()); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
    if (method === 'sendDocument') docs.push({ chat_id: /name="chat_id"\r\n\r\n(\d+)/.exec(raw.toString('latin1'))?.[1] });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(method === 'getMe' ? { ok: true, result: { username: 'TestBot' } } : { ok: true, result: {} }));
  });
});

const SERVER_JS = `// Station roster API.
// Receives a text message from the dispatch screen and echoes it back in capitals
// so it is easy to read on the big wall display in the truck bay.
// Keep this file small: every route lives here until we split things up.
const express = require('express');
const app = express();

app.post('/message', (req, res) => {
  const text = req.body.text;
  res.json({ upper: text.toUpperCase() });
});

app.listen(3000);
`;
const BIG_JS = `const big = 1;\n${'// filler line to make this file long enough to need a big model\n'.repeat(500)}`; // ~30k chars

const editFor = (file) => {
  const first = file.split('\n')[0];
  return `SUMMARY: Added a short comment at the top.\n<<<<<<< SEARCH\n${first}\n=======\n// Added by the assistant.\n${first}\n>>>>>>> REPLACE\n`;
};
function answerFor(system, user) {
  if (/Reply with the single word OK/.test(system)) return 'OK';
  if (/find the right file/.test(system)) return JSON.stringify({ path: 'server.js', new_path: null });
  if (/SEARCH\/REPLACE/.test(system)) return editFor(/<file>\n([\s\S]*)<\/file>/.exec(user)?.[1] || 'x');
  return '{}';
}

const localCalls = [];
const ollama = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(c).toString());
    const system = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    localCalls.push({ system, model: body.model });
    const content = /BREAKME/.test(user) && /SEARCH\/REPLACE/.test(system) ? `SUMMARY: Added a comment.\n<<<<<<< SEARCH\nconst app = express();\n=======\nconst app = express();\n)))(((\n>>>>>>> REPLACE\n`
      : /careful senior programmer|find the right file/.test(system) ? answerFor(system, user)
      : /helpful, direct assistant/.test(system) ? JSON.stringify({ reply: 'Hi.' }) : JSON.stringify({ action: 'chat' });
    if (body.stream) {
      res.setHeader('content-type', 'application/x-ndjson');
      return res.end(`${JSON.stringify({ message: { content }, done: false })}\n${JSON.stringify({ message: { content: '' }, done: true })}\n`);
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: { content } }));
  });
});

const ai = { calls: [], revoked: false };
const aiServer = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const body = JSON.parse(Buffer.concat(c).toString() || '{}');
    const which = req.url.split('/')[1]; // anthropic | openai | openrouter
    ai.calls.push({ which, url: req.url, headers: req.headers, body });
    if (which === 'anthropic') {
      if (ai.revoked || req.headers['x-api-key'] !== KEYS.anthropic) return json({ error: { message: `invalid key ${req.headers['x-api-key']}` } }, 401);
      if (!req.headers['anthropic-version']) return json({ error: 'missing version' }, 400);
      return json({ content: [{ type: 'text', text: answerFor(body.system, body.messages[0].content) }] });
    }
    const wantKey = KEYS[which];
    if (req.headers.authorization !== `Bearer ${wantKey}`) return json({ error: { message: 'bad key' } }, 401);
    if (which === 'openrouter' && 'max_tokens' in body) return json({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, 400);
    if (which === 'openai' && 'max_tokens' in body) return json({ error: { message: 'old field' } }, 400);
    return json({ choices: [{ message: { content: answerFor(body.messages[0].content, body.messages[1].content) } }] });
  });
});

const gh = http.createServer((req, res) => {
  const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
  const p = new URL(req.url, 'http://x').pathname; const auth = req.headers.authorization || '';
  req.resume();
  req.on('end', () => {
    if (/access_tokens$/.test(p)) return json({ token: `ghs_${/(\d+)\/access/.exec(p)[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (!/^Bearer ghs_(777|888)$/.test(auth)) return json({ message: 'unauth' }, 401);
    const mine = auth.endsWith('777');
    if (p === '/api/installation/repositories') return json({ repositories: mine ? [{ full_name: 'fire-dept/station-app', name: 'station-app', private: true }] : [{ full_name: 'other-biz/tool', name: 'tool', private: true }] });
    if (p === '/api/repos/fire-dept/station-app/git/trees/HEAD') return json({ truncated: false, tree: [{ path: 'server.js', type: 'blob', size: SERVER_JS.length }, { path: 'big.js', type: 'blob', size: BIG_JS.length }] });
    if (p === '/api/repos/other-biz/tool/git/trees/HEAD') return json({ truncated: false, tree: [{ path: 'main.py', type: 'blob', size: 20 }] });
    const file = (txt) => json({ type: 'file', size: txt.length, sha: 'sha1', encoding: 'base64', content: Buffer.from(txt).toString('base64') });
    if (p === '/api/repos/fire-dept/station-app/contents/server.js') return file(SERVER_JS);
    if (p === '/api/repos/fire-dept/station-app/contents/big.js') return file(BIG_JS);
    if (p === '/api/repos/other-biz/tool/contents/main.py') return file('print("hi")\n');
    json({ message: 'nope' }, 404);
  });
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [gh, P.gh], [aiServer, P.ai]]) await new Promise((r) => s.listen(p, r));

const vault0 = createVault(connFile, 'cd'.repeat(32));
vault0.set('111', 'github', { installationId: '777' }, { label: 'fire-dept' });
vault0.set('222', 'github', { installationId: '888' }, { label: 'other-biz' });
vault0.set('333', 'github', { installationId: '777' }, { label: 'fire-dept' });

const env = {
  ...process.env, HOME: path.join(tmp, 'home'),
  TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
  TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`,
  PORT: String(P.app), TENANTS_FILE: path.join(tmp, 'data', 'tenants.json'), WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: connFile,
  PUBLIC_URL: 'https://example.ngrok-free.dev', TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32),
  GITHUB_APP_ID: '4242', GITHUB_APP_SLUG: 'biz-agent-test', GITHUB_CLIENT_ID: 'Iv1.cid', GITHUB_CLIENT_SECRET: 'gsecret', GITHUB_APP_PRIVATE_KEY_PATH: pemFile,
  GITHUB_API_BASE: `http://127.0.0.1:${P.gh}/api`, GITHUB_WEB_BASE: `http://127.0.0.1:${P.gh}/web`,
  ANTHROPIC_API_BASE: `http://127.0.0.1:${P.ai}/anthropic/v1`, OPENAI_API_BASE: `http://127.0.0.1:${P.ai}/openai/v1`, OPENROUTER_API_BASE: `http://127.0.0.1:${P.ai}/openrouter/v1`,
  MODEL_DAILY_TASKS: '5', MANAGED_DAILY_TASKS: '20', MANAGED_GLOBAL_DAILY_TASKS: '50', MODELS_FILE: path.join(tmp, 'data', 'models.json'),
};
const proc = spawn('node', ['server.js'], { cwd: path.dirname(new URL(import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let uid = 9000;
async function say(chat, text, { quietMs = 600, maxMs = 15000 } = {}) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  const t0 = Date.now(); let last = Date.now(), seen = start;
  while (Date.now() - t0 < maxMs) { await wait(50); if (sent.length !== seen) { seen = sent.length; last = Date.now(); } else if (seen > start && Date.now() - last > quietMs) break; }
  return sent.slice(start).map((m) => m.text).join('\n---\n');
}
const base = `http://127.0.0.1:${P.app}`;
const linkState = (t) => new URL(/https?:\/\/\S+\/connect\/model\?\S+/.exec(t)[0]).searchParams.get('state');
const post = (state, fields) => fetch(`${base}/connect/model`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ state, ...fields }) });

const invite = /start=(\w+)/.exec(await say(111, '/invite Other Biz'))[1];
await say(222, `/start ${invite}`);

console.log('[setup link + private page]');
check('/connect lists the AI model option', /AI model \(optional/.test(await say(111, '/connect')));
let t = await say(111, '/connect model');
check('link points at our private page and says the key never goes through chat', /\/connect\/model\?state=[0-9a-f]{48}/.test(t) && /never through this chat/.test(t) && !/sk-/.test(t), t);
let state = linkState(t);
let r = await fetch(`${base}/connect/model?state=${state}`);
let html = await r.text();
check('form page loads with a password box', r.status === 200 && /type="password"/.test(html) && /name="key"/.test(html));
check('page is private: no-store, no referrer, locked-down CSP', r.headers.get('cache-control') === 'no-store' && r.headers.get('referrer-policy') === 'no-referrer' && /default-src 'none'/.test(r.headers.get('content-security-policy')) && /frame-ancestors 'none'/.test(r.headers.get('content-security-policy')));
check('page tells the truth about where the key goes and what gets sent', /never sent through Telegram/.test(html) && /one file/.test(html) && /you pay that provider/.test(html));
check('bad / missing state refused', (await fetch(`${base}/connect/model?state=nope`)).status === 400 && (await fetch(`${base}/connect/model`)).status === 400);
check('POST with a forged state refused', (await post('deadbeef', { provider: 'anthropic', key: KEYS.anthropic })).status === 400);
check('a stranger can\'t get a link', /invite-only/.test(await say(999, '/connect model')));

console.log('[saving a key]');
r = await post(state, { provider: 'anthropic', model: '', key: 'sk-ant-WRONGKEY1234567890abcd' });
html = await r.text();
check('wrong key: told so on the form, form offered again, key not echoed', r.status === 400 && /rejected the API key/.test(html) && /type="password"/.test(html) && !html.includes('WRONGKEY'), html.slice(0, 300));
check('nothing stored after a bad key', !fs.readFileSync(connFile, 'utf8').includes('"model"'));
r = await post(state, { provider: 'anthropic', model: '', key: 'tooshort' });
const shortHtml = await r.text();
check('too-short key rejected before any request, key not echoed', /look like an API key/.test(shortHtml) && /8 characters/.test(shortHtml) && !shortHtml.includes('tooshort'));
const callsBefore = ai.calls.length;
r = await post(state, { provider: 'openai', model: '', key: KEYS.openai });
check('provider without a default model asks for one', /Type the model name/.test(await r.text()) && ai.calls.length === callsBefore);
r = await post(state, { provider: 'banana', key: KEYS.anthropic });
check('unknown provider refused', /Pick a provider/.test(await r.text()));
const before = sent.length;
r = await post(state, { provider: 'anthropic', model: '', key: '\uFFFC\u202A \u201C' + KEYS.anthropic + '\u200B\u201D\n' });
check('good key saved (default model used) even with invisible junk from a phone paste', r.status === 200 && /Saved/.test(await r.text()));
await wait(300);
check('bot confirms in chat, without the key', sent.slice(before).some((m) => m.chat_id === '111' && /AI model connected: Anthropic \(Claude\) · claude-sonnet-5-5/.test(m.text) && !m.text.includes('GOODKEY')));
const testCall = ai.calls.find((c) => c.which === 'anthropic' && c.headers['x-api-key'] === KEYS.anthropic);
check('key was verified with a tiny real request first', testCall && testCall.body.max_tokens <= 400 && testCall.headers['anthropic-version']);
const vf = fs.readFileSync(connFile, 'utf8');
check('key is encrypted at rest (not in the file in any form we can grep)', !vf.includes('GOODKEY') && !vf.includes(Buffer.from(KEYS.anthropic).toString('base64')) && /Anthropic \(Claude\) · claude-sonnet-5-5/.test(vf));
check('vault file is private (0600)', (fs.statSync(connFile).mode & 0o777) === 0o600);
check('link is single-use', (await post(state, { provider: 'anthropic', key: KEYS.anthropic })).status === 400);
// attempt lock
state = linkState(await say(111, '/connect model'));
for (let i = 0; i < 5; i++) await post(state, { provider: 'anthropic', key: 'sk-ant-WRONGKEY1234567890abcd' });
check('too many wrong tries locks the link', (await post(state, { provider: 'anthropic', key: KEYS.anthropic })).status === 400 && (await fetch(`${base}/connect/model?state=${state}`)).status === 400);
check('/connections shows the model, not the key', /AI model: your own key — Anthropic \(Claude\) · claude-sonnet-5-5/.test(await say(111, '/connections')));

console.log('[/code uses the cloud model]');
await say(111, '/model_own'); // explicit pick = always the cloud
const localBefore = localCalls.filter((c) => /careful senior programmer|find the right file/.test(c.system)).length;
t = await say(111, '/code in station, add a short comment at the top of server.js');
check('says it is using the cloud model and what gets sent', /using your Anthropic \(Claude\) key/.test(t) && /this one file/.test(t), t);
check('does the job and offers to push', /Done — server\.js/.test(t) && /Want me to push this\?/.test(t), t);
const cc = ai.calls.filter((c) => c.which === 'anthropic' && /SEARCH\/REPLACE/.test(c.body.system || ''));
check('provider got the key, the version header, the model, and the edit instructions', cc.length === 1 && cc[0].headers['x-api-key'] === KEYS.anthropic && cc[0].body.model === 'claude-sonnet-5-5' && /Task: add a short comment/.test(cc[0].body.messages[0].content), JSON.stringify(cc[0]?.body).slice(0, 200));
check('the local model was NOT used for it', localCalls.filter((c) => /careful senior programmer|find the right file/.test(c.system)).length === localBefore);
await say(111, 'no');

t = await say(111, '/code in station, add a short comment at the top of big.js');
check('cloud model takes a ~30k-character file the local one would refuse', /Done — big\.js/.test(t), t.slice(0, 300));
await say(111, 'no');

ai.revoked = true;
t = await say(111, '/code in station, add a short comment at the top of server.js');
check('key revoked at the provider → plain explanation, no crash', /rejected the API key/.test(t) && /\/connect model/.test(t), t);
ai.revoked = false;

console.log('[other providers]');
state = linkState(await say(111, '/connect model'));
r = await post(state, { provider: 'openrouter', model: 'some/model-name', key: KEYS.openrouter });
check('provider that insists on the other token-limit field still connects (retry)', r.status === 200, await r.text());
check('openrouter tried max_tokens first, then max_completion_tokens', ai.calls.filter((c) => c.which === 'openrouter').length === 2 && 'max_completion_tokens' in ai.calls.filter((c) => c.which === 'openrouter')[1].body);
state = linkState(await say(111, '/connect model'));
r = await post(state, { provider: 'openai', model: 'gpt-test', key: KEYS.openai });
await wait(200);
check('OpenAI connects (replaces the previous one)', r.status === 200 && /AI model: your own key — OpenAI · gpt-test/.test(await say(111, '/connections')));
t = await say(111, '/code in station, add a short comment at the top of server.js');
check('/code now goes to OpenAI with a Bearer key and the new token field', /using your OpenAI key/.test(t) && /Done — server\.js/.test(t) && ai.calls.filter((c) => c.which === 'openai' && 'max_completion_tokens' in c.body && c.headers.authorization === `Bearer ${KEYS.openai}`).length >= 2, t.slice(0, 200));
await say(111, 'no');

console.log('[daily limit]');
t = await say(111, '/code in station, add a short comment at the top of server.js');
check('5th task still allowed', /Done — server\.js/.test(t), t.slice(0, 200));
await say(111, 'no');
t = await say(111, '/code in station, add a short comment at the top of server.js');
const before6 = ai.calls.length;
check('limit reached (5 tasks) → clear message', /used today's 5 coding tasks/.test(t), t);
check('and no request was sent to the provider', ai.calls.length === before6 && !/Done/.test(t));

console.log('[no key → local model; isolation]');
t = await say(222, '/connections');
check("another business doesn't see or share the key", /AI model: no key of your own/.test(t));
const aiBefore = ai.calls.length;
t = await say(222, '/code in tool, add a short comment at the top of main.py');
check('business without a key uses the local model, says so, sends nothing to any provider', /with the local model/.test(t) && /Done — main\.py/.test(t) && ai.calls.length === aiBefore, t.slice(0, 250));
await say(222, 'no');

console.log('[disconnect]');
t = await say(111, '/disconnect');
check('model is listed among disconnectable things', /disconnect_model — AI model \(OpenAI · gpt-test\)/.test(t), t);
t = await say(111, '/disconnect_model');
check('asks first and explains the fallback', /Remove your own AI key\?/.test(t) && /local model/.test(t) && /\(yes\/no\)/.test(t));
await say(111, 'no');
check('"no" keeps it', /your own key — OpenAI/.test(await say(111, '/connections')));
await say(111, '/disconnect_model');
t = await say(111, 'yes');
check('"yes" deletes the key and reminds to delete it at the provider too', /deleted the OpenAI key/.test(t) && /dashboard/.test(t), t);
check('key gone from the vault', !/"model"/.test(fs.readFileSync(connFile, 'utf8')));
t = await say(111, '/code in station, add a short comment at the top of big.js');
check('back on the local model: big files are refused with a hint to connect a cloud model', /too long for the model I'm using \(limit 12k\)/.test(t) && /\/connect model/.test(t), t);

console.log('[shared models: only the admin manages the menu]');
check("a business can't add or list shared models", /isn't available/.test(await say(222, '/addmodel')) && /isn't available/.test(await say(222, '/models')) && /isn't available/.test(await say(222, '/removemodel_x')) && /isn't available/.test(await say(222, '/defaultmodel_x')));
check('before any are added, admin sees an empty list and businesses see how to get one', /No shared models yet/.test(await say(111, '/models')) && /No cloud AI is set up yet/.test(await say(222, '/model')));

console.log('[shared models: admin adds some through the private page]');
t = await say(111, '/addmodel');
check('admin gets a private link and is told it is for all businesses and who pays', /ALL businesses/.test(t) && /you pay that provider/.test(t) && /20 coding tasks per business per day, 50 in total/.test(t) && /\/connect\/model\?state=/.test(t), t);
state = linkState(t);
html = await (await fetch(`${base}/connect/model?state=${state}`)).text();
check('managed form says it is for everyone and asks for a display name', /Add a model for everyone/.test(html) && /name="label"/.test(html) && /type="password"/.test(html));
r = await post(state, { provider: 'anthropic', model: '', label: 'Smart', key: KEYS.anthropic });
check('first model saved', r.status === 200, await r.text());
await wait(300);
check('admin told it is live, without the key', sent.slice(-3).some((m) => m.chat_id === '111' && /Model added for everyone: Smart/.test(m.text) && !m.text.includes('GOODKEY')));
let cat = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'models.json'), 'utf8')).models;
check('menu entry saved with no secret in it; first one is the default', cat.length === 1 && cat[0].id === 'smart' && cat[0].provider === 'anthropic' && cat[0].model === 'claude-sonnet-5-5' && cat[0].isDefault && !JSON.stringify(cat).includes('GOODKEY'), JSON.stringify(cat));
check('the provider key sits in the encrypted vault under the server, not readable', !fs.readFileSync(connFile, 'utf8').includes('GOODKEY') && /managed:anthropic/.test(fs.readFileSync(connFile, 'utf8')));

console.log('[automatic: code goes to the cloud model, the local model keeps everything else]');
const inv3 = /start=(\w+)/.exec(await say(111, '/invite Third Biz'))[1];
await say(333, `/start ${inv3}`);
t = await say(333, '/model');
check('/model: Automatic ticked, says code goes to Smart, local-only offered', /\/model_auto.*code goes to Smart.*✓/.test(t) && /\/model_local/.test(t) && /Right now: Smart \(automatic\)/.test(t) && /local model still handles chat/.test(t), t);
let a0 = ai.calls.length, l0 = localCalls.length;
t = await say(333, '/code in station, add a short comment at the top of server.js');
check('first time: asks permission before anything is sent, runs nothing', /Is that OK\? \(yes\/no\)/.test(t) && /Smart/.test(t) && ai.calls.length === a0 && localCalls.length === l0, t.slice(0, 300));
t = await say(333, 'yes');
check('"yes" → the cloud model writes the code, the local model is not used for it', /On it — using Smart/.test(t) && /Done — server\.js/.test(t) && ai.calls.length > a0 && localCalls.slice(l0).filter((c) => /careful senior programmer|find the right file/.test(c.system)).length === 0, t.slice(0, 300));
await say(333, 'no');

a0 = ai.calls.length;
t = await say(333, '/code in station, add a short comment at the top of big.js');
check('a ~30k-character file just works (cloud model has the room)', /Done — big\.js/.test(t) && ai.calls.length > a0, t.slice(0, 300));
await say(333, 'no');

await say(333, '/model_local');
a0 = ai.calls.length; l0 = localCalls.length;
t = await say(333, '/code in station, add a short comment at the top of server.js');
check('local-only: the local model writes it, nothing goes to any provider', /with the local model/.test(t) && /Done — server\.js/.test(t) && ai.calls.length === a0 && localCalls.length > l0, t.slice(0, 300));
await say(333, 'no');
t = await say(333, '/code in station, add a short comment at the top of server.js BREAKME');
check('local-only + a bad local result: no push offer, nothing sent anywhere', /syntax check failed/.test(t) && !/Want me to push/.test(t) && ai.calls.length === a0, t.slice(0, 300));
t = await say(333, '/code in station, add a short comment at the top of big.js');
check('local-only + too-big file: refused with the old hint', /too long for the model I'm using/.test(t) && ai.calls.length === a0, t.slice(0, 300));

await say(333, '/model_auto');
a0 = ai.calls.length;
t = await say(333, '/code in station, add a short comment at the top of server.js');
check('back to automatic: cloud again, no second permission prompt', /On it — using Smart/.test(t) && ai.calls.length > a0 && !/Is that OK/.test(t), t.slice(0, 300));
await say(333, 'no');

a0 = ai.calls.length;
t = await say(111, '/code in station, add a short comment at the top of server.js');
check('the owner (admin) uses the cloud model without being asked', /On it — using Smart/.test(t) && !/Is that OK/.test(t) && ai.calls.length > a0, t.slice(0, 300));
await say(111, 'no');
check('chat and other things still run on the local model', /Hi\./.test(await say(333, 'hello there')));

console.log('[secrets never leak]');
const everything = sent.map((m) => m.text).join('\n') + log;
check('no API key appears in any Telegram message or in the server log', !/GOODKEY|WRONGKEY/.test(everything));

proc.kill(); tg.close(); ollama.close(); gh.close(); aiServer.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('--- server log ---\n' + log.slice(-2500)); process.exit(1); }
