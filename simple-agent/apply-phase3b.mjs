// apply-phase3b.mjs — second edit for the website chat: every Telegram command works there too, files can be
// downloaded from the page, and "what are my connections" / "connect google" in plain words work (Telegram too).
// Run AFTER apply-phase3.mjs, with the new webchat.js in this folder.   node apply-phase3b.mjs
import fs from 'node:fs';

const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
if (!src.includes('mountWebChat')) { console.log('Run apply-phase3.mjs first. Nothing changed.'); process.exit(1); }
if (src.includes('pushFile')) { console.log('Already applied. Nothing changed.'); process.exit(0); }

const problems = [];
const once = (label, find, replace) => {
  const n = src.split(find).length - 1;
  if (n !== 1) { problems.push(`${label}: expected 1 match, found ${n}`); return; }
  src = src.replace(find, () => replace);
};

once('document', "  if (webSink) { webSink.push(`I made a file (${path.basename(filePath)}). Files can only be sent in Telegram, so ask me there if you need it.`); return; }\n",
`  if (webSink) { // the page offers it as a download (up to 4 MB)
    try {
      const buf = fs.readFileSync(filePath);
      if (buf.length > 4 * 1024 * 1024) webSink.push(\`I made a file (\${path.basename(filePath)}) but it's too big to download here. Ask me for it in Telegram.\`);
      else webSink.pushFile({ name: path.basename(filePath), data: buf.toString('base64') });
    } catch { webSink.push('I made a file but couldn\\'t read it back. Try again.'); }
    return;
  }
`);

once('run', `  run: async (tenant, text) => {
    const replies = [];
    const message = { chat: { id: Number(tenant.chatId) }, from: { id: 'web' }, text, message_id: null }; // never the owner, so no admin powers from a web page
    await enqueue(String(tenant.chatId), () => als.run({ sink: { push: (t) => replies.push(String(t)) } }, () => handleMessage(message)));
    return replies;
  },`,
`  run: async (tenant, text) => {
    const replies = [], files = [];
    // Only the owner's own verified login, tied to the owner's chat, gets owner powers. Everyone else is a normal customer.
    const fromId = ADMIN_ID && tenant.isAdmin && String(tenant.chatId) === ADMIN_ID ? ADMIN_ID : 'web';
    const message = { chat: { id: Number(tenant.chatId) }, from: { id: fromId }, text, message_id: null };
    const sink = { push: (t) => replies.push(String(t)), pushFile: (f) => files.push(f) };
    await enqueue(String(tenant.chatId), () => als.run({ sink }, () => handleMessage(message)));
    return { replies, files };
  },`);

// plain-words versions of /connections and /connect (Telegram and website)
once('intents', "    const plain = norm(text);\n    if (THANKS_RE.test(plain))",
`    const asked = connectionsIntent(text);
    if (asked && (await handleCommand({ chatId, text: asked, isAdmin }))) {
      logEvent(tenant, { kind: 'command', action: asked.split(' ')[0], status: 'done' });
      return;
    }

    const plain = norm(text);
    if (THANKS_RE.test(plain))`);

once('intent helper', "async function deliver(chatId, tenant, result) {",
`// "what are my connections", "connect google", "can we hook up github": answered by the real commands, never by a guess.
function connectionsIntent(raw) {
  const t = String(raw || '').toLowerCase().replace(/[?!.]+$/g, '').trim();
  if (t.length > 80 || /\\b(how|why|when|safe|secure|work|works|does|do you|are you|disconnect|unlink|remove|delete)\\b/.test(t)) return null;
  if (/^(what|which|show|list|see|check|view)\\b.*\\b(connections?|connected|integrations?)\\b/.test(t) || /^(my )?(connections|integrations)$/.test(t)) return '/connections';
  if (/^(can|could|will|would)?\\s*(we|you|i|u)?\\s*(please\\s*)?(connect|link|hook up|set up|setup|sign in to|add)\\b/.test(t) || /^(i )?(want|need|like|wanna) to (connect|link|hook up|set up|add)\\b/.test(t) || /^(let'?s|lets) (connect|link|hook up|set up)\\b/.test(t)) {
    if (/\\b(google|gmail|calendar|google calendar)\\b/.test(t)) return '/connect google';
    if (/\\bgithub\\b/.test(t)) return '/connect github';
    if (/\\b(api key|ai model|my own model|model)\\b/.test(t)) return '/connect model';
    if (/\\b(accounts?|tools?|apps?|services?|something)\\b/.test(t) && t.split(/\\s+/).length <= 5) return '/connect';
  }
  return null;
}

async function deliver(chatId, tenant, result) {`);

if (problems.length) {
  console.log('Nothing was changed. These edits did not match your server.js:');
  for (const p of problems) console.log('  - ' + p);
  console.log('Send me this list and the lines around each spot.');
  process.exit(1);
}
fs.copyFileSync(file, `${file}.bak-phase3b`);
fs.writeFileSync(file, src);
console.log(`Done. Saved your old file as ${file}.bak-phase3b (restore with: cp ${file}.bak-phase3b ${file}).`);
