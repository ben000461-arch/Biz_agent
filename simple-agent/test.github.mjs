// E2E for the GitHub connection with FAKE Telegram, Ollama and GitHub.
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { createVault } from './vault.js';

const P = { tg: 18801, ollama: 18802, app: 18803, gh: 18804 };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-e2e-'));
fs.mkdirSync(path.join(tmp, 'home', 'Desktop'), { recursive: true });
const connFile = path.join(tmp, 'data', 'connections.json');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pemFile = path.join(tmp, 'app.pem');
fs.writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
const APP_ID = '4242';

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

const prompts = []; // router system prompts seen
const ollama = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(c).toString());
    const system = body.messages[0].content, user = body.messages[body.messages.length - 1].content;
    const inRepo = /\bin (?:the )?(.+?)\??$/i.exec(user)?.[1] || null;
    let out;
    if (system.includes('helpful, direct assistant')) out = { reply: 'Hi there.' };
    else {
      prompts.push({ user, system });
      if (/projects|repos/i.test(user)) out = { action: 'list_repos' };
      else if (/pull request/i.test(user)) out = { action: 'list_prs', repo: /\bnullrepo\b/.test(user) ? 'null' : inRepo };
      else if (/build/i.test(user)) out = { action: 'build_status', repo: inRepo };
      else out = { action: 'chat' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ message: { content: JSON.stringify(out) } }));
  });
});

// fake GitHub (web + api on one server, split by prefix)
const g = { tokenCalls: 0, uninstalled: [], gone: false, jwtBad: 0, badAuth: 0 };
function jwtOk(h) {
  const t = /^Bearer (.+)$/.exec(h || '')?.[1]; if (!t) return false;
  const [hd, bd, sg] = t.split('.'); if (!sg) return false;
  const okSig = crypto.verify('RSA-SHA256', Buffer.from(`${hd}.${bd}`), publicKey, Buffer.from(sg, 'base64url'));
  const p = JSON.parse(Buffer.from(bd, 'base64url')); const now = Date.now() / 1000;
  return okSig && p.iss === APP_ID && p.exp > now && p.exp - p.iat <= 11 * 60 && JSON.parse(Buffer.from(hd, 'base64url')).alg === 'RS256';
}
const gh = http.createServer((req, res) => {
  const c = []; req.on('data', (d) => c.push(d));
  req.on('end', () => {
    const raw = Buffer.concat(c).toString();
    const json = (o, code = 200) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, 'http://x'); const p = u.pathname; const auth = req.headers.authorization || '';
    if (p === '/web/login/oauth/access_token') {
      const b = JSON.parse(raw);
      if (b.client_id !== 'Iv1.cid' || b.client_secret !== 'gsecret') return json({ error: 'incorrect_client_credentials' });
      if (b.code === 'GHCODE') return json({ access_token: 'ghu_user' });
      if (b.code === 'OTHERCODE') return json({ access_token: 'ghu_other' });
      return json({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
    }
    if (p === '/api/user/installations') {
      if (auth === 'Bearer ghu_user') return json({ installations: [{ id: 777, app_id: 4242, account: { login: 'fire-dept' } }] });
      if (auth === 'Bearer ghu_other') return json({ installations: [{ id: 888, app_id: 4242, account: { login: 'other-biz' } }] });
      return json({}, 401);
    }
    const m = /^\/api\/app\/installations\/(\d+)(\/access_tokens)?$/.exec(p);
    if (m) {
      if (!jwtOk(auth)) { g.jwtBad++; return json({ message: 'bad jwt' }, 401); }
      if (req.method === 'DELETE') { g.uninstalled.push(m[1]); res.statusCode = 204; return res.end(); }
      if (g.gone && m[1] === '777') return json({ message: 'Not Found' }, 404);
      g.tokenCalls++;
      return json({ token: `ghs_${m[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
    }
    if (g.gone && auth.endsWith('777')) return json({ message: 'Bad credentials' }, 401); // revoked with the uninstall
    if (!/^Bearer ghs_(777|888)$/.test(auth)) { g.badAuth++; return json({ message: 'unauth' }, 401); }
    if (p === '/api/installation/repositories') {
      return json({ repositories: auth.endsWith('777')
        ? [{ full_name: 'fire-dept/station-app', name: 'station-app', private: true }, { full_name: 'fire-dept/website', name: 'website', private: false }]
        : [{ full_name: 'other-biz/secret-sauce', name: 'secret-sauce', private: true }] });
    }
    if (p === '/api/repos/fire-dept/station-app/pulls') {
      return json([
        { number: 12, title: 'Fix login crash on old phones '.repeat(5), user: { login: 'chief' }, draft: false, updated_at: new Date(Date.now() - 3 * 3600e3).toISOString() },
        { number: 9, title: 'WIP roster page', user: { login: 'rookie' }, draft: true, updated_at: new Date(Date.now() - 3 * 864e5).toISOString() },
      ]);
    }
    if (p === '/api/repos/fire-dept/website/pulls') return json([]);
    if (p === '/api/repos/fire-dept/station-app/actions/runs') {
      return json({ workflow_runs: [{ name: 'CI', status: 'completed', conclusion: 'failure', head_branch: 'main', updated_at: new Date(Date.now() - 600e3).toISOString() }, { name: 'Deploy', status: 'in_progress', conclusion: null, head_branch: 'main', updated_at: new Date().toISOString() }] });
    }
    json({ message: 'nope' }, 404);
  });
});
for (const [s, p] of [[tg, P.tg], [ollama, P.ollama], [gh, P.gh]]) await new Promise((r) => s.listen(p, r));

const baseEnv = () => ({
  ...process.env, HOME: path.join(tmp, 'home'),
  TELEGRAM_BOT_TOKEN: 'T', ADMIN_TELEGRAM_ID: '111', TELEGRAM_WEBHOOK_SECRET: 's',
  TELEGRAM_API_BASE: `http://127.0.0.1:${P.tg}`, OLLAMA_HOST: `http://127.0.0.1:${P.ollama}`,
  PORT: String(P.app), TENANTS_FILE: path.join(tmp, 'data', 'tenants.json'), WORKSPACES_DIR: path.join(tmp, 'ws'), CONNECTIONS_FILE: connFile,
  PUBLIC_URL: 'https://example.ngrok-free.dev', TOKEN_ENCRYPTION_KEY: 'cd'.repeat(32),
  GITHUB_APP_ID: APP_ID, GITHUB_APP_SLUG: 'biz-agent-test', GITHUB_CLIENT_ID: 'Iv1.cid', GITHUB_CLIENT_SECRET: 'gsecret', GITHUB_APP_PRIVATE_KEY_PATH: pemFile,
  GITHUB_API_BASE: `http://127.0.0.1:${P.gh}/api`, GITHUB_WEB_BASE: `http://127.0.0.1:${P.gh}/web`,
});
function startApp(extra = {}) {
  const proc = spawn('node', ['server.js'], { cwd: path.dirname(new URL(import.meta.url).pathname), env: { ...baseEnv(), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; proc.stdout.on('data', (d) => (log += d)); proc.stderr.on('data', (d) => (log += d));
  return { proc, getLog: () => log };
}
async function waitUp() { for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${P.app}/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); } throw new Error('app did not start'); }
let uid = 9000;
async function say(chat, text, { quietMs = 350, maxMs = 4000 } = {}) {
  const start = sent.length;
  await fetch(`http://127.0.0.1:${P.app}/telegram-webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify({ update_id: ++uid, message: { chat: { id: chat }, from: { id: chat }, text } }) });
  const t0 = Date.now(); let last = Date.now(), seen = start;
  while (Date.now() - t0 < maxMs) { await new Promise((r) => setTimeout(r, 50)); if (sent.length !== seen) { seen = sent.length; last = Date.now(); } else if (seen > start && Date.now() - last > quietMs) break; }
  return sent.slice(start).map((m) => m.text).join('\n---\n');
}
let pass = 0, fail = 0;
const check = (n, c, d = '') => { if (c) { pass++; console.log(`  PASS  ${n}`); } else { fail++; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const cb = (qs) => fetch(`http://127.0.0.1:${P.app}/oauth/github/callback?${qs}`);
const stateFrom = (t) => new URL(/https?:\/\/\S+/.exec(t)[0]).searchParams.get('state');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let app = startApp(); await waitUp();
check('startup says github on', /github: on/.test(app.getLog()), app.getLog());

console.log('[install flow]');
check("stranger can't /connect github", /invite-only/.test(await say(999, '/connect github')));
let t = await say(111, '/connect github');
const link = new URL(/https?:\/\/\S+/.exec(t)[0]);
check('link goes to the app install page', link.pathname === '/web/apps/biz-agent-test/installations/new' && link.searchParams.get('state'), t);
check('owner told it only looks (and that GitHub says read+write)', /only after you say yes/.test(t) && /read and write/.test(t));
check('/connect (no arg) offers github only when google is off', !/Google \(Gmail/.test(await say(111, '/connect')));
check('/connect google says not set up', /Google isn't set up/.test(await say(111, '/connect google')));
check('/connect banana explains', /I can connect: github/.test(await say(111, '/connect banana')));

let s = stateFrom(await say(111, '/connect github'));
check('forged state rejected', (await cb('code=GHCODE&installation_id=777&state=deadbeef')).status === 400);
check('bad code rejected', (await cb(`code=BADCODE&installation_id=777&state=${s}`)).status === 400);
s = stateFrom(await say(111, '/connect github'));
check('missing installation id rejected', (await cb(`code=GHCODE&state=${s}`)).status === 400);
s = stateFrom(await say(111, '/connect github'));
let r = await cb(`code=OTHERCODE&installation_id=777&state=${s}`);
check("can't claim someone else's installation", r.status === 400 && /belong to you/.test(await r.text()));
check('nothing stored after failures', !fs.existsSync(connFile));
check('cancelled install handled', (await cb('error=access_denied')).status === 400);

s = stateFrom(await say(111, '/connect github'));
const before = sent.length;
r = await cb(`code=GHCODE&installation_id=777&setup_action=install&state=${s}`);
check('good install succeeds', r.status === 200 && /Connected/.test(await r.text()));
await wait(300);
check('bot confirms with the account', sent.slice(before).some((m) => m.chat_id === '111' && /GitHub connected as fire-dept/.test(m.text)));
check('state is single-use', (await cb(`code=GHCODE&installation_id=777&state=${s}`)).status === 400);
check('repo-selection update (no state) is a friendly no-op', /Updated/.test(await (await cb('installation_id=777&setup_action=update')).text()));

console.log('[vault]');
const file = fs.readFileSync(connFile, 'utf8');
check('installation id not stored in plain text', !file.includes('installationId') && !file.includes('ghu_user'));
check('account label stored readable', file.includes('fire-dept'));
check('/connections shows github', /GitHub: connected as fire-dept/.test(await say(111, '/connections')));

console.log('[reading GitHub]');
t = await say(111, 'what projects can you see?');
check('lists repos with lock on private', /station-app 🔒/.test(t) && /fire-dept\/website\b(?! 🔒)/.test(t), t);
t = await say(111, 'what pull requests are open in station?');
check('PRs found by fuzzy name', /fire-dept\/station-app/.test(t) && /#12/.test(t) && /#9 WIP roster page \(draft\)/.test(t), t);
check('long title is clipped', /#12 .+…/.test(t));
check('relative times', /3h ago/.test(t) && /3d ago/.test(t));
check('no open PRs handled', /No open pull requests in fire-dept\/website/.test(await say(111, 'any pull requests in website?')));
t = await say(111, 'is the build passing in station app');
check('build status', /CI — ❌ failed/.test(t) && /Deploy — ⏳ running/.test(t), t);
check('unknown project explained', /can't see a project matching "banana"/.test(await say(111, 'pull requests in banana')));
check('no project named with several: asks which', /Which project\?.*station-app.*website/.test(await say(111, 'what pull requests are open')));
check('installation token reused (one exchange)', g.tokenCalls === 1, `calls=${g.tokenCalls}`);
check('every app JWT was valid RS256 and short-lived', g.jwtBad === 0 && g.tokenCalls >= 1);
check('never called GitHub unauthenticated', g.badAuth === 0);

check('the word "null" from the model counts as no project', /Which project\?/.test(await say(111, 'what pull requests are open nullrepo')), 'got a "matching null" style error');

console.log('[prompt stays short unless connected]');
const connectedPrompt = prompts.find((p) => /pull requests/i.test(p.user))?.system || '';
check('connected business: router sees github actions', /list_prs/.test(connectedPrompt));

console.log('[isolation]');
const invite = /start=(\w+)/.exec(await say(111, '/invite Other Biz'))[1];
await say(222, `/start ${invite}`);
t = await say(222, 'what pull requests are open?');
check("other business can't see 111's repos", /isn't connected/.test(t), t);
const otherPrompt = prompts.filter((p) => p.user === 'what pull requests are open?').pop()?.system || '';
check('unconnected business: router prompt has no github actions', !/list_prs/.test(otherPrompt));
check('their /connections is their own', /GitHub: not connected/.test(await say(222, '/connections')));

console.log('[persistence]');
app.proc.kill(); await wait(300); app = startApp(); await waitUp();
check('connection survives restart', /station-app/.test(await say(111, 'what projects can you see?')));

console.log('[app uninstalled on GitHub]');
g.gone = true;
// the cached token is revoked by GitHub too; we must notice
t = await say(111, 'what projects can you see?');
check('uninstall detected, owner told to reconnect', /\/connect github/.test(t), t);
check('dead connection cleaned up', /GitHub: not connected/.test(await say(111, '/connections')));
g.gone = false;

console.log('[disconnect + remove]');
check('/disconnect with nothing connected is polite', /Nothing is connected/.test(await say(111, '/disconnect')));
s = stateFrom(await say(111, '/connect github'));
await cb(`code=GHCODE&installation_id=777&state=${s}`); await wait(300);
t = await say(111, '/disconnect');
check('GitHub disconnect warns about reinstalling and asks', /install it and pick your projects again/.test(t) && /\(yes\/no\)/.test(t), t);
check('nothing uninstalled before the yes', !g.uninstalled.includes('777'));
t = await say(111, 'yes');
check('/disconnect (single connection) uninstalls on GitHub', /removed the GitHub app/.test(t) && g.uninstalled.includes('777'), JSON.stringify(g.uninstalled));
check('secrets gone from disk', !fs.readFileSync(connFile, 'utf8').includes('"github"'));
s = stateFrom(await say(222, '/connect github'));
await cb(`code=OTHERCODE&installation_id=888&state=${s}`); await wait(300);
check('second business connects separately', /GitHub: connected as other-biz/.test(await say(222, '/connections')));
check('and sees only its own repos', /secret-sauce/.test(await say(222, 'what projects can you see?')));
await say(111, '/remove 222');
check('removing a business uninstalls its app', g.uninstalled.includes('888'));

console.log('[two connections at once]');
app.proc.kill(); await wait(300);
const connFile2 = path.join(tmp, 'data', 'connections2.json');
const v2 = createVault(connFile2, 'cd'.repeat(32));
v2.set('111', 'google', { refresh_token: 'x' }, { email: 'owner@biz.com' });
v2.set('111', 'github', { installationId: '777' }, { label: 'fire-dept' });
app = startApp({ CONNECTIONS_FILE: connFile2, GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REVOKE_URL: `http://127.0.0.1:${P.gh}/revoke` }); await waitUp();
t = await say(111, '/disconnect');
check('both connected: bot asks which, with tappable commands', /Which one/.test(t) && /\/disconnect_google — Google \(owner@biz\.com\)/.test(t) && /\/disconnect_github — GitHub \(fire-dept\)/.test(t), t);
check('unknown name explained', /I can disconnect: google, github/.test(await say(111, '/disconnect banana')));
t = await say(111, '/disconnect_google');
check('picking one asks to confirm', /Disconnect Google\?/.test(t) && /\(yes\/no\)/.test(t), t);
await say(111, 'no');
check('"no" leaves both connected', /Google: connected/.test(await say(111, '/connections')) && /GitHub: connected/.test(await say(111, '/connections')));
await say(111, '/disconnect google');
await say(111, 'yes');
t = await say(111, '/connections');
check('only the chosen one is disconnected', /Google: not connected/.test(t) && /GitHub: connected as fire-dept/.test(t), t);

console.log('[misconfiguration]');
app.proc.kill(); await wait(300);
app = startApp({ GITHUB_APP_PRIVATE_KEY_PATH: '/nonexistent.pem' }); await waitUp();
check('missing key file: github off, bot runs', /GitHub connection off/.test(app.getLog()) && /Hi there/.test(await say(111, 'hello')));
app.proc.kill(); await wait(300);
app = startApp({ GITHUB_CLIENT_SECRET: '' }); await waitUp();
check('partial settings: github off + clear warning', /GitHub connection off: set GITHUB_APP_ID/.test(app.getLog()));
check('/connect github then says not set up', /(aren't|isn't) set up/.test(await say(111, '/connect github')));

app.proc.kill(); tg.close(); ollama.close(); gh.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
