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
const KINDS = new Set(['field', 'textarea', 'select', 'checkbox', 'radio', 'button', 'link']);
const ACTIONS = { fill: ['field', 'textarea'], select: ['select'], check: ['checkbox', 'radio'], uncheck: ['checkbox'], click: ['button', 'link', 'checkbox', 'radio'] };

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
    if (e.value != null && e.value !== '') el.value = maskSensitive(clip(e.value, 200));
    if (e.kind === 'select' && Array.isArray(e.options)) el.options = e.options.slice(0, 60).map((o) => clip(o, 80));
    if (e.checked != null) el.checked = Boolean(e.checked);
    if (e.required) el.required = true;
    elements.push(el);
  }
  return {
    ok: true,
    snapshot: { host, title: maskSensitive(clip(raw.title, 200)), text: maskSensitive(clip(raw.text, MAX_TEXT)), elements },
  };
}

export function planPrompt(snapshot, request) {
  const list = snapshot.elements.map((e) => {
    let line = `${e.id} | ${e.kind}${e.type ? `:${e.type}` : ''} | "${e.label}"`;
    if (e.value) line += ` | now: "${e.value}"`;
    if (e.options) line += ` | options: ${e.options.map((o) => `"${o}"`).join(', ')}`;
    if (e.checked != null) line += ` | ${e.checked ? 'checked' : 'unchecked'}`;
    if (e.required) line += ' | required';
    return line;
  }).join('\n');
  const system = `You help an office employee get a task done on the web page they are looking at.
You get the page's visible text and a numbered list of things you can act on. Plan the steps; the employee approves them before anything happens.

Rules:
- Use ONLY the element ids listed (like "e7"). Never invent ids.
- Actions: "fill" (type text into a field), "select" (pick one of the listed options, exactly as written), "check"/"uncheck" (checkboxes), "click" (buttons and links).
- Take values from the page text or the request. Never make up facts (names, numbers, dates) that aren't there; leave that field out and say so.
- Do not click buttons that pay, delete, or send something unless the employee clearly asked for that.
- At most ${MAX_STEPS} steps, in order. If the task can't be done on this page, return no steps and explain briefly.
- "say" is one or two short, plain sentences telling the employee what you'll do (or why you can't).

Respond ONLY with JSON: {"say": string, "steps": [{"do": "fill"|"select"|"check"|"uncheck"|"click", "id": string, "value": string|null}]}`;
  const user = `Page: ${snapshot.title} (${snapshot.host})

Visible text:
${snapshot.text || '(none)'}

Things you can act on:
${list || '(nothing)'}

The employee asked: ${clip(request, 1000)}`;
  return { system, user };
}

// Check the model's plan against the snapshot. Bad steps are dropped and reported, never "fixed up".
export function checkPlan(data, snapshot) {
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
    if (action === 'fill') {
      if (s.value == null || String(s.value).trim() === '') { dropped.push(`no value for "${el.label}"`); continue; }
      step.value = clip(s.value, MAX_VALUE);
    }
    if (action === 'select') {
      const want = String(s.value ?? '').trim().toLowerCase();
      const match = (el.options || []).find((o) => o.trim().toLowerCase() === want);
      if (!match) { dropped.push(`"${clip(s.value, 40)}" isn't an option for "${el.label}"`); continue; }
      step.value = match;
    }
    steps.push(step);
  }
  const say = clip(data?.say, 400).trim() || (steps.length ? `I'll do ${steps.length} step${steps.length === 1 ? '' : 's'} on this page.` : "I couldn't find a way to do that on this page.");
  return { say, steps, dropped };
}
