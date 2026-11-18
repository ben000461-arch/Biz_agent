// apply-phase3.mjs — one-time edit of server.js that adds the website chat door (POST /web/chat).
// Run AFTER apply-phase2.mjs and apply-phase2b.mjs, with webchat.js in the same folder.
// Backup first (server.js.bak-phase3), every edit must match exactly once or nothing is written,
// refuses to run twice.   Run from the simple-agent folder:   node apply-phase3.mjs
import fs from 'node:fs';

const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
if (!src.includes('createMeter')) { console.log('Run apply-phase2.mjs and apply-phase2b.mjs first. Nothing changed.'); process.exit(1); }
if (src.includes('mountWebChat')) { console.log('Already applied. Nothing changed.'); process.exit(0); }
if (!fs.existsSync(new URL('./webchat.js', import.meta.url))) { console.log('webchat.js is missing from this folder. Copy it in first. Nothing changed.'); process.exit(1); }

const problems = [];
const once = (label, find, replace) => {
  const n = src.split(find).length - 1;
  if (n !== 1) { problems.push(`${label}: expected 1 match, found ${n}`); return; }
  src = src.replace(find, () => replace);
};

once('import', "import { PLANS as PLAN_TABLE, SETTABLE_PLANS, creditCost } from './plans.js';\n",
"import { PLANS as PLAN_TABLE, SETTABLE_PLANS, creditCost } from './plans.js';\nimport { createWebAuth, mountWebChat } from './webchat.js';\n");

// replies for the website are collected instead of sent to Telegram
once('send message', "  if (clean.length > 4000) clean = `${clean.slice(0, 3990)}\\n…(trimmed)`; // Telegram caps messages at 4096\n",
"  if (clean.length > 4000) clean = `${clean.slice(0, 3990)}\\n…(trimmed)`; // Telegram caps messages at 4096\n  const webSink = als.getStore()?.sink; // a message typed on the website: the answer goes back to the website\n  if (webSink) { webSink.push(clean); remember(chatId, 'assistant', clean); return; }\n");
once('send document', "async function sendTelegramDocument(chatId, filePath, caption) {\n",
"async function sendTelegramDocument(chatId, filePath, caption) {\n  const webSink = als.getStore()?.sink;\n  if (webSink) { webSink.push(`I made a file (${path.basename(filePath)}). Files can only be sent in Telegram, so ask me there if you need it.`); return; }\n");
once('react', "async function reactToMessage(chatId, messageId, emoji) {\n",
"async function reactToMessage(chatId, messageId, emoji) {\n  const webSink = als.getStore()?.sink;\n  if (webSink) { webSink.push(emoji); return; }\n");
once('carry sink', "  return als.run({ tenant, ent }, () => handleMessageInner(message));",
"  return als.run({ tenant, ent, sink: als.getStore()?.sink }, () => handleMessageInner(message));");

once('mount', "app.get('/health', (_req, res) => res.json({ ok: true }));\n",
`app.get('/health', (_req, res) => res.json({ ok: true }));

// The website's chat box. Same engine as Telegram; the answer goes back to the page instead.
// Only the website's own address may call it (SITE_URL, plus WEB_ORIGINS if you list more, comma-separated).
const webAuth = createWebAuth({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });
mountWebChat(app, {
  express,
  auth: webAuth,
  getTenant: (chatId) => store.get(chatId),
  siteOrigin: (() => { try { return new URL(SITE_URL).origin; } catch { return ''; } })(),
  extraOrigins: String(process.env.WEB_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  run: async (tenant, text) => {
    const replies = [];
    const message = { chat: { id: Number(tenant.chatId) }, from: { id: 'web' }, text, message_id: null }; // never the owner, so no admin powers from a web page
    await enqueue(String(tenant.chatId), () => als.run({ sink: { push: (t) => replies.push(String(t)) } }, () => handleMessage(message)));
    return replies;
  },
  log: (line) => console.log(line),
});
console.log(\`Website chat: \${webAuth.enabled ? 'on (POST /web/chat)' : 'OFF (needs the Supabase settings)'}.\`);
`);

if (problems.length) {
  console.log('Nothing was changed. These edits did not match your server.js:');
  for (const p of problems) console.log('  - ' + p);
  console.log('Send me this list and the lines around each spot.');
  process.exit(1);
}
fs.copyFileSync(file, `${file}.bak-phase3`);
fs.writeFileSync(file, src);
console.log(`Done. Saved your old file as ${file}.bak-phase3 (restore with: cp ${file}.bak-phase3 ${file}).`);
