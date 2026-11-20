// "Agent" browser extension: the server side.
//
// The extension sends a SNAPSHOT of the page the employee is looking at (visible text, plus the form fields,
// buttons and links it can act on, each with a short id like "e7") and what they asked for. We ask the model
// for a PLAN: a short list of steps that only use those ids. Nothing happens on the page until the employee
// approves the plan in the extension, and the extension re-checks each step after doing it.
//
// Safety rules enforced HERE (never trusted to the model or the browser):
//   - steps may only use element ids that are in the snapshot, with an action that fits the element
//     (fill a field, pick an option that exists, tick a checkbox, click a button/link)
//   - at most MAX_STEPS steps; values are plain text with a length cap
//   - card numbers and Social Security numbers are masked before anything reaches a model
//   - nothing from the page is logged: only the site's host name and step counts

export const MAX_STEPS = 20;
const MAX_ELEMENTS = 300;
const MAX_TEXT = 6000;
const MAX_VALUE = 2000;
const MAX_DOC_VALUE = 12000; // a whole essay can go into a document
export const AUTO_MAX_STEPS = 6;
export const MAX_ROUNDS = 6; // look-act-look again, for things like opening a menu and then picking from it
const ROLES = new Set(['menuitem', 'menu', 'tab', 'option', 'switch', 'treeitem', 'combobox']);
const MAX_HISTORY = 6;
// "document" = the body of an editor like Google Docs: filling it types at the cursor (never replaces the doc)
const KINDS = new Set(['field', 'textarea', 'document', 'select', 'checkbox', 'radio', 'button', 'link']);
// fill on a document = write at the cursor; replace = swap the whole document for new text; clear = empty it
const ACTIONS = { insert: ['document'], submit: ['field'], fill: ['field', 'textarea', 'document'], replace: ['document'], clear: ['document'], undo: ['document'], select: ['select'], check: ['checkbox', 'radio'], uncheck: ['checkbox'], click: ['button', 'link', 'checkbox', 'radio'] };

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').slice(0, n);

function luhnOk(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

// Mask Social Security numbers and real-looking card numbers.
export function maskSensitive(text) {
  return String(text ?? '')
    .replace(/\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g, '[SSN hidden]')
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
      const digits = m.replace(/\D/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhnOk(digits) ? '[card number hidden]' : m;
    });
}

// Clean up what the browser sent. Returns { ok, snapshot } or { ok:false, error }.
export function cleanSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'no page' };
  let host = '';
  try { const u = new URL(String(raw.url || '')); if (!/^https?:$/.test(u.protocol)) return { ok: false, error: 'unsupported page' }; host = u.hostname; } catch { return { ok: false, error: 'unsupported page' }; }
  const seen = new Set();
  const elements = [];
  for (const e of Array.isArray(raw.elements) ? raw.elements.slice(0, MAX_ELEMENTS) : []) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id || '');
    if (!/^e\d{1,4}$/.test(id) || seen.has(id) || !KINDS.has(e.kind)) continue;
    seen.add(id);
    const el = { id, kind: e.kind, label: maskSensitive(clip(e.label, 120)) };
    if (e.type) el.type = clip(e.type, 20);
    if (e.value != null && e.value !== '') el.value = maskSensitive(clip(e.value, e.kind === 'document' ? 3000 : 200));
    if (e.kind === 'document' && e.empty === true) el.empty = true;
    if (e.kind === 'document') { const st = cleanStyle(e.style); if (st) el.style = st; } // how its text looks now
    if (e.popup === true) el.popup = true;
    if (e.kind === 'field' && e.search === true) el.search = true; // a search box: pressing Enter just searches
    if (['dialog', 'top', 'side', 'main', 'bottom'].includes(e.where)) el.where = e.where; // where it is on screen
    if (e.offscreen === true) el.offscreen = true; // scrolled out of view
    if (e.fresh === true) el.fresh = true; // appeared after Agent's last step (a dialog, a compose window...)      // opens a menu, list or tab (harmless to click)
    if (ROLES.has(e.role)) el.role = e.role;
    if (e.kind === 'select' && Array.isArray(e.options)) el.options = e.options.slice(0, 60).map((o) => clip(o, 80));
    if (e.checked != null) el.checked = Boolean(e.checked);
    if (e.required) el.required = true;
    elements.push(el);
  }
  // panels from other sites shown inside the page (an image picker, a payment box...): Agent can't see inside them
  const frames = (Array.isArray(raw.frames) ? raw.frames.slice(0, 5) : []).filter((f) => f && typeof f === 'object')
    .map((f) => ({ label: maskSensitive(clip(f.label, 80)).trim(), host: clip(String(f.host || '').toLowerCase().replace(/[^a-z0-9.-]/g, ''), 100) }))
    .filter((f) => f.label || f.host);
  return {
    ok: true,
    snapshot: { host, title: maskSensitive(clip(raw.title, 200)), text: maskSensitive(clip(raw.text, MAX_TEXT)), elements, frames },
  };
}

// The last few messages of this chat, so a follow-up like "how about now" or "make it shorter" makes sense.
// Only what the employee typed and what Agent said back; masked and capped. Never page content.
export function cleanHistory(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(-MAX_HISTORY)
    .filter((h) => h && (h.who === 'you' || h.who === 'agent') && String(h.text ?? '').trim())
    .map((h) => ({ who: h.who, text: clip(maskSensitive(clip(h.text, 400)).replace(/\s+/g, ' ').trim(), 300) }));
}

export function planPrompt(snapshot, request, history = [], round = 1, { screenshot = false } = {}) {
  const list = snapshot.elements.map((e) => {
    let line = `${e.id} | ${e.kind}${e.type ? `:${e.type}` : ''}${e.role ? ` (${e.role})` : ''} | "${e.label}"`;
    if (e.popup) line += ' | opens a menu';
    if (e.search) line += ' | search box';
    if (e.fresh) line += ' | NEW';
    if (e.where === 'dialog') line += ' | in a pop-up window';
    if (e.offscreen) line += ' | off screen';
    if (e.kind === 'document') line += (e.empty ? ' | empty' : e.value ? ` | contains: "${e.value}"` : '') + (e.style ? ` | current style: ${JSON.stringify(e.style)}` : '');
    else if (e.value) line += ` | now: "${e.value}"`;
    if (e.options) line += ` | options: ${e.options.map((o) => `"${o}"`).join(', ')}`;
    if (e.checked != null) line += ` | ${e.checked ? 'checked' : 'unchecked'}`;
    if (e.required) line += ' | required';
    return line;
  }).join('\n');
  const last = round >= MAX_ROUNDS;
  const system = `You are Agent, a careful assistant that gets things done on the web page an office employee is looking at, in any web app (email, docs, forms, CRMs, dashboards).
You get the page's visible text and a numbered list of things you can act on: fields, buttons, links, menus, tabs and documents/editors.

${screenshot ? `You also get a SCREENSHOT of what the employee sees. Each thing you can act on has a small numbered tag drawn on it: tag 12 is element e12. Use the picture to tell things apart (which box is the big title, which window just opened, what's selected). Black boxes hide private fields. The "Agent" bar at the bottom of the screen is you: ignore it and anything underneath it.

` : ''}How to think:
- First work out what the employee actually wants and what's on the page now (read the text and what each document contains).
- Prefer the smallest change that does it. Add when they ask to add; rewrite only when they ask to change what's there.
- If a tool on the page can do it (a menu, a toolbar button, a dialog), use it. Menus often have to be opened first.

Rules:
- Use ONLY the element ids listed (like "e7"). Never invent ids.
- Actions: "fill" (type into a field), "submit" (press Enter in a field), "select" (pick a listed option, exactly as written), "check"/"uncheck", "click" (buttons, links, menus, tabs).
- Things marked NEW just appeared after your last step (a dialog, a compose window, a menu). They're usually what you need next.
- Choices (radio buttons, checkboxes, ratings) are listed as "Question: option". Use "check" on the option to pick.
- Never make up answers about the employee themselves: how they feel, what they did, their opinions, personal check-ins and surveys. Leave those out and ask them in "say". Leave optional "Other" boxes empty unless they're needed.
- Do math carefully and show the working (like "3,278.91 + 2,166.68 = 5,445.59"); it gets checked.
- To search: "fill" the search box, then "submit" it. Don't click a search button; pages often replace it while you type.
- Take facts from the page or the request. Never make up facts about real people or records (names, numbers, dates, accounts); leave it out and say so.
- When asked to WRITE something (a sentence, paragraph, essay, email, reply), compose it yourself and put the finished text in the value.
- Don't click anything that pays, deletes, submits or sends unless the employee clearly asked for that.
- At most ${MAX_STEPS} steps, in order. If it can't be done here, return no steps and say why in plain words.
- "say" is one or two short, plain sentences: what you'll do, or why you can't. Talk like a person: never mention element ids (like "e7"), "listed elements" or other internals.
- Panels from other sites (listed under "Panels you can't see inside") are walled off. If the task continues in one, do the steps up to it, then in "say" tell the employee the one thing to do there themselves (for example: "I've opened Google Images: search 'dog' and click the one you want."), and stop.

Looking again: some tasks need a look at the page after a step (a menu or dialog opens and shows new choices). Then plan only the steps up to that point and set "more": true; you'll get the updated page and can continue. ${last ? 'This is the LAST look: finish now or explain what is left, and set "more": false.' : `This is look ${round} of at most ${MAX_ROUNDS}.`}

Documents and editors (kind "document": a Google Doc, an email body, a notes editor...):
- "fill" ADDS your text where the cursor is (or at the end). Use it to add something new, and for "expand", "continue", "keep going", "add more".
- "replace" swaps the WHOLE document for your text. Use it only when they ask to change what's there: rewrite, shorten, fix, reformat, or turn it into something else. Include everything that should stay.
- "insert" writes your text AT A SPOT in the document: "find" is text that's in the document now, copied exactly and unique (a question's last words, or a blank like "a. ________"). Your text goes right after it; with "swap": true it replaces it (use that to fill in blanks). Use this to answer questions where they are, one step per answer. Keep inserted text short (one line).
- "clear" deletes everything. "undo" takes back your last change ("value": "all" to undo every change you made, back to the original).
- Slides and other editors can have several text boxes, each listed as its own document (for example 'Text box "Click to add title"'). Write into the right one; a box showing "Click to add..." is empty.
- Text format: a line "# Title" is the title, "## Heading" a heading, a blank line between paragraphs. Never run paragraphs together.
- Style (optional, on fill/replace): "style": {"font": "Times New Roman", "size": 12, "spacing": "single"|"1.5"|"double", "indent": true|false (first-line indent), "align": "left"|"center"|"right"|"justify"}.
- New text automatically matches the document's current style. Only give a style when they ask for a different look, and then keep it the same for every paragraph.
- To change how existing text looks (font, spacing, remove or add indents), "replace" it with exactly the same text plus the new style. Don't click toolbar formatting buttons for that: nothing is selected, so they do nothing.

Respond ONLY with JSON: {"say": string, "more": boolean, "steps": [{"do": "fill"|"insert"|"submit"|"replace"|"clear"|"undo"|"select"|"check"|"uncheck"|"click", "id": string, "value": string|null, "find": string|null, "swap": boolean|null, "style": object|null}]}`;
  const user = `Page: ${snapshot.title} (${snapshot.host})

Visible text:
${snapshot.text || '(none)'}

Things you can act on:
${list || '(nothing)'}
${snapshot.frames?.length ? `\nPanels you can't see inside: ${snapshot.frames.map((f) => `"${f.label || 'panel'}"${f.host ? ` (${f.host})` : ''}`).join(', ')}\n` : ''}
${history.length ? `Earlier in this chat:\n${history.map((h) => `${h.who === 'you' ? 'Employee' : 'You'}: ${h.text}`).join('\n')}\n\n` : ''}${round > 1 ? `(Look ${round}: you already did the steps above for this request; continue from the page as it is now.)\n` : ''}The employee asked: ${clip(request, 1000)}`;
  return { system, user };
}

const FONT = /^[A-Za-z][A-Za-z0-9 '-]{0,39}$/;
// Only known style settings with sane values get through; anything else is ignored.
export function cleanStyle(st) {
  if (!st || typeof st !== 'object') return null;
  const out = {};
  if (typeof st.font === 'string' && FONT.test(st.font.trim())) out.font = st.font.trim();
  const size = Number(st.size); if (Number.isFinite(size) && size >= 6 && size <= 48) out.size = Math.round(size);
  const sp = String(st.spacing ?? '').toLowerCase(); if (['single', '1.5', 'double'].includes(sp)) out.spacing = sp;
  if (typeof st.indent === 'boolean') out.indent = st.indent;
  if (['left', 'center', 'right', 'justify'].includes(st.align)) out.align = st.align;
  return Object.keys(out).length ? out : null;
}

// Check the model's plan against the snapshot. Bad steps are dropped and reported, never "fixed up".
export function checkPlan(data, snapshot, round = 1) {
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  const steps = [];
  const dropped = [];
  const raw = Array.isArray(data?.steps) ? data.steps : [];
  for (const s of raw) {
    if (steps.length >= MAX_STEPS) { dropped.push('too many steps'); break; }
    const action = String(s?.do || '').toLowerCase();
    const el = byId.get(String(s?.id || ''));
    if (!ACTIONS[action]) { dropped.push(`unknown action "${clip(action, 20)}"`); continue; }
    if (!el) { dropped.push(`unknown element "${clip(s?.id, 12)}"`); continue; }
    if (!ACTIONS[action].includes(el.kind)) { dropped.push(`can't ${action} ${el.kind} "${el.label}"`); continue; }
    const step = { do: action, id: el.id, label: el.label || el.kind, kind: el.kind };
    if (action === 'fill' || action === 'replace') {
      if (s.value == null || String(s.value).trim() === '') { dropped.push(`no value for "${el.label}"`); continue; }
      step.value = clip(s.value, el.kind === 'document' ? MAX_DOC_VALUE : MAX_VALUE);
      if (el.kind === 'document') {
        const st = cleanStyle(s.style ?? (s.spacing === 'double' ? { spacing: 'double' } : null));
        if (st) step.style = st;
      }
    }
    if (action === 'undo') step.value = s.value === 'all' ? 'all' : 'last';
    if (action === 'insert') {
      const find = clip(s.find, 300).trim();
      if (!find || s.value == null || !String(s.value).trim()) { dropped.push(`nothing to insert or no spot for "${el.label}"`); continue; }
      step.find = find;
      step.value = clip(String(s.value).replace(/\s*\n\s*/g, ' '), 1000).trim(); // one line: it goes inside existing text
      if (s.swap === true) step.swap = true;
    }
    if (action === 'select') {
      const want = String(s.value ?? '').trim().toLowerCase();
      const match = (el.options || []).find((o) => o.trim().toLowerCase() === want);
      if (!match) { dropped.push(`"${clip(s.value, 40)}" isn't an option for "${el.label}"`); continue; }
      step.value = match;
    }
    steps.push(step);
  }
  // Small, easy-to-undo tasks may run without a click (if the employee turned that on). Decided HERE from the
  // steps themselves, never by the model: only filling empty fields, picking options, ticking boxes and adding
  // text to a document, at most AUTO_MAX_STEPS steps. Clicking anything, replacing or clearing a document, or
  // overwriting something already filled in always waits for approval.
  // Also fine on their own: opening a menu, list or tab (nothing happens until something IN it is picked),
  // writing into an EMPTY document, and undoing Agent's own last change.
  const auto = steps.length > 0 && steps.length <= AUTO_MAX_STEPS && steps.every((st) => {
    const el = byId.get(st.id);
    if (st.do === 'fill') return el.kind === 'document' || !el.value;
    if (st.do === 'insert') return !st.swap || /_{3,}/.test(st.find); // adding next to text, or filling a blank line
    if (st.do === 'replace') return el.empty === true;
    if (st.do === 'click') return el.popup === true || el.role === 'tab';
    if (st.do === 'undo') return st.value === 'last';
    if (st.do === 'submit') return el.search === true; // Enter in a search box only searches; in a form it may send
    return st.do === 'select' || st.do === 'check' || st.do === 'uncheck';
  });
  const more = data?.more === true && steps.length > 0 && round < MAX_ROUNDS;
  // math that doesn't add up is flagged and never runs on its own
  const mathWarnings = steps.flatMap((st) => checkMath(st.value).map((m) => `Check this math in "${st.label}": ${m}`)).slice(0, 5);
  const say = clip(data?.say, 400).trim() || (steps.length ? `I'll do ${steps.length} step${steps.length === 1 ? '' : 's'} on this page.` : "I couldn't find a way to do that on this page.");
  return { say, steps, dropped, auto: auto && !mathWarnings.length, more, mathWarnings };
}

// ---------------------------------------------------------------- math check
// Finds sums written out in a value ("$3,278.91 + deposits $2,166.68 - $12.00 = $3,578.53") and redoes them.
// Words between the numbers are ignored; only + - × ÷ and = are understood. Returns plain-English problems.
const NUM = String.raw`\$?\(?-?\d[\d,]*(?:\.\d+)?\)?`;
export function checkMath(text) {
  const out = [];
  const src = String(text ?? '');
  const re = new RegExp(String.raw`((?:${NUM}\s*(?:[A-Za-z ]{0,25})?\s*[+\-−–×x*÷/]\s*(?:[A-Za-z ]{0,25})?)+${NUM})\s*=\s*(${NUM})`, 'g');
  for (const m of src.matchAll(re)) {
    const tokens = [...m[1].matchAll(new RegExp(String.raw`(${NUM})|([+\-−–×x*÷/])`, 'g'))].map((t) => t[1] ?? t[2]);
    const nums = []; const ops = [];
    for (const t of tokens) {
      if (/\d/.test(t)) { if (nums.length > ops.length) continue; nums.push(Number(t.replace(/[$,()]/g, ''))); }
      else if (nums.length > ops.length) ops.push(t);
    }
    if (nums.length < 2 || ops.length !== nums.length - 1 || nums.some((n) => !Number.isFinite(n))) continue;
    // × and ÷ first, then + and - left to right
    const v = [nums[0]]; const o = [];
    ops.forEach((op, i) => {
      const n = nums[i + 1];
      if (/[×x*]/.test(op)) v[v.length - 1] *= n; else if (/[÷/]/.test(op)) v[v.length - 1] /= n; else { o.push(op); v.push(n); }
    });
    let total = v[0]; o.forEach((op, i) => { total = op === '+' ? total + v[i + 1] : total - v[i + 1]; });
    const said = Number(m[2].replace(/[$,()]/g, ''));
    if (Math.abs(total - said) > 0.005 + Math.abs(said) * 1e-9) {
      const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      out.push(`it says ${fmt(said)}, but it works out to ${fmt(total)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- screenshot
// The page as the employee sees it, drawn with numbered tags by the extension. Only a JPEG or PNG data URL,
// at most ~1.5 MB. It goes to the vision model for one plan and is never stored or logged.
export const MAX_SHOT_CHARS = 2_000_000;
export function cleanShot(x) {
  if (typeof x !== 'string' || x.length > MAX_SHOT_CHARS) return null;
  const m = x.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  return m && m[2].length > 100 ? x : null;
}
