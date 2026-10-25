// apply-phase3c.mjs — third edit for the website chat:
//  * the chat model can no longer pretend it connected/reconnected something (and "connect", "reconnect a tool" in plain words give the real links)
//  * code in chat answers keeps its line breaks and can be longer (shown as code blocks on the website)
//  * "New chat" on the website starts the agent's memory fresh; reopening an old chat gives it the last few turns back
// Run AFTER apply-phase3b.mjs, with the new webchat.js in this folder.   node apply-phase3c.mjs
import fs from 'node:fs';

const file = process.argv[2] || 'server.js';
let src = fs.readFileSync(file, 'utf8');
if (!src.includes('pushFile')) { console.log('Run apply-phase3b.mjs first. Nothing changed.'); process.exit(1); }
if (src.includes('resetMemory')) { console.log('Already applied. Nothing changed.'); process.exit(0); }

const problems = [];
const once = (label, find, replace) => {
  const n = src.split(find).length - 1;
  if (n !== 1) { problems.push(`${label}: expected 1 match, found ${n}`); return; }
  src = src.replace(find, () => replace);
};

// 1. code-aware trimming of chat replies
once('trim', "function trimChatReply(reply) {\n", "function trimChatReply(reply) {\n  if (reply.includes('```')) return reply.replace(/\\r/g, '').trim().slice(0, 3500); // code keeps its line breaks and length\n");

// 2. prompt: code is allowed to be long; never claim to have connected anything
once('prompt brief',
  "- Be brief: one or two sentences, never more. No lists, no tutorials.",
  "- Be brief: one or two sentences, never more, and no lists or tutorials — EXCEPT when they ask for code or a how-to: then give a complete answer, and put every piece of code in a fenced block that names the language and puts each line of code on its own line (for example \\`\\`\\`python on its own line, the code, then \\`\\`\\` on its own line).");
once('prompt claims',
  "- Never say you've sent, saved, pushed or are waiting for a confirmation — a chat reply can't do any of that.",
  "- Never say you've sent, saved, pushed, connected, reconnected or linked anything, or that you are waiting for a confirmation — a chat reply can't do any of that. To connect or reconnect Google, GitHub or an AI key, the person types: connect.");

// 3. filter: a chat reply that claims an account was connected is replaced by the truth
once('claim filter', "async function chatReply(tenant, userText) {\n",
`const CLAIMED_ACTION_RE = /\\b(?:connected|reconnected|re-?authorized|linked|disconnected)\\b[^.?!]{0,60}\\b(?:now|ready|successfully|account|for (?:drafting|use))\\b|\\bi(?:'ve| have|'m| am| just)? (?:now |just )?(?:connect|reconnect|link|re-?authorize|disconnect)(?:ed|ing)\\b|\\b(?:re-?connecting|connecting)\\b[^.?!]{0,40}\\bnow\\b|\\bshall i (?:re-?)?connect\\b/i;
async function chatReply(tenant, userText) {
`);
once('claim use', "    return r ? trimChatReply(r) : null;\n  } catch (err) {\n    console.error('chatReply failed:'",
  "    if (r && CLAIMED_ACTION_RE.test(r)) return 'I can\\'t connect or change accounts just by chatting. Say \"connect\" and I\\'ll give you the secure links.';\n    return r ? trimChatReply(r) : null;\n  } catch (err) {\n    console.error('chatReply failed:'");

// 4. plain-words connect: replace the whole helper
{
  const a = src.indexOf('function connectionsIntent(raw) {');
  const b = src.indexOf('\nasync function deliver(chatId, tenant, result) {');
  if (a < 0 || b < 0 || b < a) problems.push('connectionsIntent: not found');
  else src = src.slice(0, a) + `function connectionsIntent(raw) {
  const t = String(raw || '').toLowerCase().replace(/[?!.]+$/g, '').trim();
  if (!t || t.length > 80 || /\\b(how|why|when|safe|secure|work|works|does|do you|are you|did you|disconnect|unlink|remove|delete|code|python)\\b/.test(t)) return null;
  if (/^(what|which|show|list|see|check|view)\\b.*\\b(my|our)\\b.*\\b(connections?|connected|integrations?)\\b/.test(t) || /^(my )?(connections|integrations)$/.test(t)) return '/connections';
  const words = t.split(/\\s+/);
  if (words.length <= 7 && /\\b(?:re-?)?conn?e+c?t(?:ing)?\\b|\\bre-?connet\\b|\\bconect\\b|\\bhook up\\b|\\bsign in to\\b/.test(t)) {
    if (/\\b(google|gmail|calendar|google calendar)\\b/.test(t)) return '/connect google';
    if (/\\bgithub\\b/.test(t)) return '/connect github';
    if (/\\b(api key|ai model|my own model|model)\\b/.test(t)) return '/connect model';
    if (words.every((w) => /^(?:can|could|will|would|we|you|i|u|please|let'?s|lets|want|need|like|wanna|to|a|my|the|an|some|(?:re-?)?conn?e+c?t(?:ing)?|re-?connet|conect|hook|up|set|setup|tool|tools|app|apps|account|accounts|service|services|something|again|new|another|other|one)$/.test(w))) return '/connect';
  }
  return null;
}
` + src.slice(b);
}

// 5. New chat on the website: fresh memory (and the last turns of an old chat on reopen)
once('reset helper', "function recall(chatId) {\n",
`// A new chat on the website starts clean; reopening an old one hands back its last few turns.
function resetMemory(chatId, turns = []) {
  chatMemory.delete(String(chatId));
  pendingActions.delete(String(chatId));
  for (const t of turns) remember(chatId, t.role === 'assistant' ? 'assistant' : 'user', t.text);
}
function recall(chatId) {
`);
once('run signature', "  run: async (tenant, text) => {\n", "  run: async (tenant, text, opts = {}) => {\n");
once('run reset', "    await enqueue(String(tenant.chatId), () => als.run({ sink }, () => handleMessage(message)));",
  "    await enqueue(String(tenant.chatId), () => { if (opts.fresh) resetMemory(tenant.chatId, opts.history || []); return als.run({ sink }, () => handleMessage(message)); });");

if (problems.length) {
  console.log('Nothing was changed. These edits did not match your server.js:');
  for (const p of problems) console.log('  - ' + p);
  console.log('Send me this list and the lines around each spot.');
  process.exit(1);
}
fs.copyFileSync(file, `${file}.bak-phase3c`);
fs.writeFileSync(file, src);
console.log(`Done. Saved your old file as ${file}.bak-phase3c (restore with: cp ${file}.bak-phase3c ${file}).`);
