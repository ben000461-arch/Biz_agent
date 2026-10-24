// apply-phase2.mjs — one-time edit of server.js: model calls go through llm.js, every Telegram message
// is checked against the customer's plan. Safe by design:
//   * makes server.js.bak-phase2 first (a copy you can restore)
//   * every change must match exactly once, or NOTHING is written
//   * refuses to run twice
// Run from the simple-agent folder:   node apply-phase2.mjs
import fs from 'node:fs';

const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
if (src.includes('handleMessageInner')) { console.log('Already applied. Nothing changed.'); process.exit(0); }

const problems = [];
const once = (label, find, replace) => {
  const n = src.split(find).length - 1;
  if (n !== 1) { problems.push(`${label}: expected 1 match, found ${n}`); return; }
  src = src.replace(find, () => replace);
};

// 1. imports
once('imports', "import { createSignups, shortId } from './signups.js';\n",
`import { createSignups, shortId } from './signups.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createLLM } from './llm.js';
import { createEntitlements, frozenMessage, trialReminderMessage } from './entitlement.js';
`);

// 2. set-up, right after the other Supabase helpers
once('setup', "const signups = createSignups({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });\n",
`const signups = createSignups({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });

// Plans + models. The model layer (llm.js) turns a plan's tiers into real models; entitlements say what each
// chat is allowed to do. "als" carries the current chat's plan to wherever a model is called, so no function
// signature has to change.
const als = new AsyncLocalStorage();
const llm = createLLM({
  groqKey: process.env.GROQ_API_KEY || '',
  groqBase: GROQ_API_BASE || undefined,
  ollamaHost: OLLAMA_HOST,
  models: { small: process.env.LLM_SMALL_MODEL, large: process.env.LLM_LARGE_MODEL, local: OLLAMA_MODEL },
  log: (r) => {
    const c = als.getStore();
    if (c && !r.failed) (c.receipts ||= []).push(r); // the credit meter (next step) reads these
    console.log(r.failed ? \`[llm] failed after \${r.attempts.length} attempt(s): \${r.attempts.map((a) => \`\${a.tier}:\${a.reason}\`).join(', ')}\` : \`[llm] \${r.tier} (\${r.model}) \${r.ms}ms\${r.degraded ? \` FALLBACK from \${r.firstChoice}\` : ''} tokens in/out \${r.usage?.in ?? '?'}/\${r.usage?.out ?? '?'}\`);
  },
});
const entitlements = createEntitlements({ url: SUPABASE_URL, key: SUPABASE_SERVICE_KEY });
console.log(\`Models: hosted \${process.env.GROQ_API_KEY ? 'on' : 'OFF (no GROQ_API_KEY: everything runs on the local model)'} [small \${llm.names.small}, large \${llm.names.large}], local \${llm.names.local}. Plans: \${entitlements.enabled ? 'on' : 'OFF (no Supabase settings: every business runs in limited mode)'}.\`);
// Commands a paused (frozen) customer may still use: seeing help, and disconnecting their own accounts.
const FROZEN_OK_COMMANDS = new Set(['/start', '/help', '/connections', '/disconnect', '/disconnect_google', '/disconnect_github', '/disconnect_model', '/unlink']);
`);

// 3. the model call itself: replace the whole old Ollama function
{
  const start = src.indexOf('async function callLocalModel(');
  const endMark = 'return JSON.parse(data.message.content);\n}';
  const end = src.indexOf(endMark);
  if (start < 0 || end < start || src.indexOf('async function callLocalModel(', start + 1) >= 0) problems.push('callLocalModel: block not found exactly once');
  else {
    const replacement = `// Every router / writer / chat model call goes through llm.js. "role" says what the call is for; the
// current chat's plan (via als) says which model that role uses and what to fall back to.
async function callLocalModel(systemPrompt, userText, { role = 'router', history = [], temperature = 0, timeoutMs } = {}) {
  const ctx = als.getStore();
  try {
    const r = await llm.run(ctx?.ent?.plan || null, role, {
      system: systemPrompt, user: userText, history, temperature, json: true,
      maxTokens: role === 'chat' ? 1200 : 3000,
      ...(timeoutMs ? { timeoutMs } : {}),
    });
    return r.data;
  } catch (err) {
    throw new Error("Couldn't reach the AI model right now.");
  }
}`;
    src = src.slice(0, start) + replacement + src.slice(end + endMark.length);
  }
}

// 4. spreadsheet edit = a "writer" job; chat = a "chat" job
once('editExcel', "const parsed = await callLocalModel(systemPrompt, `Current table:\\n${JSON.stringify(currentRows)}\\n\\nRequested change:\\n${instruction}`);",
  "const parsed = await callLocalModel(systemPrompt, `Current table:\\n${JSON.stringify(currentRows)}\\n\\nRequested change:\\n${instruction}`, { role: 'writer' });");
once('chatReply', "const out = await callLocalModel(systemPrompt, userText, { history, temperature: 0.5 });",
  "const out = await callLocalModel(systemPrompt, userText, { role: 'chat', history, temperature: 0.5 });");

// 5. "what model are you?" tells the owner the truth for the plan in use (businesses still get no model details)
once('modelAnswer', "I run on a small AI model (${OLLAMA_MODEL}) on the computer that hosts me — not ChatGPT or Claude.",
  "I run on ${llm.describe(als.getStore()?.ent?.plan || null, 'chat')} — not ChatGPT or Claude.");

// 6. every message passes the plan check first
once('handleMessage', "async function handleMessage(message) {\n  const chatId = message.chat.id;",
`// The front door for every Telegram message: look up the plan, stop paused customers, send trial reminders,
// then run the normal handler with the plan available to every model call underneath.
async function handleMessage(message) {
  const chatId = message.chat.id;
  const tenant = store.get(chatId);
  const text = (message.text || '').trim();
  if (!tenant || !text) return handleMessageInner(message); // strangers and empty messages: unchanged
  let ent;
  try { ent = await entitlements.get(tenant); } catch { ent = null; }
  if (!ent) return handleMessageInner(message);
  if (!ent.canUse) {
    const cmd = text.startsWith('/') ? text.split(/[\\s@]/)[0].toLowerCase() : '';
    if (!FROZEN_OK_COMMANDS.has(cmd)) {
      logEvent(tenant, { kind: 'blocked', action: 'frozen', status: 'blocked', reason: ent.reason || 'paused' });
      return sendTelegramMessage(chatId, frozenMessage(ent, { siteUrl: String(SITE_URL).replace(/\\/?$/, '/') }));
    }
  }
  const due = entitlements.reminderDue(ent);
  if (due) {
    const marked = await entitlements.markReminder(tenant.chatId, due); // mark first, so a failure never means a repeat
    if (marked.ok) await sendTelegramMessage(chatId, trialReminderMessage(ent));
  }
  return als.run({ tenant, ent }, () => handleMessageInner(message));
}

async function handleMessageInner(message) {
  const chatId = message.chat.id;`);

if (problems.length) {
  console.log('Nothing was changed. These edits did not match your server.js:');
  for (const p of problems) console.log('  - ' + p);
  console.log('Send me this list and the lines around each spot.');
  process.exit(1);
}
fs.copyFileSync(file, `${file}.bak-phase2`);
fs.writeFileSync(file, src);
console.log(`Done. Saved your old file as ${file}.bak-phase2 (restore with: cp ${file}.bak-phase2 ${file}).`);
