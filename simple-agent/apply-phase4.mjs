// apply-phase4.mjs — adds "schedule a meeting" (calendar booking with a yes/no first) and "build an agent"
// (up to 3 agents per business that run on a schedule and text the owner) to the bot.
//
// Needs these files in the same folder: when.js, agents.js, phase4-blocks.txt (all sent with this script).
// Changes: server.js, google.js, tenants.js, meter.js. Saves a backup of each as <name>.bak-phase4.
// Safe to run twice (it says "Already applied"), and it changes NOTHING unless every edit fits.
//   node apply-phase4.mjs
import fs from 'node:fs';

const dir = process.argv[2] || '.';
const read = (f) => fs.readFileSync(`${dir}/${f}`, 'utf8');
const blocksSrc = read('phase4-blocks.txt');
const blocks = {};
for (const part of blocksSrc.split(/^\/\/#### /m).slice(1)) { const nl = part.indexOf('\n'); blocks[part.slice(0, nl).trim()] = part.slice(nl + 1); }
for (const need of ['CORE', 'COMMANDS', 'SCHEDULER']) if (!blocks[need]) { console.log(`phase4-blocks.txt is missing the ${need} part. Nothing changed.`); process.exit(1); }

const files = {};
for (const f of ['server.js', 'google.js', 'tenants.js', 'meter.js']) files[f] = read(f);
if (files['server.js'].includes('agentKit') && files['google.js'].includes('createEvent') && files['tenants.js'].includes('addAgent') && files['meter.js'].includes('agent_delete')) {
  console.log('Already applied. Nothing changed.');
  process.exit(0);
}

const problems = [];
function rep(file, name, find, replace) {
  const n = files[file].split(find).length - 1;
  if (n !== 1) { problems.push(`${file}: "${name}" expected 1 match, found ${n}`); return; }
  files[file] = files[file].replace(find, () => replace);
}

// ---------------------------------------------------------------- google.js
rep('google.js', 'import', "import crypto from 'crypto';", "import crypto from 'crypto';\nimport { zonedParts, zonedToUtc } from './when.js';");
rep('google.js', 'scope', "  'https://www.googleapis.com/auth/calendar.readonly',", "  'https://www.googleapis.com/auth/calendar.events', // read events, and add the ones the owner said yes to");
rep('google.js', 'reconnect class', 'export class NeedsReconnect extends Error {}', 'export class NeedsReconnect extends Error {}\n// the saved sign-in is fine but was granted before we asked for this permission (e.g. read-only calendar)\nexport class NeedsMoreAccess extends Error {}');
rep('google.js', 'googleFetch', "    if (res.status === 401) throw new NeedsReconnect('Google rejected the saved sign-in');\n    if (!res.ok) throw new Error(`Google API error ${res.status}`);",
  "    if (res.status === 401) throw new NeedsReconnect('Google rejected the saved sign-in');\n    if (res.status === 403) {\n      const body = await res.json().catch(() => ({}));\n      if (/insufficient|scope/i.test(JSON.stringify(body?.error || ''))) throw new NeedsMoreAccess('the saved sign-in lacks this permission');\n      throw new Error('Google API error 403');\n    }\n    if (!res.ok) throw new Error(`Google API error ${res.status}`);");
rep('google.js', 'startOfDay', "      const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };",
  "      const startOfDay = (d) => {\n        if (tz) { const p = zonedParts(d, tz); return zonedToUtc({ y: p.y, m: p.m, d: p.d }, tz); } // the business's own midnight\n        const x = new Date(d); x.setHours(0, 0, 0, 0); return x;\n      };\n      const nextMidnight = (d) => startOfDay(new Date(startOfDay(d).getTime() + 30 * 36e5)); // 30h later is always tomorrow, even on clock-change days");
rep('google.js', 'day windows',
  "      if (when === 'tomorrow') { from = startOfDay(new Date(now.getTime() + 864e5)); to = new Date(from.getTime() + 864e5); }\n      else if (when === 'week') { to = new Date(now.getTime() + 7 * 864e5); }\n      else { to = new Date(startOfDay(now).getTime() + 864e5); }",
  "      if (when === 'tomorrow') { from = nextMidnight(now); to = nextMidnight(from); }\n      else if (when === 'week') { to = new Date(now.getTime() + 7 * 864e5); }\n      else { to = nextMidnight(now); }");
rep('google.js', 'new methods',
  "        allDay: Boolean(e.start?.date && !e.start?.dateTime),\n      }));\n    },\n  };\n}",
  `        allDay: Boolean(e.start?.date && !e.start?.dateTime),
      }));
    },

    // Events overlapping a window (to warn about a clash before booking).
    async eventsBetween(chatId, fromISO, toISO) {
      const token = await this.accessToken(chatId);
      const q = new URLSearchParams({ timeMin: new Date(fromISO).toISOString(), timeMax: new Date(toISO).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '10' });
      const data = await googleFetch(\`\${CAL}/calendars/primary/events?\${q}\`, token);
      return (data.items || []).filter((e) => e.status !== 'cancelled').map((e) => ({
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date,
        allDay: Boolean(e.start?.date && !e.start?.dateTime),
      }));
    },

    // Adds ONE event to the owner's main calendar. Only called after they said yes in chat.
    async createEvent(chatId, { title, startISO, endISO, tz }) {
      const token = await this.accessToken(chatId);
      const clean = String(title || '').replace(/[\\r\\n]+/g, ' ').trim().slice(0, 200) || 'Event';
      const when = (iso) => ({ dateTime: new Date(iso).toISOString(), ...(tz ? { timeZone: tz } : {}) });
      return googleFetch(\`\${CAL}/calendars/primary/events\`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: clean, start: when(startISO), end: when(endISO) }),
      });
    },
  };
}`);
rep('google.js', 'header', "// (OAuth), creating Gmail drafts, and reading the calendar. Nothing here sends", "// (OAuth), creating Gmail drafts, reading the calendar and adding events the owner approved. Nothing here sends");

// ---------------------------------------------------------------- tenants.js
rep('tenants.js', 'agent methods', '    setTools(chatId, groups) {',
  `    // Time zone (an IANA name like America/Chicago; the caller has checked it) and the most agents this business may have.
    setTimezone(chatId, tz) {
      const t = state.tenants[String(chatId)];
      if (!t) return false;
      t.tz = String(tz).slice(0, 60);
      save();
      return true;
    },
    setAgentCap(chatId, n) {
      const t = state.tenants[String(chatId)];
      if (!t) return false;
      t.agentCap = Math.min(10, Math.max(1, Math.floor(Number(n)) || 3));
      save();
      return true;
    },

    // Agents (see agents.js). Only these few fields can ever be changed after creation.
    agents(chatId) {
      return state.tenants[String(chatId)]?.agents || [];
    },
    addAgent(chatId, agent, cap = 3) {
      const t = state.tenants[String(chatId)];
      if (!t) return { error: 'unknown' };
      t.agents ||= [];
      if (t.agents.length >= cap) return { error: 'cap' };
      t.agents.push(agent);
      save();
      return { agent };
    },
    updateAgent(chatId, id, patch) {
      const a = (state.tenants[String(chatId)]?.agents || []).find((x) => x.id === id);
      if (!a) return null;
      for (const k of ['name', 'enabled', 'schedule', 'lastRunAt', 'armedAt', 'lastStatus', 'runs']) if (k in patch) a[k] = patch[k];
      save();
      return a;
    },
    removeAgent(chatId, id) {
      const t = state.tenants[String(chatId)];
      const before = t?.agents?.length || 0;
      if (!before) return false;
      t.agents = t.agents.filter((x) => x.id !== id);
      save();
      return t.agents.length < before;
    },

    setTools(chatId, groups) {`);

// ---------------------------------------------------------------- meter.js
rep('meter.js', 'free actions', "'chat', 'add', 'multiply', 'add_note', 'list_notes', 'disconnect', 'remove_model', 'cloud_ok', 'push_change',", "'chat', 'add', 'multiply', 'add_note', 'list_notes', 'disconnect', 'remove_model', 'cloud_ok', 'push_change', 'agent_delete',");

// ---------------------------------------------------------------- server.js
const S = 'server.js';
rep(S, 'google import', "import { createGoogle, NeedsReconnect } from './google.js';", "import { createGoogle, NeedsReconnect, NeedsMoreAccess } from './google.js';");
rep(S, 'imports', "import { createWebAuth, mountWebChat } from './webchat.js';", "import { createWebAuth, mountWebChat } from './webchat.js';\nimport { parseWhen, parseDuration, deriveTitle, looksLikeBooking, formatWhen, tzAbbrev, clock12, validTz, zonedParts, parseSchedule, describeSchedule, dueAt } from './when.js';\nimport * as agentKit from './agents.js';");
rep(S, 'action group', "  list_events: 'calendar',\n  list_repos: 'github'", "  list_events: 'calendar', create_event: 'calendar',\n  list_repos: 'github'");
rep(S, 'router prompt', "- \"list_events\": the message asks what's on their calendar, schedule, or meetings. Extract \"when\": \"today\", \"tomorrow\", or \"week\" (default \"today\").\n",
  "- \"list_events\": the message asks what's on their calendar, schedule, or meetings. Extract \"when\": \"today\", \"tomorrow\", or \"week\" (default \"today\").\n- \"create_event\": the message asks to schedule, book or add a meeting, appointment or event to the calendar. Extract \"title\" (a short name for it, in the person's own words). Do not work out the date or time.\n");
rep(S, 'router json enum', '|"list_events"${gh ?', '|"list_events"|"create_event"${gh ?');
rep(S, 'router json fields', '"when": string|null${gh ?', '"when": string|null, "title": string|null${gh ?');
rep(S, 'vetRoute start', 'function vetRoute(tenant, text, parsed) {\n  const action = parsed.action;', 'function vetRoute(tenant, text, parsed) {\n  const booked = vetBooking(tenant, text, parsed);\n  if (booked) return booked;\n  const action = parsed.action;');
rep(S, 'core block', '// null = fine to go ahead; { reply } = say this instead; { chat: true } = just talk.\n', `${blocks.CORE}\n// null = fine to go ahead; { reply } = say this instead; { chat: true } = just talk.\n`);
rep(S, 'needs confirmation', "const NEEDS_CONFIRMATION = new Set(['write_file', 'write_excel', 'edit_excel']);", "const NEEDS_CONFIRMATION = new Set(['write_file', 'write_excel', 'edit_excel', 'create_event']);");
rep(S, 'confirmation prompt', "  return null;\n}\n\n// ---------------------------------------------------------------------------\n// Commands (/start, /help, /instructions, and admin-only ones)", "  if (action === 'create_event') return confirmEventPrompt(tenant, args);\n  return null;\n}\n\n// ---------------------------------------------------------------------------\n// Commands (/start, /help, /instructions, and admin-only ones)");
rep(S, 'enough info', "        (action === 'edit_excel' && parsed.filename);", "        (action === 'edit_excel' && parsed.filename) ||\n        (action === 'create_event' && parsed.startISO);");
rep(S, 'pending set', "          if (action !== 'edit_excel' || args.updatedRows) {\n            pendingActions.set(key, { action, args, createdAt: Date.now() });\n          }\n          logEvent(tenant, { kind: 'action', action, status: 'asked', detail: detailOf(parsed) });",
  "          if (action === 'create_event' ? args.confirmOk : (action !== 'edit_excel' || args.updatedRows)) {\n            pendingActions.set(key, { action, args, createdAt: Date.now() });\n          }\n          logEvent(tenant, action === 'create_event' && !args.confirmOk\n            ? { kind: 'blocked', action, status: 'blocked', reason: 'calendar not ready' }\n            : { kind: 'action', action, status: 'asked', detail: detailOf(parsed) });");
rep(S, 'veto reroute', "      parsed.action = 'chat'; action = 'chat';\n    }", "      parsed.action = 'chat'; action = 'chat';\n    } else if (parsed.action !== action) {\n      action = parsed.action; // the booking check may have changed the route\n    }");
rep(S, 'booking skips the router', "    const parsed = FOLLOWUP_RE.test(text) && !DO_VERB_RE.test(text) ? { action: 'chat' } : await interpretCommand(tenant, text);", "    const parsed = FOLLOWUP_RE.test(text) && !DO_VERB_RE.test(text) ? { action: 'chat' } : looksLikeBooking(text) ? { action: 'create_event', title: null } : await interpretCommand(tenant, text);");
rep(S, 'execute', "  if (action === 'list_events') return { text: await calendarSummary(tenant, when) };", "  if (action === 'create_event') return createEventAction(tenant, args);\n  if (action === 'agent_run') return agentRunAction(tenant, args);\n  if (action === 'agent_delete') return agentDeleteAction(tenant, args);\n  if (action === 'list_events') return { text: await calendarSummary(tenant, when) };");
rep(S, 'calendar tz', 'events = await google.listEvents(tenant.chatId, w);', 'events = await google.listEvents(tenant.chatId, w, tenantTz(tenant));');
rep(S, 'calendar format tz', "    return d.toLocaleString('en-US', { ...(w === 'week' ? { weekday: 'short' } : {}), hour: 'numeric', minute: '2-digit' });", "    return d.toLocaleString('en-US', { ...(w === 'week' ? { weekday: 'short' } : {}), hour: 'numeric', minute: '2-digit', timeZone: tenantTz(tenant) });");
rep(S, 'help calendar', "  if (has('calendar') && google) lines.push('• Calendar — \"what\\'s on my calendar today?\"');", "  if (has('calendar') && google) lines.push('• Calendar — \"what\\'s on my calendar today?\", \"schedule a meeting with Tom tomorrow at 3pm\"');");
rep(S, 'help agents', "  lines.push(\"I'll always check with you before changing a file.\");", "  lines.push(\"I'll always check with you before changing a file.\");\n  lines.push('• Agents — \"build an agent\" sets up a helper that runs on a schedule and texts you (/agents)');");
rep(S, 'capabilities calendar', "  if (has('calendar') && google) out.push('check your calendar');", "  if (has('calendar') && google) out.push('check your calendar and add events you approve');");
rep(S, 'capabilities agents', "  if (has('utilities')) out.push('keep notes, do quick math, check the weather');", "  if (has('utilities')) out.push('keep notes, do quick math, check the weather');\n  out.push('build agents that run on a schedule and message you (send /agents)');");
rep(S, 'helper calendar', "s.googleConnected ? 'Ask like \"what\\'s on my calendar today?\" or \"…tomorrow?\".'", "s.googleConnected ? 'Ask like \"what\\'s on my calendar today?\" or \"…tomorrow?\" — or say \"schedule a meeting with Tom tomorrow at 3pm\" and I\\'ll ask before adding it.'");
rep(S, 'connect text', "Google (Gmail + Calendar) — I can only save email drafts and read your calendar, and I never send email on my own. Google's screen words the Gmail permission as \"manage drafts and send emails\"; that is the narrowest it offers.",
  "Google (Gmail + Calendar) — I can save email drafts and add calendar events, only after you say yes in chat, and I never send email on my own. Google's screen words these as \"manage drafts and send emails\" and \"view and edit events on all your calendars\"; those are the narrowest permissions it offers.");
rep(S, 'google connected message', 'I can now save email drafts to your Gmail and check your calendar. Try:', 'I can now save email drafts to your Gmail and check or add to your calendar. Try:');
rep(S, 'commands', "    case '/instructions': {", `${blocks.COMMANDS}\n    case '/instructions': {`);
rep(S, 'wizard', "  const tenant = store.get(chatId);\n  if (!tenant) return handleStranger(chatId, message);\n\n  if (!text.startsWith('/')) remember(chatId, 'user', text);",
  "  const tenant = store.get(chatId);\n  if (!tenant) return handleStranger(chatId, message);\n\n  // Halfway through \"build an agent\"? Their next plain message answers the question we asked.\n  const draft = agentDrafts.get(key);\n  if (draft && !text.startsWith('/')) {\n    if (Date.now() - draft.createdAt > agentKit.DRAFT_TTL_MS) agentDrafts.delete(key);\n    else {\n      try { return await continueAgentDraft(tenant, chatId, key, draft, text); } catch (err) {\n        console.error('[agent] builder failed:', err?.name || 'Error');\n        agentDrafts.delete(key);\n        return await sendTelegramMessage(chatId, 'Something went wrong on my end, so I scrapped that agent. Say \"build an agent\" to start again.');\n      }\n    }\n  }\n\n  if (!text.startsWith('/')) remember(chatId, 'user', text);");
rep(S, 'agent intent', "    const asked = connectionsIntent(text);", "    const agentAsk = agentKit.agentsIntent(text);\n    if (agentAsk && (await handleCommand({ chatId, text: agentAsk, isAdmin }))) {\n      logEvent(tenant, { kind: 'command', action: '/agent', status: 'done' });\n      return;\n    }\n\n    const asked = connectionsIntent(text);");
rep(S, 'reset memory', "  chatMemory.delete(String(chatId));\n  pendingActions.delete(String(chatId));", "  chatMemory.delete(String(chatId));\n  pendingActions.delete(String(chatId));\n  agentDrafts.delete(String(chatId));");
rep(S, 'bot menu', "        { command: 'connections', description: 'See what is linked' },", "        { command: 'connections', description: 'See what is linked' },\n        { command: 'agents', description: 'Build and manage your agents' },");
rep(S, 'scheduler', 'app.listen(PORT, () => {', `${blocks.SCHEDULER}\napp.listen(PORT, () => {`);

if (problems.length) {
  console.log('Nothing changed — some edits did not fit your files:');
  for (const p of problems) console.log(`  - ${p}`);
  console.log('Send me this list and I will adjust the script.');
  process.exit(1);
}
for (const f of Object.keys(files)) {
  fs.copyFileSync(`${dir}/${f}`, `${dir}/${f}.bak-phase4`);
  fs.writeFileSync(`${dir}/${f}`, files[f]);
}
console.log('Done. Backups saved as server.js.bak-phase4, google.js.bak-phase4, tenants.js.bak-phase4, meter.js.bak-phase4.');
console.log('Restore any file with: cp <name>.bak-phase4 <name>');
