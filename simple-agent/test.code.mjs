// E2E for coding tasks with FAKE Telegram, Ollama and GitHub.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createVault } from './vault.js';
import { parseCoderOutput, parseCodeRequest, matchFileHint, candidateFiles } from './coder.js';

const P = { tg: 18811, ollama: 18812, app: 18813, gh: 18814 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const connFile = path.join(tmp, 'data', 'connections.json');
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pemFile = path.join(tmp, 'app.pem');
fs.writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));

let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };

// ---------- unit checks ----------
console.log('[pure helpers]');
let o = parseCoderOutput('SUMMARY: Added a check.\n```js\nconst a = 1;\n```\n');
check('parses summary + fenced code', o.summary === 'Added a check.' && o.code === 'const a = 1;\n' && o.complete);
o = parseCoderOutput('SUMMARY: x\n```\nline1\n```inner\nline3\n```');
check('uses the LAST closing fence (code containing ``` stays whole)', o.code.includes('line3') && o.complete, JSON.stringify(o));
o = parseCoderOutput('SUMMARY: x\n```js\nconst a = 1;\n');
check('cut-off reply flagged incomplete', !o.complete);
check('no fence → no code', parseCoderOutput('sorry I cannot').code === null);
check('/code request parsing', JSON.stringify(parseCodeRequest('in station app, fix the crash in server.js when empty')) === JSON.stringify({ repo: 'station app', fileHint: 'server.js', task: 'fix the crash in server.js when empty' }) || (() => { console.log(parseCodeRequest('in station app, fix the crash in server.js when empty')); return false; })());
check('/code without repo', parseCodeRequest('add a /ping route to app.js').repo === null && parseCodeRequest('add a /ping route to app.js').fileHint === 'app.js');
const cands = candidateFiles([{ path: 'node_modules/x/index.js', size: 10 }, { path: 'package-lock.json', size: 10 }, { path: 'logo.png', size: 10 }, { path: 'src/app.js', size: 100 }, { path: 'server.js', size: 100 }, { path: 'big.js', size: 999999 }, { path: '../evil.js', size: 1 }]);
check('junk, lockfiles, binaries, huge and odd paths filtered', cands.map((c) => c.path).join() === 'server.js,src/app.js', cands.map((c) => c.path).join());
check('hint matching: basename, suffix, ambiguity', matchFileHint(cands, 'app.js') === 'src/app.js' && matchFileHint(cands, './server.js') === 'server.js' && matchFileHint(cands, 'nope.js') === null);

// ---------- fakes ----------
const sent = [], docs = [];
const tg = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const method = req.url.split('/').pop(); const raw = Buffer.concat(c);
    if (method === 'sendMessage') { const b = JSON.parse(raw.toString()); sent.push({ chat_id: String(b.chat_id), text: b.text }); }
    if (method === 'sendDocument') { const s = raw.toString('latin1'); docs.push({ chat_id: /name="chat_id"\r\n\r\n(\d+)/.exec(s)?.[1], name: /filename="([^"]+)"/.exec(s)?.[1] }); }
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
const FIXED_JS = SERVER_JS.replace("  const text = req.body.text;\n", "  const text = req.body.text;\n  if (!text) return res.status(400).json({ error: 'empty message' });\n");
const mode = { code: 'fixed', pick: null, router: null, chat: null }; // what the fake model does next
const modelCalls = [];
let editCalls = 0;
const blk = (search, replace, summary = 'Added an empty-message check so it returns 400 instead of crashing.') => `SUMMARY: ${summary}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;
const S1 = '  const text = req.body.text;';
const R1 = `${S1}\n  if (!text) return res.status(400).json({ error: 'empty message' });`;
const ollama = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(c).toString());
    const system = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    modelCalls.push({ model: body.model, system, user, messages: body.messages, options: body.options, format: body.format, stream: body.stream });
    const reply = (content) => {
      if (body.stream) { // real Ollama streams newline-delimited JSON; split it into odd-sized pieces
        res.setHeader('content-type', 'application/x-ndjson');
        const lines = [];
        for (let k = 0; k < content.length; k += 7) lines.push(JSON.stringify({ message: { content: content.slice(k, k + 7) }, done: false }));
        lines.push(JSON.stringify({ message: { content: '' }, done: true }));
        const all = lines.join('\n') + '\n';
        res.write(all.slice(0, 11)); setTimeout(() => res.end(all.slice(11)), 20);
        return;
      }
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ message: { content } }));
    };
    if (system.includes('SEARCH/REPLACE')) {
      editCalls++;
      const file = /<file>\n([\s\S]*)<\/file>/.exec(user)?.[1] || '';
      if (mode.code === 'fixed') {
        if (file.includes('req.body.text')) return reply(blk(S1, R1));
        const first = file.split('\n')[0]; // any other file: add a comment above its first line
        return reply(blk(first, `// Added by the assistant.\n${first}`, 'Added a short comment at the top.'));
      }
      if (mode.code === 'multi') return reply(`${blk(S1, R1)}${blk('app.listen(3000);', "app.listen(3000);\n// started")}`);
      if (mode.code === 'fuzzy') return reply(blk('const text = req.body.text;', "const text = req.body.text;\nif (!text) return res.status(400).json({ error: 'empty message' });")); // indentation lost
      if (mode.code === 'nomatch') return reply(blk('this line is not in the file at all', 'whatever'));
      if (mode.code === 'retry') return reply(editCalls % 2 === 1 ? blk('not in the file', 'x') : blk(S1, R1));
      if (mode.code === 'cutoff') return reply(`SUMMARY: Working.\n<<<<<<< SEARCH\n${S1}\n=======\n${S1}\n  const y = 2;\n`);
      if (mode.code === 'same') return reply(blk(S1, S1, 'Already fine.'));
      if (mode.code === 'broken') return reply(blk('  res.json({ upper: text.toUpperCase() });', '  res.json({ upper: text.toUpperCase() ;', 'Tried something.'));
      return reply('I am not able to help with that.');
    }
    if (system.includes('Create the requested new file')) {
      return reply('SUMMARY: Added a health route helper.\n```js\nexport const health = () => ({ ok: true });\n```');
    }
    if (system.includes('find the right file')) return reply(JSON.stringify(mode.pick ?? { path: 'server.js', new_path: null }));
    if (system.includes('helpful, direct assistant')) return reply(JSON.stringify({ reply: mode.chat ?? 'Hi there.' }));
    if (system.includes('helper inside a chat assistant')) return reply(JSON.stringify({ reply: 'Send /connect github first. Then use /code. Extra third sentence.' }));
    return reply(JSON.stringify(mode.router ?? { action: 'chat' }));
  });
});

const g = { writes: [], gets: [], fileSha: 'sha-server-v1', perm403: false };
const gh = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const auth = req.headers.authorization || '';
    const rawBody = Buffer.concat(c).toString();
    if (req.method !== 'GET' && !/access_tokens$/.test(p)) g.writes.push({ method: req.method, p, body: rawBody ? JSON.parse(rawBody) : null });
    if (/^\/api\/app\/installations\/(\d+)\/access_tokens$/.test(p)) return json({ token: `ghs_${/(\d+)\/access/.exec(p)[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
    if (!/^Bearer ghs_(777|888)$/.test(auth)) return json({ message: 'unauth' }, 401);
    g.gets.push(p);
    const mine = auth.endsWith('777');
    if (p === '/api/installation/repositories') {
      return json({ repositories: mine ? [{ full_name: 'fire-dept/station-app', name: 'station-app', private: true }] : [{ full_name: 'other-biz/tool', name: 'tool', private: true }] });
    }
    if (p === '/api/repos/fire-dept/station-app/git/trees/HEAD') {
      return json({ truncated: false, tree: [
        { path: 'server.js', type: 'blob', size: SERVER_JS.length }, { path: 'src', type: 'tree' }, { path: 'src/util.js', type: 'blob', size: 40 },
        { path: 'big.js', type: 'blob', size: 20000 }, { path: 'package-lock.json', type: 'blob', size: 50 }, { path: 'logo.png', type: 'blob', size: 50 },
        { path: 'README.md', type: 'blob', size: 30 },
      ] });
    }
    if (p === '/api/repos/other-biz/tool/git/trees/HEAD') return json({ truncated: false, tree: [{ path: 'main.py', type: 'blob', size: 20 }] });
    if (p === '/api/repos/fire-dept/station-app' && req.method === 'GET') return json({ default_branch: 'main' });
    if (p === '/api/repos/fire-dept/station-app/git/ref/heads/main') return json({ object: { sha: 'headsha1' } });
    if (req.method === 'POST' && p === '/api/repos/fire-dept/station-app/git/refs') return g.perm403 ? json({ message: 'Resource not accessible by integration' }, 403) : json({ ref: 'x' }, 201);
    if (req.method === 'PUT' && p.startsWith('/api/repos/fire-dept/station-app/contents/')) return json({ content: {} }, 200);
    if (req.method === 'POST' && p === '/api/repos/fire-dept/station-app/pulls') return json({ number: 7, html_url: 'https://github.com/fire-dept/station-app/pull/7' }, 201);
    const file = (txt) => json({ type: 'file', size: txt.length, sha: g.fileSha, encoding: 'base64', content: Buffer.from(txt).toString('base64') });
    if (p === '/api/repos/fire-dept/station-app/contents/server.js') return file(SERVER_JS);
    if (p === '/api/repos/fire-dept/station-app/contents/src/util.js') return file('export const x = 1;\n');
    if (p === '/api/repos/fire-dept/station-app/contents/big.js') return json({ type: 'file', size: 200000, encoding: 'base64', content: '' });
    if (p === '/api/repos/other-biz/tool/contents/main.py') return file('print("hi")\n');
    json({ message: 'nope' }, 404);
  });
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [gh, P.gh]]) await new Promise((r) => s.listen(p, r));

// pre-connected: 111 (admin) → installation 777, 222 (business) → installation 888, 333 (business, no GitHub)
const vault = createVault(connFile, 'cd'.repeat(32));
vault.set('111', 'github', { installationId: '777' }, { label: 'fire-dept' });
vault.set('222', 'github', { installationId: '888' }, { label: 'other-biz' });
const tenantsFile = path.join(tmp, 'data', 'tenants.json');

const env = {
  ...process.env, SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '', GROQ_API_KEY: '', HOME: path.join(tmp, 'home'),
  TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
  TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`,
  PORT: String(P.app), TENANTS_FILE: tenantsFile, WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: connFile,
  PENDING_TIMEOUT_MS: '3000', PUSH_OFFER_TIMEOUT_MS: '9000', // short, so the "late yes" tests can run
  PUBLIC_URL: 'https://example.ngrok-free.dev', TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32),
  GITHUB_APP_ID: '4242', GITHUB_APP_SLUG: 'biz-agent-test', GITHUB_CLIENT_ID: 'Iv1.cid', GITHUB_CLIENT_SECRET: 'gsecret', GITHUB_APP_PRIVATE_KEY_PATH: pemFile,
  GITHUB_API_BASE: `http://127.0.0.1:${P.gh}/api`, GITHUB_WEB_BASE: `http://127.0.0.1:${P.gh}/web`,
};
const proc = spawn('node', ['server.js'], { cwd: path.dirname(new URL(import.meta.url).pathname), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 100)); }

let uid = 9000;
async function say(chat, text, { quietMs = 700, maxMs = 15000 } = {}) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  const t0 = Date.now(); let last = Date.now(), seen = start;
  while (Date.now() - t0 < maxMs) { await new Promise((r) => setTimeout(r, 50)); if (sent.length !== seen) { seen = sent.length; last = Date.now(); } else if (seen > start && Date.now() - last > quietMs) break; }
  return sent.slice(start).map((m) => m.text).join('\n---\n');
}
const savedRuns = (chat, repo) => {
  const dir = path.join(chat === 111 ? path.join(tmp, 'home', 'Desktop') : path.join(tmp, 'ws', String(chat)), 'code', repo);
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((d) => path.join(dir, d)) : [];
};

// register tenant 222 (business) via invite, then give it GitHub (vault already has it)
const invite = /start=(\w+)/.exec(await say(111, '/invite Other Biz'))[1];
await say(222, `/start ${invite}`);
const invite2 = /start=(\w+)/.exec(await say(111, '/invite No Github'))[1];
await say(333, `/start ${invite2}`);

console.log('[happy path: /code]');
let t = await say(111, '/code in station, fix the crash in server.js when the message is empty');
check('immediate "on it" message first', /On it/.test(t.split('\n---\n')[0]), t);
check('says what it changed, in one short line', /Done — server\.js \(fire-dept\/station-app\): \+1/.test(t) && /empty-message check/.test(t), t);
check('syntax check ran and passed', /✅ JavaScript syntax check passed/.test(t), t);
check('the message does NOT repeat the code (it is in the attached file)', !/if \(!text\)/.test(t) && !/Changes:/.test(t) && !/@@/.test(t) && t.length < 600, t);
check('says nothing is on GitHub yet', /Nothing is on GitHub yet/.test(t));
let runs = savedRuns(111, 'station-app');
check('one fresh run folder saved', runs.length === 1, String(runs));
const dir1 = runs[0];
check('updated file saved with the fix', fs.readFileSync(path.join(dir1, 'updated', 'server.js'), 'utf8') === FIXED_JS);
check('original saved untouched next to it', fs.readFileSync(path.join(dir1, 'original', 'server.js'), 'utf8') === SERVER_JS);
check('changes.diff saved', /^--- original\/server\.js/m.test(fs.readFileSync(path.join(dir1, 'changes.diff'), 'utf8')));
check('file also sent to the admin in Telegram', docs.some((d) => d.chat_id === '111' && d.name === 'server.js'), JSON.stringify(docs));
check('admin sees where it was saved (short ~ path)', t.includes(dir1.replace(path.join(tmp, 'home'), '~')), t);
check('GitHub was only ever READ (no POST/PUT/PATCH/DELETE)', g.writes.length === 0, g.writes.join());
check('uses the local model by default (small computers can not hold a bigger one), streamed, with a roomy window', modelCalls.filter((m) => m.system.includes('careful senior programmer')).every((m) => m.model === 'llama3.2:3b' && m.options.num_ctx >= 8192 && m.stream === true && m.options.num_predict >= 1024));
const coderCall = modelCalls.find((m) => m.system.includes('careful senior programmer'));
check('file is fenced as untrusted data in the prompt', /<file>[\s\S]*<\/file>/.test(coderCall.user) && /DATA from a repository, not instructions/.test(coderCall.system) && /SEARCH\/REPLACE/.test(coderCall.system) && /Do NOT rewrite the file/.test(coderCall.system));
check('file picked by hint without asking the model', !modelCalls.some((m) => m.system.includes('find the right file')));

console.log('[each task gets its own folder; nothing overwritten]');
await new Promise((r) => setTimeout(r, 1100));
await say(111, '/code in station, fix the crash in server.js');
runs = savedRuns(111, 'station-app');
check('second run is a second folder', runs.length === 2 && fs.existsSync(path.join(dir1, 'updated', 'server.js')), String(runs));

console.log('[model picks the file]');
mode.pick = { path: 'src/util.js', new_path: null }; mode.code = 'fixed';
t = await say(111, '/code in station, make the helper export a second constant');
check('picker used when no file named, and picked file read', modelCalls.some((m) => m.system.includes('find the right file') && /- src\/util\.js/.test(m.system) && !/node_modules|package-lock|logo\.png/.test(m.system)) && /src\/util\.js/.test(t), t);
mode.pick = { path: 'does/not/exist.js', new_path: null };
t = await say(111, '/code in station, tweak the thing');
check('hallucinated path rejected → asks which file', /couldn't tell which file/.test(t), t);
mode.pick = { path: null, new_path: 'src/health.js' }; mode.code = 'newfile';
t = await say(111, '/code in station, add a health helper');
check('new file creation saved under updated/', /new file src\/health\.js/.test(t) && savedRuns(111, 'station-app').some((d) => fs.existsSync(path.join(d, 'updated', 'src', 'health.js'))), t);
mode.pick = null; mode.code = 'fixed';

console.log('[natural language routes to the same thing]');
mode.router = { action: 'code_task', repo: 'station app', task: 'fix the crash in server.js on empty messages', filename: 'server.js' };
const nBefore = savedRuns(111, 'station-app').length;
t = await say(111, 'hey can you fix the crash in server.js in the station app when messages are empty');
check('router → code_task → saved', /Done — server\.js/.test(t) && savedRuns(111, 'station-app').length === nBefore + 1, t);
mode.router = { action: 'code_task', repo: 'null', task: 'null', filename: 'null' };
t = await say(111, 'do some coding');
check('"null" task handled → asks what to do', /What should I do\?/.test(t), t);
mode.router = null;

console.log('[bad model output is never saved]');
const count = () => savedRuns(111, 'station-app').length;
let c0 = count();
editCalls = 0; mode.code = 'nomatch'; t = await say(111, '/code in station, fix server.js');
check('edit that matches nothing: retried once, then nothing saved', /couldn't make an edit/.test(t) && /aren't in the file/.test(t) && editCalls === 2 && count() === c0, `${editCalls} ${t}`);
check('retry prompt tells the model what went wrong', /previous answer didn't work/.test(modelCalls[modelCalls.length - 1].user));
editCalls = 0; mode.code = 'retry'; t = await say(111, '/code in station, fix server.js'); c0 = count();
check('first answer bad, second good → still works', /Done — server\.js/.test(t) && editCalls === 2, `${editCalls} ${t}`);
mode.code = 'cutoff'; t = await say(111, '/code in station, fix server.js');
check('unfinished edit block rejected', /never closed/.test(t) && count() === c0, t);
mode.code = 'refuse'; t = await say(111, '/code in station, fix server.js');
check('refusal / no edit block handled', /no SEARCH\/REPLACE block/.test(t) && count() === c0, t);
mode.code = 'multi'; t = await say(111, '/code in station, fix server.js'); c0 = count();
check('two edits in one answer both applied', /\+2/.test(t), t);
mode.code = 'fuzzy'; t = await say(111, '/code in station, fix server.js'); c0 = count();
check('wrong indentation from the model still lands in the right place', /\+1/.test(t), t);
mode.code = 'same'; t = await say(111, '/code in station, fix server.js');
check('no-op reported, nothing saved', /didn't change anything/.test(t) && count() === c0, t);
mode.code = 'broken'; t = await say(111, '/code in station, fix server.js');
check('syntax error is saved but loudly flagged', /⚠️ syntax problem/.test(t) && count() === c0 + 1, t);
mode.code = 'fixed';

console.log('[limits]');
t = await say(111, '/code in station, fix big.js');
check('oversized file refused plainly', /too big/.test(t), t);
t = await say(111, '/code in station');
check('empty-ish task asks what to do', /What should I do|couldn't tell which file/.test(t), t);
t = await say(111, '/code');
check('/code alone explains usage', /What should I do/.test(t), t);

console.log('[isolation + privacy]');
t = await say(333, '/code fix something');
check('business without GitHub is told to connect', /send \/connect github/.test(t), t);
t = await say(222, '/code in tool, fix main.py');
check("business gets the file in Telegram, sees no computer paths", /Done — main\.py \(other-biz\/tool\)/.test(t) && !t.includes(tmp) && !/Saved in/.test(t), t);
check('business file saved in ITS OWN workspace only', savedRuns(222, 'tool').length === 1 && savedRuns(111, 'tool').length === 0);
check('and delivered as a document to that chat', docs.some((d) => d.chat_id === '222'));
await say(222, 'no');
t = await say(222, '/code in station-app, fix server.js');
check("business can't reach another account's repo", /can't see a project matching/.test(t) && !/fire-dept/.test(t.replace(/matching[\s\S]*/, '')), t);
check('still no writes to GitHub before any yes', g.writes.length === 0, JSON.stringify(g.writes));

const latestUpdated = (rel) => { const runs = savedRuns(111, 'station-app').sort(); return path.join(runs[runs.length - 1], 'updated', rel); };
const lastRef = () => g.writes.filter((w) => w.p.endsWith('/git/refs')).pop();

console.log('[push: asks first, "no" keeps it local]');
mode.code = 'fixed'; mode.pick = null;
t = await say(111, '/code in station, fix the crash in server.js when the message is empty');
check('headline counts the added lines', /server\.js \(fire-dept\/station-app\): \+1\./.test(t), t);
check('asks to push, says branch + pull request, main untouched, in two short lines', /Want me to push this\?/.test(t) && /NEW branch/.test(t) && /pull request/.test(t) && /main stays untouched/.test(t), t);
check('still nothing written to GitHub while waiting', g.writes.length === 0);
t = await say(111, 'no');
check('"no" scraps it, nothing written', /scrapped/.test(t) && g.writes.length === 0, t);
check('the local file is still there after "no"', fs.existsSync(latestUpdated('server.js')));

console.log('[push: yes → branch + commit + PR, never main]');
await say(111, '/code in station, fix the crash in server.js when the message is empty');
t = await say(111, 'yes');
check('reports the pull request', /Pushed ✓/.test(t) && /pull request #7/.test(t) && /pull\/7/.test(t) && /Nothing is live until you merge/.test(t), t);
const w = g.writes.filter((x) => !/access_tokens/.test(x.p));
check('exactly three writes: branch, file, PR', w.length === 3 && w[0].p.endsWith('/git/refs') && w[1].method === 'PUT' && w[2].p.endsWith('/pulls'), JSON.stringify(w.map((x) => `${x.method} ${x.p}`)));
const branch = w[0].body.ref.replace('refs/heads/', '');
check('branch is a new biz-agent/ branch cut from main\'s latest commit', /^biz-agent\/[a-z0-9-]+-\d{8}-\d{6}$/.test(branch) && w[0].body.sha === 'headsha1', JSON.stringify(w[0].body));
check('file committed to that branch (not main) with the file\'s version as base', w[1].body.branch === branch && w[1].body.sha === 'sha-server-v1' && w[1].body.branch !== 'main', JSON.stringify({ ...w[1].body, content: '…' }));
check('committed content is exactly the approved file', Buffer.from(w[1].body.content, 'base64').toString() === FIXED_JS);
check('PR opened from the branch into main, with a review note', w[2].body.head === branch && w[2].body.base === 'main' && /^Biz Agent: /.test(w[2].body.title) && /review before merging/i.test(w[2].body.body), JSON.stringify(w[2].body));
check('nothing ever wrote to the main ref or committed to main', !g.writes.some((x) => /refs\/heads\/main$/.test(JSON.stringify(x.body?.ref || '')) || x.body?.branch === 'main'));
t = await say(111, 'yes');
check('a second "yes" does nothing (pending was used up)', g.writes.filter((x) => !/access_tokens/.test(x.p)).length === 3);

console.log('[push: safety stops]');
let before = g.writes.length;
await say(111, '/code in station, fix the crash in server.js');
g.fileSha = 'sha-changed-by-someone';
t = await say(111, 'yes');
check('file changed on GitHub since it was read → stops, writes nothing', /changed on GitHub after I read it/.test(t) && g.writes.length === before, t);
g.fileSha = 'sha-server-v1';

await say(111, '/code in station, fix the crash in server.js');
fs.appendFileSync(latestUpdated('server.js'), '\n// sneaky edit after approval\n');
t = await say(111, 'yes');
check('saved file edited after the preview → refuses to push it', /changed after I showed it/.test(t) && g.writes.length === before, t);

g.perm403 = true;
await say(111, '/code in station, fix the crash in server.js');
t = await say(111, 'yes');
check('no write permission → clear instructions, no commit made', /isn't allowed to write/.test(t) && /Installed GitHub Apps/.test(t) && !g.writes.slice(before).some((x) => x.method === 'PUT'), t);
g.perm403 = false; before = g.writes.length;

await say(111, '/code in station, fix the crash in server.js');
await say(111, 'hello there');
t = await say(111, 'yes');
check('an unrelated message in between cancels the offer', g.writes.length === before, t);

await say(111, '/code in station, fix the crash in server.js');
t = await say(222, 'yes');
check("another business's \"yes\" can't trigger my push", g.writes.length === before, t);
await say(111, 'no');

console.log('[push: brand-new file]');
mode.pick = { path: null, new_path: 'src/health.js' }; mode.code = 'newfile';
t = await say(111, '/code in station, add a health helper');
check('new-file result and offer', /Done — new file src\/health\.js/.test(t) && /NEW branch/.test(t), t);
await say(111, 'yes');
const newPut = g.writes.slice(before).find((x) => x.method === 'PUT');
check('new file committed without a base sha', newPut && newPut.p.endsWith('/contents/src/health.js') && !('sha' in newPut.body), JSON.stringify(newPut && { ...newPut, body: { ...newPut.body, content: '…' } }));
mode.pick = null; mode.code = 'fixed';

console.log('[push: a late or stray "yes" never pushes anything]');
const nWrites = () => g.writes.filter((x) => !/access_tokens/.test(x.p)).length;
const TASK = '/code in station, fix the crash in server.js when the message is empty';
let w0 = nWrites();
await say(111, TASK);
await new Promise((r) => setTimeout(r, 3500)); // the offer is now "old"
t = await say(111, 'yes');
check('old offer + plain "yes": not taken as a go-ahead, says what it was, asks for "push it"', /not taking a plain "yes"/.test(t) && /reply "push it"/.test(t) && /server\.js/.test(t) && nWrites() === w0, t);
t = await say(111, 'ok');
check('plain "ok" is not enough either', /not taking a plain "ok"/.test(t) && nWrites() === w0, t);
t = await say(111, 'push it');
check('"push it" does open the pull request', /Pushed ✓/.test(t) && nWrites() === w0 + 3, t);

w0 = nWrites();
await say(111, TASK);
await say(111, '/connections');
t = await say(111, 'yes');
check('a slash command in between closes the offer: a later "yes" pushes nothing', nWrites() === w0 && !/Pushed/.test(t), t);

await say(111, TASK);
await say(111, 'what is a pull request?');
t = await say(111, 'yes');
check('a conversation in between closes the offer: a later "yes" pushes nothing', nWrites() === w0 && !/Pushed/.test(t), t);

await say(111, TASK);
t = await say(111, 'yes that sounds right, tell me more');
check('a sentence that merely starts with "yes" is not a confirmation', nWrites() === w0 && !/Pushed/.test(t), t);
t = await say(111, 'yes');
check('...and it closed the offer', nWrites() === w0 && !/Pushed/.test(t), t);

await say(111, TASK);
await new Promise((r) => setTimeout(r, 9500));
t = await say(111, 'yes');
check('after the offer window: "yes" gets a clear "expired", nothing pushed', /offer has expired/.test(t) && nWrites() === w0, t);
await say(111, TASK);
await new Promise((r) => setTimeout(r, 9500));
t = await say(111, 'push it');
check('"push it" after the window: expired too', /offer has expired/.test(t) && nWrites() === w0, t);

await say(111, TASK);
t = await say(111, 'yes');
check('a fresh "yes" right after the offer still works as before', /Pushed ✓/.test(t) && nWrites() === w0 + 3, t);

console.log('[/changes: find a saved change later and push it]');
mode.code = 'fixed'; mode.pick = null;
await say(111, TASK); await say(111, 'no'); // a fresh saved change, offer declined
t = await say(111, '/changes');
const idMatch = /\/push_([a-z0-9_]+)/.exec(t);
check('/changes lists saved changes with a tap-to-push command and the +/− counts', idMatch && /server\.js in fire-dept\/station-app/.test(t) && /\+1/.test(t) && /nothing is pushed unless it says so/.test(t), t);
check('pushed ones are marked (from earlier in this run)', /✓ already pushed/.test(t), t);
const latest = /\n([^\n]*(?<!already pushed)[^\n]*)\n\/push_([a-z0-9_]+)\s*(\n|$)/.exec(t);
const idNew = [...t.matchAll(/^\d+\. ([^\n]*)\n\/push_([a-z0-9_]+)/gm)].find((m) => !/already pushed/.test(m[1]))?.[2];
check('...and at least one that is not pushed yet', Boolean(idNew), t);
w0 = nWrites();
t = await say(111, `/push_${idNew}`);
check('/push_<id> shows what it is and asks first; nothing written yet', /Push this change\?/.test(t) && /NEW branch/.test(t) && /Reply yes to push/.test(t) && nWrites() === w0, t);
t = await say(111, 'yes');
check('"yes" → pull request opened (3 writes), never main', /Pushed ✓/.test(t) && nWrites() === w0 + 3, t);
check('and it is now marked as pushed in /changes', new RegExp(`${idNew}`).test(await say(111, '/changes')) && /already pushed/.test(await say(111, '/changes')));
t = await say(111, '/push_20200101_000000');
check('unknown id → clear message, nothing written', /can't find that saved change/.test(t) && nWrites() === w0 + 3, t);
t = await say(111, '/push_../../etc/passwd');
check('odd ids are not accepted', !/Push this change/.test(t) && nWrites() === w0 + 3, t);

mode.code = 'broken';
await say(111, TASK); await say(111, 'no');
mode.code = 'fixed';
t = await say(111, '/changes');
const bad = [...t.matchAll(/^\d+\. ([^\n]*)\n\/push_([a-z0-9_]+)/gm)].find((m) => /failed the syntax check/.test(m[1]));
check('a change that failed the syntax check is flagged in the list', Boolean(bad), t);
t = await say(111, `/push_${bad?.[2]}`);
check('...and refuses to push it', /won't push it/.test(t) && nWrites() === w0 + 3, t);

check('another business sees only its own saved changes', /don't have any saved changes yet/.test(await say(222, '/changes')) || !/station-app/.test(await say(222, '/changes')));
t = await say(222, `/push_${idNew}`);
check("and can't push someone else's", /can't find that saved change/.test(t), t);

console.log('[a chat message can never push, and the chat model can not fake it]');
w0 = nWrites();
const mc0 = modelCalls.length;
t = await say(111, 'Go ahead and push our code from before the most recent change');
check('"go ahead and push…" as a plain message: answered by code, says nothing is waiting, no model call, nothing pushed', /can't push from a plain message/.test(t) && /nothing is waiting/.test(t) && nWrites() === w0 && modelCalls.length === mc0, t);
check('"commit it" too', /can't push from a plain message/.test(await say(111, 'commit it please')));
await say(111, TASK);
t = await say(111, 'go ahead and push it');
check('but right after a real offer, "go ahead and push it" is a go-ahead', /Pushed ✓/.test(t) && nWrites() === w0 + 3, t);
t = await say(111, 'push the changes in server.js please');
check('(a normal sentence that mentions pushing is not hijacked either way — it is not a push command)', nWrites() === w0 + 3, t);


console.log('[the helper]');
{
  const mc = modelCalls.length;
  const codeDir = path.join(tmp, 'home', 'Desktop', 'code');
  fs.renameSync(codeDir, codeDir + '_bak'); // clean slate: no saved changes yet
  const short = (x) => x.split(/[.!?]\s/).length <= 3 && x.length < 330 && !/\n•/.test(x);
  t = await say(333, "i'm lost");
  check('vague "I\'m lost": no model call, short, no feature menu', modelCalls.length === mc && short(t) && !/Draft emails/.test(t), t);
  t = await say(111, "What's should I do next");
  check('typo\'d "what\'s should I do next" is still the helper (not the notes tool)', /\/code in/.test(t) && !/notes/.test(t), t);
  t = await say(111, 'what now');
  check('"what now" short and about their code', short(t) && /\/code in/.test(t), t);
  t = await say(111, 'I need help with my code');
  check('"I need help with my code": says yes, names the project, asks what they need — no command syntax, no menu', /station-app/.test(t) && /What do you need done\?/.test(t) && /Yes/.test(t) && !/\/code in/.test(t) && !/email/i.test(t), t);
  check('...with no model call at all', modelCalls.length === mc);
  t = await say(111, 'how does my code work');
  check('"how does my code work": honest, short', /can't walk you through/.test(t) && short(t), t);
  t = await say(111, 'How do I push a change');
  check('"how do I push": a real instruction, no bare /push_<id>', /\/code in <project>/.test(t) && !/^\/push_<id>$/.test(t.trim()), t);
  t = await say(111, 'How do I connect my code');
  check('"connect my code" when already linked: says so', /already linked/.test(t), t);
  t = await say(333, 'how do I connect my code');
  check('a chat without GitHub: told it is not switched on / how to link, not /code', !/\/code in/.test(t), t);
  fs.renameSync(codeDir + '_bak', codeDir);
  t = await say(111, '/help how does this work');
  check('/help <question> goes to the helper', short(t), t);
  t = await say(111, '/help');
  check('plain /help still lists what I can do, plus a hint', /Here's what I can do/.test(t) && /Lost\? Send \/help/.test(t), t);
  t = await say(222, "im confused");
  check("another business gets its own answer (nothing from the admin's projects)", !/station-app/.test(t), t);
  t = await say(111, 'help me write an email to John');
  check('"help me write an email" is NOT the helper (goes on to the normal router)', !/Just say it|what you need/.test(t), t);
  // open push offer
  mode.code = 'fixed'; mode.pick = null;
  await say(111, '/code in station, fix the crash in server.js');
  t = await say(111, "i'm stuck");
  check('with a push offer open: "reply yes", one sentence', /reply yes to open the pull request/.test(t) && short(t), t);
  t = await say(111, 'I need help with my code');
  check('...same for a code question while an offer is open', /reply yes to open the pull request/.test(t), t);
  const w1 = nWrites();
  t = await say(111, 'yes');
  check('...and asking for help did NOT cancel the offer: yes still pushes', /Pushed ✓/.test(t) && nWrites() === w1 + 3, t);
  await new Promise((r) => setTimeout(r, 1100));
  await say(111, '/code in station, fix the crash in server.js');
  t = await say(111, '/help what next');
  check('a /help during an open offer keeps it too', /reply yes to open the pull request/.test(t), t);
  check('...and yes still works afterwards', /Pushed ✓/.test(await say(111, 'yes')));
  await new Promise((r) => setTimeout(r, 1100));
  await say(111, '/code in station, fix the crash in server.js'); await say(111, 'no');
  t = await say(111, 'what do i do next');
  check('a saved, unpushed change points to /changes', /saved change/.test(t) && /\/changes/.test(t) && short(t), t);
  t = await say(111, 'I need help with my code');
  check('same for the code question', /saved change/.test(t) && /\/changes/.test(t), t);
  await new Promise((r) => setTimeout(r, 1100));
  mode.code = 'broken';
  await say(111, '/code in station, fix the crash in server.js');
  t = await say(111, 'I need help with my code');
  check('if the last change failed its check, says so and how to retry', /failed its check/.test(t) && /\/code in station-app/.test(t), t);
  mode.code = 'fixed';
  // secrets
  const mc2 = modelCalls.length;
  t = await say(111, 'here is my key gsk_abcdefghijklmnopqrstuvwxyz0123456789ABCD please use it');
  check('a pasted secret is refused, not read: no model call', /don't send those in chat/.test(t) && modelCalls.length === mc2, t);
  check('github token and PEM are caught too', /don't send those/.test(await say(222, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789')) && /don't send those/.test(await say(222, '-----BEGIN RSA PRIVATE KEY-----')));
  check('the secret text never appears in the reply', !/gsk_abc/.test(t));
  check('normal sentences are not flagged', !/don't send those/.test(await say(111, 'make a note: ask-for-sk-ills review')));
  const chatCall = modelCalls.find((m) => m.system.includes('helpful, direct assistant'));
  check('the chat prompt has the real facts and no placeholder project', chatCall && /ONLY things you know/.test(chatCall.system) && !/myapp/.test(chatCall.system));
}

console.log('[guardrails: no acting on a hunch, no invented details, plain limits]');
{
  const mcA = modelCalls.length;
  t = await say(111, 'Who sent and email');
  check('"who sent an email": plain limit, no model call, nothing drafted', /can't read your inbox/.test(t) && modelCalls.length === mcA, t);
  t = await say(111, "What’s in my email drafts");
  check('"what\'s in my email drafts" (curly apostrophe): plain limit, not the notes tool', /can't read your inbox/.test(t) && !/notes/.test(t), t);
  const mcB = modelCalls.length;
  t = await say(111, 'I need help making and email');
  check('"I need help making and email": helper asks who/what, no model call, no invented draft', /Who is it to/.test(t) && modelCalls.length === mcB && !/John Doe|Subject:/.test(t), t);
  t = await say(111, 'I need help on excel');
  check('"I need help on excel": helper explains in one line, never lists a file', /spreadsheet/.test(t) && !/Here's what's in/.test(t) && modelCalls.length === mcB, t);
  t = await say(111, 'I need help with a text file');
  check('help with files: an example, no action', /todo\.txt/.test(t));
  t = await say(111, 'help with my calendar');
  check('help with calendar: short answer', t.length < 200 && !/Here's what/.test(t), t);
  t = await say(111, 'help me write an email to John');
  check('a concrete request is NOT intercepted by the helper', !/Who is it to, and what about\? Say it like/.test(t), t);
  // the router proposing things the words do not support
  mode.router = { action: 'draft_email', recipient: 'John Doe', email_subject: 'Hi', email_body: 'Hello' };
  t = await say(111, 'make an email');
  check('email with no recipient in their words: asks who, never invents "John Doe"', /Who is the email to/.test(t) && !/John Doe/.test(t), t);
  mode.router = { action: 'draft_email', recipient: 'John', email_subject: 'Friday', email_body: 'See you Friday.' };
  t = await say(111, 'draft an email to John about Friday');
  check('a proper request goes through (recipient is in their words)', !/Who is the email to/.test(t), t);
  mode.router = { action: 'list_notes' };
  t = await say(111, 'what is going on with my stuff');
  check('router says list_notes but they never mentioned notes: it just talks', !/notes saved/.test(t), t);
  mode.router = { action: 'view_excel', filename: 'inventory' };
  t = await say(111, 'tell me a joke');
  check('router says view_excel for "tell me a joke": it just talks', !/Here's what's in/.test(t), t);
  mode.router = { action: 'write_file', filename: 'x.txt', file_content: 'hi' };
  t = await say(111, 'is there a file called x.txt');
  check('a question is never turned into creating a file', !/Want me to create|Shall I|confirm/i.test(t) && !/yes\/no/.test(t), t);
  mode.router = { action: 'weather', location: 'Paris' };
  t = await say(111, 'what is going on in Paris');
  check('weather needs a weather word', !/°|weather/i.test(t), t);
  mode.router = null;
  t = await say(111, 'asdf qwerty');
  check('nothing understood: one short question, no menu', !/email|spreadsheet|text file/.test(t) && t.length < 100, t);
  t = await say(111, "What’s should I do next");
  check('curly-apostrophe "What’s should I do next" is the helper', /\/code in|\/changes|reply yes/.test(t), t);
}

console.log('[conversation: memory, real facts, no made-up answers]');
{
  const mc = modelCalls.length;
  t = await say(111, 'what time is it');
  check('the time comes from the clock, not the model', /\d{1,2}:\d{2}/.test(t) && modelCalls.length === mc, t);
  t = await say(111, 'Can you tell me what time it is');
  check('"can you tell me what time it is": still from the clock', /\d{1,2}:\d{2}/.test(t) && modelCalls.length === mc, t);
  t = await say(111, 'What LLM hosts you');
  check('"what LLM hosts you": the real model name, no model call', /llama3\.2:3b/.test(t) && !/Google Cloud/.test(t) && modelCalls.length === mc, t);
  t = await say(111, 'What other tools can I connect');
  check('"what can I connect": only what really exists (no Slack/Trello)', /GitHub/.test(t) && !/Slack|Trello|Drive/.test(t) && modelCalls.length === mc, t);
  t = await say(111, 'what can you do');
  check('"what can you do": from the real tool list, one line', /spreadsheets/.test(t) && /code changes/.test(t) && !/\n/.test(t) && modelCalls.length === mc, t);
  t = await say(222, 'what can you do');
  check('another business gets its own list (no code if no GitHub tool for it)', /spreadsheets/.test(t), t);
  // memory
  t = await say(111, 'hello there my friend');
  const m1 = modelCalls.length;
  t = await say(111, 'what did you just say');
  const call = modelCalls[modelCalls.length - 1];
  check('the next chat call carries the earlier turns (user + the bot\'s own reply)', modelCalls.length > m1 && call.messages.some((m) => m.role === 'user' && /hello there my friend/.test(m.content)) && call.messages.some((m) => m.role === 'assistant' && /Hi there\./.test(m.content)), JSON.stringify(call.messages.slice(1)));
  check('...and the current message is last, only once', call.messages[call.messages.length - 1].content === 'what did you just say' && call.messages.filter((m) => m.content === 'what did you just say').length === 1);
  await say(111, 'hello again please');
  const c2 = modelCalls[modelCalls.length - 1];
  await say(222, 'hello from business two');
  const c3 = modelCalls[modelCalls.length - 1];
  check("one chat's memory never shows up in another's", !c3.messages.some((m) => /hello there my friend|hello again/.test(m.content)), JSON.stringify(c3.messages.slice(1)));
  check('real project name in the facts, not a placeholder', /station-app/.test(c2.system) && !/myapp/.test(c2.system));
  await say(111, '/connect github');
  await say(111, 'one more hello for you');
  const c4 = modelCalls[modelCalls.length - 1];
  check('links from earlier replies are never kept in memory', !c4.messages.some((m) => /https?:\/\//.test(m.content)), JSON.stringify(c4.messages.slice(1)));
  check('slash commands are not remembered as conversation', !c4.messages.some((m) => /^\/connect/.test(m.content)));
  const cdir = path.join(tmp, 'home', 'Desktop', 'code');
  fs.renameSync(cdir, cdir + '_bak2'); // no saved changes: the plain "can you help with code" answer
  t = await say(111, 'You wnat to help me code');
  check('typo\'d "You wnat to help me code" goes to the helper: yes + what do you need', /station-app/.test(t) && /What do you need done/.test(t) && !/^g\./.test(t), t);
  t = await say(111, 'Ok you wnat to help me code');
  check('"Ok you wnat to help me code" too (leading "ok")', /What do you need done/.test(t), t);
  fs.renameSync(cdir + '_bak2', cdir);
  check('abbreviations do not cut a reply short', true);
}

console.log('[round 2: acknowledgements, follow-ups, no invented files, longer memory]');
{
  const mc = modelCalls.length;
  check('"got it": no text, no model call', (await say(111, 'got it', { maxMs: 1500 })) === '' && modelCalls.length === mc);
  check('"nvm" / "haha": nothing either', (await say(111, 'nvm', { maxMs: 1200 })) === '' && (await say(111, 'Hahah', { maxMs: 1200 })) === '' && modelCalls.length === mc);
  check('"thanks": one word', (await say(111, 'thanks')) === 'Anytime.');
  mode.router = { action: 'write_excel', filename: 'project_data.xlsx', sheet_rows: [['Project Name', 'Project Description'], ['Project 1', 'This is project 1']] };
  t = await say(111, 'The one from earlier the spreadsheet one');
  check('a follow-up about "earlier" never reaches the tool router — no invented file', !/I'll create|project_data|Sound good/.test(t) && !modelCalls.slice(mc).some((m) => /You read a short message and decide/.test(m.system)), t);
  t = await say(111, 'tell me about spreadsheets please');
  check('router says write_excel but they never asked to make one: no file', !/I'll create|project_data|Sound good/.test(t), t);
  mode.router = { action: 'view_excel', filename: 'spreadsheet' };
  t = await say(111, 'What about excel and spreadsheet how do they work');
  check('a "how does it work" question is just answered — no file lookup', !/couldn't find a spreadsheet/.test(t), t);
  mode.router = null;
  // memory depth
  await say(111, 'my codeword is pineapple');
  for (let i = 0; i < 7; i++) await say(111, `chat number ${i} hello`);
  await say(111, 'what was my codeword');
  const cm = modelCalls[modelCalls.length - 1];
  check('8 exchanges later the early message is still in memory', cm.messages.some((m) => /pineapple/.test(m.content)), JSON.stringify(cm.messages.map((m) => m.content).slice(0, 4)));
  const chat = modelCalls.filter((m) => m.system.includes('helpful, direct assistant')).pop();
  check('prompt says it can tell the time and that sending to others is what it cannot do', /tell the time and date/.test(chat.system) && /to other people for them/.test(chat.system) && !/send messages for them/.test(chat.system));
  check('prompt says what to do when asked about code help (yes + ask what they need)', /say yes/.test(chat.system) && /Don't show command syntax/.test(chat.system));
}

console.log('[round 3: math by code, no invented numbers, no refusal spiral, quiet about itself]');
{
  const mc = modelCalls.length;
  check('"5 + 7": exact answer from code, no model', (await say(111, '5 + 7')) === '5 + 7 = 12' && modelCalls.length === mc);
  check("\"What's 12 times 3\": 12 x 3 = 36", (await say(111, "What's 12 times 3")) === '12 x 3 = 36');
  check('percent and brackets', (await say(111, 'what is 15% of 80')) === '15% of 80 = 12' && (await say(111, '(3+4)*2')) === '(3 + 4) x 2 = 14');
  check('divide by zero is refused plainly', /can't divide by zero/.test(await say(111, '10 / 0')));
  mode.router = { action: 'add', a: 5, b: 7 };
  t = await say(111, '1-10');
  check('"1-10" is a score, not subtraction — and the router can not invent 5 + 7', !/5 \+ 7|= 12|-9/.test(t), t);
  t = await say(111, 'What would you rate me overall 1-10');
  check('same inside a sentence', !/5 \+ 7|= 12/.test(t), t);
  mode.router = null;
  // refusals do not poison later turns
  mode.chat = "I can't make one up.";
  await say(111, 'tell me a joke about cats');
  mode.chat = null;
  await say(111, 'ok so one more try please');
  const lastChat = modelCalls[modelCalls.length - 1];
  check("the bot's own earlier refusal is not fed back to the model", !lastChat.messages.some((m) => m.role === 'assistant' && /can't make one up/.test(m.content)), JSON.stringify(lastChat.messages.slice(1)));
  const cp = modelCalls.filter((m) => m.system.includes('helpful, direct assistant')).pop();
  check('prompt: chat can do jokes/advice/homework and use emoji; never say it can not', /tell jokes/.test(cp.system) && /emoji/.test(cp.system) && /Never say you can't do these/.test(cp.system));
  check("prompt: doesn't volunteer model/hardware and doesn't claim wants or ratings", /don't mention what model or computer you run on/.test(cp.system) && /no real wants or feelings/.test(cp.system) && !/llama3\.2/.test(cp.system));
  check('chat is a little less robotic (temperature above 0), router stays exact (0)', cp.options.temperature === 0.5 && modelCalls.filter((m) => /decide which of these actions/.test(m.system)).every((m) => m.options.temperature === 0));
  check('"Yes so what is 1-10": a chatty lead-in still gets exact subtraction', (await say(111, 'Yes so what is 1-10')) === '1 - 10 = -9');
  mode.router = { action: 'add', a: 1, b: 10 };
  t = await say(111, 'subtract 10 from 1 for me');
  check('the router can not turn "subtract" into "add"', !/1 \+ 10|= 11/.test(t), t);
  mode.router = null;
  t = await say(222, 'what are you');
  check('a business is told only that it is an AI assistant — no model details', /AI assistant set up for/.test(t) && !/llama/.test(t), t);
}

console.log('[connect text is honest about writing]');
check('/connect github says it only pushes after yes, as a pull request', /only after you say yes/.test(await say(111, '/connect github')));

proc.kill(); tg.close(); ollama.close(); gh.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('--- server log ---\n' + log.slice(-2500)); process.exit(1); }
