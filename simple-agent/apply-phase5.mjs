// apply-phase5.mjs — (1) agents that run "30 minutes before every meeting", and (2) the doors the website's
// Schedule and Agents tabs use (see webapi.js).
//
// Run phase 4 first (apply-phase4.mjs). Needs these files in the same folder: when.js, agents.js, webapi.js,
// phase5-blocks.txt (all sent with this script; when.js and agents.js REPLACE your old copies).
// Changes: server.js, google.js, tenants.js. Saves a backup of each as <name>.bak-phase5.
// Safe to run twice, and it changes NOTHING unless every edit fits.
//   node apply-phase5.mjs
import fs from 'node:fs';

const dir = process.argv[2] || '.';
const read = (f) => fs.readFileSync(`${dir}/${f}`, 'utf8');
const blocks = {};
for (const part of read('phase5-blocks.txt').split(/^\/\/#### /m).slice(1)) { const nl = part.indexOf('\n'); blocks[part.slice(0, nl).trim()] = part.slice(nl + 1); }
for (const need of ['EVENT_TICK', 'WEBAPI']) if (!blocks[need]) { console.log(`phase5-blocks.txt is missing the ${need} part. Nothing changed.`); process.exit(1); }
if (!read('server.js').includes('agentKit')) { console.log('Run apply-phase4.mjs first (this builds on it). Nothing changed.'); process.exit(1); }

const files = {};
for (const f of ['server.js', 'google.js', 'tenants.js']) files[f] = read(f);
if (files['server.js'].includes('eventTick') && files['server.js'].includes('webOps') && files['server.js'].includes('bookingAsks') && files['tenants.js'].includes("'briefed'")) { console.log('Already applied. Nothing changed.'); process.exit(0); }

const problems = [];
function rep(file, name, find, replace) {
  const n = files[file].split(find).length - 1;
  if (n !== 1) { problems.push(`${file}: "${name}" expected 1 match, found ${n}`); return; }
  files[file] = files[file].replace(find, () => replace);
}

// ---------------------------------------------------------------- google.js
rep('google.js', 'eventsBetween signature', 'async eventsBetween(chatId, fromISO, toISO) {', 'async eventsBetween(chatId, fromISO, toISO, max = 10) {');
rep('google.js', 'eventsBetween size', "orderBy: 'startTime', maxResults: '10' });", "orderBy: 'startTime', maxResults: String(Math.min(100, Math.max(1, max))) });");
rep('google.js', 'eventsBetween fields', ".filter((e) => e.status !== 'cancelled').map((e) => ({\n        title: e.summary || '(no title)',\n        start: e.start?.dateTime || e.start?.date,", ".filter((e) => e.status !== 'cancelled').map((e) => ({\n        id: e.id,\n        title: e.summary || '(no title)',\n        start: e.start?.dateTime || e.start?.date,\n        end: e.end?.dateTime || e.end?.date,");

// ---------------------------------------------------------------- tenants.js
rep('tenants.js', 'agent fields', "['name', 'enabled', 'schedule', 'lastRunAt', 'armedAt', 'lastStatus', 'runs']", "['name', 'purpose', 'info', 'tools', 'sheet', 'enabled', 'schedule', 'lastRunAt', 'armedAt', 'lastStatus', 'runs', 'briefed']");

// ---------------------------------------------------------------- server.js
const S = 'server.js';
rep(S, 'when imports', 'validTz, zonedParts, parseSchedule, describeSchedule, dueAt } from', 'validTz, zonedParts, parseSchedule, describeSchedule, dueAt, nextRuns, localDate, startOfLocalDay, fromLocal, fixBookingTypos } from');
rep(S, 'webapi import', "import * as agentKit from './agents.js';", "import * as agentKit from './agents.js';\nimport { mountWebApi } from './webapi.js';");
rep(S, 'run for a meeting',
  "  const tools = agent.tools || [];\n  const parts = [];\n  if (tools.includes('calendar')) {",
  "  const tools = agent.tools || [];\n  const parts = [];\n  let ev = args.event || null;\n  if (agent.schedule?.kind === 'before_event' && !ev) { // \"run it now\": practise on the next real meeting\n    try {\n      const soon = (await google.eventsBetween(tenant.chatId, now.toISOString(), new Date(now.getTime() + 24 * 3600e3).toISOString())).filter((e) => !e.allDay);\n      ev = soon[0] ? { title: soon[0].title, start: soon[0].start } : null;\n    } catch { ev = null; }\n    if (!ev) return { text: `🤖 ${agent.name}: I don't see a meeting in the next 24 hours to practise on. It will run ${describeSchedule(agent.schedule, tz)} once you have one.` };\n  }\n  if (ev) {\n    const p = zonedParts(new Date(ev.start), tz);\n    const mins = Math.round((Date.parse(ev.start) - now.getTime()) / 60000);\n    parts.push(`THE MEETING THIS MESSAGE IS ABOUT:\\n• ${clock12(p.h, p.mi)} — ${ev.title}${mins > 0 ? ` (starts in ${mins} minutes)` : ''}`);\n  }\n  if (tools.includes('calendar')) {");
rep(S, 'scheduled run args', 'async function runScheduledAgent(chatId, agentId) {', 'async function runScheduledAgent(chatId, agentId, extra = {}) {');
rep(S, 'scheduled run action', "const r = await runAction(tenant, 'agent_run', { agentId });", "const r = await runAction(tenant, 'agent_run', { agentId, ...extra });");
rep(S, 'schedule command', "    store.updateAgent(chatId, a.id, { schedule: s, enabled: true, armedAt: new Date().toISOString() });",
  "    if (s.kind === 'before_event' && !google?.isConnected(chatId)) return say('Running before your meetings needs your calendar. Send /connect google first.');\n    store.updateAgent(chatId, a.id, { schedule: s, enabled: true, armedAt: new Date().toISOString(), briefed: {} });");
rep(S, 'event clock', "{\n  const every = Number(process.env.AGENT_TICK_MS) || 30000;\n  setTimeout(agentTick, Math.min(3000, every)).unref();\n  setInterval(agentTick, every).unref();\n}\n",
  "{\n  const every = Number(process.env.AGENT_TICK_MS) || 30000;\n  setTimeout(agentTick, Math.min(3000, every)).unref();\n  setInterval(agentTick, every).unref();\n}\n" + blocks.EVENT_TICK);
rep(S, 'web api', "console.log(`Website chat: ${webAuth.enabled ? 'on (POST /web/chat)' : 'OFF (needs the Supabase settings)'}.`);", "console.log(`Website chat: ${webAuth.enabled ? 'on (POST /web/chat)' : 'OFF (needs the Supabase settings)'}.`);\n" + blocks.WEBAPI);


// ---------------------------------------------------------------- booking: typos, bare "lunch with Dana at 3", follow-up answers, no false "I added it"
rep(S, 'booking asks', "const DAY_TIME_ASK = 'What day and time? For example: schedule a meeting with Tom tomorrow at 3pm.';",
`const DAY_TIME_ASK = 'What day and time? For example: schedule a meeting with Tom tomorrow at 3pm.';
const bookingAsks = new Map(); // chatId -> { text, at }: we asked "what day and time?" and are waiting for the answer
// They answered our "what day and time?" with just the time (or "yes a meeting tomorrow at 3"): join it to the question it answers.
function bookingFollowUp(key, text, tenant) {
  const ask = bookingAsks.get(key);
  if (!ask) return null;
  bookingAsks.delete(key);
  if (Date.now() - ask.at > 10 * 60000 || text.startsWith('/')) return null;
  const rest = text.replace(/^(?:yes|yeah|yep|yup|ok|okay|and|also|so)[,.!]?\\s+/i, '').trim();
  if (/^(?:what|what's|whats|when|how|who|why|which|is|are|do|does|can|show|list|tell)\\b/i.test(rest) || !parseWhen(rest, { tz: tenantTz(tenant) })) return null;
  return looksLikeBooking(rest) ? rest : \`\${ask.text} \${rest}\`;
}
// A chat reply cannot add, schedule or send anything. If the AI says it did, that is not true.
const CLAIMED_DONE_RE = /\\b(?:i(?:'ve| have)?|i'll|i will)\\s+(?:just\\s+|now\\s+|gone ahead and\\s+)?(?:added|scheduled|booked|created|put|set up|saved|sent|drafted|deleted|removed|updated|logged)\\b[^.?!]{0,100}\\b(?:calendar|event|meeting|appointment|invite|email|draft|spreadsheet|sheet|note|file|reminder)\\b|\\b(?:has|have) been (?:added|scheduled|booked|created|saved|sent)\\b/i;`);
rep(S, 'booking typos', 'function vetBooking(tenant, text, parsed) {\n  const booking = looksLikeBooking(text);', 'function vetBooking(tenant, text, parsed) {\n  text = fixBookingTypos(text);\n  const booking = looksLikeBooking(text);');
rep(S, 'booking follow-up', "    const parsed = FOLLOWUP_RE.test(text) && !DO_VERB_RE.test(text) ? { action: 'chat' } : looksLikeBooking(text) ? { action: 'create_event', title: null } : await interpretCommand(tenant, text);\n    let { action } = parsed;\n    parsed.userText = text;",
"    const followUp = bookingFollowUp(key, text, tenant);\n    const bt = followUp || text; // what the booking check reads (a follow-up is joined to the question it answers)\n    const parsed = followUp ? { action: 'create_event', title: null } : FOLLOWUP_RE.test(text) && !DO_VERB_RE.test(text) ? { action: 'chat' } : looksLikeBooking(text) ? { action: 'create_event', title: null } : await interpretCommand(tenant, text);\n    let { action } = parsed;\n    parsed.userText = bt;");
rep(S, 'booking veto text', 'const veto = vetRoute(tenant, text, parsed);', 'const veto = vetRoute(tenant, bt, parsed);');
rep(S, 'remember the question', "      return await sendTelegramMessage(chatId, veto.reply);\n    }\n    if (veto?.chat) {", "      if (parsed.action === 'create_event' && (veto.reply === DAY_TIME_ASK || veto.reply === TIME_ASK)) bookingAsks.set(key, { text: bt, at: Date.now() });\n      return await sendTelegramMessage(chatId, veto.reply);\n    }\n    if (veto?.chat) {");
rep(S, 'chat says it did something', "    if (r && CLAIMED_ACTION_RE.test(r)) return 'I can\\'t connect or change accounts just by chatting. Say \"connect\" and I\\'ll give you the secure links.';",
"    if (r && CLAIMED_ACTION_RE.test(r)) return 'I can\\'t connect or change accounts just by chatting. Say \"connect\" and I\\'ll give you the secure links.';\n    if (r && CLAIMED_DONE_RE.test(r)) return 'I haven\\'t added or sent anything. To put something on your calendar, say it like: schedule lunch with Dana tomorrow at 3pm. I\\'ll show you what I\\'ll add and wait for your yes.';");
rep(S, 'chat prompt', "- Never say you've sent, saved, pushed, connected,", "- Never say you've sent, saved, added, scheduled, booked, pushed, connected,");

if (problems.length) {
  console.log('Nothing changed — some edits did not fit your files:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('Send me this list and I will adjust the script.');
  process.exit(1);
}
for (const f of Object.keys(files)) {
  fs.copyFileSync(`${dir}/${f}`, `${dir}/${f}.bak-phase5`);
  fs.writeFileSync(`${dir}/${f}`, files[f]);
}
console.log('Done. Backups saved as server.js.bak-phase5, google.js.bak-phase5, tenants.js.bak-phase5.');
console.log('Restore any file with: cp <name>.bak-phase5 <name>');
